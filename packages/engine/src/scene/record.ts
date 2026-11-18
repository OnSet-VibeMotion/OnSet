import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent, sortedKeys } from '../gojson';
import { goPathError, goRound } from '../gofmt';
import { blockValue, sceneBlocks } from './block';
import { mapOf, unmarshal, type StructType } from './jsondecode';
import * as srt from '../srt';
import { buildPrompt, DesignFile, memoryActive, outputPath, sceneCanvas, type Scene } from './scene';
import { localCues, localPhrases } from './scenedata';
import { parsePhraseTimeline } from './timing';
import { getToolVersion } from '../version';
import * as renderassets from '../renderassets';
import { resourceFiles } from './resources';
import { allSkills, HyperFramesSkillName, hyperFramesInputFiles, skillInputPath } from './skills';

/**
 * 写进诊断记录的 onset 版本，由 cli 在启动时设为 cli 的版本号。
 * 存取在 version 包（不依赖任何功能包，flow 的兼容检查也读它），这里转出，原有的 import 不用改。
 */
export { getToolVersion, setToolVersion } from '../version';

/** Go 的 scene.Record。 */
export type { RenderRecord as Record };

/** 镜头目录里的渲染记录文件名。 */
export const RecordFile = '.onset-render.json';

/**
 * 渲染记录的结构版本。
 *
 * 4：技能摘要收窄到各技能目录；HyperFrames 入口技能只记镜头可以读取的文档。
 * 3：发行版本与全片分镜摘要留作追溯。复用核对渲染契约和镜头自己的字段。
 * 2：镜头的输入文件按内容记（inputDigest）：scene.json 按解析后的数据，字幕与短语时间轴只记落在本镜头里的那几条。
 * 1：输入文件按字节记。旧记录照旧按字节核对（fingerprint 的 schema 参数），升级后没动过的镜头不会因为换了算法变成 Stale。
 */
export const RenderRecordSchema = 4;
const contentSchema = 2;
export const RecordSchemaRenderContract = 3;

/** 只有改变既有镜头的渲染契约且其他指纹识别不到时才升级。 */
const renderContract: string = '1';
const legacyRenderContract = '1';

/** 输入文件按字节记的旧记录版本。 */
export const RecordSchemaBytes = 1;

/**
 * 一次渲染的全部输入摘要。
 *
 * parts 的键是输入项名字（prompt、renderer、onset、file:<相对路径>、skill:<技能名>），
 * 值是该项内容的 sha256。分项记下而不是只存总指纹，是为了在判定 Stale 时能说出
 * 到底是哪一项变了——只说「输入变了」的话，人还得自己去翻是谁改了什么。
 */
export interface Inputs {
  fingerprint: string;
  /** Go 的 map[string]string；nil 写成 null。 */
  parts: Record<string, string> | null;
}

/**
 * 镜头产物通过校验时写下的渲染记录。
 *
 * 它回答的问题是「这份已验收的产物，是不是由当前这套输入渲出来的」，而不是
 * 「同样的输入能不能复现它」——渲染由 AI 完成，本来就不可复现。所以指纹一致时
 * 跳过重渲染是对的，指纹不一致时也只标 Stale，仍要显式 --force 才会覆盖。
 */
export interface RenderRecord extends Inputs {
  schema: number;
  output: string;
  output_size: number;
  output_sha256: string;
  onset_version?: string;
  legacy_onset_sha256?: string;
  plan_sha256?: string;
}

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
export function fingerprint(s: Scene, renderer: string, resolvedSkills: Record<string, string> | null, schema = RenderRecordSchema): Inputs {
  // 重试说明与 worker 数是调度层每次临时填的，不是镜头的输入。
  s = { ...s, retryNote: '', renderWorkers: 0, afterAttempt: null, seam: null, continuation: null, fresh: false, designOnly: false };
  const resolved = resolvedSkills ?? {};
  let prompt = buildPrompt(s, resolved);
  const parts: Record<string, string> = {
    renderer: digestString(renderer),
    ...(schema >= RecordSchemaRenderContract ? { render_contract: digestString(renderContract) } : { onset: digestString(getToolVersion()) }),
  };
  // 技能目录的绝对路径换成技能名：项目整体挪个位置不该让所有镜头变成 Stale，
  // 技能内容的变化由下面的 skill:<名字> 单独记录。
  const names = Object.keys(resolved).sort(compareBytes);
  const unused = schema >= RenderRecordSchema
    ? new Set(allSkills().filter(skill => skill.renderInput?.(s) === false).map(skill => skill.name))
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
    parts['file:' + toSlash(rel)] = schema >= contentSchema ? inputDigest(s, rel, win, schema) : digestFile(path.join(s.directory, rel));
  }
  // 扩展块自己的输入（例如角色包目录）由块给出。歌曲、卡点的数据文件不单独算：
  // 它们的 sha256 已写在 scene.json 的块里。
  for (const block of sceneBlocks()) {
    const value = blockValue(s, block.key);
    if (value !== null && block.fingerprintParts) Object.assign(parts, block.fingerprintParts(s, value));
  }
  return { fingerprint: combine(parts), parts };
}

