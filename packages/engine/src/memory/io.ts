// 本包内部的文件读写辅助（Go 版 store.go 的 writeJSON / readJSON 与 episode.go 的拷贝函数）。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';

/** json.MarshalIndent(value, "", "  ") 加换行，原子写出；目录不存在时先建。 */
export function writeJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, marshalIndent(value) + '\n', 0o644);
}

/** 读出并解析 JSON；文件不存在或解析失败时抛错（ENOENT 保留 code，调用方据此区分）。 */
export function readJSON(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function isNotExist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** os.ReadDir：按文件名排序；目录不存在时返回 null。 */
export function readDirSorted(dir: string): fs.Dirent[] | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotExist(err)) return null;
    throw err;
  }
  return entries.sort((a, b) => compareBytes(a.name, b.name));
}

export function exists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** copyFile：建好目标目录后拷贝（权限 0644）。 */
export function copyFile(source: string, target: string): void {
  const body = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, { mode: 0o644 });
}

/**
 * filepath.WalkDir 的同步版本：按文件名字典序深度优先遍历，fn 返回 'skip' 时跳过该目录
 * （对文件返回 'skip' 时跳过同目录剩下的条目，与 filepath.SkipDir 相同）。
 * 根目录读不出来时把错误交给 fn（entry 为 null），fn 返回 'skip' 则当作没有。
 */
export type WalkResult = void | 'skip';

export function walkDir(root: string, fn: (file: string, entry: fs.Dirent | null, isDir: boolean, err: unknown) => WalkResult): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(root);
  } catch (err) {
    const r = fn(root, null, false, err);
    if (r === 'skip') return;
    throw err;
  }
  const visit = (dir: string): WalkResult => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
    } catch (err) {
      const r = fn(dir, null, true, err);
      if (r === 'skip') return;
      throw err;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const isDir = entry.isDirectory();
      const r = fn(file, entry, isDir, null);
      if (r === 'skip') {
        if (isDir) continue;
        return;
      }
      if (isDir) visit(file);
    }
  };
  const r = fn(root, null, stat.isDirectory(), null);
  if (r === 'skip') return;
  if (stat.isDirectory()) visit(root);
}

/** copyTree：把 source 下的目录与普通文件原样拷进 target。 */
export function copyTree(source: string, target: string): void {
  walkDir(source, (file, entry, isDir, err) => {
    if (err) throw err;
    const rel = path.relative(source, file);
    if (isDir) {
      fs.mkdirSync(path.join(target, rel), { recursive: true });
      return;
    }
    if (entry && !entry.isFile()) return;
    copyFile(file, path.join(target, rel));
  });
}
