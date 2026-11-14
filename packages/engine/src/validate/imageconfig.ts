// image.DecodeConfig 的最小复刻：只认 PNG 与 JPEG（Go 版只注册了这两种解码器）。
//
// 只读到宽高为止，错误文案照 Go 的 image/png、image/jpeg 写。
import fs from 'node:fs';

export interface ImageConfig {
  width: number;
  height: number;
  format: string;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class Reader {
  offset = 0;
  constructor(private readonly data: Buffer) {}

  /** io.ReadFull：一个字节都没读到是 EOF，读到一部分是 unexpected EOF。 */
  readFull(n: number): Buffer {
    const remaining = this.data.length - this.offset;
    if (remaining <= 0 && n > 0) throw new Error('EOF');
    if (remaining < n) throw new Error('unexpected EOF');
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
}

/** 解码出来的错误一律把 EOF 改写成 unexpected EOF（png 与 jpeg 的 DecodeConfig 都这么做）。 */
function unexpected(err: unknown): Error {
  const message = (err as Error).message;
  return new Error(message === 'EOF' ? 'unexpected EOF' : message);
}

function pngConfig(data: Buffer): ImageConfig {
  const r = new Reader(data);
  try {
    if (!r.readFull(8).equals(pngSignature)) throw new Error('png: invalid format: not a PNG file');
    let paletted = false;
    let seenIHDR = false;
    let width = 0;
    let height = 0;
    for (;;) {
      const header = r.readFull(8);
      const length = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString('latin1');
      if (length > 0x7fffffff) throw new Error('png: invalid format: chunk length overflow');
      if (!seenIHDR && type !== 'IHDR') throw new Error('png: invalid format: chunk out of order');
      if (type === 'IHDR') {
        if (seenIHDR) throw new Error('png: invalid format: chunk out of order');
        if (length !== 13) throw new Error('png: invalid format: bad IHDR length');
        const body = r.readFull(13);
        if (body[10] !== 0) throw new Error('png: unsupported feature: compression method');
        if (body[11] !== 0) throw new Error('png: unsupported feature: filter method');
        if (body[12] !== 0 && body[12] !== 1) throw new Error('png: invalid format: invalid interlace method');
        const w = body.readInt32BE(0);
        const h = body.readInt32BE(4);
        if (w <= 0 || h <= 0) throw new Error('png: invalid format: non-positive dimension');
        if (w * h > 0x7fffffffffff) throw new Error('png: unsupported feature: dimension overflow');
        const depth = body[8];
        const colorType = body[9];
        const valid: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
        if (!(valid[colorType] ?? []).includes(depth)) {
          throw new Error(`png: unsupported feature: bit depth ${depth}, color type ${colorType}`);
        }
        paletted = colorType === 3;
        width = w;
        height = h;
        const crc = r.readFull(4).readUInt32BE(0);
        if (crc !== crc32(Buffer.concat([header.subarray(4, 8), body]))) throw new Error('png: invalid format: invalid checksum');
        seenIHDR = true;
        if (!paletted) break;
        continue;
      }
      if (type === 'PLTE') {
        r.readFull(length);
        r.readFull(4);
        break;
      }
      if (type === 'IDAT' || type === 'IEND') throw new Error('png: invalid format: chunk out of order');
      r.readFull(length);
      r.readFull(4);
    }
    return { width, height, format: 'png' };
  } catch (err) {
    throw unexpected(err);
  }
}

function jpegConfig(data: Buffer): ImageConfig {
  const r = new Reader(data);
  try {
    const soi = r.readFull(2);
    if (soi[0] !== 0xff || soi[1] !== 0xd8) throw new Error('invalid JPEG format: missing SOI marker');
    for (;;) {
      let marker = r.readFull(2);
      while (marker[0] !== 0xff) {
        // 标记之间的多余字节：Go 会跳过直到下一个 0xff。
        marker = Buffer.from([marker[1], r.readFull(1)[0]]);
      }
      let code = marker[1];
      while (code === 0xff) code = r.readFull(1)[0];
      if (code === 0x00) continue;
      if (code >= 0xd0 && code <= 0xd7) continue; // RST
      if (code === 0xd9) throw new Error('unexpected EOF');
      const length = r.readFull(2).readUInt16BE(0) - 2;
      if (length < 0) throw new Error('invalid JPEG format: short segment length');
      if (code === 0xc0 || code === 0xc1 || code === 0xc2) {
        const body = r.readFull(length);
        if (body.length < 6) throw new Error('invalid JPEG format: SOF has wrong length');
        const height = body.readUInt16BE(1);
        const width = body.readUInt16BE(3);
        return { width, height, format: 'jpeg' };
      }
      if (code === 0xc3) throw new Error('unsupported JPEG feature: lossless mode');
      if (code >= 0xc5 && code <= 0xcf && code !== 0xc8 && code !== 0xcc) {
        throw new Error('unsupported JPEG feature: unknown marker');
      }
      r.readFull(length);
    }
  } catch (err) {
    throw unexpected(err);
  }
}

/** image.DecodeConfig(file)：按文件头识别格式，认不出时报「image: unknown format」。 */
export function decodeConfig(file: string): ImageConfig {
  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch (err) {
    // Go 里目录能打开，读的时候失败，嗅探不出格式。
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') throw new Error('image: unknown format');
    throw err;
  }
  if (data.length >= 8 && data.subarray(0, 8).equals(pngSignature)) return pngConfig(data);
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) return jpegConfig(data);
  throw new Error('image: unknown format');
}
