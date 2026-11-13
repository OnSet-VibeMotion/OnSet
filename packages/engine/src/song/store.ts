// Package song owns immutable song candidates and their derived timing contract.
// 移植自 internal/song/store.go。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, parseAllDocuments, type Node } from 'yaml';
import { atomicWrite } from '../fsutil';
import { goClean, goPathError } from '../gofmt';
import { marshal, marshalIndent } from '../gojson';
import { decodeValue, splitFirstValue, type Schema } from './jsondecode';
import { knownProvider, providerInfo, validateHostedConfig } from './platforms';
import { candidateSchema, candidateToJSON, type Candidate, type Config } from './types';

export const Store = 'production/song';
export const DefaultConfig = `schema: 1
provider: minimax
lyrics: lyrics.txt
style: "Mandarin educational solo rap, clear diction"
language: zh
target_seconds: 120
bpm: 100
# Use the song_providers tool for platform access and API key setup.
# Use song_configure (provider: bailian|elevenlabs|fal|minimax|acestep|mureka|lyria|manual) to switch.
# endpoint: https://your-acestep-server.example
python: python3
`;

function statOK(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

export function enabled(root: string): boolean {
  return statOK(path.join(root, 'song.yaml'));
}

export function loadConfig(root: string): Config {
  if (statOK(path.join(root, 'cast.yaml'))) throw new Error('首版不支持 song + cast');
  const file = path.join(root, 'song.yaml');
  let b: Buffer;
  try {
    b = fs.readFileSync(file);
  } catch (err) {
    throw new Error(goPathError('open', file, err), { cause: err });
  }
  return decodeConfig(root, b);
}

type FieldKind = 'int' | 'float' | 'string';
const configFields: Array<[string, keyof Config, FieldKind]> = [
  ['schema', 'schema', 'int'],
  ['provider', 'provider', 'string'],
  ['model', 'model', 'string'],
  ['workspace', 'workspace', 'string'],
  ['endpoint', 'endpoint', 'string'],
  ['lyrics', 'lyrics', 'string'],
  ['style', 'style', 'string'],
  ['language', 'language', 'string'],
  ['target_seconds', 'target_seconds', 'float'],
  ['bpm', 'bpm', 'int'],
  ['python', 'python', 'string'],
];

/**
 * yaml.v3 的 Decoder + KnownFields(true) 解码进 Config：未知键、重复键、类型不符都报错；
 * 任何标量都能进 string（取原文），浮点截断进 int，null 保留零值。返回 null 表示解码失败。
 */
function decodeConfigYAML(body: string): { config: Config; documents: number } | null {
  let docs;
  try {
    docs = parseAllDocuments(body, { uniqueKeys: true });
  } catch {
    return null;
  }
  if (!Array.isArray(docs) || docs.length === 0) return null;
  const doc = docs[0];
  if (doc.errors.length > 0) return null;
  const c: Config = {
    schema: 0,
    provider: '',
    model: '',
    workspace: '',
    endpoint: '',
    lyrics: '',
    style: '',
    language: '',
    target_seconds: 0,
    bpm: 0,
    python: '',
  };
  const contents = doc.contents as Node | null;
  if (contents === null) return null;
  if (isScalar(contents) && contents.value === null) return null;
  if (!isMap(contents)) return null;
  for (const pair of contents.items) {
    const keyNode = pair.key as Node | null;
    if (!isScalar(keyNode)) return null;
    const key = String(keyNode.value);
    const field = configFields.find(([name]) => name === key);
    if (!field) return null; // KnownFields(true)
    const valueNode = pair.value as Node | null;
    if (valueNode === null || valueNode === undefined) continue;
    if (!isScalar(valueNode)) return null;
    const value = valueNode.value;
    if (value === null || value === undefined) continue;
    const [, prop, kind] = field;
    const source = (valueNode as unknown as { source?: string }).source;
    if (kind === 'string') {
      (c[prop] as string) = typeof value === 'string' ? value : typeof source === 'string' ? source : String(value);
    } else if (typeof value === 'number' && kind === 'float') {
      (c[prop] as number) = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      (c[prop] as number) = Math.trunc(value);
    } else {
      return null;
    }
  }
  return { config: c, documents: docs.length };
}

export function decodeConfig(root: string, b: Uint8Array): Config {
  if (statOK(path.join(root, 'cast.yaml'))) throw new Error('首版不支持 song + cast');
  const decoded = decodeConfigYAML(Buffer.from(b).toString('utf8'));
  if (!decoded) throw new Error('song.yaml 字段无效');
  if (decoded.documents > 1) throw new Error('song.yaml 只能包含一份配置');
  const c = decoded.config;
  if (
    c.schema !== 1 ||
    !knownProvider(c.provider) ||
    c.style.trim() === '' ||
    c.language === '' ||
    !finite(c.target_seconds) ||
    c.target_seconds < 10 ||
    c.target_seconds > 600 ||
    c.bpm < 30 ||
    c.bpm > 300
  ) {
    throw new Error(
      'song.yaml: schema=1，provider=minimax|acestep|bailian|elevenlabs|fal|mureka|lyria|manual，style/language 必填，target_seconds=10..600，bpm=30..300',
    );
  }
  if (c.model === '') c.model = providerInfo(c.provider).model;
  if (c.python === '') c.python = 'python3';
  localPath(root, c.lyrics);
  if (c.provider === 'acestep') {
    const u = parseGoURL(c.endpoint);
    if (!u || u.host === '' || (u.scheme !== 'http' && u.scheme !== 'https') || u.hasUser || u.rawQuery !== '' || u.fragment !== '') {
      throw new Error('ACE-Step endpoint 必须是无凭据、无查询参数的 HTTP(S) 地址');
    }
  }
  validateHostedConfig(c);
  return c;
}

/** Go net/url.Parse 的一小部分：只取校验要用的几个字段。解析失败返回 null。 */
export interface GoURL {
  scheme: string;
  hasUser: boolean;
  /** 含端口，与 Go 的 u.Host 一致。 */
  host: string;
  hostname: string;
  port: string;
  rawQuery: string;
  fragment: string;
}

export function parseGoURL(raw: string): GoURL | null {
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return null; // net/url: invalid control character in URL
  }
  let rest = raw;
  let fragment = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let scheme = '';
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(rest);
  if (m) {
    scheme = m[1].toLowerCase();
    rest = rest.slice(m[0].length);
  } else if (/^[^/?]*:/.test(rest)) {
    return null; // missing protocol scheme
  }
  let rawQuery = '';
  const q = rest.indexOf('?');
  if (q >= 0) {
    rawQuery = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  let host = '';
  let hasUser = false;
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const slash = rest.indexOf('/');
    let authority = slash >= 0 ? rest.slice(0, slash) : rest;
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      hasUser = true;
      authority = authority.slice(at + 1);
    }
    host = authority;
  }
  let hostname = host;
  let port = '';
  if (host.startsWith('[')) {
    const close = host.indexOf(']');
    if (close < 0) return null;
    hostname = host.slice(1, close);
    const after = host.slice(close + 1);
    if (after.startsWith(':')) port = after.slice(1);
    else if (after !== '') return null;
  } else {
    const colon = host.lastIndexOf(':');
    if (colon >= 0) {
      hostname = host.slice(0, colon);
      port = host.slice(colon + 1);
    }
  }
  if (port !== '' && !/^[0-9]+$/.test(port)) return null;
  return { scheme, hasUser, host, hostname, port, rawQuery, fragment };
}

