/** 配音的宿主边界：模型只给创作参数，工具参数、音色引用、转换与产物由 OnSet 管理。 */
import fs from 'node:fs';
import path from 'node:path';
import { TTSProviders } from '../config/providers';
import { marshalIndent } from '../gojson';
import { newToolchain } from '../mediaprobe';
import { MissingError } from '../prereq';
import { modelReady } from '../toolinstall';
import { defaultDir } from './dir';
import { defaultName, get } from './library';
import { designStatus } from './design';
import { generateTake } from './adapters';

/** 多段配音（按换行分段）默认在段落之间插入的静音停顿（毫秒）。 */
export const DefaultParagraphPauseMs = 450;
/** 段间静音停顿上限（毫秒）。 */
export const MaxParagraphPauseMs = 3000;

export interface SynthesisOptions {
  provider: string;
  text: string;
  /** Breeze 为库里的名字；其他服务为 voice ID。Breeze 留空使用默认音色。 */
  voice?: string;
  output: string;
  /** 倍率；腾讯使用自己的 -2..6 刻度。两个本地模型通过 instruction 指导语速。 */
  speed?: number;
  instruction?: string;
  pronunciation?: string[];
  ssml?: boolean;
  /** 段落（换行）之间插入的静音停顿毫秒数；缺省为 DefaultParagraphPauseMs，0 表示整篇一次合成不补段间停顿。 */
  paragraphPauseMs?: number;
  env: Record<string, string>;
  signal?: AbortSignal;
  progress?: (message: string) => void;
}

export interface SynthesisResult {
  provider: string;
  voice: string;
  audio: string;
  report: string;
  sources: string;
  duration_seconds: number;
  alignment?: string;
}

const json = (file: string, value: unknown) => fs.writeFileSync(file, marshalIndent(value) + '\n');
const roundSec = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/** 腾讯上限按字符保守处理，优先在标点后切，绝不删掉或重复任何字符。 */
function tencentParts(text: string): string[] {
  const chars = [...text];
  const parts: string[] = [];
  for (let at = 0; at < chars.length;) {
    let end = Math.min(at + 150, chars.length);
    if (end < chars.length) {
      for (let i = end - 1; i > at; i--) {
        if (/[。！？!?；;，,\n]/u.test(chars[i])) { end = i + 1; break; }
      }
    }
    parts.push(chars.slice(at, end).join(''));
    at = end;
  }
  return parts;
}

/** 按段落拆成待合成片段：单段或关闭停顿时保持整块，腾讯在段内再按 150 字切。 */
function buildChunks(providerId: string, text: string, pauseMs: number, ssml: boolean): { text: string; pauseAfterMs: number }[] {
  if (!ssml && pauseMs > 0) {
    const paragraphs = text.replaceAll('\r\n', '\n').split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (paragraphs.length > 1) {
      const chunks: { text: string; pauseAfterMs: number }[] = [];
      paragraphs.forEach((para, idx) => {
        const isLastPara = idx === paragraphs.length - 1;
        const sub = providerId === 'tencent' ? tencentParts(para) : [para];
        sub.forEach((part, subIdx) => {
          const isLastSub = subIdx === sub.length - 1;
          chunks.push({ text: part, pauseAfterMs: !isLastPara && isLastSub ? pauseMs : 0 });
        });
      });
      return chunks;
    }
  }
  const parts = providerId === 'tencent' ? tencentParts(text) : [text];
  return parts.map((part) => ({ text: part, pauseAfterMs: 0 }));
}

