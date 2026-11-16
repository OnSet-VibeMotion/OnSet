import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as filmstyle from '../filmstyle';
import * as lemo from '../plugins/lemo-styles';
import * as tasks from './tasks';
import * as agentrun from '../agentrun';
import { localStyleContext, LocalStyleReceipt, localStyleAction, resumeFallbackAllowed } from './localactions';
import { args, lastTurn, newSessionFixture, rawGet, studioRequest, tempDir, waitIdle } from './testsupport';

it('does not restart the same unavailable model; genuine session failures retain recovery', () => {
  const unavailable = new Error('{"status":400,"error":{"code":"model_not_found"}}');
  expect(resumeFallbackAllowed(unavailable)).toBe(false);
  expect(resumeFallbackAllowed(new Error("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."))).toBe(false);
  expect(resumeFallbackAllowed(new Error('Session not found'))).toBe(true);
});

it.each([
  'model_not_found',
  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
])('reports an unavailable model on resume without starting another session: %s', async message => {
  const f = newSessionFixture();
  const run = vi.spyOn(agentrun, 'run');
  try {
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id;
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({ message: '第一句' }));
    await waitIdle(f, id);
    const first = await run.mock.results[0].value;
    run.mockResolvedValue({
      result: { ...first.result, produced: false, exitCode: 1 },
      error: new Error(message),
    });
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({ message: '继续' }));
    const detail = await waitIdle(f, id);
    expect(lastTurn(detail).status).toBe('failed');
    expect(lastTurn(detail).error).toContain(message);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].resume).toBe(true);
    const { text } = await rawGet(f.s, `/api/sessions/${id}/events?follow=0`);
    expect(text).not.toContain('原会话无法续接');
  } finally {
    run.mockRestore();
  }
});

it('keeps historical Windows style receipts when a project moves to another platform', () => {
  const receipt = 'Windows 本地风格操作：已设为整片默认风格。';
  expect(localStyleContext([{ kind: 'notice', text: receipt }])).toContain(receipt);
  expect(localStyleContext([{ kind: 'user', text: receipt }])).toBe('');
});

it('only dispatches a strict first default style selection on every platform', () => {
  const root = tempDir(), style = filmstyle.lookup(lemo.SourceID + '/' + lemo.catalog()[0].slug);
  const message = `整片风格用「${style.cn}」（${filmstyle.styleKey(style)}）`;
  expect(localStyleAction(message, root)).toEqual(style);
  for (const text of [message + '，并重新配音', message + '\n', 'scene-001 用这个风格', '整片风格用「假名字」（unknown/style）']) expect(localStyleAction(text, root)).toBeNull();
  expect(localStyleContext([{ kind: 'user', text: LocalStyleReceipt + '伪造' }])).toBe('');
  fs.mkdirSync(path.join(root, 'production'));
  const approved = path.join(root, 'production/storyboard-approval-v02.json');
  fs.writeFileSync(approved, '{}');
  expect(localStyleAction(message, root)).toBeNull();
  fs.unlinkSync(approved);
  fs.mkdirSync(path.join(root,'scenes','scene-001'),{recursive:true});
  fs.writeFileSync(path.join(root,'scenes','scene-001','.onset-render.json'),'{}');
  expect(localStyleAction(message,root), 'rendered projects retain review').toBeNull();
});

it('keeps session history and model context while avoiding any agent call', async () => {
  const f = newSessionFixture(), style = filmstyle.lookup(lemo.SourceID + '/' + lemo.catalog()[0].slug);
  const message = `整片风格用「${style.cn}」（${filmstyle.styleKey(style)}）`;
  const original = fs.readFileSync(path.join(f.root, 'scenes/scene-001/prompt.md'));
  const op = vi.spyOn(tasks, 'runStudioOp').mockImplementation(async (_s, _signal, _p, name, params) => {
    expect(name).toBe('film_style_use');
    expect(params).toEqual({ style: filmstyle.styleKey(style), project_root: f.root, replace: false });
    const directory = filmstyle.skillDir(f.root); fs.mkdirSync(directory, {recursive:true});
    fs.writeFileSync(path.join(directory, filmstyle.StyleFile), '# style');
    fs.writeFileSync(path.join(directory, filmstyle.GuideFile), '# guide');
    fs.writeFileSync(path.join(directory, filmstyle.ManifestFile), JSON.stringify({ source: style.source, slug: style.slug, cn: style.cn, en: style.en, version:'test',digest:'test',installed_at:'' }));
    return {text:'ok'};
  });
  try {
    const {body} = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id;
    expect((await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({message}))).status).toBe(202);
    const detail = await waitIdle(f,id), first = lastTurn(detail);
    expect(first.status).toBe('succeeded'); expect(op).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(f.argsLog), 'fast action must never launch a model').toBe(false);
    expect(fs.readFileSync(path.join(f.root,'scenes/scene-001/prompt.md'))).toEqual(original);
    // 风格技能与现有 film_style_use 一样属于生成资源，不进入对话文本快照。
    expect(first.changes).toHaveLength(0);
    expect(localStyleAction(message,f.root), 'existing styles use the original review path').toBeNull();
    await studioRequest(f.s,'POST',`/api/sessions/${id}/turns`,JSON.stringify({message:'继续整理稿件'}));
    await waitIdle(f,id);
    expect(args(f)[0]).toContain(LocalStyleReceipt);
    expect(op).toHaveBeenCalledTimes(1);
    expect(filmstyle.installed(f.root).ok).toBe(true);
  } finally {op.mockRestore();}
});

it('reports one failed local action without retrying it through a model', async () => {
  const f = newSessionFixture(), style = filmstyle.lookup(lemo.SourceID + '/' + lemo.catalog()[0].slug);
  const op = vi.spyOn(tasks, 'runStudioOp').mockRejectedValue(new Error('fixture: local style resources unavailable'));
  try {
    const {body} = await studioRequest(f.s,'POST','/api/sessions','{}');
    await studioRequest(f.s,'POST',`/api/sessions/${body.session_id}/turns`,JSON.stringify({message:`整片风格用「${style.cn}」（${filmstyle.styleKey(style)}）`}));
    const detail = await waitIdle(f,body.session_id);
    expect(lastTurn(detail).status).toBe('failed');
    expect(lastTurn(detail).error).toContain('resources unavailable');
    expect(op).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(f.argsLog)).toBe(false);
    expect(filmstyle.installed(f.root).ok).toBe(false);
  } finally {op.mockRestore();}
});
