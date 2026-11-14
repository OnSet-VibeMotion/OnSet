//
// 面向人的说法。校验器 ID、事件类型是给程序和整理者看的，记忆面板直接显示它们时
// 用户只看到一串 reads.binding、episode，看不懂记忆在做什么。这里是它们的大白话，
// 只用于展示，不进提示词、不进记忆文件。
import { CheckerHuman } from './features';
import {
  EventRemember,
  EventConsolidate,
  EventDormant,
  EventDraftReject,
  EventEpisode,
  EventExam,
  EventManualEdit,
  EventPromote,
  EventReject,
  EventRollback,
  EventSnapshot,
  EventTrial,
} from './events';

/**
 * 每个校验器 ID 的一句话说明。TestEveryCheckerHasLabel 守着它与
 * knownCheckers 一致：新增校验器不补说法，面板上就会露出原始 ID。
 */
export const CheckerLabels: Readonly<Record<string, string>> = {
  'output.missing': '没有产出视频',
  'output.video-stream': '视频里没有画面',
  'output.resolution': '画面尺寸不对',
  'output.fps': '帧率不对',
  'output.duration': '时长不对',
  'output.frames': '帧数不对',
  'output.audio': '镜头带了声音（应为无声）',
  'output.other': '视频规格的其他问题',

  'determinism.clock': '动画读了真实时钟，每次渲染不一样',
  'determinism.random': '用了不固定的随机数，每次渲染不一样',
  'determinism.raf': '动画没挂在时间轴上（requestAnimationFrame）',
  'determinism.interval': '用了定时器驱动画面（setInterval）',
  'determinism.infinite-repeat': '动画写成了无限循环',
  'determinism.network': '渲染时去网上取东西',
  'determinism.font-display': '字体加载方式会让文字闪一下',
  'determinism.font-missing': '引用的字体文件不存在',
  'determinism.remote-font': '用了在线字体',
  'determinism.unpinned-cdn': '外部代码库没固定版本',
  'determinism.remote-asset': '引用了网上的素材',

  'frames.blank': '出现空白画面',

  'reads.duration': '文字停留太短，读不完',
  'reads.spoiler': '文字比配音先出现',
  'reads.order': '文字出现的先后与配音不一致',
  'reads.binding': '画面文字没对应上配音的句子',
  'reads.frames': '文字的出现与消失时间写错了',
  'reads.identity': '画面文字清单里编号缺失或重复',
  'reads.timeline': '配音时间轴与画面对不上帧率',

  'review.handoff': '与相邻镜头接不上',
  'audition.judged': '你在试镜里选的更好',

  [CheckerHuman]: '你的确认',
};

/** 校验器的说法，没有登记的原样返回 ID。 */
export function checkerLabel(id: string): string {
  return Object.hasOwn(CheckerLabels, id) ? CheckerLabels[id] : id;
}

/** 时间线事件类型的说法。 */
export const EventLabels: Readonly<Record<string, string>> = {
  [EventEpisode]: '渲染',
  [EventConsolidate]: '整理',
  [EventTrial]: '新经验',
  [EventDraftReject]: '草稿被拒',
  [EventExam]: '考试',
  [EventPromote]: '生效',
  [EventReject]: '拒绝',
  [EventDormant]: '沉睡',
  [EventRollback]: '回退',
  [EventManualEdit]: '手动修改',
  [EventSnapshot]: '存档',
  [EventRemember]: '记下偏好',
};