function validate(opts: SynthesisOptions): void {
  if (!TTSProviders.some((p) => p.id === opts.provider)) throw new Error(`配音服务 ${opts.provider} 不由内置合成器处理，请调用该插件登记的配音工具`);
  if (!opts.text.trim()) throw new Error('配音文稿不能为空');
  if (opts.text.includes('\0')) throw new Error('配音文稿不能包含 NUL');
  if (path.extname(opts.output).toLowerCase() !== '.wav') throw new Error('output 必须是 .wav 文件');
  if (opts.speed !== undefined) {
    let min = 0.5, max = 2;
    if (opts.provider === 'tencent') { min = -2; max = 6; }
    else if (opts.provider === 'elevenlabs') { min = 0.7; max = 1.2; }
    if (!Number.isFinite(opts.speed) || opts.speed < min || opts.speed > max) throw new Error(`speed 必须在 ${min}..${max} 之间`);
    if (opts.provider === 'breeze' || opts.provider === 'mlx') throw new Error('本地配音模型不支持 speed，请用 instruction 指导语速');
  }
  if (opts.paragraphPauseMs !== undefined) {
    if (!Number.isFinite(opts.paragraphPauseMs) || opts.paragraphPauseMs < 0 || opts.paragraphPauseMs > MaxParagraphPauseMs) {
      throw new Error(`paragraph_pause_ms 必须在 0..${MaxParagraphPauseMs} 之间`);
    }
  }
  if (opts.instruction && !['breeze', 'bailian', 'mlx'].includes(opts.provider)) throw new Error(`${opts.provider} 不支持 instruction`);
  if (opts.pronunciation?.length && opts.provider !== 'minimax') throw new Error('pronunciation 只适用于 MiniMax；其他服务请用终稿的朗读标记');
  if (opts.ssml && opts.provider !== 'bailian') throw new Error('ssml 只适用于百炼');
}

