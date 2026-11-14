// 下载到临时文件再改名：中断或超限时不留半成品，也不覆盖旧文件。只供本包内部使用。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goPathError } from '../gofmt';

export const downloadLimit = 512 << 20;

/** os.CreateTemp(dir, prefix+"*")：独占创建，返回路径与文件描述符。 */
export function createTemp(dir: string, prefix: string): { file: string; fd: number } {
  for (let i = 0; ; i++) {
    const file = path.join(dir, prefix + crypto.randomBytes(4).readUInt32BE(0));
    try {
      return { file, fd: fs.openSync(file, 'wx', 0o600) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && i < 10000) continue;
      throw new Error(goPathError('open', path.join(dir, prefix + '*'), err), { cause: err });
    }
  }
}

/**
 * 把 body 写进 dest 同目录的临时文件（最多 limit+1 字节），成功后改名到 dest。
 * 读取出错、写不进去、零字节或超过 limit 时抛 failure，临时文件删除。
 */
export async function saveStream(body: AsyncIterable<Uint8Array>, dest: string, prefix: string, failure: string): Promise<void> {
  const { file, fd } = createTemp(path.dirname(dest), prefix);
  let ok = false;
  try {
    let n = 0;
    let failed = false;
    try {
      for await (const chunk of body) {
        let buf = Buffer.from(chunk);
        if (n + buf.length > downloadLimit + 1) buf = buf.subarray(0, downloadLimit + 1 - n);
        fs.writeSync(fd, buf);
        n += buf.length;
        if (n > downloadLimit) break;
      }
    } catch {
      failed = true;
    }
    let closeFailed = false;
    try {
      fs.closeSync(fd);
    } catch {
      closeFailed = true;
    }
    if (failed || closeFailed || n === 0 || n > downloadLimit) throw new Error(failure);
    fs.renameSync(file, dest);
    ok = true;
  } finally {
    if (!ok) fs.rmSync(file, { force: true });
  }
}
