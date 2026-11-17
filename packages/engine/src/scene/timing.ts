//
// 本文件是口播镜头的时间合同：由 onset scene cues 从字幕或短语锚点推导每个镜头的
// 全局帧区间，写进 scene.json 的 timing 块。
//
// 过去镜头时长由制作者手算（先定帧数，再写 duration_seconds = 帧数 ÷ 帧率），
// 渲染器还要自己从完整字幕里减去镜头起点。两处手算各有一个取整口径，错开一帧
// 只有拼完成片对轴时才看得出来。现在切点只由锚点和 frames.frameOf 一个公式决定，
// 局部帧号由 onset 算好交给渲染器。
import fs from 'node:fs';
import { frameOf } from '../frames';
import { unmarshal as goUnmarshal, type StructType as GoStructType } from '../gojson/decode';
import { formatFixed, formatG, goQuote, goRound, goTrimSpace } from '../gofmt';
import * as srt from '../srt';
import { blockValue, timelineBlocks } from './block';
import { decodeFirst, ptrTo, sliceOf, type StructType } from './jsondecode';
import { sceneCanvas, contained, type Canvas, type Scene } from './scene';
import { verifyFrameAlignment } from './frames';
import { VerificationError } from './verification';

/** onset scene cues 复制进镜头目录的短语时间轴文件名。 */
export const PhraseCopyFile = 'phrase-timeline.json';

/**
 * scene.json 的 timing 块：镜头在全片时间轴上的帧区间。
 * 帧号都是全局帧，区间左闭右开。plan 是分镜计划文件的 SHA-256，
 * 用来发现「计划改了却没重跑 onset scene cues」。phrases 可省略，是镜头目录内
 * 短语时间轴副本的相对路径。
 *
 * chapter、look、enter、exit 抄自分镜计划：渲染器互相看不到，相邻两个镜头只能
 * 从这里拿到同一份配色与交接约定。字段全是可比较的值类型，--check 直接逐字段比对。
 */
export interface Timing {
  fps: number;
  start_frame: number;
  end_frame_exclusive: number;
  plan: string;
  phrases: string;
  chapter: string;
  look: Look;
  /** 上一镜头交给本镜头的交接。 */
  enter: Handoff;
  /** 本镜头交给下一镜头的交接。 */
  exit: Handoff;
}

/** 镜头的帧数。 */
export function timingFrames(t: Pick<Timing, 'start_frame' | 'end_frame_exclusive'>): number {
  return t.end_frame_exclusive - t.start_frame;
}

/**
 * 全片共用的配色。镜头各自选色时，跨章节的两个镜头常常连底色都不同，
 * 转场做得再顺也像换了一条视频。surface 与 accent_2 可省略。
 */
export interface Look {
  background: string;
  surface: string;
  ink: string;
  accent: string;
  accent_2: string;
}

/** 计划里一个交界的交接约定：用哪种手法，以及交界那一帧两侧共有的画面。 */
export interface PlanHandoff {
  device: string;
  bridge: string;
  /** 交界两侧风格不同时必填：风格怎么换过去（StyleShifts）；风格相同时不能写。 */
  style_shift: string;
}

/**
 * 写进 timing 块的一侧交接。peer 是交界另一侧的镜头 id；
 * cross_chapter 标记这是章节交界。零值表示该侧没有交接约定（硬切）。
 */
export interface Handoff {
  peer: string;
  device: string;
  bridge: string;
  cross_chapter: boolean;
  /** 交界两侧风格不同时的切换手法（StyleShifts 的 id）；风格相同时为空。 */
  style_shift: string;
  /**
   * 交界另一侧镜头 scene.json 里的 film_style 原值（空表示默认风格，none 表示不用整片风格）。
   * 记原值而不是解析后的风格：默认风格换了，交接两侧跟着换，不用重跑 cues。
   */
  peer_film_style: string;
}

export function zeroLook(): Look {
  return { background: '', surface: '', ink: '', accent: '', accent_2: '' };
}

export function zeroHandoff(): Handoff {
  return { peer: '', device: '', bridge: '', cross_chapter: false, style_shift: '', peer_film_style: '' };
}

export function lookIsZero(l: Look): boolean {
  return l.background === '' && l.surface === '' && l.ink === '' && l.accent === '' && l.accent_2 === '';
}

export function handoffIsZero(h: Handoff): boolean {
  return h.peer === '' && h.device === '' && h.bridge === '' && !h.cross_chapter && h.style_shift === '' && h.peer_film_style === '';
}

/** Go 的结构体 ==。 */
export function handoffEqual(a: Handoff, b: Handoff): boolean {
  return (
    a.peer === b.peer &&
    a.device === b.device &&
    a.bridge === b.bridge &&
    a.cross_chapter === b.cross_chapter &&
    a.style_shift === b.style_shift &&
    a.peer_film_style === b.peer_film_style
  );
}

