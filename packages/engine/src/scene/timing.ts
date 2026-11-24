//
// 本文件是口播镜头的时间合同：由 onset scene cues 从字幕或短语锚点推导每个镜头的
// 全局帧区间，写进 scene.json 的 timing 块。
//
// 过去镜头时长由制作者手算（先定帧数，再写 duration_seconds = 帧数 ÷ 帧率），
// 渲染器还要自己从完整字幕里减去镜头起点。两处手算各有一个取整口径，错开一帧
// 只有拼完成片对轴时才看得出来。现在切点只由锚点和 frames.frameOf 一个公式决定，
// 局部帧号由 onset 算好交给渲染器。
import fs from 'node:fs';
import { formatFixed, formatG, goRound, goTrimSpace } from '../gofmt';
import { type StructType as GoStructType, unmarshal as goUnmarshal } from '../gojson/decode';
import * as srt from '../srt';
import { blockValue, timelineBlocks } from './block';
import { verifyFrameAlignment } from './frames';
import { type Canvas, contained, type Scene, sceneCanvas } from './scene';
import { handoffDeviceValid, verifyLook } from './timing_handoff';
import { handoffIsZero, lookIsZero, type PhraseTimeline, timingFrames } from './timing_types';
import { VerificationError } from './verification';

export {
  HandoffCarry,
  HandoffDevices,
  HandoffFlood,
  HandoffMatch,
  HandoffPan,
  HandoffPushIn,
  HandoffSettle,
  handoffGuide,
  type StyleShift,
  StyleShiftMatchCut,
  StyleShiftMorph,
  StyleShiftSweep,
  StyleShifts,
  StyleShiftWindow,
  styleShiftOf,
  verifyFilmStyleValue,
} from './timing_handoff';
export { durationLiteral, layoutTiming, segmentFrames, type TimingSegment } from './timing_layout';
export {
  CutMidGap,
  CutNextStart,
  CutPrevEnd,
  newPlanEntry,
  type PlanEntry,
  parseTimingPlan,
  planHandoffs,
  type TimingPlan,
  TimingPlanSchema,
  VisualRoles,
  verifyStyleBoundaries,
} from './timing_plan';
export {
  type Handoff,
  handoffEqual,
  handoffIsZero,
  handoffToJSON,
  type Look,
  lookEqual,
  lookIsZero,
  lookStructType,
  lookToJSON,
  newTiming,
  PhraseCopyFile,
  type PhraseEntry,
  type PhraseTimeline,
  type PlanHandoff,
  type Timing,
  timingEqual,
  timingFrames,
  timingStructType,
  timingToJSON,
  zeroHandoff,
  zeroLook,
} from './timing_types';

const sha256Pattern = /^[0-9a-f]{64}$/;

/**
 * 核对镜头的 timing 块；渲染前与复用已有产物前都要过一遍。
 *
 * 与卡点块的输入校验不同，没有 timing 块的镜头直接放行：老项目的镜头时长
 * 是手写的，强制要求这一块会让它们全部渲染不了。帧数比对是精确的，
 * 任何偏差都说明有人手改了 duration_seconds。全部问题一次报出。
 */
