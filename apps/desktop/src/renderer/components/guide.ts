import type { ProgressState, ProgressStation } from '../types';
import { gateMessage, redoMessage } from './Progress';

/**
 * 项目内的「接下来」：按制作路线现在这一站（/api/progress 的 current 与 waiting_on），用一两句大白话说清
 * 现在该干什么，再给几个按钮。按钮只做界面本来就能做的事——开页面、往对话里发一句话、把一句话填进输入框、
 * 确认关卡——不绕过对话改项目文件。
 *
 * 站的 id 与 packages/engine/src/studio/progress.ts 的站表一一对应；新加一站时在这里补一条，没补的落到通用说法。
 * 内置插件的站不在这张表里：说法由插件登记（判断函数的 guide），经 /api/progress 的 station.guide 带过来。
 */

export type GuideAction =
  | { kind: 'page'; label: string; page: string; target?: string }
  /** 直接发给 AI。 */
  | { kind: 'say'; label: string; text: string }
  /** 填进输入框，让用户接着写。 */
  | { kind: 'draft'; label: string; text: string }
  /** 确认审核关卡（先记下确认，再把那一关的话发给 AI：宿主的在 gateMessages，内置插件的是 text）。 */
  | { kind: 'gate'; label: string; gate: string; text?: string }
  /** 第三方站的一条只能由用户触发的操作：先在卡片上确认，再执行。 */
  | { kind: 'op'; label: string; station: string; op: string; summary: string }
  | { kind: 'start'; label: string };

export interface Guide {
  /** 卡片标题：现在这一站。 */
  title: string;
  /** 这一步要做什么。 */
  text: string;
  /** 在等你（黄铜色）还是 AI 在做。 */
  waiting: boolean;
  actions: GuideAction[];
}

interface StationGuide {
  /** AI 在做时的说明。 */
  ai?: string;
  /** 等你时的说明与按钮。 */
  user?: string;
  actions?: (s: ProgressStation) => GuideAction[];
}

const change = (what: string): GuideAction => ({ kind: 'draft', label: '我要改', text: `${what}这几处要改：\n` });

const stations: Record<string, StationGuide> = {
  intake: {
    ai: 'AI 在读你给的文章和素材，定画幅、时长和讲法。',
    user: '把文章、图片或录音拖进下面的输入框，说说想做多长、给谁看。',
    actions: () => [{ kind: 'draft', label: '写给 AI', text: '我想把这篇文章做成一条视频，时长大约 ' }],
  },
  script: {
    ai: 'AI 在把文章改成适合念出来的口播稿。',
    user: '口播稿还没定。说说你想要的语气、长度，或者哪些内容一定要留。',
    actions: () => [{ kind: 'draft', label: '提要求', text: '口播稿我希望：' }],
  },
  'gate-script': {
    user: '口播稿写好了，先读一遍再配音。哪一段不对，在稿子上右键那一段「引用并说哪里不满意」；没问题就确认。',
    actions: () => [{ kind: 'page', label: '看口播稿', page: 'script' }, { kind: 'gate', label: '没问题，开始配音', gate: 'gate-script' }, change('口播稿')],
  },
  voice: {
    ai: 'AI 在配音。',
    user: '配音还没做。',
    actions: () => [{ kind: 'say', label: '开始配音', text: '口播稿定了，开始配音。' }, { kind: 'page', label: '挑声音', page: 'voice' }],
  },
  'gate-voice': {
    user: '配音好了，从头听一遍：读错的字、语气不对的地方告诉 AI；没问题就确认。',
    actions: (s) => [{ kind: 'page', label: '去听配音', page: 'file', target: s.file || 'production/audio/voice.wav' }, { kind: 'gate', label: '没问题，继续', gate: 'gate-voice' }, change('配音')],
  },
  timeline: { ai: 'AI 在对齐字幕，让字幕和配音逐字对上。' },
  style: {
    ai: 'AI 在定整片的画风。',
    user: '可以给整片挑一种画风，所有镜头照它画；不挑的话每个镜头自由发挥。',
    actions: () => [{ kind: 'page', label: '挑画风', page: 'style' }, { kind: 'say', label: '不用，继续', text: '整片风格先不定，继续拆分镜头。' }],
  },
  plan: {
    ai: 'AI 在把稿子拆成一个个镜头，写下每个镜头画什么。',
    user: '分镜还没拆完。',
    actions: () => [{ kind: 'say', label: '继续拆分镜', text: '继续拆分镜头。' }],
  },
  'gate-storyboard': {
    user: '分镜写好了。渲染前先看一遍每个镜头要画什么——现在改最省事，渲染后再改就要重画。',
    actions: () => [{ kind: 'page', label: '看分镜', page: 'storyboard' }, { kind: 'gate', label: '没问题，开始渲染', gate: 'gate-storyboard' }, change('分镜')],
  },
  render: {
    ai: 'AI 在一个个渲染镜头，要一阵子。镜头页能看每个镜头的进度。',
    user: '还有镜头没渲染完。',
    actions: () => [{ kind: 'page', label: '看镜头', page: 'scene' }, { kind: 'say', label: '继续渲染', text: '把还没渲染的镜头渲染完。' }],
  },
  'visual-qc': {
    ai: 'AI 在检查每个镜头的画面。',
    user: '镜头都渲染好了，挨个看一遍。哪个不满意，右键那个镜头说哪里要改。',
    actions: () => [{ kind: 'page', label: '看镜头', page: 'scene' }, { kind: 'say', label: '都没问题，拼成片', text: '镜头我都看过了，没问题，拼成片吧。' }],
  },
  assemble: { ai: 'AI 在把镜头拼成整片。' },
  sound: { ai: 'AI 在配乐、加音效和混音。' },
  review: {
    ai: 'AI 在整片复查：时长、交界、响度。',
    user: '复查发现了问题。',
    actions: () => [{ kind: 'page', label: '看复查', page: 'review' }, { kind: 'say', label: '修掉这些问题', text: '把复查发现的问题修掉。' }],
  },
  'gate-final': {
    user: '成片出来了，完整看一遍。满意就确认，去做封面和发布信息；不满意说哪里要改。',
    actions: () => [{ kind: 'page', label: '看成片', page: 'final' }, { kind: 'say', label: '满意，去发布', text: '成片我看过了，可以，去做封面和发布信息。' }, change('成片')],
  },
};

