/**
 * ACP（Agent Client Protocol）编排：opencode acp 与 codebuddy --acp。
 *
 * 一轮 = initialize → session/new（或 session/load 续接）→ session/prompt，期间对方用 session/update 推送
 * 正文、思考、工具调用与待办，用 session/request_permission 请我们批准工具调用。2026-11 用 opencode 2.1.0
 * 实测：请求里的 toolCall 带 rawInput.command；拒绝后 opencode 直接结束这一轮（stopReason cancelled），
 * 不像 claude 那样接着换做法。CodeBuddy 2.168 的审批、续接与后台子任务也经真实 CLI 验证。
 */
import { BasisTotalInput, type McpServer, newUsage } from '../tools';
import { runInteractive, type DriveContext, type PermissionAnswer } from './interactive';
import { KindError, KindPlan, KindSession, KindText, KindThinking, KindToolCall, KindToolResult, clip, type Event, type PlanItem } from './parse';
import type { Outcome, Spec } from './run';
import { ActiveTasks } from './activetasks';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** ACP 的协议版本（整数）。 */
export const ACPProtocolVersion = 1;

/** 把一段 ACP content（ContentBlock 或 ToolCallContent 数组）里的文字拼起来。 */
export function acpText(content: unknown): string {
  if (Array.isArray(content)) return content.map(acpText).filter((s) => s !== '').join('\n');
  const c = obj(content);
  if (c.type === 'text') return str(c.text);
  if (c.type === 'content') return acpText(c.content);
  if (c.type === 'diff') return `${str(c.path)} 已修改`;
  return '';
}

/** 审批请求里的工具调用 → 界面要的 (toolName, input)：shell 命令一律当 Bash，界面据此显示命令、记前缀。 */
export function acpPermissionTool(toolCall: unknown): { toolName: string; input: unknown } {
  const t = obj(toolCall);
  const raw = obj(t.rawInput);
  const command = str(raw.command);
  if (command !== '' || t.kind === 'execute') {
    const title = str(t.title);
    return { toolName: 'Bash', input: { command: command || title, description: title !== '' && title !== command ? title : str(raw.description) || undefined } };
  }
  return { toolName: str(t.name) || str(t.title) || str(t.kind) || 'tool', input: t.rawInput ?? { title: str(t.title) } };
}

/** 用户的回答 → ACP 的选项。always 也只答「这一次」：「以后都允许」由客户端自己记，不写进对方的配置。 */
export function acpOutcome(options: unknown, answer: PermissionAnswer): Obj {
  const list = Array.isArray(options) ? options.map(obj) : [];
  const pick = (...kinds: string[]) => {
    for (const kind of kinds) {
      const found = list.find((o) => o.kind === kind);
      if (found) return str(found.optionId);
    }
    return '';
  };
  const allow = answer.decision === 'allow' || answer.decision === 'always';
  const optionId = allow ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always');
  if (optionId === '') return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId } };
}

function planStatus(status: string): string {
  if (status === 'in_progress' || status === 'completed') return status;
  return 'pending';
}

/**
 * 把 session/update 译成统一事件。正文与思考是一小段一小段推来的，攒成一条再发：统一事件是消息级的，
 * 每个字一条事件会把对话撑爆。工具调用、待办或一轮结束时把攒着的发出去。
 */
export class ACPTranslator {
  private textBuf = '';
  private thoughtBuf = '';
  private readonly tools = new Map<string, string>();
  private readonly tasks = new ActiveTasks();
  private readonly teams = new Map<string, Map<string, string>>();

  constructor(private readonly emit: (event: Event) => void) {}

  flush(): void {
    if (this.thoughtBuf.trim() !== '') this.emit({ kind: KindThinking, text: this.thoughtBuf.trim() });
    if (this.textBuf.trim() !== '') this.emit({ kind: KindText, text: this.textBuf.trim() });
    this.thoughtBuf = '';
    this.textBuf = '';
  }

