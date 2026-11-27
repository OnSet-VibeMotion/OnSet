import {
  clip,
  type Event,
  KindError,
  KindPlan,
  KindSession,
  KindText,
  KindThinking,
  KindToolCall,
  KindToolResult,
  type Obj,
  obj,
  planFromTodos,
  rawJSON,
  str,
  toolResultText,
  unwrapOnsetToolCall,
} from './parse_types';

/** 处理 opencode run --format json 的 JSONL（2.x）。 */
export function parseOpencode(e: Obj): Event[] {
  const events: Event[] = [];
  const id = str(e.sessionID);
  if (id !== '') events.push({ kind: KindSession, session_id: id });
  const part = obj(e.part);
  switch (str(e.type)) {
    case 'text': {
      const text = str(part.text);
      if (text !== '') events.push({ kind: KindText, text });
      break;
    }
    case 'reasoning': {
      const text = str(part.text);
      if (text !== '') events.push({ kind: KindThinking, text });
      break;
    }
    case 'tool_use': {
      const state = obj(part.state);
      const callID = str(part.id);
      const { tool, input } = unwrapOnsetToolCall(str(part.tool), state.input);
      events.push({ kind: KindToolCall, tool, call_id: callID, input: rawJSON(input) });
      if (tool === 'todowrite') {
        const plan = planFromTodos(state.input);
        if (plan.length > 0) events.push({ kind: KindPlan, plan });
      }
      switch (str(state.status)) {
        case 'completed':
          events.push({ kind: KindToolResult, tool, call_id: callID, text: clip(str(state.output)) });
          break;
        case 'error':
          events.push({ kind: KindToolResult, tool, call_id: callID, text: clip(str(state.error)), is_error: true });
          break;
      }
      break;
    }
    case 'error': {
      let message = str(obj(e.error).message);
      if (message === '') message = str(obj(obj(e.error).data).message);
      events.push({ kind: KindError, text: message });
      break;
    }
  }
  return events;
}

/**
 * MiniMax Code 的工具调用状态（toolCall.status，0.6.12 实测）：4 参数还在流式生成、5 参数生成完、1 执行中、2 成功、3 失败。
 * 参数要到 1 才有，所以调用事件在第一次看到参数时发；失败看状态 3 或 details 里的错误。
 */
const McodeToolFailed = 3;

/**
 * 处理 mcode exec --output-format stream-json（0.6.12，schemaVersion 1）：每条带 sessionId；item.* 的 item.type 是
 * reasoning、agent_message、tool_call。思考与正文在 item.updated 里一小段一小段推（contentDelta），完成时 item.completed
 * 带全文（content），这里只认完成的那条：统一事件是消息级的。待办工具是 todowrite（与 opencode 同形）。
 */
export function parseMcode(e: Obj, emitted: Map<string, string>): Event[] {
  const events: Event[] = [];
  const id = str(e.sessionId);
  if (id !== '') events.push({ kind: KindSession, session_id: id });
  const type = str(e.type);
  const item = obj(e.item);
  switch (type) {
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const itemType = str(item.type);
      if (type === 'item.completed' && itemType === 'reasoning') {
        const text = str(item.content);
        if (text !== '') events.push({ kind: KindThinking, text });
      } else if (type === 'item.completed' && itemType === 'agent_message') {
        const text = str(item.content);
        if (text !== '') events.push({ kind: KindText, text });
      } else if (itemType === 'tool_call') {
        const call = obj(item.toolCall);
        const callID = str(call.id) || str(item.id);
        const rawTool = str(call.name);
        const hasInput = call.input !== undefined && call.input !== null;
        const unwrapped = hasInput ? unwrapOnsetToolCall(rawTool, call.input) : { tool: rawTool, input: call.input };
        const tool = emitted.get(callID) ?? unwrapped.tool;
        if (hasInput && !emitted.has(callID)) {
          emitted.set(callID, unwrapped.tool);
          events.push({ kind: KindToolCall, tool: unwrapped.tool, call_id: callID, input: rawJSON(unwrapped.input) });
          if (unwrapped.tool === 'todowrite') {
            const plan = planFromTodos(call.input);
            if (plan.length > 0) events.push({ kind: KindPlan, plan });
          }
        }
        if (type === 'item.completed') {
          const output = obj(call.output);
          const details = obj(output.details);
          const failed =
            call.status === McodeToolFailed || details.is_error === true || obj(details.execution).status === 'failed';
          events.push({
            kind: KindToolResult,
            tool,
            call_id: callID,
            text: clip(toolResultText(output.content)),
            is_error: failed,
          });
        }
      } else if (type === 'item.completed' && itemType === 'error') {
        events.push({ kind: KindError, text: str(item.message) || str(item.content) });
      }
      break;
    }
    case 'turn.failed': {
      const error = obj(e.error);
      const status = str(e.status);
      const text =
        str(error.message) ||
        str(e.message) ||
        (status === 'timeout' ? 'MiniMax Code 这一轮超时了' : `MiniMax Code 这一轮没有完成（${status || 'failed'}）`);
      events.push({ kind: KindError, text });
      break;
    }
    case 'error':
      events.push({ kind: KindError, text: str(e.message) || str(obj(e.error).message) });
      break;
  }
  return events;
}

