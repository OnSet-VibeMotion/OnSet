/**
 * Freesound 音效本地落盘安全工具与 audio-manifest.json 清单读写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { type AudioManifest, SfxAssetsRelDir, SfxManifestFile } from './types';

export const AllowedAudioExts = new Set(['.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff', '.m4a']);

function lstatIfPresent(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 校验 <projectDir>/assets/sfx 及其已存在父目录均不为符号链接（含悬空符号链接），并返回项目真实根下的音效目录路径。 */
export function assertSafeSfxDir(projectDir: string): string {
  const realRoot = fs.realpathSync(path.resolve(projectDir));
  let cur = realRoot;
  for (const part of SfxAssetsRelDir.split('/')) {
    cur = path.join(cur, part);
    const st = lstatIfPresent(cur);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) {
      throw new Error(`音效目录不允许是符号链接或非目录：${cur}`);
    }
  }
  const manifestPath = path.join(cur, SfxManifestFile);
  const mst = lstatIfPresent(manifestPath);
  if (mst && (mst.isSymbolicLink() || !mst.isFile())) {
    throw new Error(`音频清单不允许是符号链接：${manifestPath}`);
  }
  return cur;
}

/** 确认目标文件位于 sfxDir 内且从 sfxDir 到目标的每一级路径段均不含符号链接（防止中间目录链接写穿项目边界）。 */
export function isSafeSfxFileInside(sfxDir: string, candidateAbs: string): boolean {
  const rel = path.relative(sfxDir, candidateAbs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep).filter(Boolean);
  let cur = sfxDir;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    const st = lstatIfPresent(cur);
    if (!st || st.isSymbolicLink()) return false;
    if (i < parts.length - 1 ? !st.isDirectory() : !st.isFile()) return false;
  }
  try {
    const realParent = fs.realpathSync(path.dirname(candidateAbs));
    const parentRel = path.relative(sfxDir, realParent);
    return !parentRel.startsWith('..') && !path.isAbsolute(parentRel);
  } catch {
    return false;
  }
}

/** 音频清单路径：<projectDir>/assets/sfx/audio-manifest.json。 */
export function audioManifestPath(projectDir: string): string {
  return path.join(path.resolve(projectDir), SfxAssetsRelDir, SfxManifestFile);
}

/** 读取项目音频清单；尚不存在时返回空清单。 */
export function readAudioManifest(projectDir: string): AudioManifest {
  const dir = assertSafeSfxDir(projectDir);
  const file = path.join(dir, SfxManifestFile);
  if (!fs.existsSync(file)) return { version: 1, entries: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AudioManifest>;
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return { version: 1, entries: [...entries].sort((a, b) => compareBytes(a.id, b.id)) };
}

/** 原子写出音频清单（gojson 固定格式）。 */
export function writeAudioManifest(projectDir: string, manifest: AudioManifest): string {
  const dir = assertSafeSfxDir(projectDir);
  const file = path.join(dir, SfxManifestFile);
  const normalized: AudioManifest = {
    version: 1,
    entries: [...manifest.entries].sort((a, b) => compareBytes(a.id, b.id)),
  };
  atomicWrite(file, `${marshalIndent(normalized, '  ', false)}\n`, 0o644);
  return file;
}

/** 清洗音效文件名前缀并拒绝任何路径穿越字符。 */
export function safeSlug(raw: string): string {
  if (raw.includes('\0') || raw.includes('..') || raw.includes('/') || raw.includes('\\')) {
    throw new Error(`非法音效文件名（禁止路径穿越字符）：${raw}`);
  }
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'sfx';
}

/** 根据文件魔数优先识别音频容器扩展名，未命中时沿用 fallbackExt。 */
export function detectExtFromContent(buf: Buffer, fallbackExt: string): string {
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return '.wav';
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'OggS') return '.ogg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'fLaC') return '.flac';
  return fallbackExt;
}
