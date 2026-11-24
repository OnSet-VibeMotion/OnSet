/**
 * 纯 Node 零依赖安全 ZIP 读写器（仅 STORE / DEFLATE），
 * 拒绝符号链接、目录穿越、Windows 保留名、大小写/NFC 碰撞、ZIP64、加密与数据区重叠。
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipLimits {
  maxBytes: number;
  maxFiles: number;
}

export const DefaultZipLimits: ZipLimits = {
  maxBytes: 500 * 1024 * 1024,
  maxFiles: 5000,
};

const WindowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** 判断路径单段是否包含跨平台危险字符或 Windows 保留名。 */
export function isUnsafeZipSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return true;
  if (/[\\:*?"<>|\x00-\x1f\x7f]/.test(segment)) return true;
  if (segment.endsWith(' ') || segment.endsWith('.')) return true;
  return WindowsReserved.test(segment);
}

/** 校验并规范化 ZIP 相对路径（仅允许 / 分隔）。 */
export function assertSafeZipPath(name: string): string {
  const clean = name.endsWith('/') ? name.slice(0, -1) : name;
  if (!clean || clean.length > 400 || clean.startsWith('/')) {
    throw new Error(`归档包含非法路径：${name}`);
  }
  for (const part of clean.split('/')) {
    if (isUnsafeZipSegment(part)) throw new Error(`归档包含跨平台不安全路径段：${name}`);
  }
  return clean;
}

const IncompressibleExt =
  /\.(?:mp4|mov|webm|mkv|mp3|aac|m4a|ogg|opus|flac|png|jpg|jpeg|webp|gif|woff2|zip|gz|br|zst)$/i;

/** 将文件映射打包为标准 UTF-8 ZIP 字节流（按键字典序输出，完全确定性）。 */
export function buildZip(files: ReadonlyMap<string, Buffer>, limits: ZipLimits = DefaultZipLimits): Buffer {
  if (files.size > limits.maxFiles) throw new Error(`归档文件数超过上限（${limits.maxFiles}）`);
  const sortedNames = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const seenKeys = new Set<string>();
  let totalBytes = 0;

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const rawPath of sortedNames) {
    const clean = assertSafeZipPath(rawPath);
    const key = clean.normalize('NFC').toLowerCase();
    if (seenKeys.has(key)) throw new Error(`归档存在大小写或规范化冲突路径：${clean}`);
    seenKeys.add(key);

    const content = files.get(rawPath)!;
    totalBytes += content.length;
    if (totalBytes > limits.maxBytes) throw new Error(`归档总大小超过上限（${limits.maxBytes} 字节）`);

    const nameBytes = Buffer.from(clean, 'utf8');
    const checksum = crc32(content);
    let method = 0;
    let payload: Buffer = content;
    if (content.length >= 64 && !IncompressibleExt.test(clean)) {
      const deflated = deflateRawSync(content, { level: 6 });
      if (deflated.length < content.length) {
        method = 8;
        payload = deflated;
      }
    }

    // UTF-8 标志位（bit 11 = 0x0800）
    const flags = 0x0800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix + 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum >>> 0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(sortedNames.length, 8);
  eocd.writeUInt16LE(sortedNames.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 严格解析并校验 ZIP 字节流，返回 相对路径 → 文件内容 的映射。 */
export function readZip(data: Buffer, limits: ZipLimits = DefaultZipLimits): Map<string, Buffer> {
  const fail = (reason: string): never => {
    throw new Error(`无效或不受支持的 ZIP 归档：${reason}`);
  };
  if (data.length > limits.maxBytes || data.length < 22) return fail('文件大小超出限制或结构残缺');

  let end = data.length - 22;
  for (; end >= Math.max(0, data.length - 65557); end--) {
    if (data.readUInt32LE(end) === 0x06054b50 && end + 22 + data.readUInt16LE(end + 20) === data.length) break;
  }
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50) return fail('找不到 EOCD 记录');

  const count = data.readUInt16LE(end + 10);
  const size = data.readUInt32LE(end + 12);
  const start = data.readUInt32LE(end + 16);
  if (
    data.readUInt32LE(end + 4) !== 0 ||
    data.readUInt16LE(end + 8) !== count ||
    count > limits.maxFiles + 1000 ||
    start + size !== end
  ) {
    return fail('不支持分卷、ZIP64 或目录区偏移异常');
  }

  const files = new Map<string, Buffer>();
  const seenNames = new Set<string>();
  const ranges: [number, number][] = [];
  let offset = start;
  let expanded = 0;

  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) return fail('中央目录记录损坏');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const crc = data.readUInt32LE(offset + 16);
    const compressed = data.readUInt32LE(offset + 20);
    const bytes = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extra = data.readUInt16LE(offset + 30);
    const comment = data.readUInt16LE(offset + 32);
    const mode = data.readUInt32LE(offset + 38) >>> 16;
    const local = data.readUInt32LE(offset + 42);

    if ((flags & ~(method === 8 ? 0x80e : 0x808)) !== 0 || (method !== 0 && method !== 8))
      return fail('不支持加密或非 STORE/DEFLATE 压缩方式');
    if (data.readUInt16LE(offset + 34) !== 0) return fail('不支持多磁盘归档');
    const fileType = mode & 0xf000;
    if (fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) return fail('包含符号链接或特殊设备文件');
    if (offset + 46 + nameLength + extra + comment > end || local + 30 > start) return fail('目录记录越界');

    const rawName = data.subarray(offset + 46, offset + 46 + nameLength);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(rawName);
    } catch {
      return fail('文件名不是合法 UTF-8');
    }
    const clean = assertSafeZipPath(name);
    const key = clean.normalize('NFC').toLowerCase();
    if (seenNames.has(key)) return fail(`重复或大小写冲突路径：${clean}`);
    seenNames.add(key);

    if (
      data.readUInt32LE(local) !== 0x04034b50 ||
      data.readUInt16LE(local + 6) !== flags ||
      data.readUInt16LE(local + 8) !== method
    ) {
      return fail(`本地文件头与中央目录不一致：${clean}`);
    }
    const localNameLength = data.readUInt16LE(local + 26);
    const localExtra = data.readUInt16LE(local + 28);
    const payload = local + 30 + localNameLength + localExtra;
    if (payload + compressed > start || !data.subarray(local + 30, local + 30 + localNameLength).equals(rawName)) {
      return fail(`本地文件数据区越界或路径不一致：${clean}`);
    }
    if ((flags & 8) === 0) {
      if (
        data.readUInt32LE(local + 14) !== crc ||
        data.readUInt32LE(local + 18) !== compressed ||
        data.readUInt32LE(local + 22) !== bytes
      ) {
        return fail(`本地文件头摘要与中央目录不符：${clean}`);
      }
    }

    ranges.push([local, payload + compressed]);
    expanded += bytes;
    if (expanded > limits.maxBytes) return fail('解压后体积超过 500 MB 上限');

    const packed = data.subarray(payload, payload + compressed);
    const unpacked =
      method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, bytes) });
    if (unpacked.length !== bytes || crc32(unpacked) >>> 0 !== crc) return fail(`CRC32 校验失败：${clean}`);
    if (name.endsWith('/')) {
      if (bytes !== 0) return fail(`目录条目含非空数据：${clean}`);
    } else {
      files.set(clean, unpacked);
    }
    offset += 46 + nameLength + extra + comment;
  }

  if (offset !== end || files.size > limits.maxFiles) return fail('归档条目数超限或尾部异常');
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) return fail('检测到数据区重叠（疑似恶意归档）');
  }

  // 防止文件与目录同名冲突
  const fileKeys = new Set([...files.keys()].map((n) => n.normalize('NFC').toLowerCase()));
  for (const name of files.keys()) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length > 0) {
      if (fileKeys.has(parts.join('/').normalize('NFC').toLowerCase())) return fail(`文件与目录路径冲突：${name}`);
      parts.pop();
    }
  }
  return files;
}
