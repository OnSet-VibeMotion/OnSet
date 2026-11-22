/**
 * 把 pi 的会话事件译成 claude 系的 stream-json。agentrun 的解析、用量累计（result 事件）与模型识别
 * （system/init）都按 claude 系处理，制作人照这个格式输出就不用另写一份解析器。
 *
 * 只译消息级的事件（message_end），不译 token 增量：与其他几家一样，界面只按整条消息显示。
 * 不 import pi：事件按结构读，测试可以直接喂对象。
 */
import { marshal } from '@onset/engine/gojson';

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => obj(item))
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text as string)
    .join('\n');
}

/** 一次运行的累计：轮数、token、费用，最后写进 result。 */
export class StreamWriter {
  private turns = 0;
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private reasoning?: number;
  private compactions = 0;
  private cost = 0;
  private costKnown = true;
  private lastError = '';

  constructor(
    private readonly write: (line: string) => void,
    private sessionID = '',
  ) {}

  /** 会话开始：system/init 带会话 id 与模型名（agentrun 据此续接、记账）。 */
  init(sessionID: string, model: string): void {
    this.sessionID = sessionID;
    this.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionID, model }));
  }

  /** 译一条 pi 事件。 */
  event(raw: unknown): void {
    const e = obj(raw);
    // pi 的会话级事件不经过 message_end，必须单独转发，否则整理上下文时界面没有任何更新。
    if (e.type === 'compaction_start') {
      this.write(marshal({ type: 'system', subtype: 'status', status: 'compacting', session_id: this.sessionID }));
      return;
    }
    if (e.type === 'compaction_end') {
      if (e.result && !e.aborted && !e.errorMessage) {
        const usage = obj(obj(e.result).usage);
        if (Object.keys(usage).length > 0) this.accumulate(usage);
        this.compactions++;
        this.write(marshal({ type: 'system', subtype: 'compact_boundary', session_id: this.sessionID,
          compact_metadata: { pre_tokens: obj(e.result).tokensBefore } }));
      } else {
        this.write(marshal({ type: 'agent_event', session_id: this.sessionID,
          event: { type: 'compaction', data: { status: e.aborted ? 'cancelled' : 'failed' } } }));
      }
      return;
    }
    if (e.type !== 'message_end') return;
    const message = obj(e.message);
    switch (message.role) {
      case 'assistant':
        this.assistant(message);
        break;
      case 'toolResult':
        this.write(
          JSON.stringify({
            type: 'user',
            session_id: this.sessionID,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: String(message.toolCallId ?? ''), content: textOf(message.content), is_error: message.isError === true }],
            },
          }),
        );
        break;
    }
  }

  private assistant(message: Obj): void {
    const content: Obj[] = [];
    for (const item of Array.isArray(message.content) ? message.content : []) {
      const block = obj(item);
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') content.push({ type: 'text', text: block.text });
      else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') content.push({ type: 'thinking', thinking: block.thinking });
      else if (block.type === 'toolCall') content.push({ type: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input: obj(block.arguments) });
    }
    const usage = obj(message.usage);
    if (Object.keys(usage).length > 0) {
      this.turns++;
      this.accumulate(usage);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      this.lastError = typeof message.errorMessage === 'string' && message.errorMessage !== '' ? message.errorMessage : String(message.stopReason);
    } else {
      this.lastError = '';
    }
    if (content.length > 0) this.write(JSON.stringify({ type: 'assistant', session_id: this.sessionID, message: { role: 'assistant', content } }));
  }

  private accumulate(usage: Obj): void {
    // 输入不含缓存，输出已含推理。整理上下文也会调用模型，必须计入同一次执行。
    this.input += num(usage.input);
    this.output += num(usage.output);
    this.cacheRead += num(usage.cacheRead);
    this.cacheWrite += num(usage.cacheWrite);
    if (typeof usage.reasoning === 'number') this.reasoning = (this.reasoning ?? 0) + usage.reasoning;
    const cost = obj(usage.cost);
    if (typeof cost.total === 'number') this.cost += cost.total;
    else this.costKnown = false;
  }

  /** 这一轮里最后一条回复是不是出错收尾的（模型服务报错、被中止）。 */
  error(): string {
    return this.lastError;
  }

  /** 收尾：result 带累计用量；error 非空时标成失败。 */
  result(error: string, droppedPreviews = 0): void {
    this.write(
      JSON.stringify({
        type: 'result',
        subtype: error === '' ? 'success' : 'error',
        is_error: error !== '',
        ...(error !== '' ? { result: error } : {}),
        session_id: this.sessionID,
        num_turns: this.turns,
        ...(this.compactions ? { compactions: this.compactions } : {}),
        ...(droppedPreviews ? { dropped_preview_images: droppedPreviews } : {}),
        total_cost_usd: this.costKnown && this.turns > 0 ? this.cost : null,
        usage: {
          input_tokens: this.input,
          output_tokens: this.output,
          cache_read_input_tokens: this.cacheRead,
          cache_creation_input_tokens: this.cacheWrite,
          reasoning_tokens: this.reasoning,
        },
      }),
    );
  }
}
