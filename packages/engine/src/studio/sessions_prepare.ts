/**
 * 单轮对话启动前的准备工作：扫描项目快照、组装提示词、判断分段接力并落盘轮次记录。
 */
import crypto from 'node:crypto';
import type * as config from '../config';
import { readSection } from '../flow';
import { goTrimSpace } from '../gofmt';
import * as ledger from '../ledger';
import * as project from '../project';
import * as series from '../series';
import { describeView } from '../studioview';
import * as tools from '../tools';
import { nowTime } from './http';
import { localStyleAction } from './localactions';
import { preferenceBrief } from './memory';
import { handoffNote, rotationReason } from './rotate';
import { lastTaskPlan } from './sessions_agents';
import { attachmentText, chatPreamble, projectStateBrief, studioInteraction } from './sessions_prompt';
import { emit, updateMeta } from './sessions_store';
import { kindNotice, kindTurnStart, kindUser, newID, type Session, type TurnRequest } from './sessions_types';
import type { Project, Server } from './studio';
import { saveTurn, scanTree, type Turn } from './turns';
import { noVisionNote, orchestratorCannotSee } from './vision';

export function prepareTurn(
  _s: Server,
  p: Project,
  sess: Session,
  cfg: config.Config,
  req: TurnRequest,
): { turn: Turn; prompt: string; handoff: string } {
  const rulesName = tools.projectRulesFilename(cfg.orchestrator);
  project.writeRules(p.path, rulesName);
  let before;
  try {
    before = scanTree(p.path);
  } catch (err) {
    throw new Error(`扫描项目：${(err as Error).message}`, { cause: err });
  }
  let message = req.message + attachmentText(req.attachments);
  const where = describeView(req.view);
  if (where !== '') message += '\n\n' + where;
  let prompt = req.prompt ?? '';
  if (prompt !== '') {
    prompt += '\n\n---\n\n' + studioInteraction;
    // 只上传了文章、没写话时也要把附件交过去。
    if (goTrimSpace(message) !== '') prompt += '\n\n用户补充：' + goTrimSpace(message);
  } else if ((sess.meta.turns ?? []).length === 0 && sess.meta.kind === 'chat') {
    prompt = chatPreamble(rulesName) + message;
  } else {
    prompt = message;
  }
  const display = req.message || '开始整片制作';
  const isLocalStyle = localStyleAction(display, p.path) !== null;
  // 会话太长、关卡确认自动接力或用户手动触发分段接力时，换一个新的 CLI 会话接着做（rotate.ts）：
  // 先决定是否换新会话，再据此决定偏好、职责边界与无视觉提醒要不要发，避免续接同一 CLI 会话时每轮重复追加 5KB。
  // 本地换风格轮次不调模型，保留待消费的 handoff_reason 与现有 CLI 会话，留给下一轮普通消息接力。
  const firstTurn = (sess.meta.turns ?? []).length === 0;
  const cliSession = sess.meta.cli_session_id ?? '';
  const manualHandoff = isLocalStyle ? '' : (sess.meta.handoff_reason ?? '');
  let rotate = '';
  if (!isLocalStyle && manualHandoff === '' && cliSession !== '' && !firstTurn) {
    try {
      rotate = rotationReason(ledger.read(ledger.projectFile(p.path)), cliSession);
    } catch {
      /* 账本不可读时保留原会话；计费记录故障不能阻断对话。 */
    }
  }
  const handoffReason = manualHandoff || rotate;
  const handoff =
    handoffReason !== '' ? handoffNote(handoffReason, lastTaskPlan(sess.events, false), projectStateBrief(p.path)) : '';
  if (!isLocalStyle && (rotate !== '' || manualHandoff !== '')) {
    updateMeta(sess, (meta) => {
      meta.cli_session_id = undefined;
      meta.ownership_digest = undefined;
      meta.series_brief_digest = undefined;
      meta.vision_note_sent = undefined;
      meta.local_style_receipt = undefined;
      meta.handoff_reason = undefined;
    });
  }
  const activeSession = sess.meta.cli_session_id ?? '';
  // 同一 CLI 会话续接不再每轮重复追加 5KB 的 scene-ownership.md；首次、规则内容修订或换新会话时自动带上。
  // 不写进项目 AGENTS.md：渲染子进程也会读它，而这些限制只针对编排。
  const ownership = readSection('host', 'scene-ownership').trim();
  const ownershipDigest = crypto.createHash('sha256').update(ownership).digest('hex').slice(0, 16);
  const alreadyHasOwnership = prompt.includes(ownership);
  const sendOwnership =
    !alreadyHasOwnership &&
    (firstTurn || activeSession === '' || ownershipDigest !== (sess.meta.ownership_digest ?? ''));
  if (sendOwnership) prompt += '\n\n---\n\n' + ownership;
  // 制作人用的模型看不了图：首次或换新会话时提醒一次，同一 CLI 会话内不每轮重复追加。
  const cannotSee = orchestratorCannotSee(cfg);
  const sendVisionNote = cannotSee && (firstTurn || activeSession === '' || !sess.meta.vision_note_sent);
  if (sendVisionNote) prompt += '\n\n---\n\n' + noVisionNote;
  const seriesBrief = series.seriesPromptBrief(cfg.seriesDir, p.path);
  const alreadyHasSeriesBrief = seriesBrief.text !== '' && prompt.includes(seriesBrief.text.trim());
  const sendSeriesBrief =
    seriesBrief.text !== '' &&
    !alreadyHasSeriesBrief &&
    (firstTurn || activeSession === '' || seriesBrief.digest !== (sess.meta.series_brief_digest ?? ''));
  if (sendSeriesBrief) prompt += '\n\n---\n\n' + seriesBrief.text.trim();
  const [brief, digest] = preferenceBrief(p, cfg);
  const resend = brief !== '' && (digest !== (sess.meta.preference_digest ?? '') || !activeSession || firstTurn);
  if (resend) prompt = brief + '\n---\n\n' + prompt;
  const turn: Turn = {
    turn_id: newID('t'),
    session_id: sess.meta.session_id,
    kind: sess.meta.kind,
    message: display,
    status: 'running',
    started_at: nowTime(),
    before,
    changes: [],
  };
  saveTurn(p.path, turn);
  updateMeta(sess, (meta) => {
    meta.turns = [...(meta.turns ?? []), turn.turn_id];
    meta.running_turn = turn.turn_id;
    if (resend) meta.preference_digest = digest || undefined;
    if (alreadyHasSeriesBrief || sendSeriesBrief) meta.series_brief_digest = seriesBrief.digest || undefined;
    if (alreadyHasOwnership || sendOwnership) meta.ownership_digest = ownershipDigest;
    if (sendVisionNote) meta.vision_note_sent = true;
    if (!meta.tool) meta.tool = cfg.orchestrator;
  });
  emit(sess, turn.turn_id, { kind: kindUser, text: display + attachmentText(req.attachments) });
  emit(sess, turn.turn_id, { kind: kindTurnStart, status: 'running' });
  if (rotate !== '')
    emit(sess, turn.turn_id, {
      kind: kindNotice,
      text: `对话已经很长（${rotate}），这一轮换一个新会话接着做：带上制作说明与对话记录，进度按项目文件重新确认`,
    });
  return { turn, prompt, handoff };
}
