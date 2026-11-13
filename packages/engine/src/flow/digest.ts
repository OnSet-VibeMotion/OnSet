/**
 * 站目录的内容摘要。loadProjectStations 到处都在调（制作路线、提示词、工具列表……），每次都把 git 来源的站
 * 全量读一遍太浪费，所以按目录缓存在进程里：先只 stat 一遍目录树（相对路径、大小、mtime、ctime），
 * 概要没变才用缓存，任何一项变了就重读重算。宁可多算不可算错。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';

interface TreeFile {
  rel: string;
  abs: string;
  stat: fs.BigIntStats;
}

/** 列出站目录里的全部文件（跳过 .git），按字节序。有符号链接直接报错。 */
function listTree(dir: string): TreeFile[] {
  const files: TreeFile[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`第三方站里不能有符号链接：${child}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const abs = path.join(dir, child);
        files.push({ rel: child, abs, stat: fs.statSync(abs, { bigint: true }) });
      }
    }
  };
  walk('');
  files.sort((a, b) => compareBytes(a.rel, b.rel));
  return files;
}

function treeSignature(files: readonly TreeFile[]): string {
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(`${f.rel}\n${f.stat.size}\n${f.stat.mtimeNs}\n${f.stat.ctimeNs}\n${f.stat.ino}\n`);
  return hash.digest('hex');
}

const cache = new Map<string, { signature: string; digest: string }>();

/** 站目录的内容摘要：按字节序列出全部文件（跳过 .git），逐个记相对路径与内容。 */
export function treeDigest(dir: string): string {
  const files = listTree(dir);
  const key = path.resolve(dir);
  const signature = treeSignature(files);
  const hit = cache.get(key);
  if (hit && hit.signature === signature) return hit.digest;
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    const body = fs.readFileSync(f.abs);
    hash.update(`${f.rel}\n${body.length}\n`);
    hash.update(body);
  }
  const digest = 'sha256:' + hash.digest('hex');
  cache.set(key, { signature, digest });
  return digest;
}

/** 测试用：清掉摘要缓存。 */
export function resetTreeDigestCache(): void {
  cache.clear();
}
