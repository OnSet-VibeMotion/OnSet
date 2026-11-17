/**
 * codex app-server 编排（JSON-RPC，stdio）。codex exec 不能中途审批，app-server 能：
 * initialize → thread/start（或 thread/resume 续接）→ turn/start，然后等 turn/completed。
 * 期间 codex 以 item/commandExecution/requestApproval、item/fileChange/requestApproval 请我们批准。
 *
 * 审批策略用 untrusted（codex 自认安全的只读命令直接跑，其余都来问），沙箱仍是 workspace-write 并打开网络
 * （TTS 要连外网，理由同 exec 路径）。来问的命令先过白名单，白名单里的直接放行，其余交给用户。
 * 字段名按 codex-cli 0.163 的 app-server generate-json-schema 写。
 */
import { BasisTotalInput, CodexFastTier, effectiveOptions, LongToolWaitSeconds, longWaitServer, newUsage, windowsOrchestratorEffort, type Usage } from '../tools';
import { runInteractive, unwrapShell, type DriveContext, type PermissionAnswer } from './interactive';
import { KindError, KindPlan, KindSession, KindText, KindThinking, KindToolCall, KindToolResult, clip, compactionEvent, type Event, type PlanItem } from './parse';
import type { Outcome, Spec } from './run';
import { ActiveTasks } from './activetasks';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** 一次 codex 用量（TokenUsageBreakdown）→ 统一口径。codex 的 inputTokens 本就含缓存命中。 */
export function codexUsage(breakdown: unknown, turns: number): Usage {
  const b = obj(breakdown);
  const u = newUsage();
  u.input_tokens = num(b.inputTokens);
  u.cached_input_tokens = num(b.cachedInputTokens);
  u.output_tokens = num(b.outputTokens);
  u.turns = turns;
  u.source = 'codex app-server';
  u.basis = BasisTotalInput;
  return u;
}

function subtract(total: unknown, base: Obj | null): Obj {
  const t = obj(total);
  if (!base) return t;
  const out: Obj = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) out[key] = num(t[key]) - num(base[key]);
  return out;
}

function planStatus(status: string): string {
  if (status === 'inProgress') return 'in_progress';
  if (status === 'completed') return 'completed';
  return 'pending';
}

