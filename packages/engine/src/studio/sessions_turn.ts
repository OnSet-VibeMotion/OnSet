/**
 * 单轮对话的编排执行、视图/审批轮询与用量记账。
 */
import fs from 'node:fs';
import * as agentrun from '../agentrun';
import * as config from '../config';
import { addToolsLocation, envMap, lookPath, parsePassthrough } from '../envutil';
import { styleKey } from '../filmstyle';
import { readSection } from '../flow';
import * as ledger from '../ledger';
import * as series from '../series';
import {
  drainViewInbox,
  KindView,
  PermissionPollInterval,
  ViewInboxEnv,
  ViewPollInterval,
  ViewProjectEnv,
  type ViewRequest,
  viewInbox,
  waitPermissionResponse,
  writePermissionRequest,
} from '../studioview';
import * as tools from '../tools';
import { emitStudioEvent } from './events';
import { LocalStyleReceipt, localStyleAction, localStyleContext, resumeFallbackAllowed } from './localactions';
import { allowedCommands, expirePermissions, pollPermissions } from './permissions';
import { confirmGateFromChat } from './progress';
import { expireQuestions, pollQuestions } from './questions';
import { HandoffTranscriptLimit } from './rotate';
import { lastTaskPlan, permissionPrompt, replayGuard } from './sessions_agents';
import { productionBrief, reseedPrompt, transcript } from './sessions_prompt';
import { emit, updateMeta } from './sessions_store';
import { kindFilesChanged, kindNotice, type NewEvent, type Session, transcriptLimit } from './sessions_types';
import type { Project, Server } from './studio';
import { runStudioOp } from './tasks';
import { changedPaths, statTree, studioRoot, type Turn } from './turns';
import { writeStepMark } from './view';
import { noVisionNote, orchestratorCannotSee } from './vision';

/** changeCheckInterval 是对话进行中两次检查文件变化的最短间隔（毫秒）。 */
const changeCheckInterval = 500;

