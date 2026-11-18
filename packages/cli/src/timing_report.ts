import fs from 'node:fs';
import path from 'node:path';
import { totalFrames } from '@onset/engine/frames';
import { atomicWrite } from '@onset/engine/fsutil';
import { goRound } from '@onset/engine/gofmt';
import { marshalIndent } from '@onset/engine/gojson';
import { rejectSymlinkPath } from '@onset/engine/project';
import { contained, sceneCanvas } from '@onset/engine/scene';
import { readCues, readSpan, type Cue } from '@onset/engine/srt';
import { num, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

const sampleRate = 48_000;

export function calculateTimingReport(
  subtitles: readonly Cue[], voice: readonly Cue[], fps: number, closingHoldFrames: number,
  maxClosingHoldFrames?: number, referenceSeconds?: number,
) {
  if (!Number.isSafeInteger(closingHoldFrames) || closingHoldFrames < 0) throw new Error('closing_hold_frames 必须是已批准的非负整数');
  if (maxClosingHoldFrames !== undefined && (!Number.isSafeInteger(maxClosingHoldFrames) || closingHoldFrames > maxClosingHoldFrames)) {
    throw new Error('结尾停留超过已批准的最大尾留白');
  }
  const voiceEnd = voice.reduce((end, cue) => Math.max(end, cue.end_seconds), 0);
  if (voiceEnd <= 0 || !subtitles.length) throw new Error('需要有实际时间戳的配音字幕与定稿字幕');
  const voiceEndFrame = totalFrames(voiceEnd, fps);
  const frames = voiceEndFrame + closingHoldFrames;
  const duration = frames / fps;
  const gaps: Array<{ start_seconds: number; end_seconds: number }> = [];
  let end = 0;
  for (const cue of [...subtitles].sort((a, b) => a.start_seconds - b.start_seconds)) {
    // SRT 只能保留毫秒，允许整数帧终点的毫秒表示有舍入误差。
    if (cue.end_seconds > duration + 0.0005) throw new Error(`第 ${cue.index} 条字幕超出节目终点`);
    if (cue.start_seconds > end) gaps.push({ start_seconds: end, end_seconds: cue.start_seconds });
    end = Math.max(end, cue.end_seconds);
  }
  if (end < duration) gaps.push({ start_seconds: end, end_seconds: duration });
  const subtitleSeconds = end - subtitles.reduce((start, cue) => Math.min(start, cue.start_seconds), end);
  return {
    schema: 1,
    fps,
    total_frames: frames,
    duration_seconds: duration,
    voice_end_seconds: voiceEnd,
    voice_end_frame_exclusive: voiceEndFrame,
    closing_hold_frames: closingHoldFrames,
    max_closing_hold_frames: maxClosingHoldFrames,
    sample_rate: sampleRate,
    target_samples_per_channel: goRound(duration * sampleRate),
    subtitles,
    gaps,
    reference_subtitle_seconds: referenceSeconds,
    subtitle_duration_difference_seconds: referenceSeconds === undefined ? undefined : subtitleSeconds - referenceSeconds,
  };
}

defineOp({
  name: 'timing_report',
  cli: ['audio', 'timing-report'],
  summary: '按定稿字幕、实测语音终点和批准的尾留白生成时长报告',
  description: '帧率取项目画幅，节目终点为语音结束所占最后一帧加 closing_hold_frames。写入 production/timing-report.json，返回总帧数、每声道采样数与报告路径。',
  examples: ['timing_report({"closing_hold_frames": 15, "max_closing_hold_frames": 30})'],
  params: {
    project_root: projectRoot,
    voice_srt: { type: 'string', description: '对齐并校验后的语音字幕', default: 'production/audio/voice.srt' },
    srt: { type: 'string', description: '定稿字幕', default: 'transcription-production.srt' },
    reference_srt: { type: 'string', description: '可选参考字幕，用于比较字幕时间跨度' },
    closing_hold_frames: { type: 'integer', description: '已批准的结尾停留帧数，允许 0', required: true },
    max_closing_hold_frames: { type: 'integer', description: '已批准的最大尾留白帧数，省略时只按已批准的结尾停留帧数', default: -1 },
  },
  run: (p, { out }) => {
    const root = fs.realpathSync(str(p.project_root));
    const reference = str(p.reference_srt);
    const maxHold = p.max_closing_hold_frames;
    const reportFile = path.join(root, 'production/timing-report.json');
    const report = calculateTimingReport(
      readCues(contained(root, str(p.srt), 'srt')),
      readCues(contained(root, str(p.voice_srt), 'voice_srt')),
      sceneCanvas({ directory: root }).fps,
      num(p.closing_hold_frames),
      typeof maxHold === 'number' && maxHold !== -1 ? maxHold : undefined,
      reference ? readSpan(contained(root, reference, 'reference_srt')).seconds() : undefined,
    );
    rejectSymlinkPath(root, reportFile);
    atomicWrite(reportFile, marshalIndent(report) + '\n', 0o644);
    out.write(`已写入 production/timing-report.json，共 ${report.total_frames} 帧，尾留白 ${report.closing_hold_frames} 帧\n`);
    return { data: { report: 'production/timing-report.json', total_frames: report.total_frames, fps: report.fps, target_samples_per_channel: report.target_samples_per_channel } };
  },
});
