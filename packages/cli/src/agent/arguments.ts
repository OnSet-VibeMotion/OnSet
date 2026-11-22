import type { AssistantMessage, JsonObject } from '@earendil-works/pi-ai';

// pi 1.5.2 的 parseToolCallArguments 把未解析的原文保存在这个标记后；格式不认识就不修。
const RawArgumentsMarker = '\n\nReceived arguments:\n';

/** 只补正常 toolUse 响应缺失的最后一个 }；不猜字符串、转义、字段或更深层的括号。 */
export function completeToolArguments(message: AssistantMessage): AssistantMessage | undefined {
  if (message.stopReason !== 'toolUse') return;
  const diagnostics = [...(message.diagnostics ?? [])];
  const content = message.content.map(block => {
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
