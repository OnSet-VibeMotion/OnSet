import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { find } from '../toolpath';
import { atomicWrite } from '../fsutil';
import { formatFixed, goExt, goPathError } from '../gofmt';
import { newToolchain, type Toolchain } from '../mediaprobe';
import { DiagnosticBuffer, diagnosticToJSON, providerDiagnostic } from './diagnostic';
import { handoff } from './handoff';
import { newHosted, taskIDOf, validateLyrics } from './hosted';
import { checkCredential, type Writer } from './platforms';
import { runProcess } from './proc';
import { ACEClient, type ResumableProvider } from './provider';
import { bytesHash, candidateDir, digest, finite, hashFile, loadCandidate, loadConfig, localPath, readCandidate, withLock, writeJSON, idPattern } from './store';
import { lyricLines } from './timeline';
import { candidate as newCandidate, candidateToJSON, configToJSON, type Candidate } from './types';
import { rfc3339Nano, unixNano } from './clock';

function copyFile(source: string, dest: string): void {
  let fd: number;
  try {
    fd = fs.openSync(source, 'r');
  } catch (err) {
    throw new Error(goPathError('open', source, err), { cause: err });
  }
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error('输入必须是小于 512 MiB 的普通文件');
    const b = fs.readFileSync(fd);
    atomicWrite(dest, b, 0o644);
  } finally {
    fs.closeSync(fd);
  }
}

function finish(root: string, c: Candidate, media: Toolchain): void {
  const dir = candidateDir(root, c.id);
  const p = path.join(dir, c.audio);
  const m = media.probe(p);
  if (!m.audio || m.video || !finite(m.duration_seconds) || m.duration_seconds <= 0) throw new Error('候选必须是有时长、无视频流的音频');
  media.decode(p);
  c.duration_seconds = m.duration_seconds;
  c.audio_sha256 = hashFile(p);
  c.lyrics_sha256 = hashFile(path.join(dir, c.lyrics));
  c.state = 'ready';
  writeJSON(path.join(dir, 'candidate.json'), candidateToJSON(c));
}

/** 导入外部歌曲（am song import）。 */
export function importSong(root: string, audio: string, lyrics: string, media: Toolchain): Candidate {
  loadConfig(root);
  return withLock(root, () => importCandidate(root, audio, lyrics, media));
}

