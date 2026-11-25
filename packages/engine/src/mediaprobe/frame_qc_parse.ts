// FFmpeg 全流帧检的 stderr 增量解析与视频告警构造。
import {
  clampFrame,
  type EdgeFrameResult,
  type FrameQCEdge,
  type FrameQCIssue,
  type FrameQCScene,
  type FrameQCSeverity,
  makeIssue,
  round3,
  type SignalFrame,
  type TimeInterval,
} from './frame_qc_types';
import { formatFixed, goRound } from './gofmt';

const edgeOrder: readonly FrameQCEdge[] = ['top', 'bottom', 'left', 'right'];
const edgeLabel: Record<FrameQCEdge, string> = { top: '顶边', bottom: '底边', left: '左边', right: '右边' };

const reFrameHeader = /frame:(\d+)[\t ]+pts:[^\t ]+[\t ]+pts_time:([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reYMin = /lavfi\.signalstats\.YMIN=([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reYAvg = /lavfi\.signalstats\.YAVG=([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reYMax = /lavfi\.signalstats\.YMAX=([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reBlack =
  /black_start:([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[\t ]+black_end:([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[\t ]+black_duration:([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reFreezeStart = /lavfi\.freezedetect\.freeze_start:[\t ]*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reFreezeEnd = /lavfi\.freezedetect\.freeze_end:[\t ]*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;
const reFreezeDuration = /lavfi\.freezedetect\.freeze_duration:[\t ]*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/** 按行增量解析 FFmpeg stderr 中的 signalstats、blackdetect 与 freezedetect 事件。 */
export class VideoLogParser {
  readonly frames: SignalFrame[] = [];
  readonly blacks: TimeInterval[] = [];
  readonly freezes: TimeInterval[] = [];
  private current: SignalFrame | null = null;
  private openFreezeStart: number | null = null;
  private pendingFreezeDuration: number | null = null;
  private remainder = '';

  feed(chunk: string): void {
    const lines = (this.remainder + chunk).split(/\r?\n/);
    this.remainder = lines.pop() ?? '';
    for (const line of lines) this.parseLine(line);
  }

  finish(totalDurationSeconds: number, minFreezeSeconds: number): void {
    if (this.remainder) {
      this.parseLine(this.remainder);
      this.remainder = '';
    }
    if (this.current) {
      this.frames.push(this.current);
      this.current = null;
    }
    if (this.openFreezeStart !== null) {
      const duration = Math.max(0, totalDurationSeconds - this.openFreezeStart);
      if (duration >= minFreezeSeconds - 1e-3) {
        this.freezes.push({
          startSeconds: this.openFreezeStart,
          endSeconds: totalDurationSeconds,
          durationSeconds: duration,
        });
      }
      this.openFreezeStart = null;
    }
  }

  private parseLine(line: string): void {
    let m = reFrameHeader.exec(line);
    if (m) {
      if (this.current) this.frames.push(this.current);
      this.current = { frame: Number(m[1]), ptsTime: Number(m[2]), ymin: 0, yavg: 0, ymax: 0 };
      return;
    }
    if (this.current) {
      if ((m = reYMin.exec(line))) {
        this.current.ymin = Number(m[1]);
        return;
      }
      if ((m = reYAvg.exec(line))) {
        this.current.yavg = Number(m[1]);
        return;
      }
      if ((m = reYMax.exec(line))) {
        this.current.ymax = Number(m[1]);
        return;
      }
    }
    if ((m = reBlack.exec(line))) {
      this.blacks.push({ startSeconds: Number(m[1]), endSeconds: Number(m[2]), durationSeconds: Number(m[3]) });
      return;
    }
    if ((m = reFreezeStart.exec(line))) {
      this.openFreezeStart = Number(m[1]);
      this.pendingFreezeDuration = null;
      return;
    }
    if ((m = reFreezeDuration.exec(line))) {
      this.pendingFreezeDuration = Number(m[1]);
      return;
    }
    if ((m = reFreezeEnd.exec(line))) {
      const endSeconds = Number(m[1]);
      const startSeconds = this.openFreezeStart ?? Math.max(0, endSeconds - (this.pendingFreezeDuration ?? 0));
      const durationSeconds = this.pendingFreezeDuration ?? Math.max(0, endSeconds - startSeconds);
      this.freezes.push({ startSeconds, endSeconds, durationSeconds });
      this.openFreezeStart = null;
      this.pendingFreezeDuration = null;
    }
  }
}

export interface VideoAnalyzeParams {
  fps: number;
  totalFrames: number;
  scenes: readonly FrameQCScene[];
  frames: readonly SignalFrame[];
  blacks: readonly TimeInterval[];
  freezes: readonly TimeInterval[];
  edges: readonly EdgeFrameResult[];
  freezeSeconds: number;
  freezeWarnMultiplier: number;
  freezeFailMultiplier: number;
  flashDelta: number;
  flashNeighborTolerance: number;
  flatRangeThreshold: number;
  minEdgeFrames: number;
}

/** 汇总全部视频类检测结果（黑场、单帧闪烁、平场/空白帧、边缘贴边、静止段）。 */
export function buildVideoIssues(params: VideoAnalyzeParams): FrameQCIssue[] {
  const { fps, totalFrames } = params;
  const issues: FrameQCIssue[] = [];
  const skip = new Set<number>();

  for (const item of params.blacks) {
    const startFrame = clampFrame(goRound(item.startSeconds * fps), totalFrames);
    const endFrame = clampFrame(Math.max(startFrame, goRound(item.endSeconds * fps) - 1), totalFrames);
    const count = endFrame - startFrame + 1;
    for (let f = startFrame; f <= endFrame; f++) skip.add(f);
    issues.push(
      makeIssue(params, {
        kind: 'black',
        severity: count >= 2 ? 'fail' : 'warn',
        startFrame,
        endFrame,
        message: `检测到黑场（第 ${startFrame}–${endFrame} 帧，共 ${count} 帧 / ${formatFixed(count / fps, 3)}s）`,
        metrics: { frame_count: count },
      }),
    );
  }

  for (let i = 1; i + 1 < params.frames.length; i++) {
    const [prev, curr, next] = [params.frames[i - 1], params.frames[i], params.frames[i + 1]];
    const dPrev = curr.yavg - prev.yavg;
    const dNext = curr.yavg - next.yavg;
    if (!((dPrev > 0 && dNext > 0) || (dPrev < 0 && dNext < 0))) continue;
    const minJump = Math.min(Math.abs(dPrev), Math.abs(dNext));
    if (minJump < params.flashDelta) continue;
    if (Math.abs(prev.yavg - next.yavg) > Math.max(params.flashNeighborTolerance, minJump * 0.6)) continue;
    skip.add(curr.frame);
    issues.push(
      makeIssue(params, {
        kind: 'flash',
        severity: 'fail',
        startFrame: curr.frame,
        endFrame: curr.frame,
        message: `检测到单帧${dPrev > 0 ? '亮闪' : '暗闪'}（第 ${curr.frame} 帧，YAVG=${formatFixed(curr.yavg, 1)}，相邻帧 ${formatFixed(prev.yavg, 1)}/${formatFixed(next.yavg, 1)}）`,
        metrics: { yavg: round3(curr.yavg), prev_yavg: round3(prev.yavg), next_yavg: round3(next.yavg) },
      }),
    );
  }

  let blankStart = -1;
  let blankLast = -1;
  const flushBlank = () => {
    if (blankStart < 0) return;
    const count = blankLast - blankStart + 1;
    issues.push(
      makeIssue(params, {
        kind: 'blank',
        severity: count >= 3 ? 'fail' : 'warn',
        startFrame: blankStart,
        endFrame: blankLast,
        message: `检测到空白/平场帧（第 ${blankStart}–${blankLast} 帧，共 ${count} 帧）`,
        metrics: { frame_count: count },
      }),
    );
    blankStart = -1;
    blankLast = -1;
  };
  for (const f of params.frames) {
    if (!skip.has(f.frame) && f.ymax - f.ymin <= params.flatRangeThreshold) {
      if (blankStart < 0) blankStart = f.frame;
      else if (f.frame > blankLast + 1) {
        flushBlank();
        blankStart = f.frame;
      }
      blankLast = f.frame;
    } else {
      flushBlank();
    }
  }
  flushBlank();

  for (const edge of edgeOrder) {
    let runStart = -1;
    let runLast = -1;
    let peakGrad = 0;
    let peakStd = 0;
    const flushEdge = () => {
      if (runStart < 0) return;
      const count = runLast - runStart + 1;
      if (count >= params.minEdgeFrames) {
        issues.push(
          makeIssue(params, {
            kind: 'edge_clip',
            severity: 'warn',
            edge,
            startFrame: runStart,
            endFrame: runLast,
            message: `${edgeLabel[edge]}存在内容贴边/裁切风险（第 ${runStart}–${runLast} 帧，共 ${count} 帧）`,
            metrics: { max_grad: round3(peakGrad), max_stddev: round3(peakStd), frame_count: count },
          }),
        );
      }
      runStart = -1;
      runLast = -1;
      peakGrad = 0;
      peakStd = 0;
    };
    for (let i = 0; i < params.edges.length; i++) {
      const m = params.edges[i][edge];
      if (!skip.has(i) && m.clipped) {
        if (runStart < 0) runStart = i;
        runLast = i;
        if (m.maxGrad > peakGrad) peakGrad = m.maxGrad;
        if (m.stddev > peakStd) peakStd = m.stddev;
      } else {
        flushEdge();
      }
    }
    flushEdge();
  }

  const warnSec = params.freezeSeconds * params.freezeWarnMultiplier;
  const failSec = params.freezeSeconds * params.freezeFailMultiplier;
  for (const item of params.freezes) {
    if (item.durationSeconds < params.freezeSeconds - 1e-3) continue;
    const startFrame = clampFrame(goRound(item.startSeconds * fps), totalFrames);
    const endFrame = clampFrame(Math.max(startFrame, goRound(item.endSeconds * fps) - 1), totalFrames);
    const severity: FrameQCSeverity =
      item.durationSeconds >= failSec ? 'fail' : item.durationSeconds >= warnSec ? 'warn' : 'info';
    issues.push(
      makeIssue(params, {
        kind: 'freeze',
        severity,
        startFrame,
        endFrame,
        durationSeconds: item.durationSeconds,
        message: `检测到${severity === 'info' ? '短暂停留' : '长静止段'}（第 ${startFrame}–${endFrame} 帧，时长 ${formatFixed(item.durationSeconds, 2)}s，阈值 ${formatFixed(params.freezeSeconds, 2)}s）`,
        metrics: { freeze_seconds: round3(item.durationSeconds) },
      }),
    );
  }
  return issues;
}