  update(u: Obj): void {
    const meta = obj(u._meta);
    const team = obj(meta['codebuddy.ai/teamUpdate']);
    if (Array.isArray(team.members)) {
      this.teamUpdate(str(team.teamName), team.members);
      return;
    }
    const member = str(meta['codebuddy.ai/memberEvent']);
    if (member) {
      for (const members of this.teams.values()) {
        const id = members.get(member);
        if (id) this.childProgress(id, u);
      }
      return;
    }
    // CodeBuddy 把生命周期与子会话内容都标在 subagent 上；内容不能并入主 Agent 的回复。
    // 字段依据本机 CodeBuddy 2.168 的 createAcpSubagentStatusUpdate / getSubagentDescriptor。
    const subagent = obj(meta['codebuddy.ai/subagent']);
    const childID = str(subagent.sessionId);
    if (childID) {
      if (u.sessionUpdate === 'session_info_update') {
        this.childStatus(childID, str(subagent.status), str(subagent.description) || str(subagent.role));
      } else this.childProgress(childID, u);
      return;
    }
    switch (str(u.sessionUpdate)) {
      case 'agent_message_chunk':
        if (this.thoughtBuf !== '') this.flush();
        this.textBuf += acpText(u.content);
        return;
      case 'agent_thought_chunk':
        if (this.textBuf !== '') this.flush();
        this.thoughtBuf += acpText(u.content);
        return;
      case 'tool_call': {
        this.flush();
        const id = str(u.toolCallId);
        const raw = obj(u.rawInput);
        // kind 只是粗分类（read、edit、execute……），MCP 调用一律是 other：那时标题才说明调的是哪个工具。
        const kind = str(u.kind) === 'other' ? '' : str(u.kind);
        const name = str(u.name) || (str(raw.command) !== '' || u.kind === 'execute' ? 'shell' : kind || str(u.title) || 'tool');
        this.tools.set(id, name);
        this.emit({ kind: KindToolCall, tool: name, call_id: id, input: u.rawInput ?? { title: str(u.title) } });
        this.toolDone(id, u);
        return;
      }
      case 'tool_call_update':
        this.toolDone(str(u.toolCallId), u);
        return;
      case 'plan': {
        this.flush();
        const entries = Array.isArray(u.entries) ? u.entries.map(obj) : [];
        const plan: PlanItem[] = entries.map((e) => ({ text: str(e.content), status: planStatus(str(e.status)) })).filter((p) => p.text !== '');
        if (plan.length > 0) this.emit({ kind: KindPlan, plan });
        return;
      }
    }
  }

  /** OpenCode 的 opencode/session/child_update 扩展，根会话由调用方校验。 */
  childUpdate(p: Obj): void {
    const id = str(p.childSessionId);
    if (!id) return;
    if (p.type === 'status') this.childStatus(id, str(p.status), str(p.title));
    else if (p.type === 'update') this.childProgress(id, obj(p.update));
  }

  /** CodeBuddy 后台 Agent 实际走团队快照；成员仍存活不代表它的任务仍在运行。 */
  private teamUpdate(team: string, members: unknown[]): void {
    const next = new Map<string, string>();
    for (const value of members) {
      const member = obj(value);
      const name = str(member.name);
      const id = str(member.taskId) || str(member.sessionId) || (name ? `${team}/${name}` : '');
      if (!id) continue;
      next.set(name, id);
      if (member.status === 'running' && member.lifecycle !== 'terminated') this.tasks.start(id, str(member.description) || name);
      else this.tasks.finish(id);
    }
    const ids = new Set(next.values());
    for (const id of this.teams.get(team)?.values() ?? []) if (!ids.has(id)) this.tasks.finish(id);
    this.teams.set(team, next);
    this.emit(this.tasks.event());
  }

  private childStatus(id: string, status: string, description: string): void {
    if (status === 'created' || status === 'running') this.tasks.start(id, description);
    else if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) this.tasks.finish(id);
    else return;
    this.emit(this.tasks.event());
  }

  private childProgress(id: string, u: Obj): void {
    // 子会话正文逐字推送，只展示当前动作，避免每个字都写一份任务快照。
    const activity = str(u.title) || (u.sessionUpdate === 'agent_thought_chunk' ? '正在思考' : u.sessionUpdate === 'agent_message_chunk' ? '正在整理结果' : '');
    if (this.tasks.progress(id, activity)) this.emit(this.tasks.event());
  }

  private toolDone(id: string, u: Obj): void {
    const status = str(u.status);
    if (status !== 'completed' && status !== 'failed') return;
    const tool = this.tools.get(id) ?? 'tool';
    let text = acpText(u.content);
    if (text === '' && u.rawOutput !== undefined) {
      const out = obj(u.rawOutput);
      text = str(out.output) || str(out.stdout) || (typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput));
    }
    this.emit({ kind: KindToolResult, tool, call_id: id, text: clip(text), is_error: status === 'failed' || undefined });
  }
}

