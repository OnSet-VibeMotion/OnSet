// 移植自 internal/beat/track.go。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goQuote } from '../gofmt';
import type { Media } from '../mediaprobe';
import type { StructType } from './jsondecode';
import { Store, TrackFile, hashBytes, hashFile, isLocal, isNotExist, loadConfig, localPath, pathError, readJSON, statPath, wrapError, writeJSON } from './store';

/** Track 是导入项目的那首音乐。网格、镜头 cue 都绑定它的摘要。 */
export interface Track {
  audio: string;
  audio_sha256: string;
  duration_seconds: number;
  source: string;
}

const trackType: StructType = {
  kind: 'struct',
  goName: 'beat.Track',
  name: 'Track',
  fields: [
    ['audio', 'string'],
    ['audio_sha256', 'string'],
    ['duration_seconds', 'float'],
    ['source', 'string'],
  ],
};

export function trackToJSON(t: Track): unknown {
  return { audio: t.audio, audio_sha256: t.audio_sha256, duration_seconds: t.duration_seconds, source: t.source };
}

/** MediaChecker 是导入时用到的媒体操作；mediaprobe.Toolchain 满足它。 */
export interface MediaChecker {
  probe(file: string): Media;
  decode(file: string): void;
}

const audioExtensions = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus']);

/** filepath.Ext。 */
function ext(file: string): string {
  const base = path.basename(file);
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i) : '';
}

/**
 * Import 把音乐复制进项目并记录摘要与实测时长（Go 的 beat.Import；import 是 JS 保留字）。
 *
 * 已导入另一首音乐时默认拒绝：换歌会让已确认的网格和所有镜头 cue 失效，
 * 这种事要用户明确说（replace）。同一首重复导入是幂等的。
 */
export function importTrack(root: string, source: string, media: MediaChecker, replace: boolean): Track {
  loadConfig(root);
  let info: fs.Stats | undefined;
  try {
    info = fs.statSync(source);
  } catch {
    info = undefined;
  }
  if (!info || !info.isFile()) throw new Error(`找不到音乐文件：${source}`);
  const extension = ext(source).toLowerCase();
  if (!audioExtensions.has(extension)) {
    throw new Error(`不支持的音乐格式 ${goQuote(extension)}：可用 wav、mp3、m4a、aac、flac、ogg、opus`);
  }
  const probed = media.probe(source);
  if (probed.audio === null || probed.video !== null) throw new Error(`音乐文件必须只有音轨：${source}`);
  if (probed.duration_seconds <= 0 || !Number.isFinite(probed.duration_seconds)) throw new Error(`无法确定音乐时长：${source}`);
  try {
    media.decode(source);
  } catch (err) {
    throw wrapError(`音乐无法完整解码：${(err as Error).message}`, err);
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(source);
  } catch (err) {
    throw pathError('open', source, err);
  }
  const sum = hashBytes(body);
  // 文件名带内容摘要：替换时新旧音乐不会同名，可以先写新文件、再改记录、
  // 最后删旧文件，任何一步失败都不会让 track.json 指向一个已被删掉或覆盖的文件。
  const track: Track = { audio: 'music-' + sum.slice(0, 12) + extension, audio_sha256: sum, duration_seconds: probed.duration_seconds, source: path.basename(source) };
  let stale = '';
  let existing: Track | undefined;
  let loadError: unknown;
  try {
    existing = loadTrack(root);
  } catch (err) {
    loadError = err;
  }
  if (existing) {
    if (existing.audio_sha256 === track.audio_sha256) return existing;
    if (!replace) throw new Error(`项目已导入 ${existing.source}；换歌会让已确认的节拍网格与镜头 cue 全部失效，确认后加 --replace`);
    if (existing.audio !== track.audio) stale = existing.audio;
  } else if (!isNotExist(loadError) && !replace) {
    throw new Error(`现有 ${TrackFile} 不可用（${(loadError as Error).message}）；确认要覆盖时加 --replace`);
  }
  const dest = localPath(root, Store + '/' + track.audio);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  atomicWrite(dest, body, 0o644);
  writeJSON(localPath(root, TrackFile), trackToJSON(track));
  if (stale !== '') {
    try {
      fs.rmSync(localPath(root, Store + '/' + stale));
    } catch {
      // 旧文件删不掉不影响新记录。
    }
  }
  return track;
}

/**
 * LoadTrack 读取导入记录并核对音乐文件没有被替换。
 * 记录不存在时抛出的错误满足 isNotExist(err)（Go 的 errors.Is(err, fs.ErrNotExist)）。
 */
export function loadTrack(root: string): Track {
  const record = localPath(root, TrackFile);
  statPath(record);
  const track = readJSON<Track>(record, trackType);
  if (!isLocal(track.audio) || track.audio.includes('/')) throw new Error(`${TrackFile} 的 audio 必须是 ${Store} 下的文件名`);
  const audio = localPath(root, Store + '/' + track.audio);
  let sum: string;
  try {
    sum = hashFile(audio);
  } catch (err) {
    throw wrapError(`找不到已导入的音乐：${(err as Error).message}`, err);
  }
  if (sum !== track.audio_sha256) throw new Error(`音乐文件已被改动，与 ${TrackFile} 记录的摘要不符；请重新 am beat import`);
  return track;
}

/** AudioPath 返回已导入音乐的绝对路径。 */
export function trackAudioPath(track: Track, root: string): string {
  return localPath(root, Store + '/' + track.audio);
}