/** filepath.IsLocal（Unix）。 */
function isLocal(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel)) return false;
  const clean = goClean(rel);
  return clean !== '..' && !clean.startsWith('../');
}

/** localPath rejects traversal and symlinks before reading or writing project state. */
export function localPath(root: string, rel: string): string {
  if (rel === '' || !isLocal(rel)) throw new Error('项目路径必须是安全相对路径');
  root = path.resolve(root);
  let p = root;
  for (const part of goClean(rel).split('/')) {
    p = path.join(p, part);
    let info: fs.Stats | null = null;
    try {
      info = fs.lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(goPathError('lstat', p, err), { cause: err });
    }
    if (info && info.isSymbolicLink()) throw new Error(`歌曲路径不得包含符号链接：${rel}`);
  }
  return p;
}

export function hashFile(p: string): string {
  let body: Buffer;
  try {
    body = fs.readFileSync(p);
  } catch (err) {
    throw new Error(goPathError('open', p, err), { cause: err });
  }
  return crypto.createHash('sha256').update(body).digest('hex');
}

/** sha256(json.Marshal(v))。v 必须是已按 Go 结构体形状构造的 JSON 值（见 types.ts 的 *ToJSON）。 */
export function digest(v: unknown): string {
  return crypto.createHash('sha256').update(marshal(v)).digest('hex');
}