/** 把 codex 的 ThreadItem 译成统一事件；工具名与 exec 路径（parse.ts 的 parseCodex）一致。 */
export function codexItemEvents(phase: 'started' | 'completed', item: Obj): Event[] {
  const id = str(item.id);
  switch (str(item.type)) {
    case 'contextCompaction':
      return [compactionEvent(phase === 'started' ? 'running' : 'completed')];
    case 'agentMessage':
      return phase === 'completed' && str(item.text) !== '' ? [{ kind: KindText, text: str(item.text) }] : [];
    case 'reasoning': {
      if (phase !== 'completed') return [];
      const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].map((x) => (typeof x === 'string' ? x : str(obj(x).text)));
      const text = parts.filter((x) => x !== '').join('\n');
      return text !== '' ? [{ kind: KindThinking, text }] : [];
    }
    case 'commandExecution':
      if (phase === 'started') return [{ kind: KindToolCall, tool: 'shell', call_id: id, input: { command: unwrapShell(str(item.command)) } }];
      return [{ kind: KindToolResult, tool: 'shell', call_id: id, text: clip(str(item.aggregatedOutput)), is_error: num(item.exitCode) !== 0 || str(item.status) === 'failed' || undefined }];
    case 'fileChange':
    case 'collabAgentToolCall':
    case 'mcpToolCall':
    case 'webSearch': {
      let tool = ({ fileChange: 'file_change', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search', collabAgentToolCall: str(item.tool) } as Record<string, string>)[str(item.type)];
      // MCP 调用按 claude 的写法记成 mcp__<服务>__<工具>：界面与测试要认出调用的是哪个工具。
      if (str(item.type) === 'mcpToolCall' && str(item.server) !== '' && str(item.tool) !== '') tool = `mcp__${str(item.server)}__${str(item.tool)}`;
      if (phase === 'started') return [{ kind: KindToolCall, tool, call_id: id, input: item }];
      return [{ kind: KindToolResult, tool, call_id: id, input: item, is_error: str(item.status) === 'failed' || undefined }];
    }
  }
  return [];
}

/** spawn 的 completed 只表示已派发；子任务的结束看 agentsStates 或对应子会话的通知。 */
export class CodexTasks {
  private readonly tasks = new ActiveTasks();

  item(phase: 'started' | 'completed', item: Obj): Event | null {
    // 0.163 的子任务活动本身也有 item/completed，结束与否由 kind 决定。
    if (item.type === 'subAgentActivity') {
      const id = str(item.agentThreadId);
      if (!id) return null;
      if (item.kind === 'started') this.tasks.start(id, str(item.agentPath).split('/').filter(Boolean).at(-1) || '子任务');
      else if (item.kind === 'completed' || item.kind === 'interrupted') this.tasks.finish(id);
      else return null;
      return this.tasks.event();
    }
    if (item.type !== 'collabAgentToolCall') return null;
    const tool = str(item.tool);
    const call = str(item.id);
    const pending = call ? 'spawn:' + call : '';
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter((id): id is string => typeof id === 'string' && id !== '') : [];
    const states = obj(item.agentsStates);
    if (phase === 'started' && tool === 'spawnAgent' && receivers.length === 0) this.tasks.start(pending, str(item.prompt) || '正在启动子任务');
    if (phase === 'completed' || receivers.length > 0) this.tasks.finish(pending);
    for (const id of new Set([...receivers, ...Object.keys(states)])) {
      const status = str(obj(states[id]).status);
      if (status === 'running' || status === 'pendingInit') {
        const description = tool === 'spawnAgent' || tool === 'followupTask' ? str(item.prompt) : '';
        this.tasks.start(id, description);
      } else if (['interrupted', 'completed', 'errored', 'shutdown', 'notFound'].includes(status)) {
        this.tasks.finish(id);
      } else if (phase === 'completed' && item.status === 'completed') {
        if (['spawnAgent', 'resumeAgent', 'followupTask'].includes(tool)) this.tasks.start(id, str(item.prompt));
        else if (tool === 'closeAgent' || tool === 'interruptAgent') this.tasks.finish(id);
      }
    }
    return this.tasks.event();
  }

  /** 只接已登记的子会话，不能把别的线程或主线程的状态当作子任务。 */
  child(method: string, p: Obj): Event | null {
    const id = str(p.threadId);
    if (!this.tasks.has(id)) return null;
    if (method === 'turn/completed' || method === 'thread/closed') this.tasks.finish(id);
    else if (method === 'thread/status/changed') {
      const status = str(obj(p.status).type);
      if (status === 'active') this.tasks.start(id, '');
      else if (['idle', 'notLoaded', 'systemError'].includes(status)) this.tasks.finish(id);
    } else if (method === 'item/started') {
      const item = obj(p.item);
      this.tasks.progress(id, str(item.command) || str(item.tool) || (item.type === 'reasoning' ? '正在思考' : '正在处理子任务'));
    } else return null;
    return this.tasks.event();
  }
}

/** 用户的回答 → codex 的审批决定。拒绝用 decline（codex 接着这一轮换做法），不用 cancel（会打断整轮）。 */
export function codexDecision(answer: PermissionAnswer): string {
  return answer.decision === 'allow' || answer.decision === 'always' ? 'accept' : 'decline';
}

/** codex 一轮（argv 与环境由 tools.codexAppInvocation 给出）。 */
export function runCodexApp(spec: Spec, emit: (event: Event) => void, signal: AbortSignal | undefined, argv: string[], env: Record<string, string> | undefined): Promise<Outcome> {
  return runInteractive(spec, emit, signal, argv, env, (ctx) => driveCodex(ctx));
}

async function driveCodex(ctx: DriveContext): Promise<void> {
  const { peer, spec, signal } = ctx;
  let threadID = '';
  let turnID = '';
  let baseline: Obj | null = null;
  let finished: (turn: Obj) => void = () => {};
  const completed = new Promise<Obj>((resolve) => (finished = resolve));
  const early: Obj[] = [];
  const tasks = new CodexTasks();

  peer.onNotification((method, params) => {
    const p = obj(params);
    if (threadID !== '' && str(p.threadId) !== '' && str(p.threadId) !== threadID) {
      const event = tasks.child(method, p);
      if (event) ctx.emit(event);
      return;
    }
    switch (method) {
      case 'item/started':
      case 'item/completed': {
        const phase = method === 'item/started' ? 'started' : 'completed';
        for (const event of codexItemEvents(phase, obj(p.item))) ctx.emit(event);
        const background = tasks.item(phase, obj(p.item));
        if (background) ctx.emit(background);
        return;
      }
      case 'turn/plan/updated': {
        const steps = Array.isArray(p.plan) ? p.plan.map(obj) : [];
        const plan: PlanItem[] = steps.map((s) => ({ text: str(s.step), status: planStatus(str(s.status)) })).filter((s) => s.text !== '');
        if (plan.length > 0) ctx.emit({ kind: KindPlan, plan });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const usage = obj(p.tokenUsage);
        // total 是整条会话的累计；续接时要扣掉这一轮之前的部分。第一条更新之前的总数 = total - last。
        if (!baseline) baseline = subtract(usage.total, obj(usage.last));
        ctx.result.usage = codexUsage(subtract(usage.total, baseline), 1);
        return;
      }
      case 'error': {
        const message = str(obj(p.error).message) || str(p.message);
        if (message !== '' && p.willRetry !== true) ctx.emit({ kind: KindError, text: message });
        return;
      }
      case 'turn/completed': {
        const turn = obj(p.turn);
        if (turnID === '') early.push(turn);
        else if (str(turn.id) === turnID) finished(turn);
        return;
      }
    }
  });
  peer.onRequest('item/commandExecution/requestApproval', async (params) => {
    const p = obj(params);
    const answer = await ctx.decide('Bash', { command: unwrapShell(str(p.command)), description: str(p.reason) || undefined });
    return { decision: codexDecision(answer) };
  });
  // MCP 工具调用的审批：codex 在 untrusted 策略下给每次 MCP 调用发一个 elicitation（2026-11，0.163 实测）。
  // onset 的工具服务是客户端自己挂的，直接同意；别的服务照常问用户。
  peer.onRequest('mcpServer/elicitation/request', async (params) => {
    const p = obj(params);
    const server = str(p.serverName);
    if (spec.toolsServer && server === spec.toolsServer.name) return { action: 'accept', content: {} };
    const answer = await ctx.decide('mcp__' + server, { message: str(p.message) });
    return { action: answer.decision === 'allow' || answer.decision === 'always' ? 'accept' : 'decline', content: answer.decision === 'allow' || answer.decision === 'always' ? {} : null };
  });
  peer.onRequest('item/fileChange/requestApproval', async (params) => {
    const p = obj(params);
    const answer = await ctx.decide('Edit', { path: str(p.grantRoot) || undefined, reason: str(p.reason) || '修改工作区之外的文件' });
    return { decision: codexDecision(answer) };
  });
  const race = <T>(p: Promise<T>) => Promise.race([p, ctx.exited]);

  await race(peer.request('initialize', { clientInfo: { name: 'onset', title: 'OnSet', version: '1' } }));
  peer.notification('initialized', {});
  const cwd = spec.workdir || process.cwd();
  const writable = spec.access?.writableDirs ?? [];
  // 同 orchestratorInvocation：codex 能长时间等一次工具调用，放宽工具服务的等待上限并写上对应的超时。
  const server = longWaitServer(spec.toolsServer);
  const settings = {
    cwd,
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    ...(spec.model ? { model: spec.model } : {}),
    // 快速模式是服务档位（tools/options.ts 的 CodexFastTier），thread/start 与 thread/resume 都认。
    ...(effectiveOptions('codex', spec.options).fast === 'on' ? { serviceTier: CodexFastTier } : {}),
    config: {
      'sandbox_workspace_write.network_access': true,
      ...(writable.length > 0 ? { 'sandbox_workspace_write.writable_roots': writable } : {}),
      // onset 的工具服务：编排工具只经它调用 onset（codex 的 config 键用点号路径，值按 TOML 的结构给）。
      ...(server
        ? { [`mcp_servers.${server.name}`]: { command: server.command, args: server.args, env: server.env ?? {}, tool_timeout_sec: LongToolWaitSeconds + 120 } }
        : {}),
    },
  };
  let opened: Obj;
  if (spec.resume && spec.sessionID) opened = obj(await race(peer.request('thread/resume', { threadId: spec.sessionID, excludeTurns: true, ...settings })));
  else opened = obj(await race(peer.request('thread/start', settings)));
  threadID = str(obj(opened.thread).id) || spec.sessionID || '';
  if (threadID === '') throw new Error('thread/start 没有返回会话 id');
  ctx.result.model = str(opened.model);
  ctx.emit({ kind: KindSession, session_id: threadID });

  // 推理强度只有 turn/start 认；用户选的优先于 Windows 上的缺省。
  const effort = effectiveOptions('codex', spec.options).effort || windowsOrchestratorEffort(spec.env ?? {});
  const started = obj(await race(peer.request('turn/start', { threadId: threadID, input: [{ type: 'text', text: spec.prompt }], ...(effort ? { effort } : {}) })));
  turnID = str(obj(started.turn).id);
  const already = early.find((t) => str(t.id) === turnID);
  if (already) finished(already);
  const onAbort = () => void peer.request('turn/interrupt', { threadId: threadID, turnId: turnID }).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  let turn: Obj;
  try {
    turn = await race(completed);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (str(turn.status) === 'failed') {
    const message = str(obj(turn.error).message) || 'codex 这一轮失败了';
    ctx.emit({ kind: KindError, text: message });
    throw new Error(message);
  }
}
