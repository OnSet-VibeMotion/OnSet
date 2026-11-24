import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goPathError } from '../gofmt';
import { compareBytes, marshalIndent, sortedKeys } from '../gojson';
import * as renderassets from '../renderassets';
import { getToolVersion } from '../version';
import { blockValue, sceneBlocks } from './block';
import { mapOf, type StructType, unmarshal } from './jsondecode';
import { combine, digestFile, digestSkill, digestString, digestTreeCached, toSlash } from './record_digest';
import {
  contentSchema,
  type Inputs,
  inputDigest,
  inputFiles,
  inputMatchesRecord,
  legacyRenderContract,
  RecordFile,
  RecordSchemaBytes,
  RecordSchemaRenderContract,
  type RenderRecord,
  RenderRecordSchema,
  renderContract,
  windowOf,
} from './record_inputs';
import { resourceFiles } from './resources';
import { buildPrompt, memoryActive, outputPath, type Scene } from './scene';
import { allSkills } from './skills';

/**
 * 写进诊断记录的 onset 版本，由 cli 在启动时设为 cli 的版本号。
 * 存取在 version 包（不依赖任何功能包，flow 的兼容检查也读它），这里转出，原有的 import 不用改。
 */
export { getToolVersion, setToolVersion } from '../version';
export { digestTree, resetDigestCache } from './record_digest';
export {
  changedInputs,
  type Inputs,
  type InputWindow,
  inputFiles,
  inputMatchesRecord,
  inputsMatchRecord,
  RecordFile,
  RecordSchemaBytes,
  RecordSchemaRenderContract,
  type RenderRecord,
  /** Go 的 scene.Record。 */
  type RenderRecord as Record,
  RenderRecordSchema,
  renderInputChanges,
} from './record_inputs';

const recordType: StructType = {
  kind: 'struct',
  goName: 'scene.Record',
  name: 'Record',
  fields: [
    ['schema', 'int'],
    ['output', 'string'],
    ['output_size', 'int64'],
    ['output_sha256', 'string'],
    ['fingerprint', 'string'],
    ['parts', mapOf('string')],
    ['onset_version', 'string'],
    ['legacy_onset_sha256', 'string'],
    ['plan_sha256', 'string'],
  ],
};

/**
 * 计算镜头的输入指纹。renderer 是实际使用的渲染工具，resolvedSkills 由 resolveAllSkills 解析。
 *
 * 只算声明过的输入，不扫整个镜头目录：渲染器自己会往目录里写合成代码与素材，
 * 把它们算进来的话，渲染一结束指纹就变了，记录永远对不上。
 */
export function fingerprint(
  s: Scene,
  renderer: string,
  resolvedSkills: Record<string, string> | null,
  schema = RenderRecordSchema,
): Inputs {
  // 重试说明与 worker 数是调度层每次临时填的，不是镜头的输入。
  s = {
    ...s,
    retryNote: '',
    renderWorkers: 0,
    afterAttempt: null,
    seam: null,
    continuation: null,
    fresh: false,
    designOnly: false,
  };
  const resolved = resolvedSkills ?? {};
  let prompt = buildPrompt(s, resolved);
  const parts: Record<string, string> = {
    renderer: digestString(renderer),
    ...(schema >= RecordSchemaRenderContract
      ? { render_contract: digestString(renderContract) }
      : { onset: digestString(getToolVersion()) }),
  };
  // 技能目录的绝对路径换成技能名：项目整体挪个位置不该让所有镜头变成 Stale，
  // 技能内容的变化由下面的 skill:<名字> 单独记录。
  const names = Object.keys(resolved).sort(compareBytes);
  const unused =
    schema >= RenderRecordSchema
      ? new Set(
          allSkills()
            .filter((skill) => skill.renderInput?.(s) === false)
            .map((skill) => skill.name),
        )
      : new Set<string>();
  for (const name of names) {
    const dir = resolved[name];
    if (dir === '') continue;
    prompt = prompt.replaceAll(dir, '<skill:' + name + '>');
    if (unused.has(name)) continue;
    let digest: string;
    try {
      digest = schema < RenderRecordSchema ? digestTreeCached(dir) : digestSkill(name, dir);
    } catch (err) {
      throw new Error(`计算技能 ${name} 的内容摘要：${(err as Error).message}`, { cause: err });
    }
    parts['skill:' + name] = digest;
  }
  parts.prompt = digestString(prompt);
  // 只有已由 run 准备过共享资源的镜头才启用新指纹项；升级不让从未挂载过资源的旧产物全部 Stale。
  if (fs.existsSync(path.join(s.directory, renderassets.ManifestFile))) {
    Object.assign(parts, renderassets.inputs(s.directory, resourceFiles(s, resolved)));
  }
  // 召回的记忆单列一项：记忆一变，Stale 的原因能直接说成「召回的记忆变了」，
  // 而不是笼统的 prompt。没有召回时不加这一项，打开记忆不会让老镜头全部 Stale。
  if (memoryActive(s.memory)) parts.memory = s.memory.digest;
  // 参考范例同理：带了才有这一项，范例换了 Stale 的原因说得出来。
  if (s.exemplars && s.exemplars.names.length > 0) parts.exemplars = s.exemplars.digest;
  const win = windowOf(s);
  for (const rel of inputFiles(s)) {
    parts['file:' + toSlash(rel)] =
      schema >= contentSchema ? inputDigest(s, rel, win, schema) : digestFile(path.join(s.directory, rel));
  }
  // 扩展块自己的输入（例如角色包目录）由块给出。歌曲、卡点的数据文件不单独算：
  // 它们的 sha256 已写在 scene.json 的块里。
  for (const block of sceneBlocks()) {
    const value = blockValue(s, block.key);
    if (value !== null && block.fingerprintParts) Object.assign(parts, block.fingerprintParts(s, value));
  }
  return { fingerprint: combine(parts), parts };
}