/** 把 Antigravity CLI 与 ACP 的 MCP 工具名规范成全仓库统一的 mcp__<服务>__<工具> 写法，并把 tool_call / onset_call 拆回真实操作名。 */
export function normalizeAgyTool(name: string, input: unknown): { tool: string; input: unknown } {
  let tool = name;
  let args = input;
  if (name === 'call_mcp_tool') {
    const o = obj(input);
    const server = str(o.ServerName);
    const toolName = str(o.ToolName);
    if (server !== '' && toolName !== '') {
      tool = `mcp__${server}__${toolName}`;
      args = o.Arguments ?? {};
    }
  } else {
    const eager = /^mcp_onset_(.+)$/.exec(name);
    if (eager) tool = `mcp__onset__${eager[1]}`;
  }
  return unwrapOnsetToolCall(tool, args);
}

/**
 * 处理 Antigravity CLI（`agy --output-format stream-json`，v1.5.13 实测）：
 * 每行以 `event` 区分：`init`、`step_update`、`result`。
 * `agent_response` 的 `text_delta` 按 `step_index` 分块推送，攒到 `state === "DONE"` 发一条完整正文；
 * 工具调用在 `ACTIVE` / `DONE` 时发 `KindToolCall`（按 step 去重），`DONE` 时发 `KindToolResult`。
 */
export function parseAgy(e: Obj, textBuf: Map<number, string>, emittedCalls: Set<string>): Event[] {
  const events: Event[] = [];
  const su = obj(e.step_update);
  const res = obj(e.result);
  const id = str(e.conversation_id) || str(su.conversation_id) || str(res.conversation_id);
  if (id !== '') events.push({ kind: KindSession, session_id: id });
  switch (str(e.event)) {
    case 'step_update': {
      const idx = typeof su.step_index === 'number' ? su.step_index : -1;
      const state = str(su.state);
      const stepType = str(su.step_type);
      if (stepType === 'agent_response') {
        const delta = str(su.text_delta);
        const key = idx >= 0 ? idx : 0;
        if (delta !== '') textBuf.set(key, (textBuf.get(key) ?? '') + delta);
        if (state === 'DONE') {
          const text = textBuf.get(key) ?? '';
          textBuf.delete(key);
          if (text !== '') events.push({ kind: KindText, text });
        }
      } else if (stepType === 'thinking' || stepType === 'reasoning') {
        const text = str(su.text_delta) || str(su.text);
        if (state === 'DONE' && text !== '') events.push({ kind: KindThinking, text });
      } else if (stepType === 'tool') {
        const info = obj(su.tool_info);
        const callID = idx >= 0 ? `step-${idx}` : str(info.id) || 'tool';
        const rawName = str(info.name) || str(su.tool_name) || 'tool';
        const { tool, input } = normalizeAgyTool(rawName, info.parameters);
        if (!emittedCalls.has(callID)) {
          emittedCalls.add(callID);
          events.push({ kind: KindToolCall, tool, call_id: callID, input: rawJSON(input) });
        }
        if (state === 'DONE') {
          const err = obj(info.error);
          const failed = Object.keys(err).length > 0;
          const text = str(info.output) || str(err.message) || str(err.type);
          events.push({
            kind: KindToolResult,
            tool,
            call_id: callID,
            text: clip(text),
            ...(failed ? { is_error: true } : {}),
          });
        }
      }
      break;
    }
    case 'result': {
      const status = str(res.status);
      if (status !== '' && status !== 'SUCCESS') {
        const text = str(res.error) || `Antigravity 这一轮没有完成（${status}）`;
        events.push({ kind: KindError, text });
      }
      break;
    }
  }
  return events;
}