export function verifyTimingInputs(s: Scene): void {
  const t = s.timing;
  if (t === null) return;
  const fail = (...problems: string[]) => new VerificationError(s.output, problems);
  // 自带时间轴的扩展块（歌曲、卡点）与 timing 互斥；报错按 order 列出它们。
  const owners = timelineBlocks();
  if (owners.some((b) => blockValue(s, b.key) !== null)) {
    throw fail(
      `timing 块不能与 ${owners.map((b) => b.key).join(' 或 ')} 块同时出现：口播、${owners.map((b) => b.timeline!.label).join('、')}的时间轴来源互斥`,
    );
  }
  let canvas: Canvas;
  try {
    canvas = sceneCanvas(s);
  } catch (err) {
    throw fail((err as Error).message);
  }
  const problems: string[] = [];
  if (t.fps !== canvas.fps) problems.push(`timing.fps 是 ${t.fps}，画幅是 ${canvas.fps}fps，请重新运行 scene_cues()`);
  if (t.start_frame < 0 || t.end_frame_exclusive <= t.start_frame) {
    problems.push(`timing 的帧区间无效：[${t.start_frame}, ${t.end_frame_exclusive})`);
  }
  if (!sha256Pattern.test(t.plan)) problems.push('timing.plan 必须是分镜计划文件的 SHA-256（64 位小写十六进制）');
  if (t.fps > 0 && t.end_frame_exclusive > t.start_frame) {
    const got = goRound(s.duration_seconds * t.fps);
    if (got !== timingFrames(t)) {
      problems.push(
        `duration_seconds ${formatG(s.duration_seconds)} 秒是 ${got} 帧，timing 块是 ${timingFrames(t)} 帧：镜头时长由 scene_cues() 写入，不要手改`,
      );
    }
  }
  try {
    verifyFrameAlignment(s);
  } catch (err) {
    problems.push((err as Error).message);
  }
  if (!lookIsZero(t.look)) {
    try {
      verifyLook(t.look);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  for (const [name, h] of [
    ['enter', t.enter],
    ['exit', t.exit],
  ] as const) {
    if (!handoffIsZero(h) && (!handoffDeviceValid(h.device) || h.peer === '' || goTrimSpace(h.bridge) === '')) {
      problems.push(`timing.${name} 不完整或手法未知：交接约定由 scene_cues() 写入，不要手改`);
    }
  }
  if (t.phrases !== '') {
    try {
      loadPhraseTimelineIn(s.directory, t.phrases, t.fps);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  if (problems.length > 0) throw fail(...problems);
}

/** 判断「字幕是本镜头本地时间」时给的余量：字幕结尾可以比镜头时长多这么几秒（结尾停留、取整）。 */
const localTranscriptSlackSeconds = 0.5;

/**
 * transcript 是全片字幕（全片时间），onset 按 timing 的帧区间裁出本镜头的几条交给渲染器（scenedata.localCues）。
 * 写成本镜头的本地时间（从 0 秒起）的话，镜头不在片头时一条也裁不到，渲染器拿到「本镜头无字幕」，
 * 与 prompt.md 里的字幕要求互相矛盾，照着数据做就漏烧字幕。2026-11 Qwen4Max 一片：编排给每个镜头写了本地时间的
 * transcript.txt，除了从第 0 帧开始的 001，13 个镜头的字幕数据全是空的，9 个镜头因漏烧字幕返工，约占渲染额度的 30%。
 * 字幕较早结束也可能是全片后段没有旁白；这个启发式只提醒核对，不能证明时间来源或阻断验收。
 */
export function transcriptTimingWarning(s: Scene): string {
  const t = s.timing;
  if (!t) return '';
  if (t.fps <= 0 || t.end_frame_exclusive <= t.start_frame) return '';
  const startSeconds = t.start_frame / t.fps;
  if (startSeconds <= localTranscriptSlackSeconds) return '';
  let cues: srt.Cue[];
  try {
    cues = srt.readCues(contained(s.directory, s.transcript, 'transcript'));
  } catch {
    return '';
  }
  if (cues.length === 0) return '';
  const duration = timingFrames(t) / t.fps;
  const lastEnd = Math.max(...cues.map((c) => c.end_seconds));
  if (lastEnd > duration + localTranscriptSlackSeconds) return '';
  return (
    `transcript ${s.transcript} 可能按本镜头的本地时间写了，请核对来源：字幕最晚在 ${formatFixed(lastEnd, 3)} 秒结束，没超出本镜头时长 ${formatFixed(duration, 3)} 秒，` +
    `而本镜头从全片第 ${formatFixed(startSeconds, 3)} 秒开始，请确认这些是全片时间；全片后段没有旁白时可以保留。` +
    'transcript 要指向全片字幕（从 transcription-production.srt 复制成镜头目录里的 transcription.srt，时间是全片时间），onset 会按 timing 裁出本镜头的几条，不要自己按镜头切分或改成本地时间'
  );
}

const phraseTimelineType: GoStructType = {
  kind: 'struct',
  goName: 'scene.PhraseTimeline',
  name: 'PhraseTimeline',
  fields: [
    ['fps', 'int'],
    [
      'phrases',
      {
        kind: 'slice',
        elem: {
          kind: 'struct',
          goName: 'scene.PhraseEntry',
          name: 'PhraseEntry',
          fields: [
            ['phrase_id', 'string'],
            ['source_text', 'string'],
            ['start_frame', 'int'],
            ['end_frame_exclusive', 'int'],
          ],
        },
      },
    ],
  ],
};

/**
 * 解析并校验短语时间轴：fps 与期望一致、短语 id 唯一非空、
 * 每条短语至少一帧。wantFPS 为 0 时不比对帧率。
 */
export function parsePhraseTimeline(body: string | Uint8Array, wantFPS: number): PhraseTimeline {
  let t: PhraseTimeline;
  try {
    t = goUnmarshal<PhraseTimeline>(body, phraseTimelineType);
  } catch (err) {
    throw new Error(`短语时间轴不是合法 JSON 或字段类型不符：${(err as Error).message}`, { cause: err });
  }
  if (t.fps <= 0) throw new Error('短语时间轴缺少正整数 fps');
  if (wantFPS > 0 && t.fps !== wantFPS) throw new Error(`短语时间轴是 ${t.fps}fps，镜头是 ${wantFPS}fps`);
  const phrases = t.phrases ?? [];
  if (phrases.length === 0) throw new Error('短语时间轴的 phrases 为空');
  const seen = new Set<string>();
  phrases.forEach((p, i) => {
    if (goTrimSpace(p.phrase_id) === '') throw new Error(`短语时间轴第 ${i + 1} 条缺少 phrase_id`);
    if (seen.has(p.phrase_id)) throw new Error(`短语时间轴的 phrase_id 重复：${p.phrase_id}`);
    seen.add(p.phrase_id);
    if (p.start_frame < 0 || p.end_frame_exclusive <= p.start_frame) {
      throw new Error(`短语 ${p.phrase_id} 的帧区间无效：[${p.start_frame}, ${p.end_frame_exclusive})`);
    }
  });
  return t;
}

/** 读取镜头目录内的短语时间轴副本，路径不得逃出镜头目录。 */
export function loadPhraseTimelineIn(directory: string, relative: string, wantFPS: number): PhraseTimeline {
  const file = contained(directory, relative, 'timing.phrases');
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`timing.phrases 指向的文件无法读取：${relative}`, { cause: err });
  }
  try {
    return parsePhraseTimeline(body, wantFPS);
  } catch (err) {
    throw new Error(`${relative}：${(err as Error).message}`, { cause: err });
  }
}
