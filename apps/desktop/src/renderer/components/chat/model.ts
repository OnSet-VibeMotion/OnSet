import type { BackgroundTask, PermissionAsk, PlanItem, SessionEvent, Usage, ViewRequest } from '../../types';

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
      const block: TurnBlock = { kind: 'turn', id, state: 'running', process: [], prose: [], plan: null, backgroundTasks: [], reverted: reverted.has(id), views: [] };
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
  const said = new Set(previous.filter((e) => (e.kind === 'text' || e.kind === 'thinking') && (e.text ?? '').trim() !== '').map((e) => e.kind + '\u0000' + (e.text ?? '').trim()));
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
        else if (!(event.call_id && hidden.has(event.call_id)) && !planTools.test(event.tool ?? '')) items.push({ type: 'tool', call: { ...event, kind: 'tool-call' }, result: event });
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
    if (event.kind === 'permission' && event.permission) open.set(event.permission.id, { ...event.permission, turn: event.turn_id });
    else if (event.kind === 'permission-resolved' && event.permission) open.delete(event.permission.id);
    else if (event.kind === 'turn-end') {
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
  return text.replace(choicesBlock, '').replace(filmStylesBlock, '').trimEnd();
}

/**
 * 推荐的整片风格：film-styles 代码块，每行「来源/目录名 理由」是全片的默认风格；
 * 「来源/目录名 [用在哪一段] 理由」是只给那一段换的风格（studio/sessions.ts 的 studioInteraction）。
 */
const filmStylesBlock = /```film-styles\s*\n([\s\S]*?)```/;

export interface StylePick {
  key: string;
  reason: string;
  /** 只用在哪一段（方括号里写的，例如「回忆段，镜头 04–06」）；空是全片的默认风格。 */
  scope: string;
  /** 来自 film-styles 代码块。没有代码块、按回复里写到的风格标识认出来的，不知道是给全片还是给一段。 */
  explicit: boolean;
}

/**
 * 回复里推荐的整片风格。优先读 film-styles 代码块；没有代码块时，回复里写到的
 * 已知风格标识（「来源/目录名」，制作提示词要求推荐时写明）也算，按出现顺序。
 */
export function parseStylePicks(text: string, known: Set<string>): StylePick[] {
  const block = filmStylesBlock.exec(text);
  const picks: StylePick[] = [];
  const seen = new Set<string>();
  if (block) {
    for (const raw of block[1].split('\n')) {
      const line = raw.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim();
      const match = /^`?([\w.-]+\/[\w.-]+)`?\s*(?:[[【]([^\]】]*)[\]】])?\s*[:：—–-]*\s*(.*)$/.exec(line);
      if (!match) continue;
      const scope = (match[2] ?? '').trim();
      // 同一种风格可以既推荐给全片、又推荐给某一段，按「风格 + 范围」去重。
      if (seen.has(match[1] + '\u0000' + scope)) continue;
      seen.add(match[1] + '\u0000' + scope);
      picks.push({ key: match[1], reason: match[3].trim(), scope, explicit: true });
    }
    return picks.slice(0, 6);
  }
  if (known.size === 0) return [];
  for (const match of text.matchAll(/[\w.-]+\/[\w.-]+/g)) {
    const key = match[0];
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    picks.push({ key, reason: '', scope: '', explicit: false });
  }
  return picks.slice(0, 6);
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

/**
 * 命令开头的 `cd <目录> &&` / `cd <目录>;` 去掉：渲染器（qoder 尤甚）每条命令都先 cd 到镜头或项目目录，
 * 一行只显示得下开头，看到的全是 cd，真正跑的是什么反而看不见。完整命令仍在 `full` 里。
 */
export function strippedCommand(command: string): string {
  let rest = command.trim();
  for (;;) {
    const match = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(rest);
    if (!match || match[0].length >= rest.length) return rest;
    rest = rest.slice(match[0].length);
  }
}

/** 工具名译成一个动词，配上最能说明「做了什么」的那个参数。 */
export function describeTool(tool: string, input: unknown): { verb: string; target: string; command: boolean; path?: string; full?: string } {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const name = tool.toLowerCase();
  const path = text('file_path') || text('path') || text('filePath') || text('notebook_path');
  if (name === 'bash' || name === 'shell' || name === 'command_execution') {
    const command = text('command') || (Array.isArray(record.command) ? (record.command as string[]).join(' ') : '');
    return { verb: '执行', target: strippedCommand(command), command: true, full: command };
  }
  if (name === 'read') return { verb: '读取', target: path, command: false, path };
  if (name === 'write') return { verb: '创建', target: path, command: false, path };
  if (name === 'edit' || name === 'multiedit' || name === 'notebookedit') return { verb: '编辑', target: path, command: false, path };
  if (name === 'file_change') {
    const changes = Array.isArray(record.changes) ? (record.changes as { path?: string }[]) : [];
    return { verb: '改文件', target: changes.map((c) => c.path).filter(Boolean).join('、'), command: false };
  }
  if (name === 'grep' || name === 'glob') return { verb: '搜索', target: text('pattern'), command: false };
  // 制作人（pi）自带的找文件、列目录。
  if (name === 'find') return { verb: '找文件', target: text('pattern') || path, command: false };
  if (name === 'ls') return { verb: '查看目录', target: path, command: false, path };
  if (name === 'webfetch') return { verb: '访问', target: text('url'), command: false };
  if (name === 'websearch' || name === 'web_search') return { verb: '搜索网页', target: text('query'), command: false };
  if (name === 'task' || name === 'agent') return { verb: '子任务', target: text('description'), command: false };
  // onset 的工具：claude 系经 MCP 带 mcp__onset__ 前缀，ACP 带 am_ / onset.，制作人直接用操作名。
  const bare = name.replace(/^mcp__onset__/, '').replace(/^onset[._]/, '');
  if (/^(mcp__onset__|onset[._])/.test(name) || bare in onsetVerbs || bare === 'hyperframes') return onsetTool(bare, record);
  const fallback = text('description') || text('url') || text('pattern') || '';
  return { verb: tool, target: fallback, command: false };
}