export async function executeTurn(
  s: Server,
  signal: AbortSignal,
  p: Project,
  sess: Session,
  cfg: config.Config,
  turn: Turn,
  prompt: string,
  handoff: string,
): Promise<{ runErr: Error | null; confirmedGates: Array<{ gate: string; label: string }> }> {
  let runErr: Error | null = null;
  let stopViews: () => void = () => {};
  const confirmedGates: Array<{ gate: string; label: string }> = [];
  try {
    const env = config.childEnvironment(
      cfg,
      envMap(),
      s.config.unsafe,
      parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''),
    );
    // onset 不进编排工具的 PATH：它只经 onset 的工具服务（MCP）调用 onset，下面的 spec.toolsServer。
    addToolsLocation(env);
    const inbox = viewInbox(studioRoot(p.path), turn.turn_id);
    env[ViewInboxEnv] = inbox;
    env[ViewProjectEnv] = p.path;
    // 用户在对话里确认了关卡（studio_confirm）：原话要出自这一轮用户的话，记下后与界面按钮确认一样发 gate.confirmed。
    // 接力判断延后到本轮 recordUsage 写入账本后再执行，避免读到上一轮过时的用量。
    stopViews = watchViews(sess, turn.turn_id, inbox, p.path, (req) => {
      try {
        const { gate, label } = confirmGateFromChat(p.path, turn.message, req.said, req.gate ?? '');
        confirmedGates.push({ gate, label });
        emit(sess, turn.turn_id, { kind: kindNotice, text: '已记下你在对话里的确认：' + label });
        emitStudioEvent(s, p, 'gate.confirmed', { gate });
      } catch (err) {
        emit(sess, turn.turn_id, { kind: kindNotice, text: '没有记下关卡确认：' + (err as Error).message });
      }
    });
    let lastStat = statTree(p.path);
    let lastCheck = Date.now();
    const checkFiles = (force: boolean): void => {
      if (!force && Date.now() - lastCheck < changeCheckInterval) return;
      lastCheck = Date.now();
      const current = statTree(p.path);
      const changed = changedPaths(lastStat, current);
      if (changed.length > 0) emit(sess, turn.turn_id, { kind: kindFilesChanged, files: changed });
      lastStat = current;
    };
    // 续接时有的工具会把上一轮结尾的话原样再吐一遍（qoder 续接前压缩长对话后实测），不当成这一轮说的。
    const replay = replayGuard(sess.events, turn.turn_id);
    const onEvent = (event: agentrun.Event): void => {
      if (event.kind === agentrun.KindDone) return;
      if (event.kind === agentrun.KindSession)
        updateMeta(sess, (meta) => (meta.cli_session_id = event.session_id || undefined));
      if (replay(event)) return;
      emit(sess, turn.turn_id, { ...event });
      if (event.kind === agentrun.KindToolResult) checkFiles(false);
    };
    const localStyle = localStyleAction(turn.message, p.path);
    if (localStyle) {
      // runTurn 已持有项目写权，沿用现有执行进程；不能另开 runWriteTask 再拿一次锁。
      await runStudioOp(s, signal, p, 'film_style_use', {
        style: styleKey(localStyle),
        project_root: p.path,
        replace: false,
      });
      const receipt = `${LocalStyleReceipt}${localStyle.cn}（${styleKey(localStyle)}）已设为整片默认风格。`;
      emit(sess, turn.turn_id, { kind: kindNotice, text: receipt });
      emit(sess, turn.turn_id, {
        kind: agentrun.KindText,
        text: receipt + ' 稿件、配音和分镜的确认状态保持原样。',
      });
      // 这一轮没调模型：prepareTurn 记下的摘要其实没发出去，清掉，下一轮重新带上。
      updateMeta(sess, (meta) => {
        meta.preference_digest = undefined;
        meta.ownership_digest = undefined;
        meta.vision_note_sent = undefined;
      });
      checkFiles(true);
    } else {
      const previous = sess.meta.cli_session_id ?? '';
      const earlierTurns = (sess.meta.turns ?? []).length > 1;
      const resumed = previous !== '' && earlierTurns;
      const styleReceipt = localStyleContext(sess.events, p.path);
      if (styleReceipt !== '' && (!resumed || styleReceipt !== (sess.meta.local_style_receipt ?? ''))) {
        prompt = styleReceipt + prompt;
        updateMeta(sess, (meta) => {
          meta.local_style_receipt = styleReceipt;
        });
      }
      // 末尾两条是本轮刚发的 user 与 turn-start，不算进历史。分段接力已有项目快照，只需保留近期结论。
      const history = transcript(
        sess.events.slice(0, Math.max(sess.events.length - 2, 0)),
        handoff !== '' ? HandoffTranscriptLimit : transcriptLimit,
      );
      // 「以后都允许」的前缀并进白名单；claude 遇到白名单外的调用时经 onset studio permission-mcp 问界面上的用户。
      const access = config.orchestratorAccess(cfg);
      access.commands = [...(access.commands ?? []), ...allowedCommands(p.path)];
      const spec: agentrun.Spec = {
        tool: cfg.orchestrator,
        model: cfg.orchestratorModel,
        options: tools.effectiveOptions(cfg.orchestrator, cfg.orchestratorOptions),
        workdir: p.path,
        prompt,
        unsafe: s.config.unsafe,
        access,
        permissionPrompt: permissionPrompt(s.executable()),
        toolsServer: tools.onsetToolsServer(s.executable(), 'orchestrator', p.path, env),
        // codebuddy、opencode、codex 走双向协议，审批请求由 agentrun 直接交到这里：写进同一个收件目录，
        // 与审批 MCP 走同一条路（轮询、卡片、以后都允许），等用户回答。
        ask: async (toolName, input) => {
          const req = writePermissionRequest(inbox, toolName, input);
          return (
            (await waitPermissionResponse(inbox, req.id, PermissionPollInterval, signal)) ?? { decision: 'expired' }
          );
        },
        env,
        lookPath: (name) => lookPath(name, env.PATH ?? ''),
        longSession: true,
      };
      if (resumed) {
        spec.sessionID = previous;
        spec.resume = true;
        spec.plan = lastTaskPlan(sess.events);
        spec.baseline = ledger.lastSessionUsage(ledger.projectFile(p.path), previous);
      } else {
        spec.sessionID = agentrun.newSessionID(cfg.orchestrator);
        if (earlierTurns && history !== '')
          spec.prompt = reseedPrompt(history, spec.prompt, productionBrief(p, sess), handoff);
      }
      let outcome = await agentrun.run(spec, onEvent, signal);
      recordUsage(signal, p, sess, cfg.orchestrator, env, turn.turn_id, outcome);
      if (
        outcome.error &&
        resumed &&
        !outcome.result.produced &&
        !signal.aborted &&
        resumeFallbackAllowed(outcome.error)
      ) {
        emit(sess, turn.turn_id, {
          kind: kindNotice,
          text: '原会话无法续接（' + outcome.error.message + '），已带上之前的对话记录开新会话',
        });
        spec.sessionID = agentrun.newSessionID(cfg.orchestrator);
        spec.resume = false;
        spec.baseline = undefined;
        // 续接失败切新会话时，补回本轮因“原以为能续接”而省略的规则与提醒。
        let fallbackPrompt = prompt;
        const ownership = readSection('host', 'scene-ownership').trim();
        const brief = productionBrief(p, sess);
        if (!fallbackPrompt.includes(ownership) && !brief.includes(ownership))
          fallbackPrompt += '\n\n---\n\n' + ownership;
        if (orchestratorCannotSee(cfg) && !fallbackPrompt.includes(noVisionNote))
          fallbackPrompt += '\n\n---\n\n' + noVisionNote;
        try {
          const sb = series.seriesPromptBrief(cfg.seriesDir, p.path);
          if (sb.text !== '' && !fallbackPrompt.includes(sb.text.trim()) && !brief.includes(sb.text.trim())) {
            fallbackPrompt += '\n\n---\n\n' + sb.text.trim();
          }
        } catch {
          // 专栏配置损坏时不阻断续接回退。
        }
        spec.prompt = reseedPrompt(history, fallbackPrompt, brief, handoff);
        outcome = await agentrun.run(spec, onEvent, signal);
        recordUsage(signal, p, sess, cfg.orchestrator, env, turn.turn_id, outcome);
      }
      runErr = outcome.error;
      checkFiles(true);
    }
  } catch (err) {
    // Go 版这里不会出错；TS 里任何意外都不能让写锁一直挂着。
    runErr = err instanceof Error ? err : new Error(String(err));
  }
  stopViews();
  return { runErr, confirmedGates };
}

