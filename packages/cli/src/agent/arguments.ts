import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';

// pi 1.5.2 的 parseToolCallArguments 把未解析的原文保存在这个标记后；格式不认识就不修。
const RawArgumentsMarker = '\n\nReceived arguments:\n';

/** 只补正常 toolUse 响应缺失的最后一个 }；不猜字符串、转义、字段或更深层的括号。 */
export function completeToolArguments(message: AssistantMessage): AssistantMessage | undefined {
  if (message.stopReason !== 'toolUse') return;
  const diagnostics = [...(message.diagnostics ?? [])];
  const content = message.content.map((block) => {
    if (block.type !== 'toolCall' || !block.argumentsError) return block;
    const start = block.argumentsError.indexOf(RawArgumentsMarker);
    if (start < 0) return block;
    const raw = block.argumentsError.slice(start + RawArgumentsMarker.length);
    let args: unknown;
    try {
      args = JSON.parse(raw + '}');
    } catch {
      return block;
    }
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return block;
    const { argumentsError, ...call } = block;
    diagnostics.push({
      type: 'onset_tool_arguments_completed',
      timestamp: Date.now(),
      error: { message: argumentsError },
      details: { tool: block.name, call_id: block.id, appended: '}' },
    });
    return { ...call, arguments: args as JsonObject };
  });
  if (diagnostics.length === (message.diagnostics?.length ?? 0)) return;
  return { ...message, content, diagnostics };
}

const LegacyToolAliases: Record<string, string> = {
  tool_help: 'tool_search',
  onset_call: 'tool_call',
};

/** 静默把旧会话里的 tool_help / onset_call 映射到已注册的新工具名（tool_search / tool_call），避免续接报错。 */
export function normalizeLegacyToolCalls(
  message: AssistantMessage,
  registeredTools: ReadonlySet<string>,
): AssistantMessage | undefined {
  if (message.stopReason !== 'toolUse') return;
  let changed = false;
  const content = message.content.map((block) => {
    if (block.type !== 'toolCall') return block;
    const mapped = LegacyToolAliases[block.name];
    if (!mapped || registeredTools.has(block.name) || !registeredTools.has(mapped)) return block;
    changed = true;
    return { ...block, name: mapped };
  });
  return changed ? { ...message, content } : undefined;
}