/** 在 scene_cues 改写旧的 scene.json 前保留可证明的渲染输入。其他指纹仍来自原记录。 */
export function migrateRecordBeforePlanRewrite(s: Scene): string | undefined {
  const record = loadRecord(s);
  if (record?.schema !== contentSchema || !record.parts || !record.parts.renderer || !record.parts.prompt) return;
  if (renderContract !== legacyRenderContract || !inputMatchesRecord(s, 'scene.json', record)) return;
  const { onset, ...parts } = record.parts;
  parts.render_contract = digestString(legacyRenderContract);
  parts['file:scene.json'] = inputDigest(s, 'scene.json', windowOf(s), RenderRecordSchema);
  return (
    marshalIndent(
      recordToJSON({
        ...record,
        schema: RecordSchemaRenderContract,
        legacy_onset_sha256: onset,
        plan_sha256: s.timing?.plan,
        fingerprint: combine(parts),
        parts,
      }),
    ) + '\n'
  );
}

function recordPath(s: Pick<Scene, 'directory'>): string {
  return path.join(s.directory, RecordFile);
}

/** 按 Go 的字段顺序构造 Record 的 JSON 值（Inputs 内嵌，字段展平在后）。 */
export function recordToJSON(r: RenderRecord): unknown {
  return {
    schema: r.schema,
    output: r.output,
    output_size: r.output_size,
    output_sha256: r.output_sha256,
    fingerprint: r.fingerprint,
    parts: r.parts === null ? null : sortedKeys(r.parts),
    onset_version: r.onset_version || undefined,
    legacy_onset_sha256: r.legacy_onset_sha256 || undefined,
    plan_sha256: r.plan_sha256 || undefined,
  };
}

/** 产物通过校验后写下渲染记录。 */
export function writeRecord(s: Scene, inputs: Inputs): void {
  const [size, digest] = outputIdentity(s);
  saveRecord(s, {
    schema: RenderRecordSchema,
    output: s.output,
    output_size: size,
    output_sha256: digest,
    fingerprint: inputs.fingerprint,
    parts: inputs.parts,
    onset_version: getToolVersion(),
    plan_sha256: s.timing?.plan,
  });
}

/** 调用方已用旧版算法核对产物和输入，升级摘要时保留原渲染出处。 */
export function upgradeRenderRecord(s: Scene, old: RenderRecord, inputs: Inputs): void {
  saveRecord(s, { ...old, ...inputs, schema: RenderRecordSchema });
}

function saveRecord(s: Scene, record: RenderRecord): void {
  atomicWrite(recordPath(s), marshalIndent(recordToJSON(record)) + '\n', 0o644);
}

/**
 * 读出仍然适用于当前产物的渲染记录。
 *
 * 产物被替换过（大小或内容摘要对不上）时记录不再适用，返回 null——那份记录描述的是另一个文件。
 */
export function loadRecord(s: Scene): RenderRecord | null {
  let body: Buffer;
  try {
    body = fs.readFileSync(recordPath(s));
  } catch {
    return null;
  }
  let record: RenderRecord;
  try {
    record = unmarshal<RenderRecord>(body, recordType);
  } catch {
    return null;
  }
  if (
    ![RecordSchemaBytes, contentSchema, RecordSchemaRenderContract, RenderRecordSchema].includes(record.schema) ||
    record.output !== s.output ||
    record.fingerprint === ''
  ) {
    return null;
  }
  try {
    const [size, digest] = outputIdentity(s);
    if (size !== record.output_size || digest !== record.output_sha256) return null;
  } catch {
    return null;
  }
  return record;
}

/**
 * 删除渲染记录。开始重渲染前调用：渲染中途失败时目录里可能
 * 留下一个恰好通过校验的半成品，旧记录不能替它作保。
 */
export function removeRecord(s: Pick<Scene, 'directory'>): void {
  try {
    fs.unlinkSync(recordPath(s));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(goPathError('remove', recordPath(s), err), { cause: err });
    }
  }
}

/**
 * 直接从现有合成重新编码出片后，刷新渲染记录里的产物大小与摘要，保留原输入指纹。
 * 没有有效旧记录时返回 false，由调用方按当前输入重新写一份。
 */
export function refreshRecordOutput(s: Scene): boolean {
  let body: Buffer;
  try {
    body = fs.readFileSync(recordPath(s));
  } catch {
    return false;
  }
  let record: RenderRecord;
  try {
    record = unmarshal<RenderRecord>(body, recordType);
  } catch {
    return false;
  }
  if (
    ![RecordSchemaBytes, contentSchema, RecordSchemaRenderContract, RenderRecordSchema].includes(record.schema) ||
    record.output !== s.output ||
    record.fingerprint === ''
  ) {
    return false;
  }
  const [size, digest] = outputIdentity(s);
  saveRecord(s, { ...record, output_size: size, output_sha256: digest });
  return true;
}

function outputIdentity(s: Scene): [number, string] {
  const file = outputPath(s);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    throw new Error(goPathError('stat', file, err), { cause: err });
  }
  return [size, digestFile(file)];
}
