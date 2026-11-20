import { expect, it } from 'vitest';
import { fauxAssistantMessage, type ImageContent } from '@earendil-works/pi-ai';
import type { MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { PreviewHistory } from './preview-history';

type Message = MessageEndEvent['message'];

it('retains recent pictures and all results when compacting previews at a preview boundary', () => {
  const image: ImageContent = { type: 'image', data: 'aA==', mimeType: 'image/png' };
  const lookup: Message = { role: 'toolResult', toolName: 'read', toolCallId: 'reference', content: [image], isError: false, timestamp: 0 };
  const request: Message = { role: 'user', content: [{ type: 'text', text: '镜头执行契约' }], timestamp: 0 };
  const assistant = fauxAssistantMessage('');
  assistant.usage = { ...assistant.usage, input: 4000, cacheRead: 65000 };
  const preview = (i: number): Message => ({
    role: 'toolResult', toolName: 'scene_preview_check', toolCallId: 'preview-' + i,
    content: [{ type: 'text', text: '联系表路径 ' + i }, image], isError: false, timestamp: i,
  });
  const original = [request, lookup, preview(1), preview(2), preview(3), assistant, preview(4)];
  const history = new PreviewHistory();
  expect(history.project(original, 96000)).toMatchObject({ messages: original, trimmed: 0 });
  const first = history.project(original, 64000);
  expect(first.trimmed).toBe(2);
  expect(first.messages[1]).toBe(lookup);
  expect(first.messages[0]).toBe(request);
  expect(first.messages[2]).toMatchObject({ content: [
    { type: 'text', text: '联系表路径 1' }, { type: 'text', text: expect.stringContaining('旧预览') },
  ] });
  expect(first.messages[6]).toBe(original[6]);
  expect(history.project(original, 64000)).toEqual({ messages: first.messages, trimmed: 0 });
  expect(original[2]).toMatchObject({ content: [{ type: 'text' }, { type: 'image' }] });
});