/** ACP 一轮结束时报的用量（opencode 2.1 实测：inputTokens 不含缓存，cachedRead/WriteTokens 另算）。 */
export function acpUsage(usage: unknown): ReturnType<typeof newUsage> | null {
  const u = obj(usage);
  if (typeof u.inputTokens !== 'number' && typeof u.outputTokens !== 'number') return null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const out = newUsage();
  out.input_tokens = n(u.inputTokens) + n(u.cachedReadTokens) + n(u.cachedWriteTokens);
  out.cached_input_tokens = n(u.cachedReadTokens);
  out.output_tokens = n(u.outputTokens) + n(u.thoughtTokens);
  out.turns = 1;
  out.source = 'acp usage';
  out.basis = BasisTotalInput;
  return out;
}

/**
 * codebuddy 的用量：每次模型请求推一条 usage_update，_meta.usage 是 OpenAI 式的 prompt_tokens（含缓存命中）
 * 与 completion_tokens；同一条消息会推好几次，按消息编号去重后相加（2026-11 用 codebuddy 2.168 实测）。
 */
export class CodebuddyUsage {
  private readonly seen = new Map<string, Obj>();

  add(update: Obj): void {
    const meta = obj(update._meta);
    const usage = obj(meta.usage);
    if (typeof usage.prompt_tokens !== 'number') return;
    const key = str(meta['codebuddy.ai/messageId']) || str(meta['codebuddy.ai/requestId']) || String(this.seen.size);
    this.seen.set(key, usage);
  }

  total(): ReturnType<typeof newUsage> | null {
    if (this.seen.size === 0) return null;
    const n = (v: unknown) => (typeof v === 'number' ? v : 0);
    const out = newUsage();
    out.input_tokens = 0;
    out.output_tokens = 0;
    out.cached_input_tokens = 0;
    for (const u of this.seen.values()) {
      out.input_tokens += n(u.prompt_tokens);
      out.output_tokens += n(u.completion_tokens);
      out.cached_input_tokens += n(obj(u.prompt_tokens_details).cached_tokens) || n(u.prompt_cache_hit_tokens);
    }
    out.turns = this.seen.size;
    out.source = 'codebuddy usage_update';
    out.basis = BasisTotalInput;
    return out;
  }
}

/** 编排工具用 ACP 跑一轮（argv 与额外环境由 tools.acpInvocation 给出）。 */
export function runACP(spec: Spec, emit: (event: Event) => void, signal: AbortSignal | undefined, argv: string[], env: Record<string, string> | undefined): Promise<Outcome> {
  return runInteractive(spec, emit, signal, argv, env, (ctx) => driveACP(ctx));
}

