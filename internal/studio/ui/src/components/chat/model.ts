import type { PlanItem, SessionEvent, Usage, ViewRequest } from '../../types';

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
      const block: TurnBlock = { kind: 'turn', id, state: 'running', process: [], prose: [], plan: null, reverted: reverted.has(id), views: [] };
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
  for (const { block, raw } of turns.values()) shapeTurn(block, raw);
  return blocks;
}

function shapeTurn(block: TurnBlock, raw: SessionEvent[]) {
  const calls = new Map<string, { type: 'tool'; call: SessionEvent; result?: SessionEvent }>();
  const items: ProcessItem[] = [];
  let currentStep = '';
  for (const event of raw) {
    switch (event.kind) {
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
        const last = items[items.length - 1];
        // 连续的思考片段并成一行。
        if (last?.type === 'thinking') last.event = { ...last.event, text: `${last.event.text ?? ''}\n\n${event.text ?? ''}` };
        else items.push({ type: 'thinking', event });
        break;
      }
      case 'tool-call': {
        // 待办清单工具只用来更新进度，不单列一行。
        if (/^todo_?write$/i.test(event.tool ?? '')) break;
        const item = { type: 'tool' as const, call: event };
        if (event.call_id) calls.set(event.call_id, item);
        items.push(item);
        break;
      }
      case 'tool-result': {
        const owner = event.call_id ? calls.get(event.call_id) : undefined;
        if (owner) owner.result = event;
        else if (!/^todo_?write$/i.test(event.tool ?? '')) items.push({ type: 'tool', call: { ...event, kind: 'tool-call' }, result: event });
        break;
      }
      case 'text':
        items.push({ type: 'text', event });
        break;
      case 'error':
      case 'notice':
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
  // 末尾连续的几段话是这一轮的回复，放在过程之外。
  let cut = items.length;
  while (cut > 0 && items[cut - 1].type === 'text') cut--;
  block.prose = items.slice(cut).map((item) => (item as { type: 'text'; event: SessionEvent }).event);
  block.process = items.slice(0, cut);
  const status = block.end?.status;
  if (!block.end) {
    const last = items[items.length - 1];
    block.state = last?.type === 'thinking' ? 'thinking' : 'running';
  } else if (status === 'failed') block.state = 'failed';
  else if (status === 'cancelled') block.state = 'stopped';
  else if (status === 'interrupted') block.state = 'interrupted';
  else block.state = 'done';
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

/** 还在排队的消息：发过 queued、没被移除、之后也还没出现用户消息（出现即已合并发出）。 */
export function queuedMessages(events: SessionEvent[]): QueuedMessage[] {
  let queue: QueuedMessage[] = [];
  for (const event of events) {
    if (event.kind === 'queued' && event.queue_id) queue.push({ id: event.queue_id, text: event.text ?? '', seq: event.seq });
    else if (event.kind === 'unqueued') queue = queue.filter((item) => item.id !== event.queue_id);
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

const choicesBlock = /```choices\s*\n([\s\S]*?)```/;

/** 去掉回复里的 choices 代码块：选项另外显示成按钮。 */
export function stripChoices(text: string): string {
  return text.replace(choicesBlock, '').trimEnd();
}

/** 解析 choices 代码块里的选项：每行一个，去掉列表符号。 */
export function parseChoices(text: string): string[] {
  const match = choicesBlock.exec(text);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** 用户消息里服务端附上的附件说明，拆出来另外显示。 */
export function splitAttachmentText(text: string): { body: string; extra: string } {
  const index = text.search(/\n\n(用户上传的文件|用户引用的内容|附带的画面上下文)/);
  if (index < 0) return { body: text, extra: '' };
  return { body: text.slice(0, index), extra: text.slice(index).trim() };
}

/** 工具名译成一个动词，配上最能说明「做了什么」的那个参数。 */
export function describeTool(tool: string, input: unknown): { verb: string; target: string; command: boolean; path?: string } {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const name = tool.toLowerCase();
  const path = text('file_path') || text('path') || text('filePath') || text('notebook_path');
  if (name === 'bash' || name === 'shell' || name === 'command_execution') {
    const command = text('command') || (Array.isArray(record.command) ? (record.command as string[]).join(' ') : '');
    return { verb: '执行', target: command, command: true };
  }
  if (name === 'read') return { verb: '读取', target: path, command: false, path };
  if (name === 'write') return { verb: '创建', target: path, command: false, path };
  if (name === 'edit' || name === 'multiedit' || name === 'notebookedit') return { verb: '编辑', target: path, command: false, path };
  if (name === 'file_change') {
    const changes = Array.isArray(record.changes) ? (record.changes as { path?: string }[]) : [];
    return { verb: '改文件', target: changes.map((c) => c.path).filter(Boolean).join('、'), command: false };
  }
  if (name === 'grep' || name === 'glob') return { verb: '搜索', target: text('pattern'), command: false };
  if (name === 'webfetch') return { verb: '访问', target: text('url'), command: false };
  if (name === 'websearch' || name === 'web_search') return { verb: '搜索网页', target: text('query'), command: false };
  if (name === 'task' || name === 'agent') return { verb: '子任务', target: text('description'), command: false };
  const fallback = text('description') || text('url') || text('pattern') || '';
  return { verb: tool, target: fallback, command: false };
}
