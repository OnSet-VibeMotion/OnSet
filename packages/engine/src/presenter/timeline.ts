/**
 * 真人口播 / 录屏增强双时钟引擎（presenter）：
 * - 严格区分源素材时钟（source_time）与输出时间轴时钟（output_time）；
 * - 支持多段剪切、变速映射：output = timelineStart + (sourceTime - sourceStart) / playbackRate；
 * - 支持将源片字幕/关键词触发点自动重映射到输出时间轴，导出 SRT/VTT，并以注释边界就地更新原生字幕块。
 */
import { formatFixed } from '../gofmt';

export type SegmentRole = 'presenter' | 'screen' | 'broll' | 'motion';

export interface EditSegment {
  id: string;
  source_start: number;
  source_end: number;
  playback_rate?: number;
  role: SegmentRole;
  note?: string;
}

export interface MappedSegment extends EditSegment {
  playback_rate: number;
  output_start: number;
  output_end: number;
  output_duration: number;
}

export interface SourceCue {
  id?: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface OutputCue {
  id: string;
  segment_id: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface CaptionStylePreset {
  preset: 'minimal' | 'highlight' | 'box' | 'editorial';
  position: 'bottom' | 'center' | 'top';
  scale: number;
  visible: boolean;
}

/** 校验并构造从源片选段到输出时间轴的连续映射表。 */
export function buildOutputTimeline(segments: readonly EditSegment[]): {
  segments: MappedSegment[];
  total_duration: number;
} {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('剪辑映射表至少需要包含一个选段');
  }
  const seen = new Set<string>();
  const out: MappedSegment[] = [];
  let cursor = 0;

  for (const seg of segments) {
    if (!seg.id || !/^[a-zA-Z0-9_-]{1,64}$/.test(seg.id)) throw new Error(`非法选段 ID：${String(seg.id)}`);
    if (seen.has(seg.id)) throw new Error(`重复选段 ID：${seg.id}`);
    seen.add(seg.id);
    if (
      !Number.isFinite(seg.source_start) ||
      !Number.isFinite(seg.source_end) ||
      seg.source_start < 0 ||
      seg.source_end <= seg.source_start
    ) {
      throw new Error(`选段 ${seg.id} 的源起止时间无效（${seg.source_start} -> ${seg.source_end}）`);
    }
    const rate = seg.playback_rate ?? 1;
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) {
      throw new Error(`选段 ${seg.id} 的倍速必须在 [0.25, 4] 范围内（当前 ${rate}）`);
    }
    const dur = (seg.source_end - seg.source_start) / rate;
    const outputStart = cursor;
    const outputEnd = cursor + dur;
    out.push({
      ...seg,
      playback_rate: rate,
      output_start: Number(formatFixed(outputStart, 6)),
      output_end: Number(formatFixed(outputEnd, 6)),
      output_duration: Number(formatFixed(dur, 6)),
    });
    cursor = outputEnd;
  }

  return { segments: out, total_duration: Number(formatFixed(cursor, 6)) };
}

/** 将源素材时间点映射到输出时间轴（落在任一保留段内则返回首条匹配输出秒数，否则返回 null）。 */
export function mapSourceTimeToOutput(mapped: readonly MappedSegment[], sourceTime: number): number | null {
  for (const seg of mapped) {
    if (sourceTime >= seg.source_start - 1e-6 && sourceTime <= seg.source_end + 1e-6) {
      const clamped = Math.min(seg.source_end, Math.max(seg.source_start, sourceTime));
      const out = seg.output_start + (clamped - seg.source_start) / seg.playback_rate;
      return Number(formatFixed(out, 6));
    }
  }
  return null;
}

/**
 * 将源素材字幕/关键词事件按剪辑映射表精确重映射到输出时间轴：
 * 被剪掉的片段自动裁除，跨越切点的长句按保留区间裁剪。
 */
export function remapCuesToOutput(mapped: readonly MappedSegment[], cues: readonly SourceCue[]): OutputCue[] {
  const result: OutputCue[] = [];
  let seq = 1;
  for (const seg of mapped) {
    for (const cue of cues) {
      const s = Math.max(cue.start, seg.source_start);
      const e = Math.min(cue.end, seg.source_end);
      if (e - s <= 0.02) continue;
      const outStart = seg.output_start + (s - seg.source_start) / seg.playback_rate;
      const outEnd = seg.output_start + (e - seg.source_start) / seg.playback_rate;
      result.push({
        id: cue.id ? `${cue.id}-${seq++}` : `cue-${seq++}`,
        segment_id: seg.id,
        start: Number(formatFixed(outStart, 3)),
        end: Number(formatFixed(outEnd, 3)),
        text: cue.text.trim(),
        speaker: cue.speaker,
      });
    }
  }
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}

function fmtSrtTime(sec: number, sep: ',' | '.'): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

/** 导出标准 SRT 或 WebVTT 字幕文本。 */
export function formatOutputCues(cues: readonly OutputCue[], format: 'srt' | 'vtt' = 'srt'): string {
  const lines: string[] = format === 'vtt' ? ['WEBVTT', ''] : [];
  const sep = format === 'vtt' ? '.' : ',';
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (format === 'srt') lines.push(String(i + 1));
    lines.push(`${fmtSrtTime(c.start, sep)} --> ${fmtSrtTime(c.end, sep)}`);
    lines.push(c.text);
    lines.push('');
  }
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 以注释边界块（<!-- onset-caption:<trackId>:start --> ... <!-- onset-caption:<trackId>:end -->）
 * 在合成 HTML 中就地写入或更新受管字幕轨道，不破坏镜头其余源码。
 */
export function patchManagedCaptionBlock(
  html: string,
  trackId: string,
  cues: readonly OutputCue[],
  style: CaptionStylePreset,
): string {
  const safeTrack = trackId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const startMark = `<!-- onset-caption:${safeTrack}:start -->`;
  const endMark = `<!-- onset-caption:${safeTrack}:end -->`;
  const posCss =
    style.position === 'top'
      ? 'top:8%;'
      : style.position === 'center'
        ? 'top:50%;transform:translateY(-50%);'
        : 'bottom:10%;';
  const hiddenAttr = style.visible ? '' : ' data-hidden="true" style="display:none"';
  const items = cues
    .map(
      (c) =>
        `  <div class="onset-caption-cue" data-start="${formatFixed(c.start, 3)}" data-duration="${formatFixed(Math.max(0.05, c.end - c.start), 3)}">${escapeHtml(c.text)}</div>`,
    )
    .join('\n');
  const block = [
    startMark,
    `<div data-onset-caption-track="${safeTrack}" data-caption-preset="${style.preset}" data-caption-position="${style.position}" data-caption-scale="${formatFixed(style.scale, 2)}"${hiddenAttr} style="position:absolute;left:6%;right:6%;text-align:center;${posCss}font-size:${Math.round(42 * style.scale)}px;">`,
    items,
    '</div>',
    endMark,
  ].join('\n');

  const sIdx = html.indexOf(startMark);
  const eIdx = html.indexOf(endMark);
  if (sIdx >= 0 && eIdx > sIdx) {
    return html.slice(0, sIdx) + block + html.slice(eIdx + endMark.length);
  }
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + '\n' + block + '\n' + html.slice(bodyClose);
  }
  return html + '\n' + block + '\n';
}
