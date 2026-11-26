import type { PermissionAsk, QuestionAsk, SessionEvent } from '../../types';
import { describeTool, type ProcessItem, seconds, type TurnBlock } from './model';

type Phase =
  | 'starting'
  | 'permission'
  | 'question'
  | 'tool'
  | 'background'
  | 'thinking'
  | 'replying'
  | 'waiting'
  | 'compacting';
export interface TurnActivity {
  phase: Phase;
  label: string;
  detail: string;
  since?: string;
  lastUpdate?: string;
  quiet: boolean;
  active: number;
  completed: number;
  failed: number;
}

// 排队消息、用量和文件刷新不能把「多久没收到 AI 输出」的计时归零。
const activityKinds = new Set([
  'turn-start',
  'thinking',
  'text',
  'tool-call',
  'tool-result',
  'plan',
  'background-tasks',
  'permission',
  'permission-resolved',
  'question',
  'question-deferred',
  'question-resolved',
  'error',
  'notice',
  'view',
  'context-compaction',
]);

/** 只陈述会话事件能证明的进度；没有新输出时不猜测模型内部的思考或网络状态。 */
export function turnActivity(
  turn: TurnBlock,
  events: SessionEvent[],
  asks: PermissionAsk[],
  now: number,
  questions: QuestionAsk[] = [],
): TurnActivity | null {
  if (turn.end || turn.reverted) return null;
  const latest = [...events].reverse().find((event) => event.turn_id === turn.id && activityKinds.has(event.kind));
  const tools = turn.process.filter((item): item is Extract<ProcessItem, { type: 'tool' }> => item.type === 'tool');
  const pending = tools.filter((item) => !item.result);
  const finished = tools.filter((item) => item.result).sort((a, b) => b.result!.seq - a.result!.seq);
  const lastUpdate = latest?.time ?? turn.start;
  const quiet = seconds(lastUpdate, now) >= 30;
  const state: TurnActivity = {
    phase: 'waiting',
    label: '等待模型回复',
    detail: '尚未收到新的模型输出',
    since: lastUpdate,
    lastUpdate,
    quiet,
    active: pending.length,
    completed: finished.filter((item) => !item.result!.is_error).length,
    failed: finished.filter((item) => item.result!.is_error).length,
  };
  const describe = (call: SessionEvent) => {
    const { verb, target } = describeTool(call.tool ?? '', call.input);
    return target ? `${verb} ${target}` : verb;
  };
  if (asks.length > 0) {
    return {
      ...state,
      phase: 'permission',
      label: '等待你批准',
      detail: asks[0].description || '请处理下方的操作请求',
    };
  }
  if (questions.length > 0) {
    const first = questions[0];
    return {
      ...state,
      phase: 'question',
      label: '等待你回答问题',
      detail: first.title || `请完成下方的 ${first.questions.length} 个确认问题`,
    };
  }
  // 压缩期间的提示、后台结果与用量更新不结束压缩；模型恢复输出或新调用才表示继续工作。
  const compact = [...events]
    .reverse()
    .find(
      (event) =>
        event.turn_id === turn.id &&
        ['context-compaction', 'thinking', 'text', 'tool-call', 'error'].includes(event.kind),
    );
  if (compact?.kind === 'context-compaction' && compact.compaction?.state === 'running') {
    return {
      ...state,
      phase: 'compacting',
      label: '正在压缩上下文',
      detail: '正在整理历史对话，释放上下文空间；完成后继续当前任务',
      since: compact.time,
    };
  }
  if (pending.length > 0) {
    return {
      ...state,
      phase: 'tool',
      label: '正在执行操作',
      detail: describe(pending[0].call),
      since: pending[0].call.time,
    };
  }
  if (turn.backgroundTasks.length > 0) {
    return { ...state, phase: 'background', label: '后台任务正在执行', detail: turn.backgroundTasks[0].description };
  }
  if (compact?.kind === 'context-compaction' && compact.compaction?.state === 'completed') {
    const { pre_tokens: before, post_tokens: after } = compact.compaction;
    const detail =
      before !== undefined && after !== undefined
        ? `上下文用量：${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} tokens`
        : '历史对话已整理，等待模型继续当前任务';
    return { ...state, label: '上下文压缩完成，等待模型回复', detail, since: compact.time };
  }
  if (compact?.kind === 'context-compaction' && ['failed', 'cancelled'].includes(compact.compaction?.state ?? '')) {
    return {
      ...state,
      label:
        compact.compaction?.state === 'failed'
          ? '上下文压缩失败，等待模型后续状态'
          : '上下文压缩已取消，等待模型后续状态',
      detail: '尚未收到模型恢复执行的消息',
      since: compact.time,
    };
  }
  if (latest?.kind === 'thinking' && !quiet)
    return { ...state, phase: 'thinking', label: '正在思考', detail: '正在接收模型的思考内容' };
  if (latest?.kind === 'text' && !quiet)
    return { ...state, phase: 'replying', label: '正在回复', detail: '正在接收模型输出' };
  if (!latest || latest.kind === 'turn-start')
    return {
      ...state,
      phase: 'starting',
      label: '等待 AI 首次响应',
      detail: '已提交本轮请求，尚未收到模型输出',
      since: turn.start,
    };
  if (finished[0]) {
    state.detail = `${finished[0].result!.is_error ? '最近失败' : '最近完成'}：${describe(finished[0].call)}`;
  }
  return state;
}

/** 渲染镜头、修接缝，以及等它们跑完的 job_wait：这几样在跑时，「镜头制作」卡片已经逐个镜头说清进度。 */
const renderOps = new Set(['scene_run', 'scene_run_all', 'scene_seams', 'job_wait']);

/**
 * 这一轮只是在等镜头制作：有镜头正在渲染，而这一轮还没结果的操作全是渲染镜头（或等渲染任务跑完）。
 * 这时输入框上方已经有「镜头制作」卡片，「正在执行操作」那张就不再重复；等批准、压缩上下文、别的操作照常显示。
 */
export function waitingOnRender(
  activity: TurnActivity | null,
  turn: TurnBlock | undefined,
  renderingScenes: number,
): boolean {
  if (!activity || !turn || renderingScenes === 0 || activity.phase !== 'tool') return false;
  const pending = turn.process.filter(
    (item): item is Extract<ProcessItem, { type: 'tool' }> => item.type === 'tool' && !item.result,
  );
  return (
    pending.length > 0 &&
    pending.every((item) =>
      renderOps.has(
        (item.call.tool ?? '')
          .toLowerCase()
          .replace(/^mcp__onset__/, '')
          .replace(/^onset[._]/, ''),
      ),
    )
  );
}

/**
 * 输入框上方要不要画进度卡片：在等镜头制作时交给「镜头制作」卡片；但连接断了的时候照常画，
 * 卡片要说清「进度连接中断，正在重连」，不能当成正常等待藏起来。
 */
export function showProgressCard(
  activity: TurnActivity | null,
  turn: TurnBlock | undefined,
  renderingScenes: number,
  reconnecting: boolean,
): boolean {
  return !!activity && (reconnecting || !waitingOnRender(activity, turn, renderingScenes));
}

/**
 * 没收到新消息时要不要提示「可以停止」：这一轮已经执行过或正在执行操作（制作任务动辄几分钟没有输出），
 * 安静是正常的，不劝用户停；只在提交后一直没有任何输出、也还没执行过操作时才提一句。
 */
export function suggestStop(activity: TurnActivity): boolean {
  const waiting = activity.phase === 'waiting' || activity.phase === 'starting';
  return activity.quiet && waiting && activity.active + activity.completed + activity.failed === 0;
}
