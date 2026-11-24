// 文件系统相关的共享工具。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 删除自有的临时目录。Electron 的 Windows 运行时不会像旧版 Node 一样清除只读文件（git 对象）的属性。 */
export function removeTree(dir: string): void {
  const options = { recursive: true, force: true, ...(process.platform === 'win32' ? { maxRetries: 3 } : {}) };
  try {
    fs.rmSync(dir, options);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) throw err;
  }
  const makeWritable = (file: string) => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    // 不跟随目录链接或文件链接，不能修改临时目录以外的目标。
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file)) makeWritable(path.join(file, entry));
    } else if (stat.isFile() && (stat.mode & 0o200) === 0) {
      fs.chmodSync(file, stat.mode | 0o200);
    }
  };
  makeWritable(dir);
  fs.rmSync(dir, options);
}

/** 以原子方式写入文件：先写同目录的临时文件，再 rename 到目标路径；失败时清理临时文件，不留半成品。 */
export function atomicWrite(file: string, data: string | Uint8Array, mode = 0o644): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.onset-tmp-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    // Windows 上文件被预览、轮询或扫描短暂占用时，替换会返回共享冲突。
    // 保持同一个临时文件和原子替换，不先删旧文件；永久错误仍保留旧内容并报错。
    for (let retry = 0; ; retry++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || retry >= 6) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * 2 ** retry);
      }
    }
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败不掩盖原错误。
    }
    throw new Error(`写入 ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * 写出版本化 JSONL 索引文件（`<prefix>.<sha256前12位>.index.jsonl`），
 * 避免大目录直接塞进 MCP 工具返回值撑爆上下文。
 */
export function writeJsonlIndex(
  dir: string,
  prefix: string,
  records: readonly unknown[],
): { path: string; version: string; count: number } {
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const body = records.map((row) => JSON.stringify(row)).join('\n') + (records.length > 0 ? '\n' : '');
  const version = crypto.createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 12);
  const file = path.join(dir, `${safePrefix}.${version}.index.jsonl`);
  if (!fs.existsSync(file)) atomicWrite(file, body, 0o644);
  return { path: file, version, count: records.length };
}

export { goPathError } from '../gofmt';
export { ProjectSkippedDirs, walkDir } from './walk';