/**
 * watchViews 在这一轮进行中轮询收件目录，把 onset studio show 的请求译成 view 事件。
 * 返回的函数停止轮询、把剩下的请求处理完并删掉收件目录；可以调用多次。
 */
function watchViews(
  sess: Session,
  turnID: string,
  inbox: string,
  projectPath: string,
  onConfirm: (req: NonNullable<ViewRequest['confirm']>) => void,
): () => void {
  const seen = new Set<string>();
  const questionSeen = new Set<string>();
  const questionDeferred = new Set<string>();
  const emitEvent = (turn: string, event: NewEvent): void => emit(sess, turn, event);
  const deliver = (): void => {
    for (const req of drainViewInbox(inbox)) {
      if (req.confirm) {
        onConfirm(req.confirm);
        continue;
      }
      if (req.step) writeStepMark(projectPath, req.step);
      emit(sess, turnID, { kind: KindView, text: req.note || undefined, view: req });
    }
    pollPermissions(projectPath, inbox, turnID, sess.permissions, seen, emitEvent);
    pollQuestions(inbox, turnID, sess.questions, questionSeen, questionDeferred, emitEvent);
  };
  const timer = setInterval(deliver, ViewPollInterval);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    deliver();
    expirePermissions(sess.permissions, turnID, emitEvent);
    expireQuestions(sess.questions, turnID, emitEvent);
    fs.rmSync(inbox, { recursive: true, force: true });
  };
}

/**
 * recordUsage 把一次编排调用记进项目的用量账本。续接失败后重开的会话是两次调用，
 * 各记一行：第一次哪怕只打了一行错误，也可能已经读了一遍上下文。
 */
function recordUsage(
  signal: AbortSignal,
  p: Project,
  sess: Session,
  tool: string,
  env: Record<string, string>,
  turnID: string,
  outcome: agentrun.Outcome,
): void {
  const { result, error } = outcome;
  if (!result.started) return;
  const model = result.model || tools.configuredModel(tool, env);
  const cancelled =
    signal.aborted || (error !== null && (error.name === 'AbortError' || error.message === 'context canceled'));
  const entry = ledger.fromResult(ledger.SourceStudio, tool, model, result.sessionID, result.usage, error, cancelled);
  entry.turn = turnID;
  try {
    ledger.append(ledger.projectFile(p.path), entry);
  } catch (err) {
    emit(sess, turnID, { kind: kindNotice, text: '编排用量没能记进账本：' + (err as Error).message });
  }
}
