import path from 'node:path';
import { decodedSamples, MixSampleRate } from './mix';
import type { Toolchain } from './toolchain';

interface VoicePatchOptions {
  directory: string;
  original: string;
  replacement: string;
  startSample: number;
  endSample: number;
  signal?: AbortSignal;
}

const pcm = ['-vn', '-ac', '2', '-ar', String(MixSampleRate), '-c:a', 'pcm_s16le'];
const trim = (start: number, end: number) => `atrim=start_sample=${start}:end_sample=${end},asetpts=PTS-STARTPTS`;

export async function patchVoice(t: Toolchain, opts: VoicePatchOptions) {
  const { directory, original, replacement, startSample, endSample, signal } = opts;
  const media = t.probe(original);
  if (media.video || media.audio?.codec !== 'pcm_s16le' || media.audio.channels !== 2 || media.audio.sample_rate !== MixSampleRate) {
    throw new Error('原配音须为 48kHz 双声道 PCM16 WAV，确保区间外采样保持一致');
  }
  const length = endSample - startSample;
  const total = await decodedSamples(t, original, signal);
  if (!Number.isSafeInteger(startSample) || !Number.isSafeInteger(endSample) || startSample < 0 || length <= 0 || endSample > total) {
    throw new Error('补录区间超出原配音');
  }
  const take = path.join(directory, 'normalized-patch.wav');
  await t.transcode(take, ['-i', replacement, ...pcm], signal);
  const takeLength = await decodedSamples(t, take, signal);
  if (takeLength > length) throw new Error(`补录长于已选区间：可用 ${length} 采样，新录音 ${takeLength} 采样`);
  const filters: string[] = [], clips: string[] = [];
  if (startSample > 0) {
    filters.push(`[0:a:0]${trim(0, startSample)}[prefix]`);
    clips.push('[prefix]');
  }
  filters.push(`[1:a:0]asetpts=PTS-STARTPTS,apad=whole_len=${length}[patch]`);
  clips.push('[patch]');
  if (endSample < total) {
    filters.push(`[0:a:0]${trim(endSample, total)}[suffix]`);
    clips.push('[suffix]');
  }
  filters.push(`${clips.join('')}concat=n=${clips.length}:v=0:a=1[voice]`);
  const voice = path.join(directory, 'voice.wav');
  await t.transcode(voice, ['-i', original, '-i', take, '-filter_complex', filters.join(';'), '-map', '[voice]', ...pcm], signal);
  if (await decodedSamples(t, voice, signal) !== total) throw new Error('补录后的配音采样数发生变化');
  const audition = trim(Math.max(0, startSample - 2 * MixSampleRate), Math.min(total, endSample + 2 * MixSampleRate));
  await t.transcode(path.join(directory, 'before.wav'), ['-i', original, '-af', audition, ...pcm], signal);
  await t.transcode(path.join(directory, 'after.wav'), ['-i', voice, '-af', audition, ...pcm], signal);
  return {
    sample_rate: MixSampleRate,
    start_sample: startSample,
    end_sample_exclusive: endSample,
    total_samples: total,
    replacement_samples: takeLength,
    padding_samples: length - takeLength,
  };
}
