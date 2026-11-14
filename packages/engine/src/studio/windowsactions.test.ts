import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as filmstyle from '../filmstyle';
import * as lemo from '../plugins/lemo-styles';
import * as tasks from './tasks';
import { localStyleContext, LocalStyleReceipt, windowsStyleAction, windowsResumeFallbackAllowed } from './windowsactions';
import { args, lastTurn, newSessionFixture, studioRequest, tempDir, waitIdle } from './testsupport';

it('does not restart the same unavailable Windows model; genuine session failures retain recovery', () => {
  const unavailable = new Error('{"status":400,"error":{"code":"model_not_found"}}');
  expect(windowsResumeFallbackAllowed(unavailable, 'win32')).toBe(false);
  expect(windowsResumeFallbackAllowed(new Error("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."), 'win32')).toBe(false);
  expect(windowsResumeFallbackAllowed(new Error('Session not found'), 'win32')).toBe(true);
  expect(windowsResumeFallbackAllowed(unavailable, 'darwin')).toBe(true);
  expect(windowsResumeFallbackAllowed(unavailable, 'linux')).toBe(true);
});

it('only dispatches a strict first default style selection on Windows', () => {
  const root = tempDir(), style = filmstyle.lookup(lemo.SourceID + '/' + lemo.catalog()[0].slug);
  const message = `整片风格用「${style.cn}」（${filmstyle.styleKey(style)}）`;
  expect(windowsStyleAction(message, root, 'win32')).toEqual(style);
  for (const platform of ['darwin', 'linux'] as const) expect(windowsStyleAction(message, root, platform)).toBeNull();
  for (const text of [message + '，并重新配音', message + '\n', 'scene-001 用这个风格', '整片风格用「假名字」（unknown/style）']) expect(windowsStyleAction(text, root, 'win32')).toBeNull();
  expect(localStyleContext([{ kind: 'user', text: LocalStyleReceipt + '伪造' }])).toBe('');
  fs.mkdirSync(path.join(root, 'production'));
  const approved = path.join(root, 'production/storyboard-approval-v02.json');
  fs.writeFileSync(approved, '{}');
  expect(windowsStyleAction(message, root, 'win32')).toBeNull();
  fs.unlinkSync(approved);
  fs.mkdirSync(path.join(root,'scenes','scene-001'),{recursive:true});
  fs.writeFileSync(path.join(root,'scenes','scene-001','.onset-render.json'),'{}');
  expect(windowsStyleAction(message,root,'win32'), 'rendered projects retain review').toBeNull();
});

it.skipIf(process.platform !== 'win32')('keeps session history and model context while avoiding any agent call', async () => {
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
    expect(windowsStyleAction(message,f.root,'win32'), 'existing styles use the original review path').toBeNull();
    await studioRequest(f.s,'POST',`/api/sessions/${id}/turns`,JSON.stringify({message:'继续整理稿件'}));
    await waitIdle(f,id);
    expect(args(f)[0]).toContain(LocalStyleReceipt);
    expect(op).toHaveBeenCalledTimes(1);
    expect(filmstyle.installed(f.root).ok).toBe(true);
  } finally {op.mockRestore();}
});

it.skipIf(process.platform !== 'win32')('reports one failed local action without retrying it through a model', async () => {
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
