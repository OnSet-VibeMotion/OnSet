/**
 * 会话的附件说明、交互约定、对话记录摘要、阶段快照与分段接力。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as agentrun from '../agentrun';
import { formatFixed, goClean, goTrimSpace } from '../gofmt';
import * as ledger from '../ledger';
import * as project from '../project';
import { viewInteraction } from '../studioview';
import { computeStations } from './progress';
import { shouldGateHandoff } from './rotate';
import { discoverScenes } from './scenes';
import { emit, loadSessions, updateMeta } from './sessions_store';
import {
  type Attachment,
  BusyError,
  containedPath,
  kindNotice,
  kindUser,
  maxQuoteRunes,
  type Session,
  type SessionEvent,
  transcriptLimit,
} from './sessions_types';
import type { Project, Server } from './studio';
import { uploadDir, uploadKind } from './uploads';

/** attachmentText 把附件写成编排工具能读的说明。 */
export function attachmentText(attachments: Attachment[] | null | undefined): string {
  if (!attachments || attachments.length === 0) return '';
  const uploads: Attachment[] = [];
  const refs: Attachment[] = [];
  const frames: Attachment[] = [];
  for (const a of attachments) {
    if (a.upload) uploads.push(a);
    else if (a.quote || a.ref) refs.push(a);
    else frames.push(a);
  }
  let b = '';
  if (uploads.length > 0) {
    b +=
      '\n\n用户上传的文件（存在 Studio 的上传目录里，不属于项目；要用时先复制或转换到项目里合适的位置，例如文章放项目根或 docs/，素材放 assets/）：';
    for (const a of uploads) b += `\n- ${uploadKind(a.name ?? '')}「${a.name ?? ''}」：${a.path ?? ''}`;
  }
  if (refs.length > 0) {
    b += '\n\n用户引用的内容（这条消息说的就是这些）：';
    for (const a of refs) {
      b += '\n- ';
      if (a.quote) {
        b += a.label || '一段文字';
        if (a.source) b += `（${a.source}）`;
        b += '：';
        for (const line of goTrimSpace(a.quote).split('\n')) b += '\n  > ' + line;
      } else if (a.scene_id) {
        b += `镜头 ${a.scene_id}`;
      } else if (a.source) {
        b += a.label ? `${a.label}（${a.source}）` : `文件 ${a.source}`;
      }
      if (a.note) b += '\n  备注：' + a.note;
    }
  }
  if (frames.length === 0) return b;
  b += '\n\n附带的画面上下文：';
  for (const a of frames) {
    b += '\n- ';
    if (a.scene_id) b += `镜头 ${a.scene_id} `;
    if (a.path) b += `${formatFixed(a.seconds ?? 0, 2)} 秒处的截图 ${a.path}（请打开查看）`;
    if (a.region)
      b += `，用户圈出的区域：x=${a.region.x} y=${a.region.y} 宽 ${a.region.w} 高 ${a.region.h}（视频像素）`;
    if (a.selector) {
      b += `，合成里选中的元素 \`${a.selector}\``;
      if (a.source) b += `（${a.source}）`;
    }
    if (a.note) b += '，备注：' + a.note;
  }
  return b;
}

/** validateAttachments 只接受 Studio 自己抽出的截图与项目内的合成文件。 */
export function validateAttachments(projectPath: string, attachments: Attachment[] | null | undefined): void {
  for (const a of attachments ?? []) {
    if (a.path) {
      const clean = goClean(a.path);
      const prefix = a.upload ? uploadDir + '/' : 'production/studio/attachments/';
      if (!clean.startsWith(prefix) || clean.includes('..')) throw new Error(`附件路径不在 ${prefix} 下：${a.path}`);
      if (!fs.existsSync(path.join(projectPath, clean))) throw new Error(`附件不存在：${a.path}`);
    }
    if (a.source) containedPath(projectPath, a.source);
    const n = [...(a.quote ?? '')].length;
    if (n > maxQuoteRunes)
      throw new Error(`引用太长（${n} 字，上限 ${maxQuoteRunes}）：长内容请直接说文件名，让 AI 自己读`);
    if (a.ref && !a.scene_id && !a.source) throw new Error('引用要指明镜头或文件');
  }
}