/** Go 的结构体 ==。 */
export function lookEqual(a: Look, b: Look): boolean {
  return a.background === b.background && a.surface === b.surface && a.ink === b.ink && a.accent === b.accent && a.accent_2 === b.accent_2;
}

/** Go 的结构体 ==（timing 块的 --check 比对）。 */
export function timingEqual(a: Timing, b: Timing): boolean {
  return (
    a.fps === b.fps &&
    a.start_frame === b.start_frame &&
    a.end_frame_exclusive === b.end_frame_exclusive &&
    a.plan === b.plan &&
    a.phrases === b.phrases &&
    a.chapter === b.chapter &&
    lookEqual(a.look, b.look) &&
    handoffEqual(a.enter, b.enter) &&
    handoffEqual(a.exit, b.exit)
  );
}

/** 零值 timing 块，测试与调用方构造时用。 */
export function newTiming(fields: Partial<Timing> = {}): Timing {
  return {
    fps: 0,
    start_frame: 0,
    end_frame_exclusive: 0,
    plan: '',
    phrases: '',
    chapter: '',
    look: zeroLook(),
    enter: zeroHandoff(),
    exit: zeroHandoff(),
    ...fields,
  };
}

export const lookStructType: StructType = {
  kind: 'struct',
  goName: 'scene.Look',
  name: 'Look',
  fields: [
    ['background', 'string'],
    ['surface', 'string'],
    ['ink', 'string'],
    ['accent', 'string'],
    ['accent_2', 'string'],
  ],
};

const handoffStructType: StructType = {
  kind: 'struct',
  goName: 'scene.Handoff',
  name: 'Handoff',
  fields: [
    ['peer', 'string'],
    ['device', 'string'],
    ['bridge', 'string'],
    ['cross_chapter', 'bool'],
    ['style_shift', 'string'],
    ['peer_film_style', 'string'],
  ],
};

export const timingStructType: StructType = {
  kind: 'struct',
  goName: 'scene.Timing',
  name: 'Timing',
  fields: [
    ['fps', 'int'],
    ['start_frame', 'int'],
    ['end_frame_exclusive', 'int'],
    ['plan', 'string'],
    ['phrases', 'string'],
    ['chapter', 'string'],
    ['look', lookStructType],
    ['enter', handoffStructType],
    ['exit', handoffStructType],
  ],
};

/** 按 Go 的字段顺序与 omitempty 构造 Look 的 JSON 值。 */
export function lookToJSON(l: Look): unknown {
  return { background: l.background, surface: l.surface || undefined, ink: l.ink, accent: l.accent, accent_2: l.accent_2 || undefined };
}

/** 按 Go 的字段顺序与 omitempty 构造 Handoff 的 JSON 值。 */
export function handoffToJSON(h: Handoff): unknown {
  return {
    peer: h.peer,
    device: h.device,
    bridge: h.bridge,
    cross_chapter: h.cross_chapter || undefined,
    style_shift: h.style_shift || undefined,
    peer_film_style: h.peer_film_style || undefined,
  };
}

/** 按 Go 的字段顺序与 omitempty / omitzero 构造 Timing 的 JSON 值（json.Marshal(timing)）。 */
export function timingToJSON(t: Timing): unknown {
  return {
    fps: t.fps,
    start_frame: t.start_frame,
    end_frame_exclusive: t.end_frame_exclusive,
    plan: t.plan,
    phrases: t.phrases || undefined,
    chapter: t.chapter || undefined,
    look: lookIsZero(t.look) ? undefined : lookToJSON(t.look),
    enter: handoffIsZero(t.enter) ? undefined : handoffToJSON(t.enter),
    exit: handoffIsZero(t.exit) ? undefined : handoffToJSON(t.exit),
  };
}

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
  const local = localTranscriptProblem(s, t);
  if (local) problems.push(local);
  if (problems.length > 0) throw fail(...problems);
}

/** 判断「字幕是本镜头本地时间」时给的余量：字幕结尾可以比镜头时长多这么几秒（结尾停留、取整）。 */
const localTranscriptSlackSeconds = 0.5;

/**
 * transcript 是全片字幕（全片时间），onset 按 timing 的帧区间裁出本镜头的几条交给渲染器（scenedata.localCues）。
 * 写成本镜头的本地时间（从 0 秒起）的话，镜头不在片头时一条也裁不到，渲染器拿到「本镜头无字幕」，
 * 与 prompt.md 里的字幕要求互相矛盾，照着数据做就漏烧字幕。2026-11 Qwen4Max 一片：编排给每个镜头写了本地时间的
 * transcript.txt，除了从第 0 帧开始的 001，13 个镜头的字幕数据全是空的，9 个镜头因漏烧字幕返工，约占渲染额度的 30%。
 * 判据：本镜头不从片头开始，而字幕全部落在 [0, 镜头时长] 里——全片字幕不会这样。读不了的文件留给 scenedata 报错。
 */
