// 分镜计划（TimingPlan）的解析、章节与交接校验、风格交界校验与交接展开。
import { normalizeMotionEffects } from '../flow';
import { goQuote, goTrimSpace } from '../gofmt';
import { decodeFirst, ptrTo, type StructType, sliceOf } from './jsondecode';
import {
  HandoffDevices,
  handoffDeviceValid,
  StyleShifts,
  styleShiftOf,
  verifyFilmStyleValue,
  verifyLook,
} from './timing_handoff';
import { type Handoff, type Look, lookStructType, type PlanHandoff, zeroHandoff } from './timing_types';

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
  /** 本镜头在分镜阶段选定的核心动效标识（如 "motion-prompt:005"），最多 3 条；由 cues 抄进 scene.json。 */
  motion_effects?: string[];
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
    motion_effects: [],
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
    ['motion_effects', sliceOf('string')],
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
  if (plan.schema !== TimingPlanSchema)
    throw new Error(`分镜计划的 schema 必须是 ${TimingPlanSchema}，收到 ${plan.schema}`);
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
    if (hasSub && hasPhrase)
      throw new Error(`${where}（${entry.id}）同时写了 first_subtitle 与 first_phrase，只能填一个`);
    if (i > 0 && !hasSub && !hasPhrase) {
      throw new Error(`${where}（${entry.id}）缺少锚点：除第一个镜头外都要写 first_subtitle 或 first_phrase`);
    }
    if (hasSub && entry.first_subtitle! < 1) {
      throw new Error(`${where}（${entry.id}）的 first_subtitle 从 1 开始，收到 ${entry.first_subtitle}`);
    }
    if (!['', CutNextStart, CutPrevEnd, CutMidGap].includes(entry.cut)) {
      throw new Error(
        `${where}（${entry.id}）的 cut 只能是 ${CutNextStart}、${CutPrevEnd} 或 ${CutMidGap}，收到 ${goQuote(entry.cut)}`,
      );
    }
    if (entry.visual_role !== '' && !VisualRoles.includes(entry.visual_role)) {
      throw new Error(
        `${where}（${entry.id}）的 visual_role 只能是 ${VisualRoles.join('、')}，收到 ${goQuote(entry.visual_role)}`,
      );
    }
    if (i === 0 && entry.cut !== '') throw new Error(`${where}（${entry.id}）固定从第 0 帧开始，不能写 cut`);
    try {
      verifyFilmStyleValue(entry.film_style);
    } catch (err) {
      throw new Error(`${where}（${entry.id}）的${(err as Error).message}`);
    }
    entry.motion_effects = normalizeMotionEffects(entry.motion_effects, `${where}（${entry.id}）的 motion_effects`);
  });
  verifyLook(plan.look);
  verifyHandoffs(entries);
  return plan;
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
    throw new Error(
      `分镜计划的 chapter 要么每个镜头都写，要么都不写（${entries.length} 个镜头里写了 ${chaptered} 个）`,
    );
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
        problems.push(
          `${where}的 handoff.style_shift 只能是 ${StyleShifts.map((x) => x.id).join('、')}，收到 ${goQuote(h.style_shift)}`,
        );
      } else if (handoffDeviceValid(h.device) && !shift.devices.includes(h.device)) {
        problems.push(
          `${where}的 handoff.style_shift ${shift.id} 只能配 device ${shift.devices.join('、')}，收到 ${h.device}`,
        );
      }
    }
    const bridge = goTrimSpace(h.bridge);
    if (bridge === '') problems.push(where + '的 handoff.bridge 为空：要写清交界那一帧两侧共有的画面');
    else if ([...bridge].length > maxBridgeRunes)
      problems.push(`${where}的 handoff.bridge 超过 ${maxBridgeRunes} 字：只描述交界那一帧`);
    if (crossChapter) {
      if (h.device === lastChapterDevice)
        problems.push(`${where}与上一个章节交界都用 ${h.device}：相邻章节交界换一种手法`);
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
      if (h === null) {
        problems.push(
          `${where}从 ${label(prev)} 换成 ${label(cur)}：风格交界必须写 handoff 与 handoff.style_shift，说明画法怎么换过去`,
        );
      } else if (h.style_shift === '') {
        problems.push(
          `${where}从 ${label(prev)} 换成 ${label(cur)}：handoff 要写 style_shift（${StyleShifts.map((x) => x.id).join('、')}）`,
        );
      }
    } else if (h !== null && h.style_shift !== '') {
      problems.push(`${where}与上一镜头都是 ${label(cur)}，不是风格交界，不要写 style_shift`);
    }
  }
  if (problems.length > 0) throw new Error(`分镜计划的风格交界不合格：\n  - ${problems.join('\n  - ')}`);
}
