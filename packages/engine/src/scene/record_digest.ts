import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goPathError } from '../gofmt';
import { compareBytes } from '../gojson';
import { HyperFramesSkillName, hyperFramesInputFiles, skillInputPath } from './skills';

export function toSlash(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

export function combine(parts: Record<string, string>): string {
  const h = crypto.createHash('sha256');
  for (const name of Object.keys(parts).sort(compareBytes)) h.update(`${name}=${parts[name]}\n`);
  return h.digest('hex');
}

export function digestString(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestFile(file: string): string {
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

export function digestTreeCached(root: string): string {
  const cached = treeDigests.get(root);
  if (cached !== undefined) return cached;
  const digest = digestTree(root);
  treeDigests.set(root, digest);
  return digest;
}

export function digestSkill(name: string, dir: string): string {
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