function localTranscriptProblem(s: Scene, t: Timing): string {
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
    `transcript ${s.transcript} 像是按本镜头的本地时间写的：字幕最晚在 ${formatFixed(lastEnd, 3)} 秒结束，没超出本镜头时长 ${formatFixed(duration, 3)} 秒，` +
    `而本镜头从全片第 ${formatFixed(startSeconds, 3)} 秒开始，按全片时间一条字幕也对不上，渲染器会拿到「本镜头无字幕」。` +
    'transcript 要指向全片字幕（从 transcription-production.srt 复制成镜头目录里的 transcription.srt，时间是全片时间），onset 会按 timing 裁出本镜头的几条，不要自己按镜头切分或改成本地时间'
  );
}

/** phrase-timeline.json 里时间合同用到的字段。帧号是全片全局帧。 */
export interface PhraseEntry {
  phrase_id: string;
  source_text: string;
  start_frame: number;
  end_frame_exclusive: number;
}

/** phrase-timeline.json 的结构（只取时间合同用到的字段）。 */
export interface PhraseTimeline {
  fps: number;
  phrases: PhraseEntry[] | null;
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

/** 分镜计划文件的结构版本。 */
export const TimingPlanSchema = 1;

// 切点规则。锚点前一个文字单位结束到锚点开始之间的空白归谁，由它决定。
/** 缺省规则：切在锚点开始处，空白并入前一个镜头。 */
export const CutNextStart = 'next_start';
/** 切在前一个文字单位结束处，空白并入本镜头。 */
export const CutPrevEnd = 'prev_end';
/** 切在空白正中（向下取整）。 */
export const CutMidGap = 'mid_gap';

/** onset scene cues 的分镜计划。 */
export interface TimingPlan {
  schema: number;
  look: Look | null;
  scenes: PlanEntry[] | null;
}

/**
 * 计划里的一个镜头。first_subtitle 是字幕文件里的序号（按出现顺序，
 * 从 1 开始）；first_phrase 是短语时间轴里的 phrase_id。二者恰好填一个，
 * 第一个镜头可以都不填（它固定从第 0 帧开始）。dir 相对项目根。
 */
export interface PlanEntry {
  id: string;
  dir: string;
  first_subtitle: number | null;
  first_phrase: string;
  cut: string;
  /**
   * 制作提示词第五阶段要求的主要视觉角色，不参与计时，
   * 但写错了就该在这里报：计划是严格解析的，拼错的键不会被静默丢掉。
   */
  visual_role: string;
  /** 给人看的一句话镜头说明，不参与计时。 */
  summary: string;
  /** 镜头所属章节。写了就每个镜头都要写；相邻镜头章节不同即章节交界。 */
  chapter: string;
  /** 从上一镜头进入本镜头的交接，章节交界与风格交界必填。 */
  handoff: PlanHandoff | null;
  /** 本镜头的整片风格：空表示默认风格，「来源/目录名」表示另一种，none 表示不用。由 cues 抄进 scene.json。 */
  film_style: string;
}

/** 零值计划条目，测试与调用方构造时用。 */
export function newPlanEntry(fields: Partial<PlanEntry> = {}): PlanEntry {
  return {
    id: '',
    dir: '',
    first_subtitle: null,
    first_phrase: '',
    cut: '',
    visual_role: '',
    summary: '',
    chapter: '',
    handoff: null,
    film_style: '',
    ...fields,
  };
}

const planEntryType: StructType = {
  kind: 'struct',
  goName: 'scene.PlanEntry',
  name: 'PlanEntry',
  fields: [
    ['id', 'string'],
    ['dir', 'string'],
    ['first_subtitle', ptrTo('int')],
    ['first_phrase', 'string'],
    ['cut', 'string'],
    ['visual_role', 'string'],
    ['summary', 'string'],
    ['chapter', 'string'],
    [
      'handoff',
      ptrTo({
        kind: 'struct',
        goName: 'scene.PlanHandoff',
        name: 'PlanHandoff',
        fields: [
          ['device', 'string'],
          ['bridge', 'string'],
          ['style_shift', 'string'],
        ],
      }),
    ],
    ['film_style', 'string'],
  ],
};

const timingPlanType: StructType = {
  kind: 'struct',
  goName: 'scene.TimingPlan',
  name: 'TimingPlan',
  fields: [
    ['schema', 'int'],
    ['look', ptrTo(lookStructType)],
    ['scenes', sliceOf(planEntryType)],
  ],
};

// 交接手法。全部是「靠画面里的东西接过去」，没有一种是叠加在画面上的通用擦除：
// 章节交界要像章节内部一样自然，不能每次套同一个转场。
export const HandoffCarry = 'carry';
export const HandoffMatch = 'match';
export const HandoffPushIn = 'push_in';
export const HandoffFlood = 'flood';
export const HandoffPan = 'pan';
export const HandoffSettle = 'settle';

/** handoff.device 的合法取值与给渲染器的说明，顺序即文档顺序。 */
export const HandoffDevices: ReadonlyArray<{ id: string; guide: string }> = [
  { id: HandoffCarry, guide: '接力：同一个物件跨过交界，交界帧上它的位置、大小、颜色与状态两侧一致，下一镜头接着让它变化' },
  {
    id: HandoffMatch,
    guide: '形状匹配：上一镜头某元素在末帧的轮廓、位置与大小，与下一镜头某个不同元素在首帧的完全重合（圆点变成地球、进度条变成时间轴）',
  },
  { id: HandoffPushIn, guide: '推进穿越：镜头推进到上一镜头某元素内部，该元素的表面铺满画面，成为下一镜头的底面' },
  { id: HandoffFlood, guide: '色块铺满：上一镜头某元素扩张到铺满画面，它的颜色成为下一镜头开场的底色，再从中长出新内容' },
  {
    id: HandoffPan,
    guide: '平移续接：同一张底面朝一个方向平移，上一镜头内容移出画面，下一镜头内容从另一侧移入，交界帧只剩共享底面与跨界物件',
  },
  { id: HandoffSettle, guide: '退回底色：上一镜头语义元素退场，交界帧只剩全片底色与一个保留元素，下一镜头从这个元素长出' },
];

function handoffDeviceValid(device: string): boolean {
  return HandoffDevices.some((d) => d.id === device);
}

/** 手法的说明；未知手法返回空串。 */
export function handoffGuide(device: string): string {
  return HandoffDevices.find((d) => d.id === device)?.guide ?? '';
}

// 风格切换手法。镜头可以用不同的整片风格，交界两侧风格不同时，交接除了「靠画面里的东西接过去」，
// 还要说清画法怎么从一种换成另一种。每种手法只配几种交接手法：画中画推入只能配推进穿越，
// 靠形状切过去只能配形状匹配或接力——搭错了两侧的说明会自相矛盾。
export const StyleShiftMorph = 'morph';
export const StyleShiftWindow = 'window';
export const StyleShiftSweep = 'sweep';
export const StyleShiftMatchCut = 'match_cut';

/** 风格切换手法：哪一侧负责什么，两侧的渲染器各拿到自己那一段。 */
export interface StyleShift {
  id: string;
  name: string;
  /** 能搭配的 handoff.device。 */
  devices: readonly string[];
  guide: string;
  /** 交界前一侧（上一镜头末段）要做的。 */
  exitDuty: string;
  /** 交界后一侧（下一镜头开场）要做的。 */
  enterDuty: string;
}

export const StyleShifts: readonly StyleShift[] = [
  {
    id: StyleShiftMorph,
    name: '材质转化',
    devices: [HandoffCarry, HandoffMatch, HandoffSettle],
    guide:
      '交接物件不换，换的是它的画法：交界帧两侧都按上一镜头的风格画它；下一镜头开场用 0.5–1.5 秒让它的笔触、材质、线条与配色逐步变成新风格（线稿被填上颜料、墨迹晕成油彩、像素块柔化成笔触、剪纸展开成实物），周围画面跟着它一层层换过去',
    exitDuty: '末段与交界帧全部按本镜头的风格画，交接物件停在 bridge 写的位置与状态，不要提前换画法。',
    enterDuty:
      '第 0 帧按上一镜头的风格画交接物件与 bridge 写到的画面，与上一镜头的交界帧一致；随后 0.5–1.5 秒内从交接物件开始换成本镜头的风格（笔触、材质、线条、配色逐步过渡，不是整画面叠化），其余画面跟着它换；换完之后全部按本镜头的风格。',
  },
  {
    id: StyleShiftWindow,
    name: '画中画推入',
    devices: [HandoffPushIn],
    guide:
      '上一镜头末段，画里某个物件（屏幕、窗、书页、画框、镜面、水面、瞳孔）里出现按下一镜头风格画的画面，镜头推进到它铺满；交界帧就是铺满的那一帧，下一镜头从这里按新风格继续',
    exitDuty:
      '末段 0.5–1.5 秒里，在 bridge 写的那个物件里按下一镜头的风格画出下一镜头开场的画面，镜头推进到它铺满画面；交界帧画面完全是下一镜头的风格，构图与 bridge 一致。物件以外的部分到交界帧前一直按本镜头的风格画。',
    enterDuty: '第 0 帧就是上一镜头推进铺满后的那一帧：按本镜头的风格画，构图与 bridge 一致，然后正常展开。',
  },
  {
    id: StyleShiftSweep,
    name: '画内揭开',
    devices: [HandoffFlood, HandoffPan],
    guide:
      '画里的一样东西扫过画面（翻过的书页、漫开的颜料或墨水、扫过的光带、拉过的幕布、卷过的烟雾），扫过的地方换成新风格；交界帧上它铺满或横跨整个画面',
    exitDuty: '末段让 bridge 写的那样东西按本镜头的风格扫进画面，到交界帧铺满（或横跨）整个画面；交界帧上看不到下一镜头的风格。',
    enterDuty:
      '第 0 帧与上一镜头的交界帧一致：那样东西铺满（或横跨）画面，按上一镜头的风格画；随后它继续扫走，身后露出按本镜头风格画的画面，扫走途中它自己也换成本镜头的画法。',
  },
  {
    id: StyleShiftMatchCut,
    name: '形状匹配切',
    devices: [HandoffMatch, HandoffCarry],
    guide:
      '交界帧两侧各按自己的风格画，靠交接物件的轮廓、位置、大小、朝向与主色完全一致把眼睛带过去；切点前后各留 0.3 秒以上让它静止或匀速，切点上不同时做别的大动作',
    exitDuty: '交界帧上交接物件的轮廓、位置、大小、朝向与主色严格按 bridge，按本镜头的风格画；切点前 0.3 秒内它静止或匀速，其他元素不做大动作。',
    enterDuty: '第 0 帧交接物件的轮廓、位置、大小、朝向与主色严格按 bridge，按本镜头的风格画；切点后 0.3 秒内它静止或匀速，再展开新内容。',
  },
];

/** 风格切换手法；未知时为 undefined。 */
export function styleShiftOf(id: string): StyleShift | undefined {
  return StyleShifts.find((s) => s.id === id);
}

/** film_style 的写法：空、none 或「来源/目录名」。 */
const filmStylePattern = /^[^/\s]+\/[^/\s]+$/;

/** 校验镜头的 film_style 取值写法（不查有没有装）。 */
export function verifyFilmStyleValue(value: string): void {
  if (value === '' || value === 'none' || filmStylePattern.test(value)) return;
  throw new Error(`film_style 只能是空（默认风格）、none（不用整片风格）或「来源/目录名」，收到 ${goQuote(value)}`);
}

const hexColorPattern = /^#[0-9a-fA-F]{6}$/;

/** 限制 bridge 的长度：它描述的是一帧画面，写成段落说明分镜还没想清楚。 */
const maxBridgeRunes = 200;

/** visual_role 的合法取值，与制作提示词第五阶段的四种视觉角色一致。 */
export const VisualRoles: readonly string[] = ['语境', '证据', '机制', '节奏'];

/** 严格解析分镜计划：未知字段、缺字段、锚点写法不合法都直接报错。 */
export function parseTimingPlan(body: string | Uint8Array): TimingPlan {
  let plan: TimingPlan;
  try {
    plan = decodeFirst<TimingPlan>(body, timingPlanType, true);
  } catch (err) {
    throw new Error(`分镜计划不是合法 JSON 或含未知字段：${(err as Error).message}`, { cause: err });
  }
  if (plan.schema !== TimingPlanSchema) throw new Error(`分镜计划的 schema 必须是 ${TimingPlanSchema}，收到 ${plan.schema}`);
  const entries = plan.scenes ?? [];
  if (entries.length === 0) throw new Error('分镜计划的 scenes 为空');
  const ids = new Set<string>();
  const dirs = new Set<string>();
  entries.forEach((entry, i) => {
    const where = `分镜计划第 ${i + 1} 个镜头`;
    if (entry.id === '' || entry.dir === '') throw new Error(`${where}缺少 id 或 dir`);
    if (ids.has(entry.id)) throw new Error(`${where}的 id 重复：${entry.id}`);
    ids.add(entry.id);
    if (dirs.has(entry.dir)) throw new Error(`${where}的 dir 重复：${entry.dir}`);
    dirs.add(entry.dir);
    const hasSub = entry.first_subtitle !== null;
    const hasPhrase = entry.first_phrase !== '';
    if (hasSub && hasPhrase) throw new Error(`${where}（${entry.id}）同时写了 first_subtitle 与 first_phrase，只能填一个`);
    if (i > 0 && !hasSub && !hasPhrase) {
      throw new Error(`${where}（${entry.id}）缺少锚点：除第一个镜头外都要写 first_subtitle 或 first_phrase`);
    }
    if (hasSub && entry.first_subtitle! < 1) {
      throw new Error(`${where}（${entry.id}）的 first_subtitle 从 1 开始，收到 ${entry.first_subtitle}`);
    }
    if (!['', CutNextStart, CutPrevEnd, CutMidGap].includes(entry.cut)) {
      throw new Error(`${where}（${entry.id}）的 cut 只能是 ${CutNextStart}、${CutPrevEnd} 或 ${CutMidGap}，收到 ${goQuote(entry.cut)}`);
    }
    if (entry.visual_role !== '' && !VisualRoles.includes(entry.visual_role)) {
      throw new Error(`${where}（${entry.id}）的 visual_role 只能是 ${VisualRoles.join('、')}，收到 ${goQuote(entry.visual_role)}`);
    }
    if (i === 0 && entry.cut !== '') throw new Error(`${where}（${entry.id}）固定从第 0 帧开始，不能写 cut`);
    try {
      verifyFilmStyleValue(entry.film_style);
    } catch (err) {
      throw new Error(`${where}（${entry.id}）的${(err as Error).message}`);
    }
  });
  verifyLook(plan.look);
  verifyHandoffs(entries);
  return plan;
}

function verifyLook(look: Look | null): void {
  if (look === null) return;
  const problems: string[] = [];
  const fields: Array<[key: string, value: string, required: boolean]> = [
    ['background', look.background, true],
    ['surface', look.surface, false],
    ['ink', look.ink, true],
    ['accent', look.accent, true],
    ['accent_2', look.accent_2, false],
  ];
  for (const [key, value, required] of fields) {
    if (value === '' && required) problems.push(`look.${key} 必填`);
    else if (value !== '' && !hexColorPattern.test(value)) problems.push(`look.${key} 必须是 #RRGGBB，收到 ${goQuote(value)}`);
  }
  if (problems.length > 0) throw new Error(`分镜计划的 look 不合格：${problems.join('；')}`);
}

/**
 * 校验章节与交接约定。
 *
 * 章节交界必须写 handoff：不写就是两个各自成立的镜头硬切在一起，正是要消除的生硬。
 * 相邻两个章节交界不得用同一种手法——每次都同一个动作，观众第二次就看出套路了。
 */
function verifyHandoffs(entries: PlanEntry[]): void {
  let chaptered = 0;
  for (const entry of entries) if (goTrimSpace(entry.chapter) !== '') chaptered++;
  if (chaptered !== 0 && chaptered !== entries.length) {
    throw new Error(`分镜计划的 chapter 要么每个镜头都写，要么都不写（${entries.length} 个镜头里写了 ${chaptered} 个）`);
  }
  const problems: string[] = [];
  let lastChapterDevice = '';
  entries.forEach((entry, i) => {
    const where = `镜头 ${entry.id}`;
    const h = entry.handoff;
    if (i === 0) {
      if (h !== null) problems.push(where + '是第一个镜头，没有上一镜头可交接，不能写 handoff');
      return;
    }
    const crossChapter = chaptered > 0 && entry.chapter !== entries[i - 1].chapter;
    if (h === null) {
      if (crossChapter) problems.push(`${where}开始新章节「${entry.chapter}」，必须写 handoff 说明如何从上一章接过来`);
      return;
    }
    if (!handoffDeviceValid(h.device)) {
      const ids = HandoffDevices.map((d) => d.id);
      problems.push(`${where}的 handoff.device 只能是 ${ids.join('、')}，收到 ${goQuote(h.device)}`);
    }
    if (h.style_shift !== '') {
      const shift = styleShiftOf(h.style_shift);
      if (!shift) {
        problems.push(`${where}的 handoff.style_shift 只能是 ${StyleShifts.map((x) => x.id).join('、')}，收到 ${goQuote(h.style_shift)}`);
      } else if (handoffDeviceValid(h.device) && !shift.devices.includes(h.device)) {
        problems.push(`${where}的 handoff.style_shift ${shift.id} 只能配 device ${shift.devices.join('、')}，收到 ${h.device}`);
      }
    }
    const bridge = goTrimSpace(h.bridge);
    if (bridge === '') problems.push(where + '的 handoff.bridge 为空：要写清交界那一帧两侧共有的画面');
    else if ([...bridge].length > maxBridgeRunes) problems.push(`${where}的 handoff.bridge 超过 ${maxBridgeRunes} 字：只描述交界那一帧`);
    if (crossChapter) {
      if (h.device === lastChapterDevice) problems.push(`${where}与上一个章节交界都用 ${h.device}：相邻章节交界换一种手法`);
      lastChapterDevice = h.device;
    }
  });
  if (problems.length > 0) throw new Error(`分镜计划的章节与交接不合格：\n  - ${problems.join('\n  - ')}`);
}

/** 把计划里的交接约定展开成每个镜头两侧的 Handoff，下标与 plan.scenes 一致。 */
export function planHandoffs(plan: TimingPlan): { enter: Handoff[]; exit: Handoff[] } {
  const scenes = plan.scenes ?? [];
  const enter = scenes.map(() => zeroHandoff());
  const exit = scenes.map(() => zeroHandoff());
  for (let i = 1; i < scenes.length; i++) {
    const h = scenes[i].handoff;
    if (h === null) continue;
    const cross = scenes[i].chapter !== scenes[i - 1].chapter;
    const bridge = goTrimSpace(h.bridge);
    const shift = h.style_shift;
    enter[i] = {
      peer: scenes[i - 1].id,
      device: h.device,
      bridge,
      cross_chapter: cross,
      style_shift: shift,
      peer_film_style: shift !== '' ? scenes[i - 1].film_style : '',
    };
    exit[i - 1] = {
      peer: scenes[i].id,
      device: h.device,
      bridge,
      cross_chapter: cross,
      style_shift: shift,
      peer_film_style: shift !== '' ? scenes[i].film_style : '',
    };
  }
  return { enter, exit };
}

/**
 * 校验风格交界：相邻镜头实际用的风格（effective 把 film_style 原值换成风格标识，不用整片风格时为空）
 * 不同时必须写 handoff 与 style_shift，相同时不能写 style_shift。
 *
 * 风格不同却没有约定的话，两侧各画各的硬切在一起，画法突变比章节硬切更扎眼。
 * 这一条要知道项目的默认风格是哪种，所以不在 parseTimingPlan 里，由 onset scene cues 调用。
 */
export function verifyStyleBoundaries(plan: TimingPlan, effective: (filmStyle: string) => string): void {
  const scenes = plan.scenes ?? [];
  const problems: string[] = [];
  for (let i = 1; i < scenes.length; i++) {
    const prev = effective(scenes[i - 1].film_style);
    const cur = effective(scenes[i].film_style);
    const h = scenes[i].handoff;
    const where = `镜头 ${scenes[i].id}`;
    const label = (key: string) => (key === '' ? '不用整片风格' : key);
    if (prev !== cur) {
      if (h === null) problems.push(`${where}从 ${label(prev)} 换成 ${label(cur)}：风格交界必须写 handoff 与 handoff.style_shift，说明画法怎么换过去`);
      else if (h.style_shift === '') problems.push(`${where}从 ${label(prev)} 换成 ${label(cur)}：handoff 要写 style_shift（${StyleShifts.map((x) => x.id).join('、')}）`);
    } else if (h !== null && h.style_shift !== '') {
      problems.push(`${where}与上一镜头都是 ${label(cur)}，不是风格交界，不要写 style_shift`);
    }
  }
  if (problems.length > 0) throw new Error(`分镜计划的风格交界不合格：\n  - ${problems.join('\n  - ')}`);
}

/** layoutTiming 算出的一个镜头区间（全局帧，左闭右开）。 */
export interface TimingSegment {
  id: string;
  dir: string;
  startFrame: number;
  endFrameExclusive: number;
}

/** 镜头的帧数。 */
export function segmentFrames(s: TimingSegment): number {
  return s.endFrameExclusive - s.startFrame;
}

/** 一个可作锚点的文字单位（一条字幕或一条短语），帧号是全局帧。 */
interface AnchorUnit {
  start: number;
  end: number;
  order: number;
}

/** 把字幕换成帧区间。秒到帧只经 frames.frameOf 一个公式。 */
function unitsFromCues(cues: readonly srt.Cue[], fps: number): AnchorUnit[] {
  return cues.map((c, i) => ({ start: frameOf(c.start_seconds, fps), end: frameOf(c.end_seconds, fps), order: i }));
}

/**
 * 按时间排序后紧挨在 target 之前的那个单位的结束帧；
 * target 是最早的单位时返回 null。
 */
function previousEnd(units: AnchorUnit[], target: number): number | null {
  const sorted = [...units].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].order === target) return i === 0 ? null : sorted[i - 1].end;
  }
  return null;
}