/** chatPreamble 是聊天会话第一轮的开场说明。整片制作会话第一轮直接发制作提示词，末尾附 studioInteraction。 */
export function chatPreamble(rulesName: string): string {
  return (
    '你正在协助用户修改当前目录下的片场视频项目。动手前先读项目规则 ' +
    rulesName +
    '。需要渲染、校验、复查时直接调用 onset 工具服务里的工具。改完用几句话说明改了哪些文件、为什么，以及接下来要不要重渲染哪些镜头。\n\n' +
    studioInteraction +
    '\n\n用户的请求：'
  );
}

/**
 * studioInteraction 告诉编排工具怎样在 Studio 里和用户来回：多步任务先列待办清单
 * （网页据此显示进度），要用户拍板时用 choices 代码块（网页渲染成按钮，见 Chat.tsx 的 parseChoices）。
 */
export const studioInteraction =
  `你在 Studio 网页里和用户对话，下面几条约定让网页能把你的进度和问题显示好：
- 工具都由你来调用。回复里用用户听得懂的话说做了什么、接下来做什么，不要写工具名、参数或命令让用户去运行；工具报错里「请重新运行 beat_cues()」这类话是给你的下一步，能做就直接做掉，要用户点头的先用一句话说明要做什么、为什么。
- 多步骤的工作先用你的待办清单工具列出步骤，做的过程中及时更新状态，用户会在对话顶部看到进度。
- 需要用户拍板时（选风格、确认分镜、确认一条推测的偏好、几种做法里选一种），先把问题和各选项的差别写清楚，再在回复的最后单独放一个语言标成 choices 的代码块，每行一个选项，例如：
` +
  '```choices\n用方案 A：深色科技风\n用方案 B：白板手绘风\n```' +
  `
  用户会看到可点的按钮，点了就把那一行原样发给你。问完就结束这一轮等用户回复，不要替用户选。用户也可能直接打字回答。
- 推荐风格时（用户没指定画风、要换风格，或某一段想换一种画法），先用 film_style_list({"compact": true}) 挑出两三种贴合的，在回复里放一个语言标成 film-styles 的代码块，每行一种，写「来源/目录名」加一句为什么合适。推荐给全片当默认风格的直接写；只推荐给某一段的，在标识后面用方括号写清用在哪一段（段落名加镜头编号），例如：
` +
  '```film-styles\nlemo-opuscar/impasto 厚涂笔触适合讲历史人物的分量\nlemo-opuscar/ink-wash [回忆段，镜头 04–06] 水墨的留白像记忆一样模糊\n```' +
  `
  网页会显示每种风格的海报并标出是全片默认还是只用在哪一段。用户点了，全片默认的发来「整片风格用「中文名」（标识）」，你运行 film_style_use()；只给一段的发来「<那一段>用「中文名」风格（标识），其余镜头不变」，你按段落换风格的做法 film_style_add() 并改分镜里那几个镜头的 film_style，不要动默认风格。「不用整片风格，各镜头自主定视觉」写进同一条回复的 choices 代码块。
- 要用户试听音频、看图片或视频时（音色试听、配音片段、封面候选、预览帧），在回复里写出每个文件在项目里的相对路径，例如 production/audio/auditions/try-A.wav，网页会在回复下面直接放播放器和缩略图；只写文件名、目录另说的话网页未必找得到。
` +
  viewInteraction();

