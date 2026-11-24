import type { BackgroundTask, PermissionAsk, PlanItem, SessionEvent, Usage, ViewRequest } from '../../types';

export {
  findMedia,
  type MediaRef,
  parseChoices,
  parseStylePicks,
  type StylePick,
  splitAttachmentText,
  stripChoices,
  stylePickMessage,
} from './proseParse';
export { describeTool, pluginVerb, setPluginVerbs, strippedCommand } from './toolDescribe';

/** 一轮里「过程」的一项：思考、工具调用、中间的话、报错与提示。 */
export type ProcessItem =
  | { type: 'thinking'; event: SessionEvent; until?: string }
  | { type: 'tool'; call: SessionEvent; result?: SessionEvent }
  | { type: 'text'; event: SessionEvent }
  | { type: 'note'; event: SessionEvent }
  /** 待办清单里进行中的那一项换了：在过程里插一行小标题。 */
  | { type: 'step'; text: string; index: number; total: number };

export type TurnState = 'running' | 'thinking' | 'done' | 'failed' | 'stopped' | 'interrupted';

export interface TurnBlock {
  kind: 'turn';
  id: string;
  user?: SessionEvent;
  start?: string;
  end?: SessionEvent;
  state: TurnState;
  process: ProcessItem[];
  /** 最后一段话：过程之后给用户看的回复。 */
  prose: SessionEvent[];
  plan: PlanItem[] | null;
  backgroundTasks: BackgroundTask[];
  usage?: Usage;
  reverted: boolean;
  /** 这一轮里编排工具请用户看的页面，显示在回复下面。 */
  views: ViewRequest[];
}

export type Block = { kind: 'user'; event: SessionEvent } | TurnBlock | { kind: 'note'; event: SessionEvent };

export interface QueuedMessage {
  id: string;
  text: string;
  seq: number;
}

/** 把会话事件流整理成对话：用户消息、每一轮（过程 + 回复 + 结尾）、轮外的提示。 */
export function buildBlocks(events: SessionEvent[]): Block[] {
  const blocks: Block[] = [];
  const turns = new Map<string, { block: TurnBlock; raw: SessionEvent[] }>();
  const reverted = new Set(events.filter((e) => e.kind === 'turn-reverted').map((e) => e.turn_id));
  const turnOf = (id: string) => {
    let turn = turns.get(id);
    if (!turn) {
      const block: TurnBlock = {
        kind: 'turn',
        id,
        state: 'running',
        process: [],
        prose: [],
        plan: null,
        backgroundTasks: [],
        reverted: reverted.has(id),
        views: [],
      };
      turn = { block, raw: [] };
      turns.set(id, turn);
      blocks.push(block);
    }
    return turn;
  };
  for (const event of events) {
    switch (event.kind) {
      case 'session':
      case 'done':
      case 'queued':
      case 'unqueued':
      case 'turn-reverted':
      case 'permission':
      case 'permission-resolved':
        continue;
      case 'user':
        blocks.push({ kind: 'user', event });
        if (event.turn_id) turnOf(event.turn_id).block.user = event;
        continue;
    }
    if (!event.turn_id) {
      if (event.kind === 'notice' || event.kind === 'error') blocks.push({ kind: 'note', event });
      continue;
    }
    const turn = turnOf(event.turn_id);
    if (event.kind === 'turn-start') turn.block.start = event.time;
    else if (event.kind === 'turn-end') turn.block.end = event;
    else if (event.kind === 'usage') turn.block.usage = event.usage;
    else if (event.kind === 'view' && event.view) turn.block.views.push(event.view);
    else turn.raw.push(event);
  }
  let previous: SessionEvent[] = [];
  for (const { block, raw } of turns.values()) {
    shapeTurn(block, dropReplay(raw, previous));
    previous = raw;
  }
  return blocks;
}

/**
 * 续接时有的工具会把上一轮结尾的思考与回复原样再吐一遍（qoder 续接前压缩长对话后实测），后端已经不再记下它们
 * （studio/sessions.ts 的 replayGuard）；这里照同一条规则收拾以前存下的：一轮开头、还没有任何新东西之前，
 * 与上一轮里某段思考或回复一字不差的，不显示。
 */