/** HyperFrames 子命令说成人话：渲染器大半时间在跑它们。 */
const hyperframesVerbs: Record<string, string> = {
  lint: '检查合成代码',
  check: '检查画面',
  validate: '校验合成',
  snapshot: '截取画面',
  render: '渲染视频',
  inspect: '检查布局',
  timeline: '读取时间线',
  compositions: '列出合成',
  info: '查看合成信息',
  init: '建合成骨架',
};

/** onset 工具服务里常用工具的说法；其余按工具名把下划线换成空格。 */
const onsetVerbs: Record<string, string> = {
  scene_run: '渲染镜头',
  scene_run_all: '渲染全部镜头',
  scene_lint: '检查镜头',
  scene_frames: '抽帧查看',
  scene_cues: '计算镜头时长',
  scene_prepare: '准备镜头目录',
  scene_usage: '查看渲染用量',
  job_wait: '等任务跑完',
  job_cancel: '取消任务',
  tool_help: '查工具说明',
  concat: '拼接成片',
  review: '复查成片',
  align_build: '生成配音时间轴',
  align_run: '对齐配音和字幕',
  timing_report: '生成时长报告',
  audio_mix: '混音并校验成片',
  audio_patch_voice: '替换局部配音',
  phrase_frames: '生成短语验收证据',
  flow_guide: '查看制作阶段说明',
  align_text: '整理朗读文本',
  audio_check: '校验字幕时间轴',
  validate_reads: '检查阅读时长',
  validate_video: '校验成片',
  beat_cues: '计算镜头时长',
  film_style_use: '换整片风格',
  voice_list: '查看音色',
  voice_save: '存音色',
  studio_show: '打开页面',
  memory_remember: '记下偏好',
  config_get: '读取配置',
};

/** 内置插件给自己的工具写的说法（/api/stations 的 contents.ops[].verb），由 app.tsx 在读到插件列表后填。 */
const pluginVerbs = new Map<string, string>();

/** 内置插件工具的说法；没登记时为 undefined。 */
export function pluginVerb(name: string): string | undefined {
  return pluginVerbs.get(name);
}

export function setPluginVerbs(entries: { name: string; verb: string }[]): void {
  pluginVerbs.clear();
  for (const e of entries) if (e.verb) pluginVerbs.set(e.name, e.verb);
}

function onsetTool(name: string, record: Record<string, unknown>): { verb: string; target: string; command: boolean } {
  const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : '');
  const args = Array.isArray(record.args) ? (record.args as unknown[]).map(String).join(' ') : '';
  if (name === 'hyperframes') {
    const sub = text('subcommand');
    return { verb: hyperframesVerbs[sub] ?? `HyperFrames ${sub}`.trim(), target: args, command: false };
  }
  if (name === 'job_wait' || name === 'job_cancel') return { verb: onsetVerbs[name], target: text('job'), command: false };
  const target = text('scene') || text('scene_id') || text('tool') || text('page') || text('key') || text('name') || args;
  return { verb: onsetVerbs[name] ?? pluginVerbs.get(name) ?? name.replace(/_/g, ' '), target, command: false };
}

/** 回复里提到的媒体文件：试听、封面、预览视频。 */
export interface MediaRef {
  path: string;
  kind: 'audio' | 'image' | 'video';
}

const mediaPattern = /[^\s`'"“”‘’（）()<>|，。、；：！？]+?\.(mp3|wav|m4a|aac|flac|ogg|opus|png|jpe?g|webp|gif|mp4|mov|webm)(?![\w])/gi;

function mediaKind(path: string): MediaRef['kind'] {
  if (/\.(mp4|mov|webm)$/i.test(path)) return 'video';
  if (/\.(png|jpe?g|webp|gif)$/i.test(path)) return 'image';
  return 'audio';
}

/**
 * 找出回复里写到的、项目里确实存在的媒体文件，按出现顺序。编排工具常常只写文件名
 * （表格里一列 `try-A.wav`，目录在前文另说），所以也按文件名找：同名的有多个时，
 * 优先回复里提到过的那个目录下的。
 */
export function findMedia(text: string, files: string[]): MediaRef[] {
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const name = file.split('/').pop() ?? file;
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const fileSet = new Set(files);
  for (const match of text.matchAll(mediaPattern)) {
    const token = match[0].replace(/^\.\//, '').replace(/^\/+/, '');
    let path = '';
    if (fileSet.has(token)) path = token;
    else if (token.includes('/')) path = files.find((file) => file.endsWith('/' + token) || token.endsWith('/' + file)) ?? '';
    if (!path) {
      const candidates = byName.get(token.split('/').pop() ?? token) ?? [];
      path = candidates.find((file) => text.includes(file.slice(0, file.lastIndexOf('/') + 1))) ?? candidates[0] ?? '';
    }
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, kind: mediaKind(path) });
  }
  return out.slice(0, 12);
}

/**
 * 点风格卡片发出的那句话；收起已答的选项时按它认出选的是哪个。
 * 全片默认、只给一段、不知道是哪种（回复里没有 film-styles 代码块）各是一种说法，不能都说成「整片风格」。
 */
export function stylePickMessage(name: string, pick: StylePick): string {
  if (!pick.explicit) return `选「${name}」（${pick.key}）这个风格`;
  if (pick.scope) return `${pick.scope}用「${name}」风格（${pick.key}），其余镜头不变`;
  return `整片风格用「${name}」（${pick.key}）`;
}
