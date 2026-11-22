import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * 超长工具输出的隔离归档目录（不含凭据，安全模式下只读放行给同一会话的内置制作人）。
 * 给出真实 sessionID 时仅按会话 ID 哈希分目录：同一会话跨进程续接、甚至项目目录移动后仍可读取历史归档，
 * 同时不同会话之间严格隔离；未给会话 ID 时退回当前进程 PID 目录。
 */
export function toolOutputArchiveDir(sessionID = ''): string {
  const s = sessionID.trim();
  if (s !== '') {
    const key = createHash('sha256').update(s).digest('hex').slice(0, 24);
    return path.join(os.tmpdir(), 'onset-tool-outputs', 'session-' + key);
  }
  return path.join(os.tmpdir(), 'onset-tool-outputs', 'pid-' + String(process.pid));
}