/** 内置插件登记的、第三方站清单里声明的说法（station.guide）。 */
function fromPlugin(s: ProgressStation): StationGuide {
  const g = s.guide;
  if (!g) return {};
  const actions: GuideAction[] | undefined = g.actions
    ? g.actions.map((a): GuideAction => (a.kind === 'gate' ? { ...a, text: g.confirm } : a))
    : g.page
      ? [{ kind: 'page', label: g.page_label ?? '去看看', page: g.page }]
      : undefined;
  return { ai: g.ai, user: g.user, actions: actions ? () => actions : undefined };
}

/** 这一站对应的页面（确认后又改过、上游改过时「去看」用）。 */
function pageAction(s: ProgressStation): GuideAction[] {
  if (s.page) return [{ kind: 'page', label: '去看看', page: s.page }];
  if (s.file) return [{ kind: 'page', label: '去看看', page: 'file', target: s.file }];
  return [];
}

/**
 * 现在该做什么。started 为 false 表示这个项目还没开始制作（没有任何一轮对话），此时引导用户开工。
 * 没有制作路线时返回 null。
 */
export function guideFor(progress: ProgressState | null, started: boolean): Guide | null {
  if (!progress) return null;
  const s = progress.stations.find((x) => x.id === progress.current) ?? null;
  if (!s) {
    // 最后一站有页面（例如发布页）就给一个去看的按钮。
    const last = [...progress.stations].reverse().find((x) => x.page);
    return { title: '全部做完了', text: '片子做好了。', waiting: false, actions: last ? [{ kind: 'page', label: last.guide?.page_label ?? `看${last.label}`, page: last.page! }] : [] };
  }
  // 没有对话、路线上也一站都没做过，才是还没开工（项目里已经有稿子、配音的不算）。
  if (!started && progress.stations.every((x) => x.status === 'todo')) {
    return {
      title: '开始做片',
      text: '把文章或素材拖进下面的输入框，再点「开始制作」。AI 会先读素材、整理口播稿，每到要你拍板的地方都会停下来等你。',
      waiting: true,
      actions: [{ kind: 'start', label: '开始制作' }],
    };
  }
  const g = stations[s.id] ?? fromPlugin(s);
  if (s.status === 'changed') {
    const text = gateMessage(s);
    const gate = text ? [{ kind: 'gate', label: '没问题', gate: s.id, text } as GuideAction] : [];
    return { title: s.label, text: '你确认过之后它又改过了，再看一遍。', waiting: true, actions: [...pageAction(s), ...gate] };
  }
  if (s.status === 'stale') {
    return {
      title: s.label,
      text: s.stale_note ? `${s.stale_note}。` : '前面的步骤改过了，这一步要按新的重做。',
      waiting: true,
      actions: [...(s.stale_note ? pageAction(s) : []), { kind: 'say', label: '按新的重做', text: redoMessage(s) }],
    };
  }
  if (progress.waiting_on === 'user') {
    const text = g.user ?? (s.detail ? `${s.detail}，等你处理。` : `「${s.label}」这一步等你处理。`);
    const actions = g.actions?.(s) ?? [...pageAction(s), { kind: 'say', label: '继续', text: `继续做「${s.label}」这一步。` }];
    return { title: s.label, text, waiting: true, actions };
  }
  return { title: s.label, text: g.ai ?? `AI 在做「${s.label}」。`, waiting: false, actions: [] };
}

