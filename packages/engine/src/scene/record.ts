import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent, sortedKeys } from '../gojson';
import { goPathError } from '../gofmt';
import { blockValue, sceneBlocks } from './block';
import { mapOf, unmarshal, type StructType } from './jsondecode';
import { buildPrompt, memoryActive, outputPath, type Scene } from './scene';
import { getToolVersion } from '../version';

/**
 * 写进输入指纹的 am 版本，由 cli 在启动时设为 cli 的版本号（Go 的 scene.ToolVersion = cli.Version）。
 * 存取在 version 包（不依赖任何功能包，flow 的兼容检查也读它），这里转出，原有的 import 不用改。
 */
export { getToolVersion, setToolVersion } from '../version';

/** Go 的 scene.Record。 */
export type { RenderRecord as Record };

/** 镜头目录里的渲染记录文件名。 */
export const RecordFile = '.am-render.json';

/** 渲染记录的结构版本。 */
const recordSchema = 1;

/**
 * 一次渲染的全部输入摘要。
 *
 * parts 的键是输入项名字（prompt、renderer、am、file:<相对路径>、skill:<技能名>），
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
  ],
};

/**
 * 计算镜头的输入指纹。renderer 是实际使用的渲染工具，resolvedSkills 由 resolveAllSkills 解析。
 *
 * 只算声明过的输入，不扫整个镜头目录：渲染器自己会往目录里写合成代码与素材，
 * 把它们算进来的话，渲染一结束指纹就变了，记录永远对不上。
 */
export function fingerprint(s: Scene, renderer: string, resolvedSkills: Record<string, string> | null): Inputs {
  // 重试说明与 worker 数是调度层每次临时填的，不是镜头的输入。
  s = { ...s, retryNote: '', renderWorkers: 0, afterAttempt: null };
  const resolved = resolvedSkills ?? {};
  let prompt = buildPrompt(s, resolved);
  const parts: Record<string, string> = {
    renderer: digestString(renderer),
    am: digestString(getToolVersion()),
  };
  // 技能目录的绝对路径换成技能名：项目整体挪个位置不该让所有镜头变成 Stale，
  // 技能内容的变化由下面的 skill:<名字> 单独记录。
  const names = Object.keys(resolved).sort(compareBytes);
  for (const name of names) {
    const dir = resolved[name];
    if (dir === '') continue;
    prompt = prompt.replaceAll(dir, '<skill:' + name + '>');
    let digest: string;
    try {
      digest = digestTreeCached(dir);
    } catch (err) {
      throw new Error(`计算技能 ${name} 的内容摘要：${(err as Error).message}`, { cause: err });
    }
    parts['skill:' + name] = digest;
  }
  parts.prompt = digestString(prompt);
  // 召回的记忆单列一项：记忆一变，Stale 的原因能直接说成「召回的记忆变了」，
  // 而不是笼统的 prompt。没有召回时不加这一项，打开记忆不会让老镜头全部 Stale。
  if (memoryActive(s.memory)) parts.memory = s.memory.digest;
  for (const rel of inputFiles(s)) {
    parts['file:' + toSlash(rel)] = digestFile(path.join(s.directory, rel));
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
  if (s.style_guide !== '') files.push(s.style_guide);
  return [...files, ...timingInputFiles(s)];
}

/**
 * 时间合同引用的镜头内文件，供输入指纹使用。
 *
 * 镜头局部数据 am-scene.js 不算：它由 scene.json、字幕、视觉规范与这里的
 * 短语时间轴推出，每次渲染前重写，算进去只会重复计数。
 */
function timingInputFiles(s: Scene): string[] {
  if (s.timing === null || s.timing.phrases === '') return [];
  return [s.timing.phrases];
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
  };
}

/** 产物通过校验后写下渲染记录。 */
export function writeRecord(s: Scene, inputs: Inputs): void {
  const [size, digest] = outputIdentity(s);
  const body = marshalIndent(
    recordToJSON({ schema: recordSchema, output: s.output, output_size: size, output_sha256: digest, fingerprint: inputs.fingerprint, parts: inputs.parts }),
  );
  atomicWrite(recordPath(s), body + '\n', 0o644);
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
  if (record.schema !== recordSchema || record.output !== s.output || record.fingerprint === '') return null;
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

/** 清空技能目录摘要缓存。 */
export function resetDigestCache(): void {
  treeDigests.clear();
}