function toSlash(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

/**
 * 列出镜头声明过的输入文件（相对镜头目录），即输入指纹覆盖的文件。
 * 渲染记忆冻结经历时按这份清单拷贝，与指纹同源，不会一边多一边少。
 * 扩展块的目录类输入（例如角色包）见各块的 fingerprintParts，不在这份清单里。
 */
export function inputFiles(s: Scene): string[] {
  const files = ['scene.json', s.transcript];
  if (fs.existsSync(path.join(s.directory, 'prompt.md'))) files.push('prompt.md');
  // 两段式的设计稿：有它时实现者照它做，改了它就该重渲染。没有它的镜头清单不变。
  if (fs.existsSync(path.join(s.directory, DesignFile))) files.push(DesignFile);
  return [...files, ...timingInputFiles(s)];
}

/**
 * 时间合同引用的镜头内文件，供输入指纹使用。
 *
 * 镜头局部数据 onset-scene.js 不算：它由 scene.json、字幕、frame.md 与这里的
 * 短语时间轴推出，每次渲染前重写，算进去只会重复计数。
 */
function timingInputFiles(s: Scene): string[] {
  if (s.timing === null || s.timing.phrases === '') return [];
  return [s.timing.phrases];
}

/** 本镜头在全片里的位置（裁字幕、短语时间轴用），只算一次；没有 timing 或画幅读不出时为 null。 */
export interface InputWindow {
  start: number;
  frames: number;
  fps: number;
}

function windowOf(s: Scene): () => InputWindow | null {
  let done = false;
  let w: InputWindow | null = null;
  return () => {
    if (!done) {
      done = true;
      try {
        if (s.timing !== null) {
          const fps = sceneCanvas(s).fps;
          w = { start: s.timing.start_frame, frames: goRound(s.duration_seconds * fps), fps };
        }
      } catch {
        w = null;
      }
    }
    return w;
  };
}

/**
 * 一个输入文件按内容的摘要（file 默认是镜头目录里的 rel，旧记录核对时换成快照里的旧内容）。按字节算的话，
 * 同一份内容换个写法也算输入变了：编排工具用脚本重写 scene.json，6.100000 变成 6.1；全片字幕里另一个镜头的
 * 一条改了时间，每个镜头目录里那份字幕都变，所有镜头跟着 Stale（2026-11 实测：一个项目 24 个镜头里 18 个
 * 就这样被判要重渲染，实际一个都没受影响）。
 *
 *   scene.json        解析后按键排序重新序列化：数字写法、键的先后、缩进都不算变化
 *   字幕、短语时间轴  只记渲染器实际拿到的那几条：有 timing 的镜头是 onset-scene.js 里裁到本镜头的字幕与短语
 *                     （正文与局部帧号，scenedata 的 localCues / localPhrases），没有 timing 的镜头记全部字幕（正文与时间）
 *   其余（prompt.md） 按字节：渲染器逐字读它
 *
 * 渲染器能看到的其余信息都在提示词里，由 prompt 那一项管。读不懂（JSON 写坏、字幕格式不对）时退回按字节。
 */
function inputDigest(
  s: Scene, rel: string, win: () => InputWindow | null, schema: number, file = path.join(s.directory, rel),
): string {
  try {
    if (rel === 'scene.json') {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (schema >= RecordSchemaRenderContract && value?.timing && typeof value.timing === 'object' && !Array.isArray(value.timing)) {
        delete value.timing.plan;
      }
      return digestString('json\n' + canonicalJSON(value));
    }
    if (rel === s.transcript) {
      const w = win();
      if (w !== null) return digestString('cues\n' + JSON.stringify(localCues(srt.readCues(file), w.start, w.frames, w.fps).map((c) => [c.text, c.start_frame, c.end_frame_exclusive])));
      if (s.timing === null) return digestString('cues\n' + JSON.stringify(srt.readCues(file).map((c) => [c.text, c.start_seconds, c.end_seconds])));
    }
    if (s.timing !== null && rel === s.timing.phrases) {
      const w = win();
      if (w !== null) {
        const phrases = localPhrases(parsePhraseTimeline(fs.readFileSync(file), w.fps), w.start, w.frames, w.fps);
        return digestString('phrases\n' + JSON.stringify(phrases.map((p) => [p.phrase_id, p.text, p.start_frame, p.end_frame_exclusive])));
      }
    }
  } catch {
    // 读不懂，按字节。
  }
  return digestFile(file);
}

/** 键按字节序排好的 JSON（数字按 JS 的最短写法）。 */
function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort(compareBytes).map((k) => JSON.stringify(k) + ':' + canonicalJSON(obj[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * 客户端每轮对话前后把项目里的文本文件按 sha256 存进 production/studio/blobs/（studio/turns.ts）。旧记录里的
 * 摘要正是那份内容的 sha256，找得到就能拿渲染时的内容按新规则比。项目根是镜头目录往上第一个有
 * onset.conf 的目录。
 */
function snapshotOf(dir: string, digest: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(digest)) return null;
  for (let at = path.resolve(dir); ; ) {
    if (fs.existsSync(path.join(at, 'onset.conf'))) {
      const file = path.join(at, 'production', 'studio', 'blobs', digest);
      return fs.existsSync(file) ? file : null;
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * 镜头声明过的输入文件 rel 与渲染记录里的那一项是否一致。新记录（2）按内容比；旧记录（1）先按字节比，
 * 对不上时到客户端的快照里找渲染时那份内容，找到就两份都按内容比，找不到才算变了。
 */
export function inputMatchesRecord(s: Scene, rel: string, record: Pick<RenderRecord, 'schema' | 'parts'>, win: () => InputWindow | null = windowOf(s)): boolean {
  const want = record.parts?.['file:' + toSlash(rel)];
  if (want === undefined) return false;
  try {
    if (record.schema >= contentSchema) return inputDigest(s, rel, win, record.schema) === want;
    const file = path.join(s.directory, rel);
    if (digestFile(file) === want) return true;
    const old = snapshotOf(s.directory, want);
    return old !== null && inputDigest(s, rel, win, RenderRecordSchema, old) === inputDigest(s, rel, win, RenderRecordSchema);
  } catch {
    return false;
  }
}

/**
 * 当前输入与渲染记录是否等价：指纹相同，或者变了的只有镜头的输入文件、且每个都与记录一致
 * （inputMatchesRecord：内容没变，只是写法、别的镜头的字幕变了）。onset 判断复用与镜头列表都用它。
 */
export function inputsMatchRecord(s: Scene, current: Inputs, record: RenderRecord): boolean {
  if (record.schema < RecordSchemaRenderContract && renderContract !== legacyRenderContract) return false;
  if (current.fingerprint === record.fingerprint) return true;
  if (!record.parts?.renderer || !record.parts.prompt) return false;
  const changed = renderInputChanges(current, record);
  const win = windowOf(s);
  return changed.every((name) => name.startsWith('file:') && inputMatchesRecord(s, name.slice('file:'.length), record, win));
}

/** 旧记录里的发行号只用于追溯。已经升级渲染契约时不能沿用旧记录。 */
export function renderInputChanges(current: Inputs, record: RenderRecord): string[] {
  const changed = changedInputs(current, record);
  if (record.schema >= RecordSchemaRenderContract) return changed;
  const renderChanges = changed.filter(name => name !== 'onset');
  if (renderContract !== legacyRenderContract) renderChanges.push('render_contract');
  return renderChanges;
}

/** 在 scene_cues 改写旧的 scene.json 前保留可证明的渲染输入。其他指纹仍来自原记录。 */
export function migrateRecordBeforePlanRewrite(s: Scene): string | undefined {
  const record = loadRecord(s);
  if (record?.schema !== contentSchema || !record.parts || !record.parts.renderer || !record.parts.prompt) return;
  if (renderContract !== legacyRenderContract || !inputMatchesRecord(s, 'scene.json', record)) return;
  const { onset, ...parts } = record.parts;
  parts.render_contract = digestString(legacyRenderContract);
  parts['file:scene.json'] = inputDigest(s, 'scene.json', windowOf(s), RenderRecordSchema);
  return marshalIndent(recordToJSON({
    ...record,
    schema: RecordSchemaRenderContract,
    legacy_onset_sha256: onset,
    plan_sha256: s.timing?.plan,
    fingerprint: combine(parts),
    parts,
  })) + '\n';
}

/** 与 other 相比内容不同、新增或消失的输入项，按名字排序。 */
export function changedInputs(inputs: Inputs, other: Inputs): string[] {
  const mine = inputs.parts ?? {};
  const theirs = other.parts ?? {};
  const changed: string[] = [];
  for (const [name, digest] of Object.entries(mine)) {
    if (theirs[name] !== digest) changed.push(name);
  }
  for (const name of Object.keys(theirs)) {
    if (!Object.hasOwn(mine, name)) changed.push(name);
  }
  return changed.sort(compareBytes);
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
    schema: RenderRecordSchema, output: s.output, output_size: size, output_sha256: digest,
    fingerprint: inputs.fingerprint, parts: inputs.parts, onset_version: getToolVersion(), plan_sha256: s.timing?.plan,
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
  if (![RecordSchemaBytes, contentSchema, RecordSchemaRenderContract, RenderRecordSchema].includes(record.schema) || record.output !== s.output || record.fingerprint === '') return null;
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
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(goPathError('remove', recordPath(s), err), { cause: err });
  }
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

function combine(parts: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  for (const name of Object.keys(parts).sort(compareBytes)) h.update(`${name}=${parts[name]}\n`);
  return h.digest('hex');
}

function digestString(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestFile(file: string): string {
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    const op = (err as NodeJS.ErrnoException).code === 'EISDIR' ? 'read' : 'open';
    throw new Error(goPathError(op, file, err), { cause: err });
  }
  return crypto.createHash('sha256').update(body).digest('hex');
}

/**
 * 对目录下全部普通文件的相对路径与内容做摘要，顺序固定（filepath.WalkDir 的字典序）。
 * 符号链接按链接目标的路径文本计入，不跟进去：技能树与角色包里都不该有它们。
 */
export function digestTree(root: string): string {
  const h = crypto.createHash('sha256');
  const visit = (file: string, rel: string, stat: fs.Stats) => {
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = fs.readlinkSync(file);
      } catch (err) {
        throw new Error(goPathError('readlink', file, err), { cause: err });
      }
      h.update(`link ${rel} -> ${target}\n`);
      return;
    }
    if (stat.isFile()) {
      h.update(`file ${rel} ${digestFile(file)}\n`);
      return;
    }
    if (!stat.isDirectory()) return;
    let names: string[];
    try {
      names = fs.readdirSync(file);
    } catch (err) {
      throw new Error(goPathError('open', file, err), { cause: err });
    }
    for (const name of names.sort(compareBytes)) {
      const child = path.join(file, name);
      let childStat: fs.Stats;
      try {
        childStat = fs.lstatSync(child);
      } catch (err) {
        throw new Error(goPathError('lstat', child, err), { cause: err });
      }
      visit(child, rel === '.' ? name : rel + '/' + name, childStat);
    }
  };
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch (err) {
    throw new Error(goPathError('lstat', root, err), { cause: err });
  }
  visit(root, '.', rootStat);
  return h.digest('hex');
}

/**
 * 缓存技能目录摘要：run-all 开跑前要给每个镜头算一遍指纹，
 * 几十个镜头共用同一套技能，没必要把同一棵树读几十遍。Go 版进程只活一条命令，
 * 期间技能树不会变；TS 版在常驻的客户端里会活很久，所以调用方在一批渲染开始前
 * 应当 resetDigestCache()，让技能树的改动能被看见。
 */
const treeDigests = new Map<string, string>();

function digestTreeCached(root: string): string {
  const cached = treeDigests.get(root);
  if (cached !== undefined) return cached;
  const digest = digestTree(root);
  treeDigests.set(root, digest);
  return digest;
}

function digestSkill(name: string, dir: string): string {
  const root = skillInputPath(name, dir);
  if (name !== HyperFramesSkillName) return digestTreeCached(root);
  const key = root + '\0scene-contract';
  const cached = treeDigests.get(key);
  if (cached !== undefined) return cached;
  const parts: Record<string, string> = {};
  for (const rel of hyperFramesInputFiles) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) parts[toSlash(rel)] = digestTree(file);
  }
  const digest = combine(parts);
  treeDigests.set(key, digest);
  return digest;
}

/** 清空技能目录摘要缓存。 */
export function resetDigestCache(): void {
  treeDigests.clear();
}