/** transcript 把会话里已有的对话整理成文字，供续接失败或分段接力时补发。只保留末尾 limit 字。 */
export function transcript(events: SessionEvent[], limit = transcriptLimit): string {
  let b = '';
  for (const event of events) {
    if (event.kind === kindUser) b += '\n用户：' + (event.text ?? '') + '\n';
    else if (event.kind === agentrun.KindText) b += '你：' + (event.text ?? '') + '\n';
  }
  let runes = [...b];
  if (runes.length > limit) runes = runes.slice(runes.length - limit);
  return goTrimSpace(runes.join(''));
}

/** 按磁盘产物生成精简的项目状态快照，供分段接力的新会话快速对齐进度。 */
export function projectStateBrief(projectPath: string): string {
  try {
    const scenes = discoverScenes(projectPath);
    const progress = computeStations(projectPath, scenes);
    const lines: string[] = [];
    const current = progress.stations.find((st) => st.id === progress.current);
    lines.push(`- 流程：${progress.mode}；当前站：${current ? `${current.label}（${current.id}）` : '全部完成'}`);
    const done = progress.stations
      .filter((st) => st.status === 'done' || st.status === 'confirmed' || st.status === 'passed')
      .map((st) => st.label + (st.detail ? `（${st.detail}）` : st.file ? `（${st.file}）` : ''));
    if (done.length > 0) lines.push(`- 已完成 / 已确认：${done.join('、')}`);
    const attention = progress.stations
      .filter((st) => st.status === 'stale' || st.status === 'changed')
      .map((st) => st.label + (st.stale_note ? `（${st.stale_note}）` : ''));
    if (attention.length > 0) lines.push(`- 需重做 / 重确认：${attention.join('、')}`);
    if (scenes.length > 0) {
      const ready = scenes.filter((sc) => sc.exists && !sc.stale);
      const stale = scenes.filter((sc) => sc.exists && sc.stale).map((sc) => sc.id);
      const missing = scenes.filter((sc) => !sc.exists).map((sc) => sc.id);
      const formatList = (ids: string[]) =>
        ids.length <= 12 ? ids.join(', ') : `${ids.slice(0, 12).join(', ')} 等 ${ids.length} 个`;
      const parts = [`共 ${scenes.length} 镜`, `已就绪 ${ready.length}`];
      if (stale.length > 0) parts.push(`待重渲 ${stale.length}（${formatList(stale)}）`);
      if (missing.length > 0) parts.push(`未渲染 ${missing.length}（${formatList(missing)}）`);
      lines.push(`- 镜头进度：${parts.join('；')}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 阶段边界手动接力：保留 Studio 对话界面与轮次历史，清空底层 CLI 会话号，
 * 让下一轮自动用精简项目状态快照 + 近期对话记录开启新 CLI 会话（不再背负旧工具输出与看图历史）。
 */
export function handoffSession(sess: Session, reason = '手动分段接力'): void {
  if (sess.cancel || sess.meta.running_turn) throw new BusyError('当前轮次正在进行，请等结束后再分段接力');
  if ((sess.meta.turns ?? []).length === 0) throw new Error('这个会话还没有对话记录，无需分段接力');
  updateMeta(sess, (meta) => {
    meta.cli_session_id = undefined;
    meta.preference_digest = undefined;
    meta.ownership_digest = undefined;
    meta.vision_note_sent = undefined;
    meta.local_style_receipt = undefined;
    meta.handoff_reason = reason.trim() || '手动分段接力';
  });
  emit(sess, '', {
    kind: kindNotice,
    text: '已开启新会话接力：下一轮将清空旧工具输出与看图历史，只带项目文件快照与近期对话继续',
  });
}

/** 冻结大阶段产物的硬审核关卡：确认后自动预约下一轮轻接力，避免把上一阶段的几十轮工具输出拖入下一阶段（含 gate-final 进入发布/封面制作）。 */
const autoHandoffGates: ReadonlySet<string> = new Set([
  'gate-script',
  'gate-voice',
  'gate-storyboard',
  'gate-pilot',
  'gate-final',
  'gate-story',
  'gate-grid',
  'gate-beat-storyboard',
]);

/**
 * 关卡确认后为该项目已有至少 2 轮历史的整片制作会话预约阶段边界接力（ONSET_AUTO_HANDOFF=off 可关闭）。
 * 结合账本与空闲时长做缓存感知判断（shouldGateHandoff）：会话还很轻且热缓存未过期时继续复用，不白交冷启动写费。
 */
export function scheduleGateHandoff(s: Server, projectPath: string, gate: string, label: string): void {
  if (!autoHandoffGates.has(gate) || process.env.ONSET_AUTO_HANDOFF === 'off') return;
  loadSessions(s, projectPath);
  let entries: ledger.Entry[] | null = null;
  try {
    entries = ledger.read(ledger.projectFile(projectPath));
  } catch {
    // 账本不可读时退回默认接力策略。
  }
  const nowMs = Date.now();
  for (const sess of s.sessions.values()) {
    if (sess.project !== projectPath || sess.meta.kind !== 'production') continue;
    if (!sess.meta.cli_session_id || (sess.meta.turns ?? []).length < 2 || sess.meta.handoff_reason) continue;
    if (!shouldGateHandoff(entries, sess.meta.cli_session_id, sess.meta.updated_at, nowMs)) continue;
    updateMeta(sess, (meta) => {
      meta.handoff_reason = `关卡「${label}」已确认，自动分段接力进入下一阶段`;
    });
  }
}

export function reseedPrompt(history: string, prompt: string, production = '', handoff = ''): string {
  return (
    (production !== '' ? production + '\n\n---\n\n' : '') +
    '下面是这个项目里你和用户之前的对话记录（较早的部分可能被截掉），供你接上上下文：\n\n' +
    history +
    '\n\n---\n\n' +
    (handoff !== '' ? handoff + '\n\n---\n\n' : '') +
    studioInteraction +
    '\n\n---\n\n' +
    prompt
  );
}

/** 按当前项目进度解析应聚焦的制作阶段 ID（无对应分段或读不到进度时返回 undefined，退回全文）。 */
export function focusStageFor(projectPath: string): string | undefined {
  try {
    const progress = computeStations(projectPath, discoverScenes(projectPath));
    const aliases: Record<string, string> = {
      'gate-script': 'script',
      'gate-voice': 'voice',
      'gate-storyboard': 'plan',
      'gate-pilot': 'render',
      'gate-beat-storyboard': 'beat-plan',
      'gate-final': 'review',
    };
    const beatStages: Record<string, string> = {
      story: 'beat',
      'gate-story': 'beat',
      music: 'beat',
      grid: 'beat',
      'gate-grid': 'beat',
      plan: 'beat-plan',
      sound: 'beat-sound',
    };
    const focus =
      aliases[progress.current] ??
      (progress.mode === 'beat' ? beatStages[progress.current] : undefined) ??
      progress.current;
    return focus || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 整片制作的会话换了 CLI 会话（续接失败、换了编排工具）时，制作提示词要重发：对话记录只有双方说的话，
 * 第一轮发过的制作说明（各阶段怎么做、关卡在哪）不在里面，新会话拿不到就只能凭对话猜。
 * 从项目产物重算进度，带公共规则、当前阶段和已通过的关卡。
 */
export function productionBrief(p: Project, sess: Session): string {
  if (sess.meta.kind !== 'production') return '';
  try {
    const progress = computeStations(p.path, discoverScenes(p.path));
    const focus = focusStageFor(p.path);
    const text = project.composeProjectPrompt(p.path, focus).text;
    const confirmed = progress.stations.filter(
      (station) => station.status === 'confirmed' || station.status === 'passed',
    );
    const gates = confirmed.map((station) => station.label + (station.file ? `（${station.file}）` : '')).join('、');
    return '下面是这次整片制作的说明。' + (gates ? `已通过的关卡有${gates}。\n\n` : '\n\n') + text;
  } catch {
    return '';
  }
}
