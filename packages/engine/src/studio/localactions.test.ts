import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as filmstyle from '../filmstyle';
import * as lemo from '../plugins/lemo-styles';
import * as tasks from './tasks';
import * as agentrun from '../agentrun';
import { localStyleContext, LocalStyleReceipt, localStyleAction, resumeFallbackAllowed } from './localactions';
import * as memory from '../memory';
import { args, lastTurn, newSessionFixture, rawGet, setEnv, studioRequest, tempDir, waitIdle } from './testsupport';

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

/** 在项目里装上一种风格（只写清单，与 film_style_use 落下的东西一样够 installed() 认）。 */
function installStyle(root: string, style: filmstyle.Style): void {
  const directory = filmstyle.skillDir(root); fs.mkdirSync(directory, {recursive:true});
  fs.writeFileSync(path.join(directory, filmstyle.StyleFile), '# style');
  fs.writeFileSync(path.join(directory, filmstyle.GuideFile), '# guide');
  fs.writeFileSync(path.join(directory, filmstyle.ManifestFile), JSON.stringify({ source: style.source, slug: style.slug, cn: style.cn, en: style.en, version:'test',digest:'test',installed_at:'' }));
}

it('stops saying a locally chosen style is installed once the default style changed', () => {
  const [a, b] = lemo.catalog().slice(0, 2).map(c => filmstyle.lookup(lemo.SourceID + '/' + c.slug));
  const receipt = `${LocalStyleReceipt}${a.cn}（${filmstyle.styleKey(a)}）已设为整片默认风格。`;
  const root = tempDir();
  installStyle(root, a);
  expect(localStyleContext([{ kind: 'notice', text: receipt }], root)).toContain(receipt);
  // 之后经原来的路子换成了 B：不能再说 A 已经装好。
  installStyle(root, b);
  expect(localStyleContext([{ kind: 'notice', text: receipt }], root)).toBe('');
  // 风格被去掉了也一样。
  fs.rmSync(filmstyle.skillDir(root), { recursive: true });
  expect(localStyleContext([{ kind: 'notice', text: receipt }], root)).toBe('');
});

it('sends a changed preference after a locally handled style turn', async () => {
  const f = newSessionFixture(), style = filmstyle.lookup(lemo.SourceID + '/' + lemo.catalog()[0].slug);
  const memoryDir = tempDir();
  setEnv('ONSET_MEMORY_DIR', memoryDir);
  const store = memory.open(memoryDir);
  store.remember({ name: 'calm-palette', body: '配色克制，不要满屏霓虹', global: true });
  const op = vi.spyOn(tasks, 'runStudioOp').mockImplementation(async () => { installStyle(f.root, style); return { text: 'ok' }; });
  try {
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id;
    const turn = async (message: string) => {
      expect((await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({ message }))).status).toBe(202);
      await waitIdle(f, id);
    };
    // 先有一个续接着的 CLI 会话，偏好已经发过一次。
    await turn('先看看素材');
    expect(args(f).at(-1)).toContain('【calm-palette】');
    const calls = args(f).length;
    // 偏好变了，紧接着的一轮是在客户端里直接选风格，没调模型。
    store.remember({ name: 'no-emoji', body: '画面里不要 emoji', global: true });
    await turn(`整片风格用「${style.cn}」（${filmstyle.styleKey(style)}）`);
    expect(args(f)).toHaveLength(calls);
    // 下一轮调模型时要把新偏好带上，不能当成已经发过。
    await turn('继续整理稿件');
    expect(args(f).at(-1)).toContain('【no-emoji】');
  } finally { op.mockRestore(); }
});

it('still reaches the model when the style manifest behind an old receipt is broken', async () => {
  const f = newSessionFixture(), style = filmstyle.lookup(lemo.SourceID + '/' + lemo.catalog()[0].slug);
  const op = vi.spyOn(tasks, 'runStudioOp').mockImplementation(async () => { installStyle(f.root, style); return { text: 'ok' }; });
  try {
    const { body } = await studioRequest(f.s, 'POST', '/api/sessions', '{}');
    const id = body.session_id;
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({ message: `整片风格用「${style.cn}」（${filmstyle.styleKey(style)}）` }));
    await waitIdle(f, id);
    // 回执之后风格清单被写坏了。
    fs.writeFileSync(path.join(filmstyle.skillDir(f.root), filmstyle.ManifestFile), '{broken');
    expect(() => filmstyle.installed(f.root)).toThrow();
    await studioRequest(f.s, 'POST', `/api/sessions/${id}/turns`, JSON.stringify({ message: '修复风格配置' }));
    const detail = await waitIdle(f, id);
    expect(lastTurn(detail).status).toBe('succeeded');
    expect(args(f)).toHaveLength(1);
    // 核对不了的旧回执不再说「风格已安装」（对话记录里照实留着那条回执）。
    expect(args(f)[0]).not.toContain('风格已安装，无需重复');
  } finally { op.mockRestore(); }
});