/** 写出 MarshalIndent(v, "", "  ") 加换行；内容不变时不碰文件。v 同 digest。 */
export function writeJSON(p: string, v: unknown): void {
  const b = Buffer.from(marshalIndent(v) + '\n');
  try {
    if (fs.readFileSync(p).equals(b)) return;
  } catch {
    // 不存在或读不了：照常写。
  }
  atomicWrite(p, b, 0o644);
}

/**
 * readJSON 严格读取（DisallowUnknownFields，且只能有一个值）。schema 描述 Go 的目标类型；
 * 省略时等同于 map[string]any。
 */
export function readJSON<T>(p: string, schema: Schema = 'any'): T {
  let b: string;
  try {
    b = fs.readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(goPathError('open', p, err), { cause: err });
  }
  const split = splitFirstValue(b);
  let value: T;
  try {
    if (!split) throw new Error('EOF');
    value = decodeValue(JSON.parse(split[0]), schema, true) as T;
  } catch {
    throw new Error(`JSON 文件无效：${p}`);
  }
  if (split[1].trim() !== '') throw new Error(`JSON 存在多余内容：${p}`);
  return value;
}

export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/;

export function candidateDir(root: string, id: string): string {
  if (!idPattern.test(id)) throw new Error('候选 ID 无效');
  return localPath(root, path.join(Store, 'candidates', id));
}

export function readCandidate(p: string): Candidate {
  return readJSON<Candidate>(p, candidateSchema);
}

export function loadCandidate(root: string, id: string): Candidate {
  const dir = candidateDir(root, id);
  const record = localPath(dir, 'candidate.json');
  const c = readCandidate(record);
  if (c.id !== id || c.state !== 'ready' || !finite(c.duration_seconds) || c.duration_seconds <= 0) {
    throw new Error('歌曲候选尚未就绪');
  }
  for (const f of [
    { p: c.audio, h: c.audio_sha256 },
    { p: c.lyrics, h: c.lyrics_sha256 },
  ]) {
    const file = localPath(dir, f.p);
    if (hashFile(file) !== f.h) throw new Error('候选文件摘要变化，请重新导入或生成');
  }
  return c;
}

export function select(root: string, id: string): void {
  withLock(root, () => selectCandidate(root, id));
}

function selectCandidate(root: string, id: string): void {
  loadConfig(root);
  const c = loadCandidate(root, id);
  const p = localPath(root, Store + '/selected.json');
  writeJSON(p, candidateToJSON(c));
}

export function selected(root: string): Candidate {
  const p = localPath(root, Store + '/selected.json');
  let c: Candidate;
  try {
    c = readCandidate(p);
  } catch (err) {
    throw new Error(`尚未选定歌曲，请试听后运行 song_select({"args": ["<id>"]})：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const actual = loadCandidate(root, c.id);
  if (digest(candidateToJSON(actual)) !== digest(candidateToJSON(c))) throw new Error('选定记录与候选不一致，请重新选择');
  return c;
}

export function finite(f: number): boolean {
  return Number.isFinite(f);
}

export function bytesHash(b: Uint8Array | string): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

/** 项目级的歌曲操作锁：同一时刻只允许一个改动歌曲状态的命令。 */
export function withLock<T>(root: string, fn: () => T): T {
  const p = localPath(root, Store + '/.operation-lock');
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
  let fd: number;
  try {
    fd = fs.openSync(p, 'wx', 0o600);
  } catch {
    throw new Error(`歌曲操作锁已存在；确认没有运行中命令后才可删除 ${p}`);
  }
  fs.closeSync(fd);
  let async = false;
  try {
    const out = fn();
    if (out instanceof Promise) {
      async = true;
      return out.finally(() => fs.rmSync(p, { force: true })) as T;
    }
    return out;
  } finally {
    if (!async) fs.rmSync(p, { force: true });
  }
}

