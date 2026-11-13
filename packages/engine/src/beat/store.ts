// Package beat 是无配音卡点制作的时间契约：音乐 → 人工确认的节拍网格 →
// 按小节切分的镜头。移植自 internal/beat。
//
// 卡点的「切点落在重拍上」不靠渲染后对轴，而由结构保证：镜头时长只能用小节数
// 表达，切点帧号只由一个公式（重拍秒数 × fps 四舍五入）算出。全片只有这一个
// 时间来源，画面与音乐不会因为两处取整方式不同而慢慢错开。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, LineCounter, parseDocument } from 'yaml';
import { atomicWrite } from '../fsutil';
import { goClean, goPathError, goQuote, goTrimSpace } from '../gofmt';
import { marshalIndent } from '../gojson';
import { decodeFirst, onlySpace, type StructType } from './jsondecode';

/** Store 是卡点产物目录，相对项目根。 */
export const Store = 'production/beat';

/** ConfigFile 存在即启用卡点模式。 */
export const ConfigFile = 'beat.yaml';

// 项目内的固定文件名。镜头 cue 只认 GridFile，草稿不能直接拿去切镜头。
export const TrackFile = Store + '/track.json';
export const DraftFile = Store + '/grid-draft.json';
export const GridFile = Store + '/grid.json';
export const ClickFile = Store + '/grid-click.wav';
export const PlanFile = Store + '/plan.json';
export const AnalysisFile = Store + '/analysis.wav';

/**
 * AnalyzerVersion 是固定的 beat-this 版本。版本不符时脚本直接失败，
 * 不同版本的模型给出的网格不同，静默换版会让已确认的网格失去复现依据。
 */
export const AnalyzerVersion = '1.1.0';

/** DefaultConfig 是 am beat init 写出的 beat.yaml。 */
export const DefaultConfig = `schema: 1
# 节拍模型：final0（约 78 MB，默认）或 small0（约 8 MB，精度略低）；
# 同系列还有 final1/final2、small1/small2，是不同随机种子训练的同结构模型。
checkpoint: final0
# 不写 python 时用客户端工具准备页装好的共享环境（beat-this==${AnalyzerVersion}）。
# 只有要用自己的环境时才写，例如 python: /path/to/venv/bin/python
`;

/** Config 是 beat.yaml 的内容。 */
export interface Config {
  schema: number;
  checkpoint: string;
  /** 空：用 am setup 装好的共享环境（beat/env.ts）。 */
  python: string;
}

const checkpoints = new Set(['final0', 'final1', 'final2', 'small0', 'small1', 'small2']);

/** Enabled 报告项目根是否启用了卡点模式。 */
export function enabled(root: string): boolean {
  return fs.existsSync(path.join(root, ConfigFile));
}

/** 带 cause 的错误：Go 里用 %w 包住的底层错误放进 cause，isNotExist 顺着它找。 */
export function wrapError(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

/** Go 的 *fs.PathError：文案照 Go 写，底层的 Node 错误放进 cause。 */
export function pathError(op: string, file: string, err: unknown): Error {
  return wrapError(goPathError(op, file, err), err);
}

/** errors.Is(err, fs.ErrNotExist)：顺着 cause 链找 ENOENT。 */
export function isNotExist(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if (!(e instanceof Error)) break;
  }
  return false;
}

/** os.Stat 的存在性检查：失败时抛 Go 文案的 PathError。 */
export function statPath(file: string): fs.Stats {
  try {
    return fs.statSync(file);
  } catch (err) {
    throw pathError('stat', file, err);
  }
}

function readFile(file: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw pathError('open', file, err);
  }
}

/**
 * LoadConfig 读取并校验 beat.yaml。卡点与歌曲、多角色对话互斥：
 * 三者的时间轴各有唯一来源，混用时镜头时长该听谁的没有定义。
 */
export function loadConfig(root: string): Config {
  for (const other of ['song.yaml', 'cast.yaml']) {
    if (fs.existsSync(path.join(root, other))) throw new Error(`卡点模式不能与 ${other} 同时启用`);
  }
  const body = readFile(path.join(root, ConfigFile)).toString('utf8');
  let c: Config;
  try {
    c = decodeConfig(body);
  } catch (err) {
    throw wrapError(`${ConfigFile} 字段无效：${(err as Error).message}`, err);
  }
  if (c.schema !== 1 || !checkpoints.has(c.checkpoint)) {
    throw new Error(`${ConfigFile}：schema 必须为 1，checkpoint 取 final0..2 或 small0..2`);
  }
  c.python = goTrimSpace(c.python);
  return c;
}

/**
 * yaml.v3 的 Decoder + KnownFields(true) 解码进 Config 的复刻：未知键、类型不符都收集起来，
 * 写成「yaml: unmarshal errors:\n  line N: …」。空文件是 io.EOF。
 */
