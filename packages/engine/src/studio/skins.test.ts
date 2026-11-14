import './testsupport';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { installStation, writeStationForTest } from '../flow';
import { newSessionFixture, send, startStudio, studioRequest, tempDir } from './testsupport';
import path from 'node:path';

function catPlugin(extra: Record<string, string> = {}): string {
  return writeStationForTest({
    'onset-station.json': JSON.stringify({ id: 'cat-skins', version: '1', name: '猫咪皮肤', skins: ['skins/cat.json', 'skins/broken.json'], pages: [{ id: 'cat', label: '猫咪', entry: 'ui/cat.html' }] }),
    'skins/cat.json': JSON.stringify({ id: 'cat', name: '猫咪', scheme: 'light', tokens: { bg: '#fff8f0', accent: '#e07a5f' }, pet: { page: 'cat' } }),
    'skins/broken.json': JSON.stringify({ id: 'broken', name: '坏的', tokens: { bg: 'url(https://x.test/a.png)' } }),
    'ui/cat.html': '<!doctype html><title>cat</title>',
    ...extra,
  });
}

describe('skins API', () => {
  it('lists the theater, the builtin skins and plugin skins, and reports broken ones', async () => {
    const f = newSessionFixture();
    let { status, body } = await studioRequest(f.s, 'GET', '/api/skins');
    expect(status).toBe(200);
    expect(body.current).toBe('default');
    expect(body.skins.map((x: { id: string; origin: string }) => [x.id, x.origin])).toEqual([
      ['default', 'host'],
      ['skins/daylight', 'builtin'],
      ['skins/darkroom', 'builtin'],
    ]);
    expect(body.skins[1]).toMatchObject({ name: '白昼', scheme: 'light', plugin: '界面皮肤' });

    installStation(`link:${catPlugin()}`);
    ({ body } = await studioRequest(f.s, 'GET', '/api/skins'));
    const cat = body.skins.find((x: { id: string }) => x.id === 'cat-skins/cat');
    expect(cat).toMatchObject({ name: '猫咪', origin: 'plugin', plugin: '猫咪皮肤', tokens: { bg: '#fff8f0', accent: '#e07a5f' } });
    expect(cat.pet.page_url).toBe('/station-ui/cat-skins/ui/cat.html');
    expect(body.problems).toEqual([{ plugin: '猫咪皮肤', file: 'skins/broken.json', message: expect.stringContaining('tokens.bg 要是颜色') }]);

    // 拿去当桌宠的页面不进插件菜单。
    ({ body } = await studioRequest(f.s, 'GET', '/api/stations'));
    const st = body.stations.find((x: { id: string }) => x.id === 'cat-skins');
    expect(st.pages[0]).toMatchObject({ id: 'cat', pet: true });
    expect(st.skins).toEqual(['猫咪']);
    expect(st.experimental).toContain('skins');

    // 当桌宠的页面：宿主插进拖动脚本，CSP 放行它；别的页面原样给。
    const res = await send(f.s, 'GET', '/station-ui/cat-skins/ui/cat.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<!doctype html><title>cat</title><script src="/station-ui/_pet.js"></script>');
    expect(res.headers.get('Content-Security-Policy')).toContain('onset://app/station-ui/_pet.js');
    const drag = await send(f.s, 'GET', '/station-ui/_pet.js');
    expect(await drag.text()).toContain("onset: 'pet-drag'");
  });

  it('remembers the choice for the user, not the project, and falls back when it is gone', async () => {
    const configPath = path.join(tempDir(), 'projects.json');
    const s = startStudio({ projectPath: '', configPath });
    let { status, body } = await studioRequest(s, 'PUT', '/api/skins/current', JSON.stringify({ id: 'skins/darkroom' }));
    expect(status).toBe(200);
    expect(body.skin).toMatchObject({ id: 'skins/darkroom', name: '暗房' });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).skin).toBe('skins/darkroom');
    // 重开客户端还是它。
    ({ body } = await studioRequest(startStudio({ projectPath: '', configPath }), 'GET', '/api/skins/current'));
    expect(body.skin.id).toBe('skins/darkroom');

    ({ status } = await studioRequest(s, 'PUT', '/api/skins/current', JSON.stringify({ id: 'nope/none' })));
    expect(status).toBe(404);

    // 插件去掉了：退回放映室，照实说原来选的是谁。
    const dir = catPlugin();
    installStation(`link:${dir}`);
    await studioRequest(s, 'PUT', '/api/skins/current', JSON.stringify({ id: 'cat-skins/cat' }));
    fs.rmSync(dir, { recursive: true, force: true });
    ({ body } = await studioRequest(s, 'GET', '/api/skins/current'));
    expect(body).toMatchObject({ skin: { id: 'default' }, missing: 'cat-skins/cat' });

    // 换回放映室：登记里不留这一项。
    await studioRequest(s, 'PUT', '/api/skins/current', JSON.stringify({ id: 'default' }));
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).not.toHaveProperty('skin');
  });
});
