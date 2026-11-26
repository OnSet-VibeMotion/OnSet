import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOp, normalizeParams, TextSink } from './ops/op';
import { tempDir } from './testutil';
import { describeTools } from './toolsmcp';

const CollectOps = ['asset_gather', 'asset_collect', 'asset_fetch', 'asset_page'] as const;

describe('collect_cmd operations and MCP exposure', () => {
  it('exposes asset_* tools only to orchestrator and never to renderer', () => {
    const orchestratorNames = describeTools('orchestrator').map((t) => t.name);
    const rendererNames = describeTools('renderer').map((t) => t.name);
    for (const name of CollectOps) {
      expect(orchestratorNames, `编排端应暴露 ${name}`).toContain(name);
      expect(rendererNames, `渲染器严禁暴露网络工具 ${name}`).not.toContain(name);
    }
  });

  it('validates asset_page mutually exclusive inputs and blocks html_file path traversal', async () => {
    const op = findOp('asset_page')!;
    expect(op).toBeDefined();
    const project = tempDir();
    const outside = path.join(tempDir(), 'secret.html');
    fs.writeFileSync(outside, '<h1>secret</h1>');
    const ctx = () => ({
      out: new TextSink(),
      err: new TextSink(),
      signal: new AbortController().signal,
      unsafe: false,
    });

    // 三个来源都没给
    await expect(op.run(normalizeParams(op, { project_root: project }), ctx())).rejects.toThrow(/三选一|之一/);
    // 同时给了 url 与 html
    await expect(
      op.run(normalizeParams(op, { project_root: project, url: 'https://example.com/', html: '<b>x</b>' }), ctx()),
    ).rejects.toThrow(/之一/);
    // 路径穿越被拒绝
    await expect(op.run(normalizeParams(op, { project_root: project, html_file: outside }), ctx())).rejects.toThrow(
      /路径穿越/,
    );
    // 项目目录内指向外部文件的符号链接同样被拒绝
    const symlinkHtml = path.join(project, 'escape.html');
    fs.symlinkSync(outside, symlinkHtml);
    await expect(
      op.run(normalizeParams(op, { project_root: project, html_file: 'escape.html' }), ctx()),
    ).rejects.toThrow(/符号链接穿越/);
  });

  it('rejects SSRF addresses directly at op execution level', async () => {
    const project = tempDir();
    const ctx = () => ({
      out: new TextSink(),
      err: new TextSink(),
      signal: new AbortController().signal,
      unsafe: false,
    });
    const fetchOp = findOp('asset_fetch')!;
    const collectOp = findOp('asset_collect')!;
    const gatherOp = findOp('asset_gather')!;

    for (const bad of [
      'http://127.0.0.1/a.png',
      'http://169.254.169.254/latest',
      'http://10.0.0.1/a',
      'file:///etc/passwd',
    ]) {
      await expect(fetchOp.run(normalizeParams(fetchOp, { url: bad, project_root: project }), ctx())).rejects.toThrow();
      await expect(
        collectOp.run(normalizeParams(collectOp, { url: bad, project_root: project }), ctx()),
      ).rejects.toThrow();
      await expect(
        gatherOp.run(normalizeParams(gatherOp, { target: bad, project_root: project }), ctx()),
      ).rejects.toThrow();
    }
  });
});
