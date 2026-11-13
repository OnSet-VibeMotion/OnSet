// 校验相关测试共用的辅助（发布插件的测试也用）。不从 index.ts 导出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { onTestFinished } from 'vitest';
import * as assets from '../assets';

/** t.TempDir()：测试结束时删掉。 */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-validate-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 仓库根下的 assets/。 */
export function repoAssets(...parts: string[]): string {
  return path.join(assets.assetsBase(), 'assets', ...parts);
}

/** 共用素材 assets/shared/…。 */
export function sharedSource(...parts: string[]): string {
  return repoAssets('shared', ...parts);
}

export const read = (file: string) => fs.readFileSync(file, 'utf8');

/** 只替换第一处；找不到时原样返回。 */
export function replaceOnce(body: string, old: string, replacement: string): string {
  const index = body.indexOf(old);
  if (index < 0) return body;
  return body.slice(0, index) + replacement + body.slice(index + old.length);
}

/** 写一张指定尺寸的灰度 PNG（对应 Go 测试里的 png.Encode(image.NewGray(...))）。 */
export function writeImage(file: string, w: number, h: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc((w + 1) * h);
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** 期待 fn 抛错并返回错误；不抛时让测试失败。 */
export function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('期待报错，实际没有报错');
}
