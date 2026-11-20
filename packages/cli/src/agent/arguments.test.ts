import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, parseToolCallArguments } from '@earendil-works/pi-ai';
import { completeToolArguments } from './arguments';

function call(raw: string) {
  return { ...fauxToolCall('write', {}, { id: 'c1' }), ...parseToolCallArguments(raw) };
}

describe('completeToolArguments', () => {
  it('adds only the final object brace and keeps text, escapes, nested values and the original error', () => {
    const expected = { path: '中文目录/test.js', content: 'const x = {"path":"C:\\tmp"};\n// } 引号 "', options: { list: [1, true] } };
    const broken = call(JSON.stringify(expected).slice(0, -1));
    const message = fauxAssistantMessage([fauxThinking('先写文件'), broken, fauxThinking('.')], { stopReason: 'toolUse' });
    const repaired = completeToolArguments(message)!;
    expect(repaired.content[1]).toEqual({ type: 'toolCall', id: 'c1', name: 'write', arguments: expected });
    expect(repaired.diagnostics).toEqual([expect.objectContaining({
      type: 'onset_tool_arguments_completed', error: { message: broken.argumentsError },
      details: { tool: 'write', call_id: 'c1', appended: '}' },
    })]);
    expect(message.content[1]).toBe(broken);
    expect(broken.argumentsError).toBeDefined();
    expect(completeToolArguments(repaired)).toBeUndefined();
  });

  it.each([
    '{"content":"cut off',
    '{"content":"ends with an escape\\',
    '{"content":"bad\\q"',
    '{"content":"raw\nnewline"',
    '{"content":',
    '{"content":"x",',
    '{"options":{"nested":1',
    '[{"content":"x"}',
    '{"content":"x"} garbage',
    '{"content":"x"}',
  ])('does not complete other invalid JSON or change valid JSON: %s', raw => {
    const message = fauxAssistantMessage(call(raw), { stopReason: 'toolUse' });
    expect(completeToolArguments(message)).toBeUndefined();
  });

  it.each(['length', 'aborted', 'error', 'stop'] as const)('does not complete a response ending in %s', stopReason => {
    expect(completeToolArguments(fauxAssistantMessage(call('{"path":"x"'), { stopReason }))).toBeUndefined();
  });

  it('leaves unrelated errors and text alone and accepts trailing whitespace before the missing brace', () => {
    const unknown = { ...fauxToolCall('write', {}), argumentsError: 'unknown provider error' };
    const message = fauxAssistantMessage([unknown, fauxText('hello'), call('{"path":"x" \n')], { stopReason: 'toolUse' });
    const repaired = completeToolArguments(message)!;
    expect(repaired.content.slice(0, 2)).toEqual(message.content.slice(0, 2));
    expect(repaired.content[2]).toMatchObject({ arguments: { path: 'x' } });
  });
});
