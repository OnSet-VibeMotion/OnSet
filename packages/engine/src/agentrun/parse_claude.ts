import {
  arr,
  type BackgroundTask,
  clip,
  compactionEvent,
  type Event,
  KindBackgroundTasks,
  KindContextCompaction,
  KindError,
  KindPlan,
  KindSession,
  KindText,
  KindThinking,
  KindToolCall,
  KindToolResult,
  type Obj,
  obj,
  type PlanItem,
  planFromTodos,
  rawJSON,
  str,
  toolResultText,
  unwrapOnsetToolCall,
} from './parse_types';

/**
 * Claude 的任务生命周期独立于 Agent / Bash 的工具返回，不能用 tool-result 当作后台任务结束。
 * 协议：https://code.claude.com/docs/en/agent-sdk/typescript#sdktaskstartedmessage
 * 新版有完整快照，旧版靠生命周期事件；未提供 is_backgrounded 的旧事件也要显示。
 */
export class BackgroundTasks {
  private tasks = new Map<
    string,
    BackgroundTask & { run?: string; background?: boolean; ambient?: boolean; ended?: boolean }
  >();

  parse(e: Obj): Event | null {
    if (e.type !== 'system') return null;
    const subtype = str(e.subtype);
    if (subtype === 'background_tasks_changed') {
      if (!Array.isArray(e.tasks)) return null;
      const previous = this.tasks;
      this.tasks = new Map();
      for (const entry of e.tasks) {
        const item = obj(entry);
        const id = str(item.task_id);
        if (!id) continue;
        const old = previous.get(id);
        const run = str(item.run_id);
        this.tasks.set(id, {
          id,
          description: clip(str(item.description)) || '后台任务',
          run,
          activity: !run || run === old?.run ? old?.activity : undefined,
          background: true,
          ambient: item.ambient === true,
        });
      }
    } else {
      if (!['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(subtype)) return null;
      const id = str(e.task_id);
      if (!id) return null;
      const run = str(e.run_id);
      let task = this.tasks.get(id);
      // 恢复的子任务沿用 task_id；旧一次运行迟到的结束事件不能关掉新一次。
      if (task?.run && run && run < task.run) return this.event();
      if (!task || (run && run !== task.run) || (subtype === 'task_started' && task.ended)) {
        task = { id, description: '后台任务', run };
        this.tasks.set(id, task);
      }
      const data = subtype === 'task_updated' ? obj(e.patch) : e;
      if (str(data.description)) task.description = clip(str(data.description));
      if (typeof data.is_backgrounded === 'boolean') task.background = data.is_backgrounded;
      if (typeof data.ambient === 'boolean') task.ambient = data.ambient;
      if (subtype === 'task_progress') task.activity = clip(str(e.summary) || str(e.last_tool_name)) || undefined;
      if (subtype === 'task_notification' || ['completed', 'failed', 'stopped', 'killed'].includes(str(data.status)))
        task.ended = true;
    }
    return this.event();
  }

  private event(): Event {
    return {
      kind: KindBackgroundTasks,
      background_tasks: [...this.tasks.values()]
        .filter((task) => !task.ended && !task.ambient && task.background !== false)
        .map(({ id, description, activity }) => ({ id, description, ...(activity ? { activity } : {}) })),
    };
  }
}

/** Qoder 1.1.87 与 Claude 的 system/status + compact_boundary 协议。
 * Qoder 在压缩成功或失败后都会清 status；只有 boundary 能确认压缩成功。
 */
export class CompactionStatus {
  private active = false;

  parse(e: Obj): Event | null {
    if (str(e.agent_id)) return null; // 子任务整理自己的上下文，不改变主会话状态。
    // CodeBuddy 的 stream-json（制作人也用同一形状报告失败与取消）。
    if (e.type === 'agent_event' && obj(e.event).type === 'compaction') {
      const origin = obj(e.origin);
      if (origin.type === 'subagent' || origin.parentSessionId) return null;
      const status = str(obj(obj(e.event).data).status);
      if (['in_progress', 'completed', 'failed', 'cancelled'].includes(status)) {
        if (status === 'in_progress' && this.active) return null;
        this.active = status === 'in_progress';
        return compactionEvent(status === 'in_progress' ? 'running' : (status as 'completed' | 'failed' | 'cancelled'));
      }
    }
    if (e.type !== 'system') {
      if (['assistant', 'user', 'result'].includes(str(e.type))) this.active = false;
      return null;
    }
    if (e.subtype === 'compact_boundary') {
      this.active = false;
      const metadata = obj(e.compact_metadata);
      const count = (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
      return {
        kind: KindContextCompaction,
        text: '上下文压缩完成',
        compaction: {
          state: 'completed',
          pre_tokens: count(metadata.pre_tokens),
          post_tokens: count(metadata.post_tokens),
        },
      };
    }
    if (e.subtype !== 'status') return null;
    if (e.status === 'compacting' && !this.active) {
      this.active = true;
      return { kind: KindContextCompaction, text: '正在压缩上下文', compaction: { state: 'running' } };
    }
    if (e.status === null && this.active) {
      this.active = false;
      return {
        kind: KindContextCompaction,
        text: '上下文压缩阶段结束，等待模型继续',
        compaction: { state: 'ended' },
      };
    }
    return null;
  }
}

/**
 * 逐条建、逐条改的任务工具：qoder 与新版 claude 不用 TodoWrite，而是 TaskCreate({subject, activeForm})
 * 建一条（编号只出现在结果里：「Task #3 created successfully: …」），TaskUpdate({taskId, status}) 改一条。
 * 把它们攒成完整清单，每变一次发一份 plan 事件，界面与 TodoWrite 走同一条路（2026-11 qoder 实测）。
 */
export class TaskBoard {
  private tasks: Array<{ id: string; subject: string; active: string; status: string }> = [];
  private readonly creating = new Map<string, { subject: string; active: string }>();

  /** 续接同一个 CLI 会话时接上一轮的清单（只认带编号的项）。 */
  seed(plan: PlanItem[]): void {
    this.tasks = plan
      .filter((item) => item.id)
      .map((item) => ({ id: item.id as string, subject: item.text, active: '', status: item.status }));
  }

  /** TaskCreate 的调用：编号要等结果。 */
  create(callID: string, input: unknown): void {
    const o = obj(input);
    const subject = str(o.subject) || str(o.content) || str(o.description);
    if (callID !== '' && subject !== '') this.creating.set(callID, { subject, active: str(o.activeForm) });
  }

  /** TaskCreate 的结果：读出编号，记下这一条。 */
  created(callID: string, text: string, failed: boolean): Event | null {
    const pending = this.creating.get(callID);
    if (!pending) return null;
    this.creating.delete(callID);
    const id = /#\s*(\w+)/.exec(text)?.[1];
    if (failed || !id) return null;
    this.tasks = this.tasks.filter((task) => task.id !== id);
    this.tasks.push({ id, ...pending, status: 'pending' });
    return this.event();
  }

  /** TaskUpdate：改状态或标题；deleted 去掉。不认识的编号（续接前建的、没接上）不管。 */
  update(input: unknown): Event | null {
    const o = obj(input);
    const id = str(o.taskId) || str(o.id) || (typeof o.taskId === 'number' ? String(o.taskId) : '');
    const task = this.tasks.find((item) => item.id === id);
    if (!task) return null;
    const status = str(o.status);
    if (status === 'deleted') this.tasks = this.tasks.filter((item) => item !== task);
    else if (status !== '') task.status = status;
    if (str(o.subject) !== '') task.subject = str(o.subject);
    if (str(o.activeForm) !== '') task.active = str(o.activeForm);
    return this.event();
  }

  private event(): Event {
    const plan = this.tasks.map((task) => {
      const status = task.status === 'in_progress' || task.status === 'completed' ? task.status : 'pending';
      return { text: status === 'in_progress' && task.active !== '' ? task.active : task.subject, status, id: task.id };
    });
    return { kind: KindPlan, plan };
  }
}

/** 处理 claude、qoder、codebuddy 共用的 stream-json；制作人（director）也照这个格式输出。 */
export function parseClaudeLike(e: Obj, tasks: TaskBoard): Event[] {
  const events: Event[] = [];
  const id = str(e.session_id);
  if (id !== '') events.push({ kind: KindSession, session_id: id });
  switch (str(e.type)) {
    case 'assistant':
      for (const item of arr(obj(e.message).content)) {
        const block = obj(item);
        switch (str(block.type)) {
          case 'text': {
            const text = str(block.text);
            if (text !== '') events.push({ kind: KindText, text });
            break;
          }
          case 'thinking': {
            const text = str(block.thinking);
            if (text !== '') events.push({ kind: KindThinking, text });
            break;
          }
          case 'tool_use': {
            // qoder 懒加载模式下经 mcp_call({toolName, arguments}) 调用，紧凑模式下各家经 tool_call / onset_call 调用扩展工具；
            // 统一拆回真正的工具名与参数，界面与桌宠才认得出这是 onset 的哪个工具。
            const wrapped = str(block.name) === 'mcp_call' ? obj(block.input) : {};
            const baseTool = str(wrapped.toolName) !== '' ? str(wrapped.toolName) : str(block.name);
            const baseInput = str(wrapped.toolName) !== '' ? (wrapped.arguments ?? {}) : block.input;
            const { tool, input } = unwrapOnsetToolCall(baseTool, baseInput);
            events.push({
              kind: KindToolCall,
              tool,
              call_id: str(block.id),
              input: rawJSON(input),
            });
            if (tool === 'TodoWrite') {
              const plan = planFromTodos(input);
              if (plan.length > 0) events.push({ kind: KindPlan, plan });
            }
            if (tool === 'TaskCreate') tasks.create(str(block.id), input);
            if (tool === 'TaskUpdate') {
              const plan = tasks.update(input);
              if (plan) events.push(plan);
            }
            break;
          }
        }
      }
      break;
    case 'user':
      for (const item of arr(obj(e.message).content)) {
        const block = obj(item);
        if (str(block.type) !== 'tool_result') continue;
        const text = toolResultText(block.content);
        events.push({
          kind: KindToolResult,
          call_id: str(block.tool_use_id),
          text: clip(text),
          is_error: block.is_error === true,
        });
        const plan = tasks.created(str(block.tool_use_id), text, block.is_error === true);
        if (plan) events.push(plan);
      }
      break;
    case 'result':
      if (e.is_error === true) {
        let text = str(e.result);
        if (text === '')
          text = arr(e.errors)
            .map((item) => (typeof item === 'string' ? item : str(obj(item).message)))
            .filter(Boolean)
            .join('\n');
        if (text === '')
          text = arr(e.errors_info)
            .map((item) => str(obj(item).details))
            .filter(Boolean)
            .join('\n');
        if (text === '') text = str(e.subtype);
        events.push({ kind: KindError, text });
      }
      break;
  }
  return events;
}
