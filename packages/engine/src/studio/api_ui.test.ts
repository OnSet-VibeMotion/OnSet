// 移植自 internal/studio/api_ui_test.go。
//
// 不移植 TestStaticServesBuiltAssetsWithMIME：TS 版后端不服务界面文件（Go 版 go:embed 的 web/），
// 界面由 Electron 从 am://app/ 自己加载。
import './testsupport';
import { describe, expect, it } from 'vitest';
import * as preset from '../preset';
import { newSessionFixture, rawGet, studioRequest, writeTree } from './testsupport';

describe('api_ui', () => {
  it('styles list and example images', async () => {
    const f = newSessionFixture();
    const { status, body } = await studioRequest(f.s, 'GET', '/api/styles');
    expect(status).toBe(200);
    expect(body.canvases).toHaveLength(preset.all().length);
    expect(body.styles).toHaveLength(preset.allStyles().length);
    expect(body.custom.id).toBe(preset.CustomStyle.id);
    expect(body.default_canvas).toBe(preset.defaultPreset().id);

    const style = preset.defaultStyle().id;
    const canvas = preset.defaultPreset().id;
    const res = await f.s.handle(new Request(`http://studio.test/api/styles/${style}/${canvas}/${preset.ArchetypeIDs[0]}.png`));
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    for (const p of [
      `${style}/${canvas}/unknown.png`,
      `no-such-style/${canvas}/proposition.png`,
      `${style}/no-such-canvas/proposition.png`,
      `${preset.CustomStyle.id}/${canvas}/proposition.png`,
      `${style}/${canvas}/proposition.svg`,
      `${style}/${canvas}`,
    ]) {
      expect((await rawGet(f.s, '/api/styles/' + p)).status, p).toBe(404);
    }
    expect((await studioRequest(f.s, 'POST', '/api/styles', '{}')).status).toBe(405);
  });

  it('tree skips state, dependencies and secrets', async () => {
    const f = newSessionFixture();
    writeTree(f.root, { 'node_modules/x/index.js': 'skip', 'production/studio/tasks.json': 'skip', 'production/review/sheet-01.png': 'png' });
    const { status, body } = await studioRequest(f.s, 'GET', '/api/tree');
    expect(status).toBe(200);
    const paths = new Set((body.files as { path: string }[]).map((entry) => entry.path));
    for (const want of ['PROMPT.md', 'scenes/scene-001/prompt.md', 'production/review/sheet-01.png']) expect(paths.has(want), `缺少 ${want}`).toBe(true);
    for (const skipped of ['.env', 'scenes/scene-001/.env', 'node_modules/x/index.js', 'production/studio/tasks.json', '.agents/skills/scene-kit/SKILL.md']) {
      expect(paths.has(skipped), `${skipped} 不应列出`).toBe(false);
    }
    expect(body.truncated).toBe(false);
  });

  it('raw serves project files but not secrets', async () => {
    const f = newSessionFixture();
    const { status, text } = await rawGet(f.s, '/api/raw?path=scenes/scene-001/prompt.md');
    expect(status).toBe(200);
    expect(text).toBe('original');
    for (const p of ['.env', 'scenes/scene-001/.env', '../etc/passwd', '/etc/passwd', 'scenes', 'missing.mp4', '']) {
      expect((await rawGet(f.s, '/api/raw?path=' + p)).status, p).toBe(404);
    }
    expect((await studioRequest(f.s, 'POST', '/api/raw?path=PROMPT.md', '{}')).status).toBe(405);
    // TS 额外：视频拖动要用的 Range。
    const ranged = await f.s.handle(new Request('http://studio.test/api/raw?path=scenes/scene-001/prompt.md', { headers: { Range: 'bytes=1-3' } }));
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('rig');
    expect(ranged.headers.get('Content-Range')).toBe('bytes 1-3/8');
  });

  it('beat state follows project files', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/beat');
    expect(status).toBe(200);
    expect(body.enabled).toBe(false);
    expect(body.click).toBe(false);
    writeTree(f.root, { 'beat.yaml': 'x', 'production/beat/grid-click.wav': 'wav', 'production/beat/grid-draft.json': '{}' });
    ({ body } = await studioRequest(f.s, 'GET', '/api/beat'));
    expect(body).toEqual({ enabled: true, click: true, draft: true, confirmed: false, click_path: 'production/beat/grid-click.wav' });
  });
});