/**
 * 按切点规则算出镜头边界。前一个单位与锚点重叠（结束晚于锚点开始）
 * 时没有空白可分，三种规则都切在锚点开始处，保证锚点的文字不会落进上一个镜头。
 */
function cutFrame(rule: string, anchorStart: number, prevEnd: number | null): number {
  if (prevEnd === null || prevEnd >= anchorStart) return anchorStart;
  switch (rule) {
    case CutPrevEnd:
      return prevEnd;
    case CutMidGap:
      return Math.trunc((prevEnd + anchorStart) / 2);
    default:
      return anchorStart;
  }
}

/**
 * 由分镜计划的锚点推导每个镜头的全局帧区间。
 *
 * 第一个镜头从第 0 帧开始，最后一个镜头到 total 结束；其余边界由锚点与切点
 * 规则决定。锚点必须严格递增，每个镜头至少一帧，合计正好 total 帧。
 * phrases 为 null 时计划里不能出现 first_phrase。
 */
export function layoutTiming(plan: TimingPlan, cues: readonly srt.Cue[], phrases: PhraseTimeline | null, fps: number, total: number): TimingSegment[] {
  if (fps <= 0) throw new Error(`帧率必须是正整数，收到 ${fps}`);
  if (total <= 0) throw new Error(`总帧数必须是正整数，收到 ${total}`);
  if (phrases !== null && phrases.fps !== fps) throw new Error(`短语时间轴是 ${phrases.fps}fps，镜头是 ${fps}fps`);
  const subUnits = unitsFromCues(cues, fps);
  const phraseUnits: AnchorUnit[] = [];
  const phraseIndex = new Map<string, number>();
  if (phrases !== null) {
    (phrases.phrases ?? []).forEach((p, i) => {
      phraseUnits.push({ start: p.start_frame, end: p.end_frame_exclusive, order: i });
      phraseIndex.set(p.phrase_id, i);
    });
  }
  const scenes = plan.scenes ?? [];
  const boundaries = scenes.map(() => 0);
  let lastAnchor = -1;
  let lastAnchorName = '';
  for (let i = 0; i < scenes.length; i++) {
    const entry = scenes[i];
    let units: AnchorUnit[];
    let target: number;
    let name: string;
    if (entry.first_subtitle !== null) {
      const n = entry.first_subtitle;
      if (n < 1 || n > subUnits.length) throw new Error(`镜头 ${entry.id} 的 first_subtitle ${n} 超出字幕范围（共 ${subUnits.length} 条）`);
      units = subUnits;
      target = n - 1;
      name = `第 ${n} 条字幕`;
    } else if (entry.first_phrase !== '') {
      if (phrases === null) throw new Error(`镜头 ${entry.id} 用短语 ${entry.first_phrase} 作锚点，但没有提供短语时间轴（--phrases）`);
      const index = phraseIndex.get(entry.first_phrase);
      if (index === undefined) throw new Error(`镜头 ${entry.id} 的 first_phrase ${entry.first_phrase} 不在短语时间轴里`);
      units = phraseUnits;
      target = index;
      name = '短语 ' + entry.first_phrase;
    } else {
      // 只有第一个镜头可以不写锚点，parseTimingPlan 已保证。
      boundaries[i] = 0;
      continue;
    }
    const anchorStart = units[target].start;
    if (anchorStart <= lastAnchor) {
      throw new Error(
        `锚点必须严格递增：镜头 ${entry.id} 的${name}从第 ${anchorStart} 帧开始，不晚于上一个锚点${lastAnchorName}（第 ${lastAnchor} 帧）`,
      );
    }
    lastAnchor = anchorStart;
    lastAnchorName = name;
    if (i === 0) {
      boundaries[i] = 0;
      continue;
    }
    boundaries[i] = cutFrame(entry.cut, anchorStart, previousEnd(units, target));
  }
  const segments: TimingSegment[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const entry = scenes[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : total;
    if (end <= boundaries[i]) {
      if (i + 1 === boundaries.length) {
        throw new Error(`最后一个镜头 ${entry.id} 从第 ${boundaries[i]} 帧开始，不早于总帧数 ${total}：锚点超出了全片`);
      }
      throw new Error(`镜头 ${entry.id} 不足一帧：边界第 ${boundaries[i]} 帧到第 ${end} 帧，切点必须严格递增`);
    }
    segments.push({ id: entry.id, dir: entry.dir, startFrame: boundaries[i], endFrameExclusive: end });
  }
  const sum = segments.reduce((acc, s) => acc + segmentFrames(s), 0);
  if (sum !== total) throw new Error(`镜头帧数合计 ${sum}，不等于总帧数 ${total}`);
  return segments;
}

/**
 * 写进 scene.json 的 duration_seconds 字面量：帧数 ÷ 帧率，保留 6 位小数。
 * 6 位小数在常见帧率下离整数帧不到 1e-4 帧，round(时长 × 帧率) 总能还原帧数，
 * 也能通过 verifyFrameAlignment。
 */
export function durationLiteral(frames: number, fps: number): string {
  return formatFixed(frames / fps, 6);
}