/** 不覆盖任何已有 take；原始音频、服务响应、文本与参数保存在同名 .tts 目录。 */
export async function synthesize(opts: SynthesisOptions): Promise<SynthesisResult> {
  validate(opts);
  opts.signal?.throwIfAborted();
  const provider = TTSProviders.find((p) => p.id === opts.provider)!;
  const output = path.resolve(opts.output);
  const sources = output.slice(0, -4) + '.tts';
  if (fs.existsSync(output) || fs.existsSync(sources)) throw new Error('配音产物已存在，请使用新的版本文件名：' + output);
  let voice = opts.voice?.trim() ?? '';
  let reference: ReturnType<typeof get> | undefined;
  if (provider.id === 'breeze') {
    const root = defaultDir(opts.env);
    if (!root) throw new Error('无法确定音色库目录');
    voice ||= defaultName(root);
    if (!voice) throw new Error('还没有默认音色，请在音色页设计或保存一个声音，再用 voice_list() 选择');
    reference = get(root, voice);
    const status = designStatus(opts.env);
    if (!status.ready) throw new MissingError('Breeze TTS 2', status.problem);
  } else if (!voice) throw new Error('请用 voice_catalog() 选择音色后填写 voice');
  if (provider.id === 'tencent' && !/^\d+$/.test(voice)) throw new Error('腾讯音色 voice 必须是数字 VoiceType');
  if (provider.model && !modelReady(provider.model, opts.env)) throw new MissingError(provider.name + ' 模型');

  fs.mkdirSync(path.dirname(output), { recursive: true });
  // 同一路径只能有一个生成任务，防止两个请求同时检查到「尚不存在」。
  const lock = sources + '.lock';
  try { fs.mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('这个配音输出正在生成，请等原任务结束：' + output);
    throw error;
  }
  let work = '';
  let publishedSources = false;
  try {
    work = fs.mkdtempSync(path.join(path.dirname(output), '.tts-'));
    fs.writeFileSync(path.join(work, 'text.txt'), opts.text);
    const env = { ...opts.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
    const tc = newToolchain(env);
    const pauseMs = Math.round(opts.paragraphPauseMs ?? DefaultParagraphPauseMs);
    const chunks = buildChunks(provider.id, opts.text, pauseMs, opts.ssml === true);
    const needsPause = chunks.some((c) => c.pauseAfterMs > 0);
    const pauseFile = path.join(work, 'pause.wav');
    let pauseDuration = 0;
    if (needsPause) {
      const pauseSamples = Math.max(1, Math.round((pauseMs / 1000) * 48000));
      await tc.transcode(
        pauseFile,
        ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-af', `atrim=end_sample=${pauseSamples}`, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le'],
        opts.signal,
      );
      pauseDuration = pauseSamples / 48000;
    }
    const segments: { audio: string; text: string; start_seconds: number; duration_seconds: number; pause_after_ms?: number }[] = [];
    const concatEntries: string[] = [];
    const mergedAlignment: { text: string; start: number; end: number }[] = [];
    let hasAlignment = false;
    let elapsed = 0;
    let alignment: string | undefined;
    for (const [index, chunk] of chunks.entries()) {
      opts.signal?.throwIfAborted();
      opts.progress?.(`正在生成配音（${provider.name}，${index + 1}/${chunks.length}）`);
      const dir = path.join(work, String(index + 1).padStart(3, '0'));
      fs.mkdirSync(dir);
      const take = await generateTake({ ...opts, env }, provider, voice, reference, dir, chunk.text);
      const raw = take.raw;
      if (take.alignment) {
        hasAlignment = true;
        for (const item of take.alignment) {
          mergedAlignment.push({ text: item.text, start: roundSec(elapsed + item.start), end: roundSec(elapsed + item.end) });
        }
      }
      const audio = path.join(dir, 'audio.wav');
      await tc.transcode(audio, ['-i', raw, '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le'], opts.signal);
      const duration = tc.probe(audio).duration_seconds;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('配音音频时长无效');
      const relAudio = path.relative(work, audio).split(path.sep).join('/');
      segments.push({
        audio: relAudio,
        text: chunk.text,
        start_seconds: roundSec(elapsed),
        duration_seconds: duration,
        ...(chunk.pauseAfterMs > 0 ? { pause_after_ms: chunk.pauseAfterMs } : {}),
      });
      concatEntries.push(`file '${relAudio}'`);
      elapsed = roundSec(elapsed + duration);
      if (chunk.pauseAfterMs > 0) {
        concatEntries.push(`file 'pause.wav'`);
        elapsed = roundSec(elapsed + pauseDuration);
      }
    }
    if (hasAlignment) {
      json(path.join(work, 'align.json'), mergedAlignment);
      alignment = path.join(sources, 'align.json');
    }
    opts.progress?.('正在整理配音产物');
    const final = path.join(work, 'audio.wav');
    if (concatEntries.length === 1) fs.copyFileSync(path.join(work, segments[0].audio), final);
    else {
      fs.writeFileSync(path.join(work, 'concat.txt'), concatEntries.join('\n') + '\n');
      await tc.transcode(final, ['-f', 'concat', '-safe', '1', '-i', path.join(work, 'concat.txt'), '-c:a', 'pcm_s16le'], opts.signal);
    }
    const duration = tc.probe(final).duration_seconds;
    const result: SynthesisResult = { provider: provider.id, voice, audio: output, report: path.join(sources, 'report.json'), sources, duration_seconds: duration, ...(alignment ? { alignment } : {}) };
    json(path.join(work, 'report.json'), { ...result, schema: 1, sample_rate: 48000, channels: 2, speed: opts.speed, instruction: opts.instruction, pronunciation: opts.pronunciation, ssml: opts.ssml, paragraph_pause_ms: needsPause ? pauseMs : 0, segments });
    opts.signal?.throwIfAborted();
    // 再检查一次，保护并发调用期间出现的产物；WAV 用独占复制发布。
    if (fs.existsSync(sources)) throw new Error('配音产物已存在：' + sources);
    fs.renameSync(work, sources);
    publishedSources = true;
    fs.copyFileSync(path.join(sources, 'audio.wav'), output, fs.constants.COPYFILE_EXCL);
    return result;
  } catch (error) {
    if (publishedSources) fs.rmSync(sources, { recursive: true, force: true });
    throw error;
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(lock, { recursive: true, force: true });
  }
}
