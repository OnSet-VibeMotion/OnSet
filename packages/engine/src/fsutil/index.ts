// 文件系统相关的共享工具。移植自 internal/fsutil。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 以原子方式写入文件：先写同目录的临时文件，再 rename 到目标路径；失败时清理临时文件，不留半成品。 */
export function atomicWrite(file: string, data: string | Uint8Array, mode = 0o644): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.am-tmp-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
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
 * Go 的 *fs.PathError 文案：「open /a/b: no such file or directory」。Go 版把这类错误原样拼进中文提示里
 * （例如「读取风格描述文件失败：open x: no such file or directory」），TS 版照样拼，用户与测试看到的文字才一致。
 */
export function goPathError(err: unknown, op: string, file: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const reasons: Record<string, string> = {
    ENOENT: 'no such file or directory',
    EACCES: 'permission denied',
    EPERM: 'operation not permitted',
    EISDIR: 'is a directory',
    ENOTDIR: 'not a directory',
    EEXIST: 'file exists',
    ENOTEMPTY: 'directory not empty',
  };
  const reason = (code && reasons[code]) ?? (err instanceof Error ? err.message : String(err));
  return `${op} ${file}: ${reason}`;
}
