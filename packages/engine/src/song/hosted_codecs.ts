import { formatFixed, goRound, goTrimSpace } from '../gofmt';
import { saveStream } from './download';
import { readLimited } from './http';
import { decodeFirst } from './jsondecode';
import { idPattern } from './store';
import type { Config } from './types';

/** Go map[string]any 的编码按键排序。 */
export function sortKeys(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

export function runeCount(s: string): number {
  return [...s].length;
}

const hanPattern = /\p{Script=Han}/u;

export function validateLyrics(c: Config, lyrics: string): void {
  if (c.provider === 'mureka' && (runeCount(lyrics) > 5000 || runeCount(murekaPrompt(c)) > 1024)) {
    throw new Error('歌曲平台 Mureka 歌词最多 5000 字符，曲风及生成要求最多 1024 字符');
  }
  if (c.provider === 'bailian') {
    const max = hanPattern.test(lyrics) ? 350 : 2000;
    const n = runeCount(lyrics);
    if (n < 5 || n > max) throw new Error(`百炼非流式歌词需 5..${max} 字符（含结构标签），当前 ${n}`);
  }
  if (c.provider === 'elevenlabs') elevenPlan(c, lyrics);
}

export function elevenPlan(c: Config, lyrics: string): Record<string, unknown> {
  const lines = goTrimSpace(lyrics).split('\n');
  for (const l of lines) if (runeCount(l) > 200) throw new Error('ElevenLabs 每行歌词最多 200 字符');
  let n = Math.ceil(c.target_seconds / 120);
  const m = Math.trunc((lines.length + 29) / 30);
  if (m > n) n = m;
  const total = goRound(c.target_seconds * 1000);
  if (Math.trunc(total / n) < 3000) throw new Error('歌词过多，请增加目标时长或缩短歌词');
  const chunks: unknown[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.trunc((i * lines.length) / n);
    const end = Math.trunc(((i + 1) * lines.length) / n);
    let duration = Math.trunc(total / n);
    if (i === n - 1) duration += total % n;
    chunks.push({
      duration_ms: duration,
      negative_styles: [],
      positive_styles: [
        c.style,
        `${c.bpm} BPM`,
        'clear solo vocals',
        'precise diction',
        'educational song',
        'balanced accompaniment',
      ],
      text: lines.slice(start, end).join('\n'),
    });
  }
  return { composition_plan: { chunks }, model_id: c.model };
}

export function murekaPrompt(c: Config): string {
  return `${c.style}; language ${c.language}; target duration ${formatFixed(c.target_seconds, 0)} seconds; ${c.bpm} BPM; clear solo vocals`;
}

export async function saveAudio(body: AsyncIterable<Uint8Array>, dest: string): Promise<void> {
  await saveStream(body, dest, '.audio-', '歌曲音频下载不完整或超过 512 MiB');
}

/** base64.StdEncoding 的解码（容忍 \r \n，与 Go 的 NewDecoder 一致），非法输入返回 null。 */
function decodeStdBase64(s: string): Buffer | null {
  const clean = s.replace(/[\r\n]/g, '');
  if (clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) return null;
  return Buffer.from(clean, 'base64');
}

export async function decodeLyria(reader: AsyncIterable<Uint8Array>, dest: string): Promise<string> {
  // Unlike metadata-only responses this JSON contains the base64 audio itself.
  const maxJSON = 96 << 20;
  let b: Buffer;
  try {
    b = await readLimited(reader, maxJSON + 1);
  } catch {
    throw new Error('歌曲平台 Lyria 音频响应中断或超过 96 MiB');
  }
  if (b.length > maxJSON) throw new Error('歌曲平台 Lyria 音频响应中断或超过 96 MiB');
  type Block = { type: string; mime_type: string; data: string };
  type Step = { type: string; content: Block[] | null };
  let result: { id: string; status: string; steps: Step[] | null };
  try {
    const text = b.toString('utf8');
    result = decodeFirst(text, {
      struct: [
        ['id', 'string'],
        ['status', 'string'],
        [
          'steps',
          {
            slice: {
              struct: [
                ['type', 'string'],
                [
                  'content',
                  {
                    slice: {
                      struct: [
                        ['type', 'string'],
                        ['mime_type', 'string'],
                        ['data', 'string'],
                      ],
                    },
                  },
                ],
              ],
            },
          },
        ],
      ],
    });
    // json.Unmarshal：值之后只能是空白。
    JSON.parse(text);
  } catch {
    throw new Error('歌曲平台 Lyria 返回无效 JSON');
  }
  let id = result.id;
  if (!idPattern.test(id)) id = '';
  if (result.status !== '' && result.status !== 'completed') {
    throw Object.assign(new Error('歌曲平台 Lyria 未返回完成状态；未重新生成'), { taskID: id });
  }
  let encoded = '';
  let count = 0;
  for (const step of result.steps ?? []) {
    if (step.type !== 'model_output') continue;
    for (const block of step.content ?? []) {
      if (block.type !== 'audio') continue;
      count++;
      if (block.mime_type !== 'audio/mpeg' && block.mime_type !== 'audio/mp3') {
        throw Object.assign(new Error('歌曲平台 Lyria 返回非 MP3 音频，拒绝保存为 MP3'), { taskID: id });
      }
      encoded = block.data;
    }
  }
  if (count !== 1 || encoded === '') {
    throw Object.assign(new Error('歌曲平台 Lyria 应返回一个完整内联音轨，实际音频块缺失或有多个；未自动选择或拼接'), {
      taskID: id,
    });
  }
  const audio = decodeStdBase64(encoded);
  async function* once(): AsyncIterable<Uint8Array> {
    if (audio === null) throw new Error('illegal base64 data');
    yield audio;
  }
  await withTaskID(id, saveAudio(once(), dest));
  return id;
}

/**
 * Go 版 Generate 失败时仍返回已知的任务 ID（Lyria 的 id、ElevenLabs 的 song-id、百炼的 request_id），
 * 调用方把它记进候选；TS 版把它挂在抛出的错误的 taskID 上，用 taskIDOf 取出。
 */
export function taskIDOf(err: unknown): string {
  const id = (err as { taskID?: unknown } | null)?.taskID;
  return typeof id === 'string' ? id : '';
}

export async function withTaskID<T>(id: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { taskID: id });
  }
}
