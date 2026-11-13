// 移植自 internal/song/handoff.go。
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { formatFixed, goPathError } from '../gofmt';
import type { Toolchain } from '../mediaprobe';
import { importCandidate } from './generate';
import type { Writer } from './platforms';
import { bytesHash, digest, hashFile, idPattern, loadCandidate, loadConfig, localPath, readJSON, Store, withLock, writeJSON } from './store';
import { lyricLines } from './timeline';
import { webHandoffSchema, webHandoffToJSON, type Candidate, type Config, type WebHandoff } from './types';

const handoffState = Store + '/web-handoff.json';

function handoffDir(root: string, id: string): string {
  if (id.length !== 64 || !/^[0-9a-f]*$/.test(id)) throw new Error('网页交接 ID 无效');
  return localPath(root, path.join(Store, 'handoffs', id));
}

function handoffStyle(c: Config): string {
  return `${c.style}\n演唱语言：${c.language}\n目标时长：${formatFixed(c.target_seconds, 0)} 秒（以实际生成音频为准）\n目标 BPM：${c.bpm}\n单人演唱，咬字清楚，伴奏不要盖过人声。按提供的歌词及顺序演唱，保留重复副歌，不自动改词或新增知识内容。\n`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface LoadedHandoff {
  handoff: WebHandoff;
  /** 交接快照目录。 */
  dir: string;
}

export function loadHandoff(root: string): LoadedHandoff {
  const p = localPath(root, handoffState);
  let h: WebHandoff;
  try {
    h = readJSON<WebHandoff>(p, webHandoffSchema);
  } catch (err) {
    throw new Error(`尚无网页交接，请先运行 am song handoff：${errText(err)}`, { cause: err });
  }
  if (h.schema !== 1 || (h.state !== 'waiting_for_audio' && h.state !== 'imported')) throw new Error('网页交接状态无效');
  if ((h.state === 'imported' && !idPattern.test(h.candidate_id)) || (h.state === 'waiting_for_audio' && h.candidate_id !== '')) {
    throw new Error('网页交接候选记录无效');
  }
  const dir = handoffDir(root, h.id);
  for (const entry of [
    { name: 'lyrics.txt', sha: h.lyrics_sha256 },
    { name: 'style.txt', sha: h.style_sha256 },
  ]) {
    const file = localPath(dir, entry.name);
    if (hashFile(file) !== entry.sha) throw new Error('网页交接内容已变化，请重新核对歌词和曲风');
  }
  if (h.id !== digest([h.lyrics_sha256, h.style_sha256])) throw new Error('网页交接摘要不一致');
  return { handoff: h, dir };
}

/**
 * handoff writes reproducible snapshots and a durable wait marker. It performs
 * no network, model or media calls and never holds a process open awaiting a user.
 */
export function handoff(root: string, out: Writer): void {
  handoffWithRefresh(root, false, out);
}

export function handoffWithRefresh(root: string, refresh: boolean, out: Writer): void {
  const c = loadConfig(root);
  withLock(root, () => {
    const p = localPath(root, c.lyrics);
    let lyrics: Buffer;
    try {
      lyrics = fs.readFileSync(p);
    } catch (err) {
      throw new Error(goPathError('open', p, err), { cause: err });
    }
    if (lyricLines(lyrics.toString('utf8')).length === 0) throw new Error(`请先根据文章写好歌词文件 ${c.lyrics}，再运行 am song handoff`);
    const style = Buffer.from(handoffStyle(c));
    let h: WebHandoff = { schema: 1, id: '', state: 'waiting_for_audio', lyrics_sha256: bytesHash(lyrics), style_sha256: bytesHash(style), candidate_id: '' };
    h.id = digest([h.lyrics_sha256, h.style_sha256]);
    const dir = handoffDir(root, h.id);
    const state = localPath(root, handoffState);
    let stateExists = true;
    try {
      fs.statSync(state);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(goPathError('stat', state, err), { cause: err });
      stateExists = false;
    }
    if (stateExists) {
      const old = loadHandoff(root).handoff;
      if (old.id === h.id) h = old;
      else if (old.state === 'waiting_for_audio' && !refresh) {
        throw new Error(
          '仍在等待上一版歌词的音频；不能替换已交给用户的材料。确需重做时运行 am song handoff --refresh，并告知用户使用新版歌词重新生成',
        );
      }
    }
    for (const entry of [
      { name: 'lyrics.txt', data: lyrics },
      { name: 'style.txt', data: style },
    ]) {
      const dest = localPath(dir, entry.name);
      let existing: Buffer | null = null;
      try {
        existing = fs.readFileSync(dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(goPathError('open', dest, err), { cause: err });
      }
      if (existing !== null) {
        if (!existing.equals(entry.data)) throw new Error('网页交接快照已被修改，拒绝覆盖');
        continue;
      }
      atomicWrite(dest, entry.data, 0o644);
    }
    writeJSON(state, webHandoffToJSON(h));
    out.write(`网页生成材料：${dir}\n\n【复制到歌词栏】\n${lyrics.toString('utf8')}\n\n【复制到曲风/风格栏】\n${style.toString('utf8')}\n`);
    if (h.state === 'imported') {
      const candidate = loadCandidate(root, h.candidate_id);
      out.write(`已收到候选 ${candidate.id}；请先核对用户试听选择，不重复索要或生成音频。\n`);
    } else {
      out.write(
        '等待用户提供音频：请在所选网页的自定义歌词模式粘贴以上内容，生成并试听后下载 MP3/WAV。将文件上传到当前会话，或提供本机文件路径。若网页改了歌词，请同时提供最终歌词。\n此处暂停，不生成时间轴、不分镜、不渲染；收到文件后运行 am song receive AUDIO。CLI 已正常退出，不代表歌曲已生成。\n',
      );
    }
  });
}

export function receive(root: string, audio: string, media: Toolchain): Candidate {
  loadConfig(root);
  return withLock(root, () => {
    const { handoff: h, dir } = loadHandoff(root);
    if (h.candidate_id !== '') {
      const old = loadCandidate(root, h.candidate_id);
      if (old.lyrics_sha256 !== h.lyrics_sha256) throw new Error('接收记录与歌词快照不一致');
      if (hashFile(audio) === old.audio_sha256) return old;
    }
    // Always import the exact lyric snapshot handed to the user, even if the
    // editable project lyrics have since changed. Corrections use explicit import.
    const candidate = importCandidate(root, audio, path.join(dir, 'lyrics.txt'), media);
    h.state = 'imported';
    h.candidate_id = candidate.id;
    writeJSON(localPath(root, handoffState), webHandoffToJSON(h));
    return candidate;
  });
}
