import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newSessionFixture, studioRequest } from './testsupport';

describe('scene edits api', () => {
  it('reads, validates, writes visual overrides under project write lock, and rejects invalid CSS', async () => {
    const f = newSessionFixture();
    const htmlPath = path.join(f.root, 'scenes', 'scene-001', 'index.html');
    fs.writeFileSync(htmlPath, '<!doctype html><html><body><div id="bar"></div></body></html>\n', 'utf8');

    const init = await studioRequest(f.s, 'GET', '/api/scenes/scene-001/edits');
    expect(init.status).toBe(200);
    expect(init.body).toEqual({ has_html: true, edits: { schema: 1, elements: {} } });

    const bad = await studioRequest(
      f.s,
      'PUT',
      '/api/scenes/scene-001/edits',
      JSON.stringify({ edits: { schema: 1, elements: { '#bar': { selector: '#bar', backgroundColor: 'url(https://evil.test/x)' } } } }),
    );
    expect(bad.status).toBe(400);

    // 占用项目写锁时，保存编辑被 409 拦下，不和对话或任务打架。
    f.s.acquire(f.root, '正在对话');
    try {
      const busy = await studioRequest(
        f.s,
        'PUT',
        '/api/scenes/scene-001/edits',
        JSON.stringify({ edits: { schema: 1, elements: { '#bar': { selector: '#bar', backgroundColor: 'rgb(31, 155, 233)' } } } }),
      );
      expect(busy.status).toBe(409);
    } finally {
      f.s.release(f.root);
    }

    const saved = await studioRequest(
      f.s,
      'PUT',
      '/api/scenes/scene-001/edits',
      JSON.stringify({
        edits: {
          schema: 1,
          elements: {
            '#bar': { selector: '#bar', backgroundColor: 'rgb(31, 155, 233)', dx: 20, dy: -12, rotate: 5 },
          },
        },
      }),
    );
    expect(saved.status).toBe(200);
    expect(fs.readFileSync(htmlPath, 'utf8')).toContain('background-color: rgb(31, 155, 233) !important');
    expect(fs.readFileSync(htmlPath, 'utf8')).toContain('translate: 20px -12px !important');

    const reread = await studioRequest(f.s, 'GET', '/api/scenes/scene-001/edits');
    expect(reread.status).toBe(200);
    expect(reread.body.edits).toEqual(saved.body.edits);
  });

  it('rejects encode when scene has no index.html', async () => {
    const f = newSessionFixture();
    fs.rmSync(path.join(f.root, 'scenes', 'scene-001', 'index.html'), { force: true });
    const res = await studioRequest(f.s, 'POST', '/api/scenes/scene-001/encode');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('html_missing');
  });
});
