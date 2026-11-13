import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeView, drainViewInbox, validateViewRequest, ViewInboxEnv, ViewProjectEnv, type ViewRequest, writeViewRequest } from './index';

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
      'production/treatment.md': 'x',
      '.env': 'A=1',
    });
    const ok: ViewRequest[] = [
      { page: 'script' },
      { page: 'scene', target: 'scene-001' },
      { page: 'compose' },
      { page: 'file', target: 'production/treatment.md' },
      { page: 'file', target: path.join(root, 'production', 'treatment.md') },
    ];
    for (const req of ok) {
      const got = validateViewRequest(root, req);
      if (req.page === 'file') expect(got.target).toBe('production/treatment.md');
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

  it('describes what the user is looking at', () => {
    expect(describeView(undefined)).toBe('');
    expect(describeView({ page: 'bogus' })).toBe('');
    expect(describeView({ page: 'file', file: 'a.md' })).toContain('「文件」页，文件 a.md');
  });
});