function dropReplay(raw: SessionEvent[], previous: SessionEvent[]): SessionEvent[] {
  const said = new Set(
    previous
      .filter((e) => (e.kind === 'text' || e.kind === 'thinking') && (e.text ?? '').trim() !== '')
      .map((e) => e.kind + '\u0000' + (e.text ?? '').trim()),
  );
  if (said.size === 0) return raw;
  const out: SessionEvent[] = [];
  let guarding = true;
  for (const e of raw) {
    if (e.text_id) guarding = false; // ACP 的历史已过滤，不能按上一轮的短片段删掉新思考。
    if (guarding && (e.kind === 'text' || e.kind === 'thinking')) {
      if (said.has(e.kind + '\u0000' + (e.text ?? '').trim())) continue;
      guarding = false;
    } else if (guarding && (e.kind === 'tool-call' || e.kind === 'tool-result' || e.kind === 'plan')) {
      guarding = false;
    }
    out.push(e);
  }
  return out;
}

function shapeTurn(block: TurnBlock, raw: SessionEvent[]) {
  const calls = new Map<string, { type: 'tool'; call: SessionEvent; result?: SessionEvent }>();
  const hidden = new Set<string>();
  const thoughts = new Map<string, Extract<ProcessItem, { type: 'thinking' }>>();
  const items: ProcessItem[] = [];
  let currentStep = '';
  for (const event of raw) {
    switch (event.kind) {
      case 'background-tasks':
        block.backgroundTasks = event.background_tasks ?? [];
        break;
      case 'plan':
        if (event.plan?.length) {
          block.plan = event.plan;
          const index = event.plan.findIndex((item) => item.status === 'in_progress');
          if (index >= 0 && event.plan[index].text !== currentStep) {
            currentStep = event.plan[index].text;
            items.push({ type: 'step', text: currentStep, index: index + 1, total: event.plan.length });
          }
        }
        break;
      case 'thinking': {
        const previous = event.text_id ? thoughts.get(event.text_id) : undefined;
        if (previous) {
          previous.event = { ...previous.event, text: (previous.event.text ?? '') + (event.text ?? '') };
          break;
        }
        const last = items[items.length - 1];
        const item = last?.type === 'thinking' ? last : { type: 'thinking' as const, event };
        // 连续的思考片段并成一行。
        if (item === last) item.event = { ...item.event, text: `${item.event.text ?? ''}\n\n${event.text ?? ''}` };
        else items.push(item);
        if (event.text_id) thoughts.set(event.text_id, item);
        break;
      }
      case 'tool-call': {
        // 待办清单工具只用来更新进度，不单列一行；它们的结果也不列。
        if (planTools.test(event.tool ?? '')) {
          if (event.call_id) hidden.add(event.call_id);
          break;
        }
        // CodeBuddy 会先发空参数、再以同一 call_id 补发完整调用。更新原行，否则结果只会配到最后
        // 一行，早先的「执行」会一直转。保留首次事件的时间与序号，耗时从开始算，也保留已有结果。
        const existing = event.call_id ? calls.get(event.call_id) : undefined;
        if (existing) {
          existing.call = { ...existing.call, ...unwrapCall(event), time: existing.call.time, seq: existing.call.seq };
          break;
        }
        const item = { type: 'tool' as const, call: unwrapCall(event) };
        if (event.call_id) calls.set(event.call_id, item);
        items.push(item);
        break;
      }
      case 'tool-result': {
        const owner = event.call_id ? calls.get(event.call_id) : undefined;
        if (owner) owner.result = event;
        else if (!(event.call_id && hidden.has(event.call_id)) && !planTools.test(event.tool ?? '')) {
          items.push({ type: 'tool', call: { ...event, kind: 'tool-call' }, result: event });
        }
        break;
      }
      case 'text':
        items.push({ type: 'text', event });
        break;
      case 'error':
      case 'notice':
      case 'context-compaction':
        items.push({ type: 'note', event });
        break;
    }
  }
  // 思考一直持续到下一项开始。
  items.forEach((item, index) => {
    if (item.type === 'thinking') {
      const next = items.slice(index + 1).find((other) => other.type !== 'step');
      item.until = next ? timeOf(next) : block.end?.time;
    }
  });
  // 末尾连续的几段话是这一轮的回复，放在过程之外。思考与只标步骤、切页的调用（studio_step /
  // studio_show）不算把回复隔开：编排工具常常写完汇报再想一下、标步骤、补一句「请选一个方向」，
  // 不跳过的话汇报连同里面的选项与风格推荐都被收进折叠的过程，界面上什么都点不了（2026-11 qoder 实测）。
  let cut = items.length;
  const between = (item: ProcessItem) => item.type === 'thinking' || item.type === 'step' || quietTool(item);
  while (cut > 0 && (items[cut - 1].type === 'text' || between(items[cut - 1]))) cut--;
  // 开头的思考、标记留在过程里，回复从第一段话开始。
  while (cut < items.length && items[cut].type !== 'text') cut++;
  const tail = items.slice(cut);
  block.prose = tail.flatMap((item) => (item.type === 'text' ? [item.event] : []));
  block.process = [...items.slice(0, cut), ...tail.filter((item) => item.type !== 'text')];
  const status = block.end?.status;
  // turn-end 表示 CLI 进程已结束；中断、取消、重开历史也不能留下仍在执行的假象。
  if (block.end) block.backgroundTasks = [];
  if (!block.end) {
    const last = items[items.length - 1];
    block.state = last?.type === 'thinking' ? 'thinking' : 'running';
  } else if (status === 'failed') block.state = 'failed';
  else if (status === 'cancelled') block.state = 'stopped';
  else if (status === 'interrupted') block.state = 'interrupted';
  else block.state = 'done';
}

