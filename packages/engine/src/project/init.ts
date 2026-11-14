import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goPathError } from '../gofmt';

export interface InitResult {
  created: number;
  unchanged: number;
}

/**
 * 一棵只读源树，路径相对树根、用 / 分隔，对应 Go 的 fs.FS。
 * assets.AssetTree 天然满足；测试里用 Map 造的树（对应 fstest.MapFS）也满足。
 */
export interface SourceTree {
  /** 全部文件（不含目录），按 fs.WalkDir 的词法顺序。 */
  walkFiles(): string[];
  readFile(rel: string): Buffer;
}

interface Asset {
  name: string;
  body: Buffer;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotExist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/** io/fs.ValidPath：不带根、斜杠分隔、不含空元素与 . / ..（单独的 "." 合法）。 */
export function validPath(name: string): boolean {
  if (name === '.') return true;
  if (name === '') return false;
  for (const elem of name.split('/')) {
    if (elem === '' || elem === '.' || elem === '..') return false;
  }
  return true;
}

/**
 * initialize 把若干棵源树叠加拷贝进项目目录。
 *
 * 每棵源树的内部路径就是它在项目根下的目标路径，不做任何改写。多棵树写入同一
 * 路径视为素材组织错误并直接报错——静默覆盖会让「哪棵树赢」取决于参数顺序。
 */
export function initialize(target: string, ...sources: SourceTree[]): InitResult {
  return initializeWithFiles(target, null, ...sources);
}

/**
 * initializeWithFiles atomically adds optional mode configuration to the scaffold.
 *
 * extra 对应 Go 的 map[string][]byte；Go 的 map 遍历无序，这里按插入顺序。
 */
export function initializeWithFiles(
  target: string,
  extra: Map<string, Uint8Array> | Record<string, Uint8Array> | null,
  ...sources: SourceTree[]
): InitResult {
  target = path.resolve(target);
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new Error(`创建项目目录: ${goPathError('mkdir', target, err)}`, { cause: err });
  }
  const assets: Asset[] = [];
  const seen = new Set<string>();
  const extraEntries = extra instanceof Map ? [...extra.entries()] : Object.entries(extra ?? {});
  for (const [name, body] of extraEntries) {
    if (!validPath(name)) throw new Error(`无效模板路径：${name}`);
    assets.push({ name, body: Buffer.from(body) });
    seen.add(name);
  }
  for (const source of sources) {
    try {
      for (const file of source.walkFiles()) {
        if (seen.has(file)) throw new Error(`多棵源树写入同一路径：${file}`);
        seen.add(file);
        assets.push({ name: file, body: source.readFile(file) });
      }
    } catch (err) {
      throw new Error(`读取内置项目模板: ${errText(err)}`, { cause: err });
    }
  }

  const result: InitResult = { created: 0, unchanged: 0 };
  for (const item of assets) {
    const destination = path.join(target, ...item.name.split('/'));
    rejectSymlinkPath(target, destination);
    let existing: Buffer | null = null;
    try {
      existing = fs.readFileSync(destination);
    } catch (err) {
      if (!isNotExist(err)) {
        const op = (err as NodeJS.ErrnoException).code === 'EISDIR' ? 'read' : 'open';
        throw new Error(`检查目标文件 ${destination}: ${goPathError(op, destination, err)}`, { cause: err });
      }
    }
    if (existing !== null) {
      if (!existing.equals(item.body)) throw new Error(`目标文件已存在且内容不同：${destination}`);
      result.unchanged++;
    }
  }

  const created: string[] = [];
  const rollback = () => {
    for (let i = created.length - 1; i >= 0; i--) {
      try {
        fs.rmSync(created[i], { force: true });
      } catch {
        // 回滚尽力而为，与 Go 版忽略 os.Remove 的错误一致。
      }
    }
  };
  for (const item of assets) {
    const destination = path.join(target, ...item.name.split('/'));
    if (fs.existsSync(destination)) continue;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    } catch (err) {
      rollback();
      throw new Error(goPathError('mkdir', path.dirname(destination), err), { cause: err });
    }
    const tmpName = path.join(path.dirname(destination), `.onset-init-${crypto.randomBytes(5).readUInt32BE(0)}`);
    try {
      fs.writeFileSync(tmpName, item.body, { mode: 0o600, flag: 'wx' });
      fs.chmodSync(tmpName, 0o644);
      fs.renameSync(tmpName, destination);
    } catch (err) {
      try {
        fs.rmSync(tmpName, { force: true });
      } catch {
        // 忽略。
      }
      rollback();
      throw new Error(`写入 ${destination}: ${errText(err)}`, { cause: err });
    }
    created.push(destination);
    result.created++;
  }
  return result;
}

/** 目标路径上任一层是符号链接、或父路径不是目录，都拒绝写入。 */
export function rejectSymlinkPath(root: string, destination: string): void {
  const relative = path.relative(root, destination);
  if (relative === '..' || path.isAbsolute(relative)) {
    throw new Error(`模板路径逃出项目目录：${destination}`);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let info: fs.Stats;
    try {
      info = fs.lstatSync(current);
    } catch (err) {
      if (isNotExist(err)) return;
      throw new Error(`检查模板路径 ${current}: ${goPathError('lstat', current, err)}`, { cause: err });
    }
    if (info.isSymbolicLink()) throw new Error(`模板路径不得包含符号链接：${current}`);
    if (current !== destination && !info.isDirectory()) throw new Error(`模板父路径不是目录：${current}`);
  }
}
