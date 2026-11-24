// timing 块与短语时间轴的数据类型、零值、相等判断、JSON 编解码结构定义。
import type { StructType } from './jsondecode';

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
  return (
    h.peer === '' &&
    h.device === '' &&
    h.bridge === '' &&
    !h.cross_chapter &&
    h.style_shift === '' &&
    h.peer_film_style === ''
  );
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
  return (
    a.background === b.background &&
    a.surface === b.surface &&
    a.ink === b.ink &&
    a.accent === b.accent &&
    a.accent_2 === b.accent_2
  );
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
  return {
    background: l.background,
    surface: l.surface || undefined,
    ink: l.ink,
    accent: l.accent,
    accent_2: l.accent_2 || undefined,
  };
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
