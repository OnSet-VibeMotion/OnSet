/**
 * 剪映导出的 FFmpeg 音视频重编码、cue 合成与 README 生成辅助函数。
 */
import { formatFixed, goRound } from '../gofmt';
import type { Toolchain } from '../mediaprobe';
import type { DiscoveredAudioCue } from './collect';
import { DraftCompatibilityNote } from './draft';
import {
  type AudioCueMeta,
  type AudioManifest,
  JianyingAudioChannels,
  JianyingAudioSampleRate,
  type ShotsManifest,
} from './types';

export function roundSeconds(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function framesToUs(frames: number, fps: number): number {
  return goRound((frames / fps) * 1_000_000);
}

/** 精确重编码切镜：libx264 crf 18 + yuv420p + bt709 + 首帧关键帧 + 无音轨，绝不用 -c copy。 */
export async function encodeShotClip(
  toolchain: Toolchain,
  source: string,
  dest: string,
  fps: number,
  trimRange?: { startFrame: number; endFrame: number },
  signal?: AbortSignal,
): Promise<void> {
  const args = ['-i', source];
  if (trimRange) {
    args.push('-vf', `trim=start_frame=${trimRange.startFrame}:end_frame=${trimRange.endFrame},setpts=PTS-STARTPTS`);
  }
  const gop = Math.max(1, goRound(fps));
  args.push(
    '-an',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-g',
    String(gop),
    '-force_key_frames',
    'expr:eq(n,0)',
    '-fps_mode',
    'passthrough',
    '-movflags',
    '+faststart',
  );
  await toolchain.transcode(dest, args, signal);
}

/** 将分轨音频按视频总采样数规范化对齐为 48kHz 立体声 PCM16 WAV。 */
export async function exportAlignedStemFile(
  toolchain: Toolchain,
  source: string,
  dest: string,
  totalSamples: number,
  signal?: AbortSignal,
): Promise<void> {
  const filter = `aformat=sample_fmts=s16:sample_rates=${JianyingAudioSampleRate}:channel_layouts=stereo,asetpts=PTS-STARTPTS,apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}`;
  await toolchain.transcode(
    dest,
    [
      '-i',
      source,
      '-vn',
      '-af',
      filter,
      '-ar',
      String(JianyingAudioSampleRate),
      '-ac',
      String(JianyingAudioChannels),
      '-c:a',
      'pcm_s16le',
    ],
    signal,
  );
}

/** 当没有预混音轨但 cue-sheet.json 存在该类 cue 时，按帧精确合成对齐的分轨 WAV。 */
export async function exportCueSynthesizedStem(
  toolchain: Toolchain,
  cues: readonly DiscoveredAudioCue[],
  dest: string,
  fps: number,
  totalSamples: number,
  signal?: AbortSignal,
): Promise<void> {
  const toSample = (f: number) => goRound((f / fps) * JianyingAudioSampleRate);
  const fmt = `aformat=sample_fmts=fltp:sample_rates=${JianyingAudioSampleRate}:channel_layouts=stereo`;
  const pad = (samples: number) => `apad=whole_len=${samples},atrim=end_sample=${samples}`;
  const inputs = cues.flatMap((c) => ['-i', c.file]);
  const filters = cues.map((c, i) => {
    const start = toSample(c.startFrame);
    const length = Math.max(1, toSample(c.startFrame + c.durationFrames) - start);
    const srcStart = toSample(c.sourceStartFrame);
    const fadeIn = c.fadeInFrames > 0 ? `,afade=t=in:ss=0:ns=${toSample(c.fadeInFrames)}` : '';
    const fadeOutSamples = c.fadeOutFrames > 0 ? Math.min(length, toSample(c.fadeOutFrames)) : 0;
    const fadeOut =
      fadeOutSamples > 0 ? `,afade=t=out:ss=${Math.max(0, length - fadeOutSamples)}:ns=${fadeOutSamples}` : '';
    return `[${i}:a:0]${fmt},atrim=start_sample=${srcStart}:end_sample=${srcStart + length},asetpts=PTS-STARTPTS,${pad(length)},volume=${c.gainDB}dB${fadeIn}${fadeOut},adelay=${start}S:all=1[c${i}]`;
  });
  const mixInputs = cues.map((_, i) => `[c${i}]`).join('');
  filters.push(`${mixInputs}amix=inputs=${cues.length}:normalize=0,${pad(totalSamples)}[stem]`);
  await toolchain.transcode(
    dest,
    [
      ...inputs,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[stem]',
      '-vn',
      '-ar',
      String(JianyingAudioSampleRate),
      '-ac',
      String(JianyingAudioChannels),
      '-c:a',
      'pcm_s16le',
    ],
    signal,
  );
}

export function buildCueMetas(cues: readonly DiscoveredAudioCue[], fps: number): AudioCueMeta[] {
  return cues.map((c) => {
    const startUs = framesToUs(c.startFrame, fps);
    const endUs = framesToUs(c.startFrame + c.durationFrames, fps);
    return {
      asset: c.assetRel,
      start_frame: c.startFrame,
      duration_frames: c.durationFrames,
      offset_seconds: roundSeconds(c.startFrame / fps),
      duration_seconds: roundSeconds(c.durationFrames / fps),
      offset_us: startUs,
      duration_us: Math.max(0, endUs - startUs),
      gain_db: c.gainDB,
      fade_in_seconds: roundSeconds(c.fadeInFrames / fps),
      fade_out_seconds: roundSeconds(c.fadeOutFrames / fps),
    };
  });
}

export function buildReadme(
  name: string,
  shots: ShotsManifest,
  audio: AudioManifest,
  hasSubtitles: boolean,
  includeDraft: boolean,
): string {
  const audioLines =
    audio.tracks.length > 0
      ? audio.tracks
          .map(
            (t) =>
              `- \`${t.file}\`（${t.role}，起点 ${formatFixed(t.offset_seconds, 3)}s，时长 ${formatFixed(t.duration_seconds, 3)}s）`,
          )
          .join('\n')
      : '- （本工程无独立音频轨）';
  const draftSection = includeDraft
    ? `## 剪映草稿骨架说明

本次导出已额外生成 \`draft_content.json\` 与 \`draft_meta_info.json\`。

> **兼容性声明**：${DraftCompatibilityNote}
`
    : `## 如需草稿骨架

如需同时生成通用剪映草稿骨架（\`draft_content.json\` / \`draft_meta_info.json\`），重新导出时传入 \`include_draft: true\` 即可。
`;

  return `# 剪映可二次编辑素材包：${name}

- **画幅与帧率**：${shots.width_px}×${shots.height_px} @ ${shots.fps} fps
- **镜头总数**：${shots.shots.length} 镜（总计 ${shots.total_frames} 帧，${formatFixed(shots.total_duration_seconds, 3)} 秒）
- **编码规格**：H.264（libx264 CRF 18 / yuv420p / BT.709 / 首帧强制关键帧 / 无音轨）

## 目录结构

- \`clips/\`：按镜序精确重编码的纯画面分镜（\`shot-01.mp4\` …），无 GOP 切点漂移
- \`audio/\`：48kHz 立体声 PCM16 分轨音频，已按总帧数与时间轴对齐：
${audioLines}
${hasSubtitles ? '- `subtitles.srt`：全片字幕时间轴\n' : ''}- \`shots.json\`：每镜序号、帧区间、微秒时间码与编码规格
- \`audio.json\`：分轨偏移、增益与 cue 淡入淡出清单

## 在剪映中一键拼回与二次精修

1. 新建草稿，将工程画幅与帧率设为 **${shots.width_px}×${shots.height_px}、${shots.fps}fps**。
2. 将 \`clips/\` 下的 \`shot-01.mp4\` … 全选按文件名顺序拖入主视频轨，即与原片帧级对齐。
3. 将 \`audio/\` 下的分轨音频（如 \`voice.wav\`、\`bgm.wav\`、\`sfx.wav\`）全部对齐时间轴 \`00:00:00\` 拖入独立音轨，可分别微调人声/配乐/音效音量与淡入淡出。
${hasSubtitles ? '4. 导入 `subtitles.srt`（文稿 → 本地字幕）即可叠加完整可编辑字幕轨。\n' : ''}
${draftSection}`;
}
