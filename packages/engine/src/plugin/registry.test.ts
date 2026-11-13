/**
 * 新增一个内置功能只要写它的 apply：这里登记一个只在测试里存在的假内置插件，证明宿主的
 * flow/builtin.ts、studio/progress.ts、studioview 与客户端后端的路由都不用改就认得它。
 * （工具服务那一侧在 packages/cli/src/plugin_ops.test.ts。）
 */
import '../studio/testsupport';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as flow from '../flow';
import { computeStations } from '../studio/progress';
import { discoverScenes } from '../studio/scenes';
import { newSessionFixture, studioRequest } from '../studio/testsupport';
import * as studioview from '../studioview';
import { appliedPluginIDs, pluginStations, registerBuiltin, type BuiltinPlugin } from './index';

const cleanups: (() => void)[] = [];
const temps: string[] = [];
afterEach(() => {
  for (const undo of cleanups.splice(0)) undo();
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-plugin-')));
  temps.push(dir);
  return dir;
}

/** 假插件「字幕翻译」：在复查之后加一站，写 production/translate/，有一段提示词、一页、一个接口、一个校验器。 */
function fakePlugin(dir: string): BuiltinPlugin {
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sections', 'stage.md'), '## {{STAGE:translate}}：翻译字幕\n\n在{{STAGE:review}}之后把字幕译成英文。\n\n');
  return {
    id: 'fake-translate',
    dir,
    apply(ctx) {
      ctx.station({
        id: 'translate',
        name: '翻译字幕',
        nodes: [{ id: 'translate', label: '翻译字幕', step: 'final', page: 'translate', produces: [{ prefix: 'production/translate/' }] }],
        flows: ['speech'],
        after: 'review',
        sections: [{ id: 'stage', file: 'sections/stage.md', after: 'review/stage', stage: 'translate', title: '翻译字幕' }],
        judges: {
          translate: {
            output: (c) => {
              try {
                return fs.statSync(path.join(c.root, 'production', 'translate', 'en.srt')).mtimeMs;
              } catch {
                return 0;
              }
            },
            detail: () => '英文',
            waiting: () => 'user',
          },
        },
      });
      ctx.page({ id: 'translate', label: '翻译', target: '', after: 'review', files: ['production/translate/en.srt'] });
      ctx.route({ pattern: '/api/translate', handle: (host) => {
        const p = host.projectOr404();
        if (p instanceof Response) return p;
        return Response.json({ root: path.basename(p.path) });
      } });
      ctx.validator({ id: 'translate', label: '检查译文', file: 'production/translate/en.srt', op: 'validate_translate' });
    },
  };
}

function register(): void {
  cleanups.push(registerBuiltin(fakePlugin(tempDir())));
}

describe('builtin plugin apply', () => {
  it('registers the shipped plugins once', () => {
    expect(appliedPluginIDs()).toEqual(['publishing']);
    expect(() => registerBuiltin({ id: 'publishing', apply: () => {} })).toThrow('登记了两次');
  });

  it('every applied plugin has a manifest next to its sections', () => {
    const manifests = new Set(flow.builtinPluginIDs());
    for (const id of appliedPluginIDs()) expect(manifests.has(id), id).toBe(true);
  });

  it('puts the station on the route and its files under it', () => {
    register();
    const root = tempDir();
    const ids = flow.route('speech', flow.projectExtras(root)).map((r) => r.node.id);
    expect(ids.slice(ids.indexOf('gate-final'), ids.indexOf('gate-final') + 3)).toEqual(['gate-final', 'translate', 'publish']);
    expect(flow.route('beat', flow.projectExtras(root)).some((r) => r.node.id === 'translate')).toBe(false);
    expect(flow.stationOfPath('production/translate/en.srt', 'speech')).toBe('translate');
  });

  it('judges the station with the registered function', () => {
    register();
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'production', 'translate'), { recursive: true });
    fs.writeFileSync(path.join(root, 'production', 'translate', 'en.srt'), '1\n');
    const got = computeStations(root, discoverScenes(root));
    expect(got.stations.find((s) => s.id === 'translate')).toMatchObject({ status: 'done', detail: '英文', page: 'translate', step: 'final' });
    expect(got.current).toBe('publish');
    expect(got.waiting_on).toBe('ai');
    // 站点自己的 waiting 在它是「现在」时起作用：试听确认过、还没翻译。
    fs.rmSync(path.join(root, 'production', 'translate'), { recursive: true });
    fs.writeFileSync(path.join(root, 'production', 'approval.json'), '{}');
    const next = computeStations(root, discoverScenes(root));
    expect(next.current).toBe('translate');
    expect(next.waiting_on).toBe('user');
  });

  it('composes its prompt section after its anchor and numbers the stages', () => {
    register();
    const order = flow.productionOrder();
    expect(order.slice(order.indexOf('review/stage'), order.indexOf('review/stage') + 3)).toEqual(['review/stage', 'translate/stage', 'publish/stage']);
    expect(flow.allStageTitles().translate).toBe('翻译字幕');
    const composed = flow.composeProduction(path.join(__dirname, '..', 'preset', 'gen', 'templates', 'production'));
    expect(composed).toContain('<!-- am-plugin:fake-translate -->\n## 第十二阶段：翻译字幕\n\n在第十一阶段之后把字幕译成英文。');
    expect(composed).toContain('## 第十三阶段：刷新发布配置');
  });

  it('adds its page, dedicated file, route and validator command to the client', async () => {
    register();
    expect(studioview.viewPage('translate')).toEqual({ id: 'translate', label: '翻译', target: '' });
    const ids = studioview.viewPages().map((p) => p.id);
    expect(ids.slice(ids.indexOf('review'), ids.indexOf('review') + 3)).toEqual(['review', 'translate', 'publish']);
    expect(studioview.dedicatedPage('', 'production/translate/en.srt')).toEqual({ page: 'translate' });
    const f = newSessionFixture();
    let r = await studioRequest(f.s, 'GET', '/api/translate');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ root: path.basename(f.root) });
    r = await studioRequest(f.s, 'POST', '/api/commands/translate.check', '{}');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('translate_missing');
    expect(r.body.message).toBe('找不到 production/translate/en.srt');
  });

  it('goes away with the project switch and with its registration', () => {
    register();
    const root = tempDir();
    fs.writeFileSync(path.join(root, flow.LockFile), JSON.stringify({ version: 1, stations: [], disabled: ['fake-translate'] }));
    expect(flow.route('speech', flow.projectExtras(root)).some((r) => r.node.id === 'translate')).toBe(false);
    expect(flow.route('speech', flow.projectExtras(root)).some((r) => r.node.id === 'publish')).toBe(true);
    cleanups.pop()!();
    expect(pluginStations().some((s) => s.value.id === 'translate')).toBe(false);
    expect(flow.route('speech').some((r) => r.node.id === 'translate')).toBe(false);
  });

  it('rejects a station without a judge, a duplicate station and an unknown anchor', () => {
    const base = { id: 'x', name: 'x', flows: ['speech'], after: 'review' } as const;
    expect(() => registerBuiltin({ id: 'bad-judge', apply: (ctx) => ctx.station({ ...base, nodes: [{ id: 'x', label: 'x', step: 'final' }] }) })).toThrow('没有判断函数');
    expect(() => registerBuiltin({ id: 'bad-dup', apply: (ctx) => ctx.station({ ...base, id: 'publish', nodes: [] }) })).toThrow('站 publish 已经有了');
    const undo = registerBuiltin({ id: 'bad-anchor', apply: (ctx) => ctx.station({ ...base, nodes: [], sections: [{ id: 's', file: 's.md', after: 'nope/stage' }] }) });
    try {
      expect(() => flow.productionOrder()).toThrow('要接在 nope/stage 后面');
    } finally {
      undo();
    }
    expect(appliedPluginIDs()).toEqual(['publishing']);
  });
});

describe('the shipped prompt sections of builtin plugins', () => {
  it('exist, carry their stage title and no hard-coded stage numbers, and leave no orphan files', () => {
    for (const { owner, value: s } of pluginStations()) {
      const dir = path.join(flow.builtinPluginsDir(), owner);
      const declared = (s.sections ?? []).map((sec) => sec.file).sort();
      const files = fs.existsSync(path.join(dir, 'sections')) ? fs.readdirSync(path.join(dir, 'sections')).map((f) => 'sections/' + f).sort() : [];
      expect(files, owner).toEqual(declared);
      for (const sec of s.sections ?? []) {
        const body = fs.readFileSync(path.join(dir, sec.file), 'utf8');
        expect(body, sec.file).not.toMatch(/第[一二三四五六七八九十]+阶段/);
        if (sec.stage) expect(body.split('\n')[0], sec.file).toBe(`## {{STAGE:${sec.stage}}}：${sec.title}`);
      }
    }
  });
});