async function driveACP(ctx: DriveContext): Promise<void> {
  const { peer, spec, signal } = ctx;
  const translator = new ACPTranslator(ctx.emit);
  let loading = false;
  let denied = false;
  const requests = new CodebuddyUsage();
  let sessionID = '';
  peer.onNotification((method, params) => {
    if (method === 'opencode/session/child_update' && !loading) {
      const p = obj(params);
      if (sessionID !== '' && str(p.rootSessionId) === sessionID) translator.childUpdate(p);
      return;
    }
    if (method !== 'session/update' || loading) return; // 续接时对方会把历史重放一遍，不能当成这一轮的事件。
    const p = obj(params);
    if (sessionID !== '' && str(p.sessionId) !== '' && str(p.sessionId) !== sessionID) return;
    const update = obj(p.update);
    if (update.sessionUpdate === 'usage_update') requests.add(update);
    translator.update(update);
  });
  peer.onRequest('session/request_permission', async (params) => {
    const p = obj(params);
    translator.flush();
    const { toolName, input } = acpPermissionTool(p.toolCall);
    const answer = await ctx.decide(toolName, input);
    if (answer.decision !== 'allow' && answer.decision !== 'always') denied = true;
    return acpOutcome(p.options, answer);
  });
  const race = <T>(p: Promise<T>) => Promise.race([p, ctx.exited]);

  const init = obj(
    await race(
      peer.request('initialize', {
        protocolVersion: ACPProtocolVersion,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          ...(spec.tool === 'opencode' ? { _meta: { 'opencode/child-session-updates': true } } : {}),
        },
        clientInfo: { name: 'onset', version: '1' },
      }),
    ),
  );
  const canLoad = obj(init.agentCapabilities).loadSession === true;
  const cwd = spec.workdir || process.cwd();
  if (spec.resume && spec.sessionID) {
    if (!canLoad) throw new Error('这个编排工具不支持续接会话（ACP loadSession）');
    loading = true;
    let loaded: Obj;
    try {
      loaded = obj(await race(peer.request('session/load', { sessionId: spec.sessionID, cwd, mcpServers: acpMcpServers(spec.toolsServer) })));
    } finally {
      loading = false;
    }
    sessionID = spec.sessionID;
    await race(ensureModel(peer, sessionID, loaded, spec.model ?? ''));
    ctx.result.model = acpModel(loaded);
  } else {
    const created = obj(await race(peer.request('session/new', { cwd, mcpServers: acpMcpServers(spec.toolsServer) })));
    sessionID = str(created.sessionId);
    if (sessionID === '') throw new Error('session/new 没有返回 sessionId');
    await race(ensureModel(peer, sessionID, created, spec.model ?? ''));
    ctx.result.model = acpModel(created);
  }
  ctx.emit({ kind: KindSession, session_id: sessionID });

  const onAbort = () => peer.notification('session/cancel', { sessionId: sessionID });
  signal?.addEventListener('abort', onAbort, { once: true });
  let response: Obj;
  try {
    response = obj(await race(peer.request('session/prompt', { sessionId: sessionID, prompt: [{ type: 'text', text: spec.prompt }] })));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    translator.flush();
  }
  const usage = acpUsage(response.usage) ?? requests.total();
  if (usage) ctx.result.usage = usage;
  const stop = str(response.stopReason);
  if (stop === 'cancelled' && !signal?.aborted && denied) {
    // opencode 被拒后不换做法，直接结束这一轮：说清楚为什么停了，免得用户以为它卡住或做完了。
    ctx.emit({ kind: KindError, text: '你拒绝了一条调用，编排工具因此结束了这一轮。可以在对话里告诉它换一种做法再继续。' });
  }
  if (stop === 'refusal' && !ctx.result.produced) {
    // codebuddy 把模型请求失败（例如未登录）报成 refusal，原因写在 _meta 里。
    const meta = obj(response._meta);
    const detail = Object.entries(meta).find(([key]) => key.endsWith('errorMessage'))?.[1];
    let message = '编排工具拒绝了这一轮';
    if (typeof detail === 'string') {
      try {
        message = str(obj(JSON.parse(detail)).message) || detail;
      } catch {
        message = detail;
      }
    }
    ctx.emit({ kind: KindError, text: message });
    throw new Error(message);
  }
}

/** session/new 结果里的当前模型：models.currentModelId（codebuddy）或 configOptions 里的 model（opencode）。 */
export function acpModel(created: Obj): string {
  const models = obj(created.models);
  if (str(models.currentModelId) !== '') return str(models.currentModelId);
  const options = Array.isArray(created.configOptions) ? created.configOptions.map(obj) : [];
  const model = options.find((o) => o.id === 'model' || o.category === 'model');
  return model ? str(model.currentValue) : '';
}


/**
 * 会话开出来后核对模型：启动参数（codebuddy 的 --model、opencode 配置里的 model）没生效时，按对方报的方式再切一次——
 * opencode 报 configOptions 里的 model 项，用 session/set_config_option；codebuddy 报 models，用 session/set_model。
 * 切完把 opened 里记的当前模型改成新的，acpModel 读到的就是这一轮实际用的。对方什么都没报时不切（不知道它认不认）。
 */
export async function ensureModel(peer: { request(method: string, params: unknown): Promise<unknown> }, sessionID: string, opened: Obj, model: string): Promise<void> {
  if (model === '' || acpModel(opened) === model || acpModel(opened) === '') return;
  const options = Array.isArray(opened.configOptions) ? opened.configOptions.map(obj) : [];
  const option = options.find((o) => o.id === 'model' || o.category === 'model');
  try {
    if (option) {
      await peer.request('session/set_config_option', { sessionId: sessionID, configId: str(option.id), value: model });
      option.currentValue = model;
    } else {
      await peer.request('session/set_model', { sessionId: sessionID, modelId: model });
      obj(opened.models).currentModelId = model;
    }
  } catch (err) {
    throw new Error(`编排工具不接受模型 ${model}：${(err as Error).message}`, { cause: err });
  }
}

/** ACP 的 mcpServers：stdio 服务的 env 是 {name, value} 列表。 */
function acpMcpServers(server: McpServer | undefined): Array<Record<string, unknown>> {
  if (!server) return [];
  return [{ name: server.name, command: server.command, args: server.args, env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })) }];
}
