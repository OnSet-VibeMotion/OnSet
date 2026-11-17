/**
 * ACP（Agent Client Protocol）编排：opencode acp 与 codebuddy --acp。
 *
 * 一轮 = initialize → session/new（或 session/load 续接）→ session/prompt，期间对方用 session/update 推送
 * 正文、思考、工具调用与待办，用 session/request_permission 请我们批准工具调用。2026-11 用 opencode 2.1.0
 * 实测：请求里的 toolCall 带 rawInput.command；拒绝后 opencode 直接结束这一轮（stopReason cancelled），
 * 不像 claude 那样接着换做法。CodeBuddy 2.168 的审批、续接与后台子任务也经真实 CLI 验证。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { BasisTotalInput, type McpServer, newUsage } from '../tools';
import { runInteractive, type DriveContext, type PermissionAnswer } from './interactive';
import { KindError, KindPlan, KindSession, KindText, KindThinking, KindToolCall, KindToolResult, clip, compactionEvent, type ContextCompaction, type Event, type PlanItem } from './parse';
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
 * 每个字一条事件会把对话撑爆。思考每半秒发一批，避免长思考时界面一直停在「正在启动 AI」；
 * 正文、剩余思考在工具调用、待办或一轮结束时发出去。
 */
export class ACPTranslator {
  private textBuf = '';
  private thoughtBuf = '';
  private thoughtTimer: ReturnType<typeof setTimeout> | undefined;
  private thoughtID: string | undefined;
  private thoughtSerial = 0;
  private readonly tools = new Map<string, string>();
  private readonly tasks = new ActiveTasks();
  private readonly teams = new Map<string, Map<string, string>>();
  private compactionState: ContextCompaction['state'] | undefined;

  constructor(private readonly emit: (event: Event) => void) {}

  flush(): void {
    if (this.thoughtTimer) clearTimeout(this.thoughtTimer);
    this.thoughtTimer = undefined;
    this.flushThought();
    this.thoughtID = undefined;
    if (this.textBuf.trim() !== '') this.emit({ kind: KindText, text: this.textBuf.trim() });
    this.textBuf = '';
  }

  private flushThought(): void {
    // 一旦开始分批，空格与换行也是原文的一部分，不能逐批 trim。
    if (this.thoughtBuf !== '' && (this.thoughtID || this.thoughtBuf.trim() !== '')) {
      this.emit({ kind: KindThinking, text: this.thoughtID ? this.thoughtBuf : this.thoughtBuf.trim(), ...(this.thoughtID ? { text_id: this.thoughtID } : {}) });
    }
    this.thoughtBuf = '';
  }

