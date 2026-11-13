// 移植自 internal/song/prepare.go。
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../envutil';
import { find } from '../toolpath';
import { atomicWrite } from '../fsutil';
import { goPathError, goTrimSpace } from '../gofmt';
import { newToolchain } from '../mediaprobe';
import { unmarshal } from './jsondecode';
import { checkCredential, providerInfo, type Writer } from './platforms';
import { output } from './proc';
import { ACEClient } from './provider';
import { candidateDir, loadConfig, localPath, readJSON, selected, Store, withLock, writeJSON } from './store';
import { lyricLines, problems, saveTimeline } from './timeline';
import { sourceLineToJSON, timeline, timelineSchema, timelineToJSON, type Candidate, type Config, type Line, type SourceLine, type Timeline, type Word } from './types';
import { unixNano } from './clock';

export const AlignerVersion = '0.6.1';
export const LibrosaVersion = '0.11.0';
const versionScript = `import importlib.metadata as m
assert m.version('xingyu-lyrics-aligner') == '0.6.1', 'requires xingyu-lyrics-aligner==0.6.1'
`;
const beatScript = `import importlib.metadata as m, json, sys
assert m.version('librosa') == '0.11.0'
import librosa
y, sr = librosa.load(sys.argv[1], sr=22050, mono=True)
_, frames = librosa.beat.beat_track(y=y, sr=sr)
print(json.dumps(librosa.frames_to_time(frames, sr=sr).tolist()))
`;