export function importCandidate(root: string, audio: string, lyrics: string, media: Toolchain): Candidate {
  let b: Buffer;
  try {
    b = fs.readFileSync(lyrics);
  } catch (err) {
    throw new Error(goPathError('open', lyrics, err), { cause: err });
  }
  if (lyricLines(b.toString('utf8')).length === 0) throw new Error('歌词为空');
  const c = newCandidate({ id: `import-${unixNano()}`, provider: 'import', audio: 'audio' + goExt(audio), lyrics: 'lyrics.txt', state: 'importing' });
  const dir = candidateDir(root, c.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  copyFile(audio, path.join(dir, c.audio));
  atomicWrite(path.join(dir, c.lyrics), b, 0o644);
  finish(root, c, media);
  return c;
}

function seconds(since: number): number {
  return (performance.now() - since) / 1000;
}

/**
 * generate reuses deterministic request slots. Failed/ambiguous submissions are
 * never automatically resubmitted. A new --batch explicitly authorizes new work.
 */
export async function generate(
  root: string,
  count: number,
  batch: string,
  env: Record<string, string> | null,
  out: Writer,
  signal?: AbortSignal,
): Promise<void> {
  if (count < 1 || count > 8 || !idPattern.test(batch)) throw new Error('--count 必须为 1..8，--batch 必须是安全标识');
  const c = loadConfig(root);
  if (c.provider === 'manual') {
    handoff(root, out);
    return;
  }
  const environ = env ?? {};
  const p = localPath(root, c.lyrics);
  let lyrics: Buffer;
  try {
    lyrics = fs.readFileSync(p);
  } catch (err) {
    throw new Error(goPathError('open', p, err), { cause: err });
  }
  const lyricsText = lyrics.toString('utf8');
  if (lyricLines(lyricsText).length === 0) throw new Error('歌词为空');
  checkCredential(c, environ);
  validateLyrics(c, lyricsText);
  const media = newToolchain(environ);
  const audioName = c.provider === 'fal' ? 'audio.wav' : 'audio.mp3';
  await withLock(root, async () => {
    const requestSHA = digest({ Config: configToJSON(c), Lyrics: lyricsText });
    for (let i = 0; i < count; i++) {
      const id = `${batch}-${requestSHA.slice(0, 16)}-${String(i + 1).padStart(2, '0')}`;
      const dir = candidateDir(root, id);
      let candidate = newCandidate({
        id,
        provider: c.provider,
        model: c.model,
        request_sha256: requestSHA,
        audio: audioName,
        lyrics: 'lyrics.txt',
        state: 'submitting',
        started_at: rfc3339Nano(),
      });
      const record = localPath(dir, 'candidate.json');
      for (const name of ['lyrics.txt', 'request.json', audioName, 'provider-error.json']) localPath(dir, name);
      let exists = true;
      try {
        fs.statSync(record);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(goPathError('stat', record, err), { cause: err });
        exists = false;
      }
      if (exists) {
        candidate = readCandidate(record);
        if (
          candidate.request_sha256 !== requestSHA ||
          candidate.id !== id ||
          candidate.provider !== c.provider ||
          candidate.model !== c.model ||
          candidate.audio !== audioName ||
          candidate.lyrics !== 'lyrics.txt'
        ) {
          throw new Error('请求摘要冲突');
        }
        if (candidate.state === 'ready') {
          loadCandidate(root, id);
          out.write(`复用候选 ${id}：${path.join(dir, candidate.audio)}\n`);
          continue;
        }
        if (candidate.state === 'downloaded') {
          finish(root, candidate, media);
          out.write(`已验证本地候选 ${id}：${path.join(dir, candidate.audio)}\n`);
          continue;
        }
        if (candidate.task_id === '' || (c.provider !== 'acestep' && c.provider !== 'fal' && c.provider !== 'mureka') || candidate.state !== 'pending') {
          throw new Error(`候选 ${id} 提交状态不明或曾失败，未重发；检查服务后用新 --batch 显式生成`);
        }
      } else {
        atomicWrite(path.join(dir, candidate.lyrics), lyrics, 0o644);
        writeJSON(path.join(dir, 'request.json'), { config: configToJSON(c), lyrics_sha256: bytesHash(lyrics), request_sha256: requestSHA });
        writeJSON(record, candidateToJSON(candidate));
      }
      if (candidate.task_id !== '') {
        if (hashFile(path.join(dir, candidate.lyrics)) !== bytesHash(lyrics)) throw new Error('待完成候选歌词摘要变化，拒绝恢复');
      }
      const attemptStart = performance.now();
      out.write(`正在处理候选 ${id}（${c.provider} / ${c.model}）\n`);
      const dest = path.join(dir, candidate.audio);
      if (c.provider === 'minimax') {
        const binary = find('mmx', environ);
        const args = [
          'music',
          'generate',
          '--non-interactive',
          '--output',
          'json',
          '--model',
          c.model,
          '--prompt',
          `${c.style}; language ${c.language}; target duration ${formatFixed(c.target_seconds, 0)} seconds`,
          '--bpm',
          String(c.bpm),
          '--lyrics-file',
          path.join(dir, candidate.lyrics),
          '--out',
          dest,
        ];
        const stdout = new DiagnosticBuffer();
        const stderr = new DiagnosticBuffer();
        // Persist only structured, redacted errors; never raw provider output.
        const ran = await runProcess(binary, args, environ, { stdout: (b) => stdout.write(b), stderr: (b) => stderr.write(b) }, signal);
        if (ran.error) {
          candidate.state = 'submission_unknown';
          candidate.elapsed_seconds += seconds(attemptStart);
          if (ran.exited) candidate.provider_exit_code = ran.exitCode;
          writeJSON(record, candidateToJSON(candidate));
          let detail = providerDiagnostic(stderr.data, environ);
          if (detail.code === 0) {
            const alternative = providerDiagnostic(stdout.data, environ);
            if (alternative.code !== 0) detail = alternative;
          }
          writeJSON(path.join(dir, 'provider-error.json'), diagnosticToJSON(detail));
          throw new Error(`MiniMax 生成未完成（候选 ${id}，退出码 ${candidate.provider_exit_code}）：${detail.message}；未自动重试`);
        }
      } else if (c.provider === 'bailian' || c.provider === 'elevenlabs' || c.provider === 'lyria') {
        try {
          candidate.task_id = await newHosted(c, environ).generate(lyricsText, dest, signal);
        } catch (err) {
          candidate.task_id = taskIDOf(err);
          candidate.state = 'submission_unknown';
          candidate.elapsed_seconds += seconds(attemptStart);
          writeJSON(record, candidateToJSON(candidate));
          throw err;
        }
      } else {
        const a: ResumableProvider =
          c.provider === 'fal' || c.provider === 'mureka' ? newHosted(c, environ) : new ACEClient({ endpoint: c.endpoint, key: environ.ACESTEP_API_KEY ?? '' });
        if (candidate.task_id === '') {
          let task: string;
          try {
            task = await a.submit(c, lyricsText, signal);
          } catch (err) {
            candidate.state = 'submission_unknown';
            candidate.elapsed_seconds += seconds(attemptStart);
            writeJSON(record, candidateToJSON(candidate));
            throw err;
          }
          candidate.task_id = task;
          candidate.state = 'pending';
          writeJSON(record, candidateToJSON(candidate));
        }
        try {
          await a.resume(candidate.task_id, dest, signal);
        } catch (err) {
          candidate.elapsed_seconds += seconds(attemptStart);
          writeJSON(record, candidateToJSON(candidate));
          throw new Error(`候选 ${id} 可通过相同 generate 命令继续轮询：${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
      }
      candidate.elapsed_seconds += seconds(attemptStart);
      candidate.state = 'downloaded';
      writeJSON(record, candidateToJSON(candidate));
      finish(root, candidate, media);
      out.write(`候选 ${id}：${dest}\n`);
    }
    out.write('请试听后由用户运行 song_select({"candidate": "<candidate-id>"})。未自动选歌。\n');
  });
}