/** 只用来更新待办清单的工具：TodoWrite 一次给全，TaskCreate / TaskUpdate 逐条建、逐条改（qoder、新版 claude）。 */
const planTools = /^(todo_?write|task_?create|task_?update)$/i;

/** 只做标记、不产出内容的 onset 工具：跑完的才算，还在跑的照常是过程的一部分。 */
const quietTools = /^(mcp__onset__|onset[._])?(studio_step|studio_show)$/i;

function quietTool(item: ProcessItem): boolean {
  return item.type === 'tool' && !!item.result && quietTools.test(item.call.tool ?? '');
}

/** qoder 经 mcp_call({toolName, arguments}) 调 MCP 工具；解析器已经拆开，这里照顾拆开之前存下的事件。 */
function unwrapCall(event: SessionEvent): SessionEvent {
  if (event.tool !== 'mcp_call' || !event.input || typeof event.input !== 'object') return event;
  const input = event.input as Record<string, unknown>;
  if (typeof input.toolName !== 'string' || input.toolName === '') return event;
  return { ...event, tool: input.toolName, input: input.arguments ?? {} };
}

function timeOf(item: ProcessItem): string | undefined {
  switch (item.type) {
    case 'thinking':
    case 'text':
    case 'note':
      return item.event.time;
    case 'tool':
      return item.call.time;
  }
  return undefined;
}

/**
 * 编排工具还在等用户批准的调用：发过 permission、还没有对应的 permission-resolved。
 * 这一轮结束时后端会把没答的都答成 expired，所以重开客户端、读回历史事件时不会留下过期的卡片。
 */
export function pendingPermissions(events: SessionEvent[]): PermissionAsk[] {
  const open = new Map<string, PermissionAsk & { turn?: string }>();
  for (const event of events) {
    if (event.kind === 'permission' && event.permission) {
      open.set(event.permission.id, { ...event.permission, turn: event.turn_id });
    } else if (event.kind === 'permission-resolved' && event.permission) {
      open.delete(event.permission.id);
    } else if (event.kind === 'turn-end') {
      // 一轮结束了，它的请求不会再有人等（客户端中途退出时没来得及发 resolved）。
      for (const [id, item] of open) if (item.turn === event.turn_id) open.delete(id);
    }
  }
  return [...open.values()];
}

/** 还在排队的消息：发过 queued、没被移除、之后也还没出现用户消息（出现即已合并发出）。 */
export function queuedMessages(events: SessionEvent[]): QueuedMessage[] {
  let queue: QueuedMessage[] = [];
  for (const event of events) {
    if (event.kind === 'queued' && event.queue_id) {
      queue.push({ id: event.queue_id, text: event.text ?? '', seq: event.seq });
    } else if (event.kind === 'unqueued') queue = queue.filter((item) => item.id !== event.queue_id);
    else if (event.kind === 'user') queue = [];
  }
  return queue;
}

/** 两个时间点之间的秒数。 */
export function seconds(from?: string, to?: string | number): number {
  if (!from) return 0;
  const end = typeof to === 'number' ? to : to ? Date.parse(to) : Date.now();
  return Math.max(0, (end - Date.parse(from)) / 1000);
}

export function formatElapsed(value: number): string {
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  const m = Math.floor(value / 60);
  const s = Math.round(value % 60);
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