async function python(c: Config, env: Record<string, string>, args: string[], signal?: AbortSignal): Promise<Buffer> {
  const binary = lookPath(c.python, env.PATH ?? '');
  try {
    return await output(binary, args, env, signal);
  } catch {
    throw new Error('本地 Python 工具失败；请检查独立环境与固定版本依赖');
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface AlignmentDoc {
  lines: Array<{
    index: number;
    text: string;
    start: number | null;
    end: number | null;
    status: string;
    warnings: string[] | null;
    tokens: Array<{ text: string; start: number | null; end: number | null; estimated: boolean }> | null;
  }> | null;
  warnings: string[] | null;
}

export function convertAlignment(raw: Uint8Array, c: Candidate, lyrics: string[]): { timeline: Timeline; issues: string[] } {
  const t = timeline({
    schema: 1,
    candidate_id: c.id,
    audio_sha256: c.audio_sha256,
    lyrics_sha256: c.lyrics_sha256,
    duration_seconds: c.duration_seconds,
    source: 'xingyu-lyrics-aligner/' + AlignerVersion,
  });
  let doc: AlignmentDoc;
  try {
    doc = unmarshal<AlignmentDoc>(Buffer.from(raw).toString('utf8'), {
      struct: [
        [
          'lines',
          {
            slice: {
              struct: [
                ['index', 'int'],
                ['text', 'string'],
                ['start', { ptr: 'float' }],
                ['end', { ptr: 'float' }],
                ['status', 'string'],
                ['warnings', { slice: 'string' }],
                [
                  'tokens',
                  {
                    slice: {
                      struct: [
                        ['text', 'string'],
                        ['start', { ptr: 'float' }],
                        ['end', { ptr: 'float' }],
                        ['estimated', 'bool'],
                      ],
                    },
                  },
                ],
              ],
            },
          },
        ],
        ['warnings', { slice: 'string' }],
      ],
    });
  } catch {
    throw new Error('对齐工具 Xingyu alignment.json 格式无效');
  }
  const issues: string[] = [];
  const warn = (...items: string[]) => {
    if (items.length > 0) (t.warnings ??= []).push(...items);
  };
  warn(...(doc.warnings ?? []));
  const docLines = doc.lines ?? [];
  if (docLines.length !== lyrics.length) issues.push('对齐歌词行数不匹配');
  docLines.forEach((l, i) => {
    const ln: Line = { id: `line-${String(i + 1).padStart(4, '0')}`, source_line: i + 1, text: l.text, alignment_text: l.text, start: 0, end: 0, words: null };
    if (i < lyrics.length) {
      ln.text = lyrics[i];
      if (goTrimSpace(l.text) !== goTrimSpace(lyrics[i])) issues.push(`第 ${i + 1} 行对齐文本不匹配`);
    }
    if (l.start === null || l.end === null) {
      issues.push(ln.id + ' 缺失时间戳');
    } else {
      ln.start = l.start;
      ln.end = l.end;
    }
    if (l.status !== 'aligned') issues.push(ln.id + ' 对齐需复核：' + l.status);
    warn(...(l.warnings ?? []));
    for (const w of l.tokens ?? []) {
      if (w.start === null || w.end === null || w.estimated) {
        warn(ln.id + ' 字词缺失或为估算，已移除逐字同步依据：' + w.text);
        continue;
      }
      const word: Word = { text: w.text, start: w.start, end: w.end, estimated: false };
      (ln.words ??= []).push(word);
    }
    (t.lines ??= []).push(ln);
  });
  issues.push(...problems(t));
  return { timeline: t, issues };
}

export async function prepare(
  root: string,
  manual: string,
  reviewed: boolean,
  env: Record<string, string>,
  out: Writer,
  signal?: AbortSignal,
): Promise<void> {
  const c = loadConfig(root);
  const chosen = selected(root);
  await withLock(root, async () => {
    if (manual !== '') {
      const t = readJSON<Timeline>(manual, timelineSchema);
      t.reviewed = reviewed;
      t.source = 'manual';
      saveTimeline(root, t);
      return;
    }
    if (reviewed) throw new Error('--reviewed 仅用于导入已人工核对的 --timeline');
    try {
      await python(c, env, ['-c', versionScript], signal);
    } catch (err) {
      throw new Error(`需要 xingyu-lyrics-aligner==${AlignerVersion}：${errText(err)}`, { cause: err });
    }
    const dir = candidateDir(root, chosen.id);
    const audio = path.join(dir, chosen.audio);
    const work = localPath(root, `${Store}/alignment/${chosen.id}-${unixNano()}`);
    fs.mkdirSync(work, { recursive: true, mode: 0o755 });
    const lyricsFile = path.join(dir, chosen.lyrics);
    let b: string;
    try {
      b = fs.readFileSync(lyricsFile, 'utf8');
    } catch (err) {
      throw new Error(goPathError('open', lyricsFile, err), { cause: err });
    }
    const lines = lyricLines(b);
    const lyricsPath = path.join(work, 'alignment-lyrics.txt');
    atomicWrite(lyricsPath, lines.join('\n') + '\n', 0o644);
    const mapping = lyricMapping(b);
    writeJSON(path.join(work, 'source-lines.json'), mapping.length === 0 ? null : mapping.map(sourceLineToJSON));
    const media = newToolchain(env);
    const wav = path.join(work, 'analysis.wav');
    await media.prepareAlignment(audio, wav, signal);
    out.write('正在运行 Xingyu 0.6.1 对齐；原始报告保存在 ' + work + '\n');
    await python(
      c,
      env,
      ['-m', 'xingyu_lyrics_aligner.cli', 'align', '--audio', wav, '--lyrics', lyricsPath, '--output-dir', work, '--language', c.language, '--device', 'cpu', '--json-result'],
      signal,
    );
    const alignmentFile = path.join(work, 'alignment.json');
    let raw: Buffer;
    try {
      raw = fs.readFileSync(alignmentFile);
    } catch (err) {
      throw new Error(goPathError('open', alignmentFile, err), { cause: err });
    }
    const converted = convertAlignment(raw, chosen, lines);
    const t = converted.timeline;
    let issues = converted.issues;
    (t.lines ?? []).forEach((l, i) => {
      if (i < mapping.length) l.source_line = mapping[i].source_line;
    });
    let beatsOK = true;
    try {
      const beats = await python(c, env, ['-c', beatScript, wav], signal);
      t.beats = unmarshal<number[] | null>(beats.toString('utf8'), { slice: 'float' });
    } catch {
      beatsOK = false;
    }
    if (!beatsOK) {
      t.beats = null;
      (t.warnings ??= []).push('节拍分析失败，已降级为歌词驱动动画');
    }
    issues = [...issues, ...problems(t)];
    writeJSON(path.join(work, 'issues.json'), { blocking: issues, warnings: t.warnings });
    writeJSON(path.join(work, 'timeline-draft.json'), timelineToJSON(t));
    if (issues.length > 0) {
      throw new Error(`对齐需人工修正：${path.join(work, 'issues.json')}；修正 timeline-draft.json 后用 prepare --timeline FILE --reviewed 导入`);
    }
    saveTimeline(root, t);
    for (const w of t.warnings ?? []) out.write('提示： ' + w + '\n');
    out.write('时间轴已生成。请核对术语与句首时间，再用 prepare --timeline production/song/timeline.json --reviewed 确认。\n');
  });
}

export async function doctor(root: string, env: Record<string, string>, out: Writer, signal?: AbortSignal): Promise<void> {
  const c = loadConfig(root);
  const failures: string[] = [];
  const check = (name: string, e: unknown) => {
    if (e) {
      failures.push(name + ': ' + errText(e));
      out.write('FAIL ' + name + '\n');
    } else {
      out.write('OK ' + name + '\n');
    }
  };
  const attempt = async (fn: () => unknown): Promise<unknown> => {
    try {
      await fn();
      return null;
    } catch (err) {
      return err;
    }
  };
  for (const name of ['ffprobe', 'ffmpeg']) check(name, await attempt(() => find(name, env)));
  check('xingyu-lyrics-aligner==' + AlignerVersion, await attempt(() => python(c, env, ['-c', versionScript], signal)));
  const librosa = await attempt(() => python(c, env, ['-c', "import importlib.metadata as m; assert m.version('librosa') == '" + LibrosaVersion + "'"], signal));
  if (librosa) out.write('WARN librosa==' + LibrosaVersion + ' 不可用；将降级为歌词驱动\n');
  if (c.provider === 'minimax') {
    const e = await attempt(async () => {
      const binary = find('mmx', env);
      const b = await output(binary, ['music', 'generate', '--help'], env, signal);
      if (!b.toString('utf8').includes('--lyrics-file')) throw new Error('mmx 不支持 --lyrics-file');
    });
    check('MiniMax mmx（登录态以实际生成为准）', e);
  } else if (c.provider === 'acestep') {
    check('ACE-Step health', await attempt(() => new ACEClient({ endpoint: c.endpoint, key: env.ACESTEP_API_KEY ?? '' }).health(signal)));
  }
  if (c.provider === 'manual') out.write('OK 网页手动生成无需 API Key；handoff 不需要媒体/对齐环境，receive 和 prepare 才需要相应工具\n');
  if (c.provider !== 'minimax' && c.provider !== 'acestep' && c.provider !== 'manual') {
    check(providerInfo(c.provider).key + '（仅本地存在性，不验证权限/额度）', await attempt(() => checkCredential(c, env)));
  }
  out.write(`平台接入说明：song_providers({"platform": "${c.provider}"})\n`);
  if (failures.length > 0) throw new Error(`歌曲环境检查未通过：${failures.join('；')}`);
}

export function lyricMapping(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  text.split('\n').forEach((raw, i) => {
    const l = goTrimSpace(raw);
    if (l === '' || (l.startsWith('[') && l.endsWith(']'))) return;
    out.push({ source_line: i + 1, original: raw, display: l, alignment_input: l });
  });
  return out;
}
