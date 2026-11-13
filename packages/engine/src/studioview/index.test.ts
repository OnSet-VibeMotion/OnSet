import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeView, drainViewInbox, stepIDs, validateViewRequest, ViewInboxEnv, ViewProjectEnv, type ViewRequest, writeViewRequest } from './index';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-studioview-'));

function writeTree(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
}

describe('studio view requests', () => {
  it('validates pages and targets, writes and drains the inbox in order', () => {
    const root = temp();
    writeTree(root, {
      'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}',
      'production/notes.md': 'x',
      '.env': 'A=1',
    });
    const ok: ViewRequest[] = [
      { page: 'script' },
      { page: 'scene', target: 'scene-001' },
      { page: 'compose' },
      { page: 'file', target: 'production/notes.md' },
      { page: 'file', target: path.join(root, 'production', 'notes.md') },
    ];
    for (const req of ok) {
      const got = validateViewRequest(root, req);
      if (req.page === 'file') expect(got.target).toBe('production/notes.md');
    }
    const bad: ViewRequest[] = [
      { page: 'nope' },
      { page: 'scene' },
      { page: 'scene', target: 'scene-009' },
      { page: 'script', target: 'x' },
      { page: 'file' },
      { page: 'file', target: '.env' },
      { page: 'file', target: '../outside' },
      { page: 'file', target: 'missing.md' },
    ];
    for (const req of bad) expect(() => validateViewRequest(root, req), JSON.stringify(req)).toThrow();
    // 不在客户端里：页面对就静默跳过，页面错照样报。
    expect(writeViewRequest({}, { page: 'script' })).toBe(false);
    expect(() => writeViewRequest({}, { page: 'nope' })).toThrow();
    const inbox = path.join(temp(), 'inbox');
    const env = { [ViewInboxEnv]: inbox, [ViewProjectEnv]: root };
    for (const page of ['script', 'final']) expect(writeViewRequest(env, { page })).toBe(true);
    const got = drainViewInbox(inbox);
    expect(got.map((r) => r.page)).toEqual(['script', 'final']);
    expect(drainViewInbox(inbox)).toEqual([]);
  });

  // 编排工具常用 file 页打开口播稿、分镜、成片：那样用户看到的是一份原文，有专门页面的都改切过去。
  it('sends files that have their own page to that page', () => {
    const root = temp();
    writeTree(root, {
      'production/script-final.md': 'x',
      'production/scene-plan.md': 'x',
      'production/treatment.md': 'x',
      'production/audio/candidate.mp4': 'x',
      'final.mp4': 'x',
      'publish.md': 'x',
      'scenes/scene-002/scene.json': '{"id":"scene-002","duration_seconds":1,"output":"out.mp4"}',
      'scenes/scene-002/render-scene-002.mp4': 'x',
      'scenes/scene-002/index.html': 'x',
      'scenes/scene-002/assets/a.png': 'x',
      'docs/a.md': 'x',
    });
    const cases: [string, ViewRequest][] = [
      ['production/script-final.md', { page: 'script' }],
      ['production/scene-plan.md', { page: 'storyboard' }],
      ['production/treatment.md', { page: 'storyboard' }],
      ['production/audio/candidate.mp4', { page: 'final' }],
      ['final.mp4', { page: 'final' }],
      ['publish.md', { page: 'publish' }],
      ['scenes/scene-002/render-scene-002.mp4', { page: 'scene', target: 'scene-002' }],
      ['scenes/scene-002/assets/a.png', { page: 'scene', target: 'scene-002' }],
      ['scenes/scene-002/index.html', { page: 'compose', target: 'scene-002' }],
      ['docs/a.md', { page: 'file', target: 'docs/a.md' }],
    ];
    for (const [file, want] of cases) expect(validateViewRequest(root, { page: 'file', target: file, note: 'n' }), file).toEqual({ ...want, note: 'n' });
  });

  it('marks the production step without switching pages', () => {
    expect(stepIDs()).toEqual(['beat', 'script', 'storyboard', 'scene', 'final', 'publish']);
    expect(validateViewRequest('', { page: '', step: 'storyboard' })).toEqual({ page: '', step: 'storyboard' });
    expect(validateViewRequest('', { page: 'final', step: 'final' })).toEqual({ page: 'final', step: 'final' });
    expect(() => validateViewRequest('', { page: '', step: 'nope' })).toThrow('没有步骤');
    expect(() => validateViewRequest('', { page: '' })).toThrow();
    // 第三方插件的页面：只查写法。
    expect(validateViewRequest('', { page: 'x:fake-publisher:dashboard', target: 'ignored' })).toEqual({ page: 'x:fake-publisher:dashboard' });
    expect(() => validateViewRequest('', { page: 'x:Bad:page' })).toThrow('没有页面');
    const inbox = path.join(temp(), 'inbox');
    expect(writeViewRequest({ [ViewInboxEnv]: inbox }, { page: '', step: 'scene', note: '开始渲染' })).toBe(true);
    expect(drainViewInbox(inbox)).toEqual([{ page: '', step: 'scene', note: '开始渲染' }]);
  });

  it('describes what the user is looking at', () => {
    expect(describeView(undefined)).toBe('');
    expect(describeView({ page: 'bogus' })).toBe('');
    expect(describeView({ page: 'file', file: 'a.md' })).toContain('「文件」页，文件 a.md');
  });
});
