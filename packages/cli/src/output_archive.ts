import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 超长工具输出的隔离归档目录（不含凭据，安全模式下只读放行给同一会话的内置制作人）。
 * 给出 workdir / sessionID 时按会话归属哈希分目录，同一会话跨进程续接仍可读取历史归档，
 * 且不同项目或不同会话之间互相隔离；未给会话范围时退回当前进程 PID 目录。
 */
export function toolOutputArchiveDir(workdir = '', sessionID = ''): string {
  const w = workdir.trim();
  const s = sessionID.trim();
  if (w !== '' || s !== '') {
    let real = w;
    if (w !== '') {
      try {
        real = fs.realpathSync(w);
      } catch {
        real = path.resolve(w);
      }
    }
    const key = createHash('sha256').update(real).update('\0').update(s).digest('hex').slice(0, 24);
    return path.join(os.tmpdir(), 'onset-tool-outputs', 'session-' + key);
  }
  return path.join(os.tmpdir(), 'onset-tool-outputs', 'pid-' + String(process.pid));
}
