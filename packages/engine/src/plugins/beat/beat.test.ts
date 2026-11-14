/**
 * 卡点做成内置插件之后：它登记的东西都在（流程、站、操作、页面、步骤、网页命令、前置资源、子进程变量、新建选项、镜头块），
 * 宿主没有一处按名字认识它；项目关掉它时操作、页面、前置资源都不在，有 beat.yaml 时不许关。
 */
import '../../studio/testsupport';
import { describe, expect, it } from 'vitest';
import * as config from '../../config';
import * as flow from '../../flow';
import * as plugin from '../../plugin';
import * as prereqs from '../../prereqs';
import * as projectinit from '../../projectinit';
import * as scene from '../../scene';
import * as studioview from '../../studioview';
import * as tools from '../../tools';
import { newSessionFixture, studioRequest, writeTree } from '../../studio/testsupport';
import { BeatFlow } from './index';

const owned = <T>(list: plugin.Owned<T>[]) => list.filter((x) => x.owner === 'beat').map((x) => x.value);

describe('the beat plugin', () => {
  it('registers everything the beat mode needs', () => {
    expect(owned(plugin.pluginFlows()).map((f) => f.id)).toEqual([BeatFlow]);
    expect(owned(plugin.pluginStations()).map((s) => s.id)).toEqual(['beat-story', 'beat-music', 'beat-plan', 'beat-common']);
    expect(owned(plugin.pluginOps()).map((o) => o.name).sort()).toEqual([
      'beat_analyze',
      'beat_bars',
      'beat_click',
      'beat_confirm',
      'beat_cues',
      'beat_doctor',
      'beat_import',
      'beat_init',
      'beat_regrid',
      'validate_beat',
    ]);
    expect(owned(plugin.pluginPages()).map((p) => p.id)).toEqual(['beat']);
    expect(owned(plugin.pluginRoutes()).map((r) => r.pattern)).toEqual(['/api/beat']);
    expect(owned(plugin.pluginSteps()).map((s) => s.id)).toEqual(['beat']);
    expect(owned(plugin.pluginCommands()).map((c) => c.id)).toEqual(['beat.confirm', 'beat.regrid']);
    expect(owned(plugin.pluginPrereqs()).map((p) => p.id)).toEqual(['beat']);
    expect(owned(plugin.pluginChildEnvs()).map((e) => e.key)).toEqual(['ONSET_BEAT_ENV_DIR']);
    expect(owned(plugin.pluginPresets()).map((p) => p.id)).toEqual(['beat']);
    expect(owned(plugin.pluginSceneBlocks()).map((b) => b.key)).toEqual(['beat']);
    expect(owned(plugin.pluginRenderChecks())).toHaveLength(1);

    // 宿主的表里经登记表拿到它：页面排在制作路线后面、步骤排在口播稿前面、新建选项排在口播后面、流程排在口播后面。
    expect(studioview.viewPages().map((p) => p.id).slice(0, 3)).toEqual(['progress', 'beat', 'script']);
    expect(studioview.stepIDs()).toEqual(['beat', 'script', 'storyboard', 'scene', 'final', 'publish']);
    expect(projectinit.presets().map((p) => p.id).slice(0, 3)).toEqual(['speech', 'beat', 'song']);
    expect(flow.allFlows().map((f) => f.id)).toEqual(['speech', 'beat', 'song']);
    expect(flow.builtinFirstPages()).toEqual(['script', 'beat']);
    expect(scene.sceneBlocks().map((b) => b.key)).toContain('beat');
    // 卡点的网格确认要用户本人听过：插件页面不能申请调它。
    expect(flow.pageCallableOp('beat_confirm')).toBe(false);
    expect(flow.pageCallableOp('beat_bars')).toBe(true);
  });

  it('passes the analysis environment to children and the tool server', () => {
    const root = newSessionFixture().root;
    const env = { HOME: '/home/u', XDG_DATA_HOME: '/data' };
    const cfg = config.load(root, env);
    expect(process.platform === 'win32' ? cfg.pluginEnv.ONSET_BEAT_ENV_DIR.replaceAll('\\', '/') : cfg.pluginEnv.ONSET_BEAT_ENV_DIR).toMatch(/^\/data\/onset\/beat\//);
    expect(config.childEnvironment(cfg, env).ONSET_BEAT_ENV_DIR).toBe(cfg.pluginEnv.ONSET_BEAT_ENV_DIR);
    expect(tools.onsetToolsServer('onset', 'orchestrator', root, { ONSET_BEAT_ENV_DIR: '/x', SECRET: 'no' }).env).toMatchObject({ ONSET_BEAT_ENV_DIR: '/x' });
    expect(tools.onsetToolsServer('onset', 'orchestrator', root, { SECRET: 'no' }).env?.SECRET).toBeUndefined();
  });

  it('is there in every project: its prerequisite is listed and /api/stations has no switch for it', async () => {
    const f = newSessionFixture();
    expect(prereqs.items(prereqs.selection(process.env as Record<string, string>, f.root)).map((i) => i.id)).toContain('beat');
    expect(prereqs.items(prereqs.selection(process.env as Record<string, string>)).map((i) => i.id)).toContain('beat');
    const body = (await studioRequest(f.s, 'GET', '/api/stations')).body as { stations: Record<string, unknown>[] };
    const beat = body.stations.find((x) => x.id === 'beat');
    expect(beat).toMatchObject({ builtin: true });
    expect(beat).not.toHaveProperty('enabled');
    expect(body).not.toHaveProperty('hidden_pages');
  });

  it('serves /api/beat and its two page commands through the plugin', async () => {
    const f = newSessionFixture();
    let r = await studioRequest(f.s, 'GET', '/api/beat');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: false });
    writeTree(f.root, { 'beat.yaml': 'schema: 1\n' });
    r = await studioRequest(f.s, 'GET', '/api/beat');
    expect(r.body).toMatchObject({ enabled: true, click_path: 'production/beat/grid-click.wav' });
    r = await studioRequest(f.s, 'POST', '/api/commands/beat.regrid', JSON.stringify({ meter: 0, anchor: 0 }));
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_regrid');
    r = await studioRequest(f.s, 'POST', '/api/commands/nope', '{}');
    expect(r.body.code).toBe('unknown_command');
  });
});
