// 移植自 internal/studio/uploads_test.go。
import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Server } from './studio';
import { args, lastTurn, newSessionFixture, studioRequest, waitIdle } from './testsupport';
import { safeFileName, uploadDir, uploadKind } from './uploads';

async function uploadRequest(s: Server, files: Record<string, string>): Promise<{ status: number; body: any }> {
  const form = new FormData();
  for (const [name, content] of Object.entries(files)) form.append('file', new Blob([content]), name);
  const res = await s.handle(new Request('http://studio.test/api/uploads', { method: 'POST', body: form }));
  return { status: res.status, body: await res.json() };
}

describe('uploads', () => {
  // 上传存进 production/studio/uploads/，不算任何一轮的改动；附进消息后，编排工具收到文件路径与种类。
  it('uploads land in studio state and reach the prompt', async () => {
    const f = newSessionFixture();
    let { status, body } = await uploadRequest(f.s, { '我的 文章.md': '# 标题\n正文' });
    expect(status, JSON.stringify(body)).toBe(201);
    const attachment = body.attachments[0];
    const p = attachment.path as string;
    expect(p.startsWith(uploadDir + '/')).toBe(true);
    expect(attachment.name).toBe('我的 文章.md');
    expect(attachment.upload).toBe(true);
    expect(p).not.toContain(' ');
    expect(fs.readFileSync(path.join(f.root, p), 'utf8')).toContain('正文');
    expect((await uploadRequest(f.s, { '.env': 'SECRET=1' })).status, '.env 不能上传').toBe(400);

    ({ status, body } = await studioRequest(f.s, 'POST', '/api/sessions', '{"title":"上传"}'));
    expect(status).toBe(201);
    const id = body.session_id as string;
    ({ status } = await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({ message: '用这篇文章做视频', attachments: [attachment] })));
    expect(status).toBe(202);
    const detail = await waitIdle(f, id);
    for (const change of lastTurn(detail).changes) expect(change.path.startsWith('production/studio'), '上传不该算这一轮的改动').toBe(false);
    const a = args(f)[0];
    for (const want of ['用户上传的文件', '文档「我的 文章.md」：' + p, 'choices', '待办清单']) expect(a).toContain(want);
    // 伪造的上传路径被拒。
    const bad = JSON.stringify({ message: 'x', attachments: [{ upload: true, path: 'scenes/scene-001/prompt.md' }] });
    expect((await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, bad)).status).toBe(400);
  });

  // TS 额外：流式读 multipart 的边界情况。
  it('multipart edge cases', async () => {
    const f = newSessionFixture();
    const post = (body: string | FormData, contentType?: string) =>
      f.s.handle(new Request('http://studio.test/api/uploads', { method: 'POST', body, headers: contentType ? { 'Content-Type': contentType } : {} }));
    expect((await post('x', 'text/plain')).status).toBe(400);
    const empty = new FormData();
    empty.append('other', 'value');
    const res = await post(empty);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe('no_file');
    const zero = new FormData();
    zero.append('file', new Blob([]), 'empty.md');
    expect(((await (await post(zero)).json()) as any).message).toBe('文件是空的');
    // 跨多个块、内容里含有像分隔符的片段。
    const big = 'a\r\n--not-the-boundary\r\n'.repeat(20000);
    const form = new FormData();
    form.append('file', new Blob([big]), 'big.txt');
    form.append('file', new Blob(['second']), 'b.txt');
    const ok = await post(form);
    const body = (await ok.json()) as any;
    expect(ok.status).toBe(201);
    expect(body.attachments).toHaveLength(2);
    expect(fs.readFileSync(path.join(f.root, body.attachments[0].path), 'utf8')).toBe(big);
    expect(body.attachments[0].size).toBe(Buffer.byteLength(big));
  });

  it('safeFileName and uploadKind', () => {
    for (const [input, want] of Object.entries({ 'a/b\\c.md': 'a_b_c.md', '..hidden': 'hidden', '我的 文章.md': '我的-文章.md', '': 'file' })) {
      expect(safeFileName(input), input).toBe(want);
    }
    const long = safeFileName('长'.repeat(120) + '.png');
    expect([...long].length).toBe(80);
    expect(long.endsWith('.png')).toBe(true);
    for (const [name, kind] of Object.entries({ 'a.MD': '文档', 'b.png': '图片', 'c.wav': '音频', 'd.mov': '视频', 'e.woff2': '字体', 'f.bin': '文件' })) {
      expect(uploadKind(name), name).toBe(kind);
    }
  });
});
