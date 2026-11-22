import os from 'node:os';
import path from 'node:path';

/** 超长工具输出的进程隔离归档目录（不含凭据，安全模式下只读放行给内置制作人）。 */
export function toolOutputArchiveDir(): string {
  return path.join(os.tmpdir(), 'onset-tool-outputs', String(process.pid));
}
