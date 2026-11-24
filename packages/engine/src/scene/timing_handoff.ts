// 交接手法、风格切换手法、全片配色与 film_style 取值的规则定义与校验。
import { goQuote } from '../gofmt';
import type { Look } from './timing_types';

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
  {
    id: HandoffCarry,
    guide: '接力：同一个物件跨过交界，交界帧上它的位置、大小、颜色与状态两侧一致，下一镜头接着让它变化',
  },
  {
    id: HandoffMatch,
    guide:
      '形状匹配：上一镜头某元素在末帧的轮廓、位置与大小，与下一镜头某个不同元素在首帧的完全重合（圆点变成地球、进度条变成时间轴）',
  },
  { id: HandoffPushIn, guide: '推进穿越：镜头推进到上一镜头某元素内部，该元素的表面铺满画面，成为下一镜头的底面' },
  {
    id: HandoffFlood,
    guide: '色块铺满：上一镜头某元素扩张到铺满画面，它的颜色成为下一镜头开场的底色，再从中长出新内容',
  },
  {
    id: HandoffPan,
    guide:
      '平移续接：同一张底面朝一个方向平移，上一镜头内容移出画面，下一镜头内容从另一侧移入，交界帧只剩共享底面与跨界物件',
  },
  {
    id: HandoffSettle,
    guide: '退回底色：上一镜头语义元素退场，交界帧只剩全片底色与一个保留元素，下一镜头从这个元素长出',
  },
];

export function handoffDeviceValid(device: string): boolean {
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
    exitDuty:
      '末段让 bridge 写的那样东西按本镜头的风格扫进画面，到交界帧铺满（或横跨）整个画面；交界帧上看不到下一镜头的风格。',
    enterDuty:
      '第 0 帧与上一镜头的交界帧一致：那样东西铺满（或横跨）画面，按上一镜头的风格画；随后它继续扫走，身后露出按本镜头风格画的画面，扫走途中它自己也换成本镜头的画法。',
  },
  {
    id: StyleShiftMatchCut,
    name: '形状匹配切',
    devices: [HandoffMatch, HandoffCarry],
    guide:
      '交界帧两侧各按自己的风格画，靠交接物件的轮廓、位置、大小、朝向与主色完全一致把眼睛带过去；切点前后各留 0.3 秒以上让它静止或匀速，切点上不同时做别的大动作',
    exitDuty:
      '交界帧上交接物件的轮廓、位置、大小、朝向与主色严格按 bridge，按本镜头的风格画；切点前 0.3 秒内它静止或匀速，其他元素不做大动作。',
    enterDuty:
      '第 0 帧交接物件的轮廓、位置、大小、朝向与主色严格按 bridge，按本镜头的风格画；切点后 0.3 秒内它静止或匀速，再展开新内容。',
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

export function verifyLook(look: Look | null): void {
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
    else if (value !== '' && !hexColorPattern.test(value))
      problems.push(`look.${key} 必须是 #RRGGBB，收到 ${goQuote(value)}`);
  }
  if (problems.length > 0) throw new Error(`分镜计划的 look 不合格：${problems.join('；')}`);
}
