import {
  arr,
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
  type PlanItem,
  rawJSON,
  str,
  toolResultText,
} from './parse_types';

/** 读 codex 的 todo_list：items 为 [{text, completed}]，第一项未完成的算进行中。 */
function planFromCodex(item: Obj): PlanItem[] {
  const plan: PlanItem[] = [];
  let current = false;
  for (const entry of arr(item.items)) {
    const todo = obj(entry);
    let status = 'pending';
    if (todo.completed === true) status = 'completed';
    else if (!current) {
      status = 'in_progress';
      current = true;
    }
    plan.push({ text: str(todo.text), status });
  }
  return plan;
}

/** 处理 codex exec --json 的 JSONL。 */
export function parseCodex(e: Obj): Event[] {
  const item = obj(e.item);
  switch (str(e.type)) {
    case 'thread.started':
      return [{ kind: KindSession, session_id: str(e.thread_id) }];
    case 'item.started':
    case 'item.updated':
      if (str(item.type) === 'todo_list') return [{ kind: KindPlan, plan: planFromCodex(item) }];
      if (str(e.type) === 'item.started' && str(item.type) === 'mcp_tool_call') {
        return [
          {
            kind: KindToolCall,
            tool: `mcp__${str(item.server)}__${str(item.tool)}`,
            call_id: str(item.id),
            input: rawJSON(item.arguments ?? {}),
          },
        ];
      }
      if (str(e.type) === 'item.started' && str(item.type) === 'command_execution') {
        return [
          {
            kind: KindToolCall,
            tool: 'shell',
            call_id: str(item.id),
            input: rawJSON({ command: item.command ?? null }),
          },
        ];
      }
      break;
    case 'item.completed':
      switch (str(item.type)) {
        case 'mcp_tool_call': {
          const result = obj(item.result);
          const text = toolResultText(result.content) || str(obj(item.error).message);
          return [
            {
              kind: KindToolResult,
              tool: `mcp__${str(item.server)}__${str(item.tool)}`,
              call_id: str(item.id),
              input: rawJSON(item.arguments ?? {}),
              text: clip(text),
              is_error:
                str(item.status) === 'failed' ||
                result.isError === true ||
                (item.error !== null && item.error !== undefined),
            },
          ];
        }
        case 'agent_message':
          return [{ kind: KindText, text: str(item.text) }];
        case 'todo_list':
          return [{ kind: KindPlan, plan: planFromCodex(item) }];
        case 'reasoning':
          return [{ kind: KindThinking, text: str(item.text) }];
        case 'command_execution': {
          const code = typeof item.exit_code === 'number' ? item.exit_code : 0;
          return [
            {
              kind: KindToolResult,
              tool: 'shell',
              call_id: str(item.id),
              text: clip(str(item.aggregated_output)),
              is_error: code !== 0,
            },
          ];
        }
        case 'file_change':
        case 'web_search': {
          const failed = str(item.status) === 'failed';
          return [
            {
              kind: KindToolResult,
              tool: str(item.type),
              call_id: str(item.id),
              input: rawJSON(item),
              is_error: failed,
            },
          ];
        }
        case 'error':
          return [{ kind: KindError, text: str(item.message) }];
      }
      break;
    case 'turn.failed':
      return [{ kind: KindError, text: str(obj(e.error).message) }];
    case 'error':
      return [{ kind: KindError, text: str(e.message) }];
  }
  return [];
}