  private scheduleThought(): void {
    if (this.thoughtTimer || this.thoughtBuf === '') return;
    this.thoughtTimer = setTimeout(() => {
      this.thoughtTimer = undefined;
      if (!this.thoughtID && this.thoughtBuf.trim() === '') return;
      this.thoughtID ??= `acp-thought-${++this.thoughtSerial}`;
      this.flushThought();
    }, 500);
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
    if (meta['codebuddy.ai/isSubAgent'] === true) return;
    // OpenCode 2.1 的旧客户端扩展与新版 ACP / CodeBuddy 的正式 compaction_update。
    const compact = u.sessionUpdate === 'compaction_update' ? u : obj(meta['opencode/compaction']);
    const status = str(compact.status);
    if (['started', 'in_progress', 'completed', 'failed', 'cancelled'].includes(status)) {
      const aborted = ['aborted', 'compaction.interrupted'].includes(str(obj(compact.error).type));
      this.compaction(status === 'started' || status === 'in_progress' ? 'running' : aborted ? 'cancelled' : status as 'completed' | 'failed' | 'cancelled');
      return;
    }
    // CodeBuddy 2.168 默认 ACP 客户端通过 progress 扩展报告；清空不代表压缩成功。
    const progress = meta['codebuddy.ai/progress'];
    const progressType = str(obj(progress).type);
    if (progressType === 'compacting' || progressType.includes('Compacting context')) {
      this.compaction('running');
      return;
    }
    if (progress === null && this.compactionState === 'running') this.compaction('ended');
    if (meta['codebuddy.ai/isCompactInternal'] === true) return;
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(str(u.sessionUpdate))) this.compactionState = undefined;
    switch (str(u.sessionUpdate)) {
      case 'agent_message_chunk':
        if (this.thoughtBuf !== '' || this.thoughtID) this.flush();
        this.textBuf += acpText(u.content);
        return;
      case 'agent_thought_chunk':
        if (this.textBuf !== '') this.flush();
        this.thoughtBuf += acpText(u.content);
        this.scheduleThought();
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

  private compaction(state: ContextCompaction['state']): void {
    if (this.compactionState === state) return;
    this.flush();
    this.compactionState = state;
    this.emit(compactionEvent(state));
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
    if (spec.tool === 'mcode') await race(configureMcode(peer, sessionID, loaded, spec));
    await race(ensureModel(peer, sessionID, loaded, spec.model ?? ''));
    ctx.result.model = acpModel(loaded);
  } else {
    const created = obj(await race(peer.request('session/new', { cwd, mcpServers: acpMcpServers(spec.toolsServer) })));
    sessionID = str(created.sessionId);
    if (sessionID === '') throw new Error('session/new 没有返回 sessionId');
    if (spec.tool === 'mcode') await race(configureMcode(peer, sessionID, created, spec));
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
  if (!model) return '';
  const value = str(model.currentValue);
  return mcodeModelValue(value)?.model ?? value;
}

/**
 * mcode 的 ACP 模型值写成 `m:<服务商>:<模型>:v:<变体>`（`m:minimax:MiniMax-M3.1-Flash:v:thinking`，0.6.12 实测），
 * 同一模型的「思考 / 不思考」是两项。onset 里模型一律记成 exec 的 --model 写法「服务商/模型」。
 */
export function mcodeModelValue(value: string): { model: string; variant: string } | null {
  const m = /^m:([^:]+):(.+):v:([^:]*)$/.exec(value);
  return m ? { model: `${m[1]}/${m[2]}`, variant: m[3]! } : null;
}

/** mcode 会话的选项（session/new 的 configOptions）里，某一项的当前值与可选值。 */
function configOption(opened: Obj, id: string): Obj | undefined {
  const options = Array.isArray(opened.configOptions) ? opened.configOptions.map(obj) : [];
  return options.find((o) => o.id === id);
}

/**
 * mcode 会话开出来后：
 * - 权限模式（permissionMode，只对这个进程生效）：用户自己的 config.yaml 常是 bypassPermissions，安全模式必须显式切成
 *   default（Ask），白名单外的调用才会发 session/request_permission（2026-11 实测 curl 会问）；不安全模式切成 bypassPermissions。
 * - 模型：值要换成它自己的 `m:…:v:…`，同一模型优先保留当前的变体（思考与否）；
 * - 推理强度（thinkingEffort）：只有部分模型报这一项，切完模型再设，不支持时它报 Invalid params。
 * 改动后把 opened 里的当前值改掉，acpModel 读到的就是这一轮实际用的。
 */
export async function configureMcode(peer: { request(method: string, params: unknown): Promise<unknown> }, sessionID: string, opened: Obj, spec: Pick<Spec, 'unsafe' | 'model' | 'options' | 'env'>): Promise<void> {
  mcodeAskBash(mcodeDataDir(spec.env ?? (process.env as Record<string, string>)), sessionID, !spec.unsafe);
  const set = async (configId: string, value: string): Promise<void> => {
    const result = obj(await peer.request('session/set_config_option', { sessionId: sessionID, configId, value }));
    if (Array.isArray(result.configOptions)) opened.configOptions = result.configOptions;
  };
  const mode = spec.unsafe ? 'bypassPermissions' : 'default';
  if (str(configOption(opened, 'permissionMode')?.currentValue) !== mode) await set('permissionMode', mode);
  const wanted = spec.model ?? '';
  const model = configOption(opened, 'model');
  if (wanted !== '' && model) {
    const current = mcodeModelValue(str(model.currentValue));
    if (current?.model !== wanted) {
      const choices = (Array.isArray(model.options) ? model.options.map(obj) : []).map((o) => str(o.value)).filter((v) => mcodeModelValue(v)?.model === wanted);
      const pick = choices.find((v) => mcodeModelValue(v)?.variant === current?.variant) ?? choices[0];
      if (!pick) throw new Error(`MiniMax Code 没有模型 ${wanted}（写成「服务商/模型」，例如 minimax/MiniMax-M3.1-Flash）`);
      try {
        await set('model', pick);
      } catch (err) {
        throw new Error(`编排工具不接受模型 ${wanted}：${(err as Error).message}`, { cause: err });
      }
    }
  }
  const effort = spec.options?.effort ?? '';
  if (effort !== '' && str(configOption(opened, 'thinkingEffort')?.currentValue) !== effort) {
    try {
      await set('thinkingEffort', effort);
    } catch (err) {
      throw new Error(`这个模型不支持推理强度「${effort}」：${(err as Error).message}`, { cause: err });
    }
  }
}


/**
 * 会话开出来后核对模型：启动参数（codebuddy 的 --model、opencode 配置里的 model）没生效时，按对方报的方式再切一次——
 * opencode 报 configOptions 里的 model 项，用 session/set_config_option；codebuddy 报 models，用 session/set_model。
 * 切完把 opened 里记的当前模型改成新的，acpModel 读到的就是这一轮实际用的。对方什么都没报时不切（不知道它认不认）。
 */
export async function ensureModel(peer: { request(method: string, params: unknown): Promise<unknown> }, sessionID: string, opened: Obj, model: string): Promise<void> {
  // opencode 的推理档位附在模型名后（provider/model#high，见 tools/options.ts）：报回来的带不带变体都算同一个模型。
  const current = acpModel(opened);
  if (mcodeModelValue(str(configOptionValue(opened, 'model'))) !== null) return; // mcode：configureMcode 已经切过。
  if (model === '' || current === model || current.split('#')[0] === model || current === '') return;
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

function configOptionValue(opened: Obj, id: string): unknown {
  return configOption(opened, id)?.currentValue;
}

/** mcode 的数据目录：MINIMAX_DATA_DIR，缺省 ~/.minimax。 */
export function mcodeDataDir(env: Record<string, string | undefined>): string {
  return env.MINIMAX_DATA_DIR || path.join(env.HOME || os.homedir(), '.minimax');
}

/** 「每条 shell 命令都问」这条会话规则（version 2 的写法）。 */
const askBashRule = { tool_name: 'bash', matcher: { kind: 'tool' } };
const isAskBash = (rule: unknown): boolean => {
  const r = obj(rule);
  return r.tool_name === 'bash' && obj(r.matcher).kind === 'tool';
};

/**
 * mcode 的 Ask 模式自己判断哪些命令要批准（部分交给云端判定），白名单外的 brew 有时照样直接跑（2026-11 实测），
 * 不能当闸门。它的权限规则按会话存在 `<数据目录>/sessions/<会话>/permission.json`（version 2：allow / deny / ask，
 * 每条 {tool_name, matcher}），判定顺序是 deny → ask → 安全检查 → allow，不带命令的 ask 规则让这个会话的每条 bash
 * 都来问；白名单内的由 agentrun 直接答应（commandAllowed）。用户点「允许一次」时 mcode 会往同一份文件记 allow，
 * ask 排在前面，下一次照样来问，「以后都允许」只由客户端记。安全模式加上这条，不安全模式去掉，其余规则不动。
 */
export function mcodeAskBash(dataDir: string, sessionID: string, ask: boolean): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error(`mcode 会话号不对：${sessionID}`);
  const file = path.join(dataDir, 'sessions', sessionID, 'permission.json');
  let doc: Obj = { version: 2, allow: [], deny: [], ask: [] };
  try {
    const existing = obj(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (existing.version === 2) doc = existing;
  } catch {
    // 没有或读不了：从空规则开始。
  }
  const rules = Array.isArray(doc.ask) ? doc.ask : [];
  const has = rules.some(isAskBash);
  if (has === ask) return;
  doc.ask = ask ? [...rules, askBashRule] : rules.filter((r) => !isAskBash(r));
  for (const key of ['allow', 'deny']) if (!Array.isArray(doc[key])) doc[key] = [];
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWrite(file, marshalIndent(doc) + '\n', 0o600);
}
