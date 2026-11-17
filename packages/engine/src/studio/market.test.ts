import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordInstalled } from '../flow/installed';
import * as market from '../flow/market';
import { resetMarketState, startRefresh } from './market';
import { startStudio, studioRequest, tempDir, waitStudioTask } from './testsupport';

const c1 = 'a'.repeat(40);
const c2 = 'b'.repeat(40);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

function catalog(dir: string, versions = [{ version: '0.1.0', ref: 'v0.1.0', commit: c1 }]): string {
  fs.mkdirSync(path.join(dir, 'icons'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'icons', 'p.png'), png);
  const file = path.join(dir, 'index.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: 1,
      plugins: [
        { id: 'onset-publisher', name: '自动发布', description: '发出去', source: 'github:someone/onset-publisher', icon: 'icons/p.png', versions },
        { id: 'publishing', name: '同名', description: '和内置的撞了', source: 'github:someone/publishing', versions: [{ version: '1.0.0', commit: c2 }] },
      ],
    }),
  );
  return file;
}

/** 假执行进程：把要它跑的操作原样交回，看后端交给 station_add / station_update 的参数。 */
function studio() {
  const root = tempDir();
  const worker = path.join(root, 'worker.cjs');
  fs.writeFileSync(worker, `process.stdout.write('\\u0000am-result '+JSON.stringify({ok:true,exit_code:0,data:{argv:process.argv.slice(2)}})+'\\n');`);
  return startStudio({ executable: worker, configPath: path.join(root, 'projects.json') });
}

const opOf = (task: Record<string, unknown>) => {
  const argv = (task.result as { argv: string[] }).argv;
  const at = argv.indexOf('__op');
  return { name: argv[at + 1], params: JSON.parse(argv[at + 2]) as Record<string, unknown> };
};

afterEach(() => {
  resetMarketState();
  market.useHttpFetch(null);
  vi.unstubAllEnvs();
});

describe('market API', () => {
  it('lists the catalog against what is installed and starts plugins through staging', async () => {
    const dir = tempDir();
    vi.stubEnv('PLUGIN_CATALOG_URL', `file://${catalog(dir)}`);
    const s = studio();
    try {
      // 第一次没有缓存：立刻返回，后台去取。
      let r = await studioRequest(s, 'GET', '/api/market');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ items: [], fetched_at: '', custom_url: true });
      await startRefresh();
      r = await studioRequest(s, 'GET', '/api/market');
      expect(r.body.error).toBe('');
      expect(r.body.items.map((x: { id: string; state: string }) => [x.id, x.state])).toEqual([
        ['onset-publisher', 'available'],
        ['publishing', 'builtin'],
      ]);
      expect(r.body.items[0]).toMatchObject({ icon: '/api/market/images/onset-publisher/icon', latest: { version: '0.1.0', commit: c1 } });

      const icon = await s.handle(new Request('http://studio.test/api/market/images/onset-publisher/icon'));
      expect(icon.status).toBe(200);
      expect(icon.headers.get('Content-Type')).toBe('image/png');
      expect((await studioRequest(s, 'GET', '/api/market/images/onset-publisher/3')).status).toBe(404);

      // 只认目录里列的 commit；来源由后端算。
      expect((await studioRequest(s, 'POST', '/api/market/install', JSON.stringify({ id: 'onset-publisher', commit: c2 }))).status).toBe(404);
      expect((await studioRequest(s, 'POST', '/api/market/install', JSON.stringify({ id: 'publishing', commit: c2 }))).status).toBe(409);
      r = await studioRequest(s, 'POST', '/api/market/install', JSON.stringify({ id: 'onset-publisher', commit: c1, source: 'link:/evil' }));
      expect(r.status).toBe(202);
      expect(opOf(await waitStudioTask(s, r.body.task_id))).toEqual({
        name: 'station_add',
        params: { source: `github:someone/onset-publisher#${c1}`, expect_id: 'onset-publisher', expect_commit: c1 },
      });

      // 装上之后出了新版本：给「更新」，同样只取到暂存。
      recordInstalled(process.env.ONSET_STATIONS_DIR!, { id: 'onset-publisher', version: '0.1.0', source: `github:someone/onset-publisher#${c1}`, commit: c1, digest: 'x', role: { flow: false, replaces: '', after: '', nodes: false } });
      catalog(dir, [{ version: '0.1.0', ref: 'v0.1.0', commit: c1 }, { version: '0.2.0', ref: 'v0.2.0', commit: c2 }]);
      expect((await studioRequest(s, 'POST', '/api/market/refresh', '{}')).status).toBe(202);
      await startRefresh();
      r = await studioRequest(s, 'GET', '/api/market');
      expect(r.body.items[0]).toMatchObject({ state: 'update', installed_version: '0.1.0', latest: { version: '0.2.0' } });
      expect((await studioRequest(s, 'POST', '/api/market/install', JSON.stringify({ id: 'onset-publisher', commit: c2 }))).status).toBe(409);
      r = await studioRequest(s, 'POST', '/api/market/update', JSON.stringify({ id: 'onset-publisher', commit: c2 }));
      expect(r.status).toBe(202);
      expect(opOf(await waitStudioTask(s, r.body.task_id))).toEqual({
        name: 'station_update',
        params: { id: 'onset-publisher', source: `github:someone/onset-publisher#${c2}`, expect_commit: c2 },
      });
    } finally {
      s.shutdown();
    }
  });

  it('keeps the cached catalog and says why when the network fails', async () => {
    const s = studio();
    try {
      vi.stubEnv('PLUGIN_CATALOG_URL', 'https://plugins.example/index.json');
      market.useHttpFetch(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      });
      await startRefresh();
      const r = await studioRequest(s, 'GET', '/api/market');
      expect(r.body.items).toEqual([]);
      expect(r.body.error).toContain('连不上 plugins.example');
      expect(r.body.refreshing).toBe(false);
      expect((await studioRequest(s, 'POST', '/api/market/install', JSON.stringify({ id: 'onset-publisher', commit: c1 }))).status).toBe(409);
    } finally {
      s.shutdown();
    }
  });
});
