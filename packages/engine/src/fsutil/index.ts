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
