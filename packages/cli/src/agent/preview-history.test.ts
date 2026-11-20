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

it('compacts older inspection images in orchestrator mode while preserving user attachments', () => {
  const image: ImageContent = { type: 'image', data: 'aA==', mimeType: 'image/png' };
  const userWithImage: Message = { role: 'user', content: [{ type: 'text', text: '参考图' }, image], timestamp: 0 };
  const assistant = fauxAssistantMessage('');
  assistant.usage = { ...assistant.usage, input: 10000, cacheRead: 90000 };
  const qcRead = (i: number): Message => ({
    role: 'toolResult', toolName: 'read', toolCallId: 'qc-' + i,
    content: [{ type: 'text', text: 'Read image file [image/png] qc-' + i }, image], isError: false, timestamp: i,
  });
  const original = [userWithImage, qcRead(1), qcRead(2), qcRead(3), assistant, qcRead(4)];
  const history = new PreviewHistory('orchestrator');
  expect(history.project(original, 128000)).toMatchObject({ messages: original, trimmed: 0 });
  const compacted = history.project(original, 96000);
  expect(compacted.trimmed).toBe(2);
  // 用户消息里附带的参考图始终原样保留。
  expect(compacted.messages[0]).toBe(userWithImage);
  // 较早的两张工具看图被移出，保留文字与路径提示；最新两张保留原图。
  expect(compacted.messages[1]).toMatchObject({ content: [
    { type: 'text', text: 'Read image file [image/png] qc-1' },
    { type: 'text', text: expect.stringContaining('旧检查的附图已移出上下文') },
  ] });
  expect(compacted.messages[3]).toBe(original[3]);
  expect(compacted.messages[5]).toBe(original[5]);
});
