/**
 * 对照测试：「发布」搬进内置插件的进程内登记（apply）前后，宿主看到的东西逐字节不变。
 * 金样（testdata/golden.json）是搬家之前的代码写下的；AM_UPDATE_GOLDEN=1 时重写（只在确实要改行为时用）。
 */
import '../../studio/testsupport';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../../flow';
import { runPrompt } from '../../project/runprompt';
import { computeStations, readProgress } from '../../studio/progress';
import { discoverScenes } from '../../studio/scenes';
import { newSessionFixture, studioRequest, writeStudioPNG } from '../../studio/testsupport';
import * as studioview from '../../studioview';
import * as assets from '../../assets';

const goldenFile = path.join(__dirname, 'testdata', 'golden.json');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-publishing-golden-')));
  temps.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const rule = (r: flow.PathRule) => ({ path: r.path, prefix: r.prefix, base: r.base?.source });
const routeJSON = (stops: flow.RouteStop[]) => stops.map(({ station, node }) => ({ station, ...node, produces: node.produces?.map(rule) }));

function setDisabled(root: string, off: boolean): void {
  if (off) flow.setBuiltinEnabled(root, 'publishing', false);
}

async function collect(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  // 制作提示词：三种画幅、开与关。
  for (const canvas of ['vertical-3x4', 'vertical-9x16', 'landscape-16x9']) {
    const text = fs.readFileSync(path.join(assets.assetsBase(), 'assets', 'presets', canvas, 'PROMPT-PRODUCTION.md'));
    for (const off of [false, true]) {
      const root = project();
      fs.writeFileSync(path.join(root, 'PROMPT-PRODUCTION.md'), text);
      setDisabled(root, off);
      const prompt = runPrompt(root, '').prompt;
      out[`prompt:${canvas}:${off ? 'off' : 'on'}`] = { sha256: sha(prompt), bytes: prompt.length };
    }
  }
  // 路线、文件归站、关卡、阶段标题。
  for (const off of [false, true]) {
    const root = project();
    setDisabled(root, off);
    const extras = flow.projectExtras(root);
    for (const id of ['speech', 'beat']) {
      out[`route:${id}:${off ? 'off' : 'on'}`] = routeJSON(flow.route(id, extras));
      out[`owner:${id}:${off ? 'off' : 'on'}`] = ['publish.md', 'covers/douyin-4x3.png', 'production/approval.json'].map((p) => flow.stationOfPath(p, id, extras));
    }
  }
  out.gateFiles = flow.gateFiles();
  // 只看发布插件的站（后来歌曲讲解插件登记了自己的站 song-prompt，与发布无关）。
  out.stationOwners = [...flow.stationOwners()].filter(([, owner]) => owner === 'publishing').sort();
  // 制作路线：发布信息的几种状态。
  const states: Record<string, Record<string, string>> = {
    none: {},
    draft: { 'publish.md': '---\n{"publish_status": "draft"}\n---\n' },
    pending: { 'production/approval.json': '{}', 'publish.md': '---\n{"publish_status": "pending_manual_checks"}\n---\n' },
    blocked: { 'production/approval.json': '{}', 'publish.md': '---\n{"publish_status": "blocked"}\n---\n' },
    ready: { 'production/approval.json': '{}', 'publish.md': '---\n{"publish_status": "ready"}\n---\n' },
    broken: { 'publish.md': '---\n: [\n---\n' },
  };
  for (const [name, files] of Object.entries(states)) {
    for (const off of [false, true]) {
      const root = project(files);
      setDisabled(root, off);
      const got = computeStations(root, discoverScenes(root));
      out[`progress:${name}:${off ? 'off' : 'on'}`] = {
        mode: got.mode,
        current: got.current,
        waiting_on: got.waiting_on,
        stations: got.stations.map((s) => ({ id: s.id, status: s.status, detail: s.detail ?? '', page: s.page ?? '', step: s.step })),
      };
      out[`progress-turns:${name}:${off ? 'off' : 'on'}`] = readProgress(root).turns;
    }
  }
  // 界面的页面表与专门页面。
  out.viewPage = studioview.viewPage('publish') ?? null;
  out.viewPages = studioview.viewPages().map((p) => p.id);
  out.dedicated = studioview.dedicatedPage('', 'publish.md');
  // 后端接口：/api/publish 与发布校验命令。
  const f = newSessionFixture();
  let r = await studioRequest(f.s, 'GET', '/api/publish');
  out['api:publish:none'] = { status: r.status, body: r.body };
  r = await studioRequest(f.s, 'POST', '/api/commands/publish.check', '{}');
  out['api:check:none'] = { status: r.status, body: r.body };
  fs.copyFileSync(path.join(assets.assetsBase(), 'assets', 'shared', 'templates', 'publish.md'), path.join(f.root, 'publish.md'));
  writeStudioPNG(path.join(f.root, 'covers', 'douyin-4x3.png'), 4, 3);
  r = await studioRequest(f.s, 'GET', '/api/publish');
  out['api:publish:template'] = { status: r.status, body: r.body };
  fs.writeFileSync(path.join(f.root, 'publish.md'), '---\n: [\n---\n');
  r = await studioRequest(f.s, 'GET', '/api/publish');
  out['api:publish:broken'] = { status: r.status, body: r.body };
  return JSON.parse(JSON.stringify(out));
}

describe('publishing plugin keeps the host output byte-for-byte', () => {
  it('matches the golden output recorded before the move', async () => {
    const got = await collect();
    if (process.env.AM_UPDATE_GOLDEN === '1') {
      fs.writeFileSync(goldenFile, JSON.stringify(got, null, 2) + '\n');
      return;
    }
    const want = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const key of Object.keys(want)) expect(got[key], key).toEqual(want[key]);
  });
});