function decodeConfig(body: string): Config {
  const lineCounter = new LineCounter();
  const doc = parseDocument(body, { lineCounter, uniqueKeys: false });
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    const line = e.linePos?.[0]?.line;
    throw new Error(line ? `yaml: line ${line}: ${e.code === 'BAD_INDENT' ? 'bad indentation' : e.message.split('\n')[0]}` : `yaml: ${e.message}`);
  }
  const config: Config = { schema: 0, checkpoint: '', python: '' };
  const contents = doc.contents;
  if (contents === null || (isScalar(contents) && (contents.value === null || contents.value === undefined) && !body.trim())) {
    throw new Error('EOF');
  }
  const lineOf = (node: { range?: [number, number, number] | null }): number => lineCounter.linePos(node.range?.[0] ?? 0).line;
  const errors: string[] = [];
  if (!isMap(contents)) {
    const what = isScalar(contents) ? `!!str \`${String(contents.source ?? contents.value)}\`` : '!!seq';
    errors.push(`line ${lineOf(contents as never)}: cannot unmarshal ${what} into beat.Config`);
    throw new Error(`yaml: unmarshal errors:\n  ${errors.join('\n  ')}`);
  }
  for (const pair of contents.items) {
    const keyNode = pair.key as { value?: unknown; range?: [number, number, number] };
    const key = String(isScalar(pair.key) ? pair.key.value : keyNode?.value);
    const valueNode = pair.value;
    const line = lineOf(keyNode ?? {});
    if (key !== 'schema' && key !== 'checkpoint' && key !== 'python') {
      errors.push(`line ${line}: field ${key} not found in type beat.Config`);
      continue;
    }
    if (valueNode === null || (isScalar(valueNode) && valueNode.value === null)) continue;
    if (!isScalar(valueNode)) {
      errors.push(`line ${lineOf(valueNode as never)}: cannot unmarshal ${isMap(valueNode) ? '!!map' : '!!seq'} into ${key === 'schema' ? 'int' : 'string'}`);
      continue;
    }
    const source = String(valueNode.source ?? valueNode.value);
    if (key === 'schema') {
      const v = valueNode.value;
      // yaml.v3 把浮点解进 int 字段时直接截断（1.5 → 1），不报错。
      if (typeof v === 'number' && Number.isFinite(v)) config.schema = Math.trunc(v) + 0;
      else errors.push(`line ${lineOf(valueNode as never)}: cannot unmarshal ${typeof v === 'boolean' ? '!!bool' : '!!str'} \`${source}\` into int`);
    } else {
      config[key as 'checkpoint' | 'python'] = source;
    }
  }
  if (errors.length > 0) throw new Error(`yaml: unmarshal errors:\n  ${errors.join('\n  ')}`);
  return config;
}

/** filepath.IsLocal 的 Unix 语义：非空、非绝对路径、Clean 后不越出当前目录。 */
export function isLocal(p: string): boolean {
  if (p === '' || p.startsWith('/')) return false;
  const clean = goClean(p);
  return clean !== '..' && !clean.startsWith('../');
}

/** localPath 把项目内相对路径解析成绝对路径，拒绝越界与符号链接。 */
export function localPath(root: string, rel: string): string {
  if (rel === '' || !isLocal(rel)) throw new Error(`项目路径必须是安全的相对路径：${goQuote(rel)}`);
  let current = path.resolve(root);
  for (const part of goClean(rel).split('/')) {
    current = path.join(current, part);
    let info: fs.Stats | undefined;
    try {
      info = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw pathError('lstat', current, err);
    }
    if (info?.isSymbolicLink()) throw new Error(`卡点产物路径不得包含符号链接：${rel}`);
  }
  return current;
}

export function hashFile(file: string): string {
  return hashBytes(readFile(file));
}

export function hashBytes(b: Uint8Array): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

/**
 * encodeJSON 是写盘与算摘要共用的唯一编码：两边各编一次的话，缩进或换行
 * 稍有不同，摘要就永远对不上。
 */
export function encodeJSON(v: unknown): Buffer {
  return Buffer.from(marshalIndent(v) + '\n', 'utf8');
}

export function writeJSON(file: string, v: unknown): void {
  const body = encodeJSON(v);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, body, 0o644);
}

/** readJSON 严格解码：未知字段与多余内容都报错，手改文件时的笔误不会被静默忽略。 */
export function readJSON<T>(file: string, t: StructType): T {
  const body = readFile(file);
  let decoded: { value: T; rest: Uint8Array };
  try {
    decoded = decodeFirst<T>(body, t, true);
  } catch (err) {
    throw wrapError(`JSON 文件无效：${file}（${(err as Error).message}）`, err);
  }
  if (!onlySpace(decoded.rest)) throw new Error(`JSON 文件有多余内容：${file}`);
  return decoded.value;
}
