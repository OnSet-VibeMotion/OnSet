/**
 * 把 ACP 的 session/update 与子会话通知译成统一事件流。
 */
import { acpText, type Obj, obj, str } from './acp_protocol';
import { ActiveTasks } from './activetasks';
import {
  type ContextCompaction,
  clip,
  compactionEvent,
  type Event,
  KindPlan,
  KindText,
  KindThinking,
  KindToolCall,
  KindToolResult,
  normalizeAgyTool,
  type PlanItem,
} from './parse';

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
  private stepCount = 0;
  private inStep = false;
  private sawToolCall = false;

  constructor(private readonly emit: (event: Event) => void) {}

  /** 估算本轮内发出的模型请求步数（每次工具结果回来后重新开始思考/输出/调工具算新一步）。 */
  steps(): number {
    return Math.max(1, this.stepCount);
  }

  /** 本轮可确认为单次无工具调用的模型请求（此时 response.usage.inputTokens 即精确单次请求上下文）。 */
  singleRequest(): boolean {
    return this.stepCount === 1 && !this.sawToolCall;
  }

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
      this.emit({
        kind: KindThinking,
        text: this.thoughtID ? this.thoughtBuf : this.thoughtBuf.trim(),
        ...(this.thoughtID ? { text_id: this.thoughtID } : {}),
      });
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
      this.compaction(
        status === 'started' || status === 'in_progress'
          ? 'running'
          : aborted
            ? 'cancelled'
            : (status as 'completed' | 'failed' | 'cancelled'),
      );
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
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(str(u.sessionUpdate))) {
      this.compactionState = undefined;
      if (!this.inStep) {
        this.stepCount++;
        this.inStep = true;
      }
    }
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
        this.sawToolCall = true;
        this.flush();
        const id = str(u.toolCallId);
        const raw = obj(u.rawInput);
        // kind 只是粗分类（read、edit、execute……），MCP 调用一律是 other：那时标题才说明调的是哪个工具。
        const kind = str(u.kind) === 'other' ? '' : str(u.kind);
        const rawName =
          str(u.name) ||
          (str(raw.command) !== '' || str(raw.CommandLine) !== '' || u.kind === 'execute'
            ? 'shell'
            : kind || str(u.title) || 'tool');
        const normalized = normalizeAgyTool(rawName, u.rawInput ?? { title: str(u.title) });
        const name = normalized.tool;
        this.tools.set(id, name);
        this.emit({ kind: KindToolCall, tool: name, call_id: id, input: normalized.input });
        this.toolDone(id, u);
        return;
      }
      case 'tool_call_update':
        this.toolDone(str(u.toolCallId), u);
        return;
      case 'plan': {
        this.flush();
        const entries = Array.isArray(u.entries) ? u.entries.map(obj) : [];
        const plan: PlanItem[] = entries
          .map((e) => ({ text: str(e.content), status: planStatus(str(e.status)) }))
          .filter((p) => p.text !== '');
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
      if (member.status === 'running' && member.lifecycle !== 'terminated')
        this.tasks.start(id, str(member.description) || name);
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
    const activity =
      str(u.title) ||
      (u.sessionUpdate === 'agent_thought_chunk'
        ? '正在思考'
        : u.sessionUpdate === 'agent_message_chunk'
          ? '正在整理结果'
          : '');
    if (this.tasks.progress(id, activity)) this.emit(this.tasks.event());
  }

  private toolDone(id: string, u: Obj): void {
    const status = str(u.status);
    if (status !== 'completed' && status !== 'failed') return;
    this.inStep = false;
    const tool = this.tools.get(id) ?? 'tool';
    let text = acpText(u.content);
    if (text === '' && u.rawOutput !== undefined) {
      const out = obj(u.rawOutput);
      text =
        str(out.output) ||
        str(out.stdout) ||
        (typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput));
    }
    this.emit({
      kind: KindToolResult,
      tool,
      call_id: id,
      text: clip(text),
      is_error: status === 'failed' || undefined,
    });
  }
}
