import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goClean, goPathError } from '../gofmt';
import { marshal, marshalIndent } from '../gojson';
import { decodeValue, type Schema, splitFirstValue } from './jsondecode';

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
  if (process.platform === 'win32') {
    // path.join emits backslashes on Windows; inspect every ancestor, including junctions.
    if (path.win32.parse(rel).root !== '') throw new Error('项目路径必须是安全相对路径');
    rel = rel.replaceAll('\\', '/');
  }
  if (rel === '' || !isLocal(rel)) throw new Error('项目路径必须是安全相对路径');
  root = path.resolve(root);
  let p = root;
  for (const part of goClean(rel).split('/')) {
    p = path.join(p, part);
    let info: fs.Stats | null = null;
    try {
      info = fs.lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(goPathError('lstat', p, err), { cause: err });
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

export function finite(f: number): boolean {
  return Number.isFinite(f);
}

export function bytesHash(b: Uint8Array | string): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}
