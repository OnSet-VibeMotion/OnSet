import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allOps } from './ops/op';
import { Buffer, run, tempDir } from './testutil';
import { callTarget, describeTools, prepareCall } from './toolsmcp';

const fake = path.resolve(__dirname, '..', '..', 'engine', 'src', 'flow', 'testdata', 'fake-publisher');

async function projectWithFake(): Promise<string> {
  const root = tempDir();
  const out = new Buffer();
  expect(await run(['station', 'add', `link:${fake}`, '--project-root', root], out), out.text).toBe(0);
  expect(out.text).toContain('已加入第三方站 假发布（fake-publisher 0.1.0）');
  expect(out.text).toContain('[按钮] send');
  expect(out.text).toContain('[工具] x_fake_publisher_status');
  return root;
}

describe('station ops', () => {
  it('are not tools the orchestrator can call', () => {
    for (const name of ['station_add', 'station_remove', 'station_list', 'station_run', 'station_flow', 'station_builtin']) {
      expect(allOps().find((op) => op.name === name)?.scopes, name).toEqual(['cli']);
    }
    expect(describeTools('orchestrator').some((t) => t.name.startsWith('station_'))).toBe(false);
  });

  it('adds, runs, lists and removes a station', async () => {
    const root = await projectWithFake();
    const out = new Buffer();
    expect(await run(['station', 'run', 'fake-publisher', 'send', '--params', '{"platform": "douyin"}', '--project-root', root], out), out.text).toBe(0);
    expect(out.text).toContain('已发到 douyin');
    expect(fs.existsSync(path.join(root, 'production', 'publish', 'receipts.json'))).toBe(true);

    const bad = new Buffer();
    expect(await run(['station', 'run', 'fake-publisher', 'send', '--params', '{}', '--project-root', root], bad)).toBe(1);
    expect(bad.text).toContain('缺参数 platform');

    const list = new Buffer();
    expect(await run(['station', 'list', '--project-root', root], list), list.text).toBe(0);
    expect(list.text).toContain('fake-publisher 0.1.0  假发布');

    expect(await run(['station', 'remove', 'fake-publisher', '--project-root', root], new Buffer())).toBe(0);
    expect(fs.existsSync(path.join(root, 'article-to-motion.flow.json'))).toBe(false);
  });
});

describe('third-party tools', () => {
  it('registers only agent-triggered ops and routes them to station_run', async () => {
    const root = await projectWithFake();
    const tools = describeTools('orchestrator', root);
    const names = tools.map((t) => t.name);
    expect(names).toContain('x_fake_publisher_status');
    expect(names.some((n) => n.includes('send'))).toBe(false);
    expect(describeTools('renderer', root).some((t) => t.name.startsWith('x_'))).toBe(false);

    const status = tools.find((t) => t.name === 'x_fake_publisher_status')!;
    expect(status.description).toContain('第三方站「假发布」');
    expect(status.help).toContain('不是 am 自带的工具');
    expect(() => prepareCall(status, { extra: 1 })).toThrow();
    expect(callTarget(status, prepareCall(status, {}))).toEqual({
      name: 'station_run',
      params: { station: 'fake-publisher', op: 'status', params: '{}', project_root: '.' },
    });
  });
});

describe('op worker scope', () => {
  it('refuses ops outside the scope the caller asked for', async () => {
    const { runOpWorker } = await import('./ops/worker');
    const { OpScopeEnv } = await import('@am/engine/opworker');
    const before = process.env[OpScopeEnv];
    process.env[OpScopeEnv] = 'orchestrator';
    try {
      const out = new Buffer();
      expect(await runOpWorker('config_set', '{"key":"SCENE_JOBS","value":"5"}', out, new AbortController().signal, false)).toBe(1);
      expect(out.text).toContain('config_set 不在 orchestrator 能调用的范围里');
      // 编排工具本来就能用的操作不受限（这里在不是项目的目录里跑，成不成功无所谓，只要不是被范围拦下）。
      const ok = new Buffer();
      await runOpWorker('config_get', '{"key":"SCENE_JOBS"}', ok, new AbortController().signal, false);
      expect(ok.text).not.toContain('能调用的范围');
    } finally {
      if (before === undefined) delete process.env[OpScopeEnv];
      else process.env[OpScopeEnv] = before;
    }
  });
});

describe('builtin plugins', () => {
  it('claim only ops that exist, each op by one plugin at most', async () => {
    const flow = await import('@am/engine/flow');
    const names = new Set(allOps().map((o) => o.name));
    const owner = new Map<string, string>();
    for (const plugin of flow.builtinPlugins()) {
      for (const op of plugin.manifest.am_ops) {
        expect(names.has(op), `${plugin.manifest.id} 认领了不存在的操作 ${op}`).toBe(true);
        expect(owner.get(op), `${op} 被两个内置插件认领`).toBeUndefined();
        owner.set(op, plugin.manifest.id);
      }
    }
    // 歌曲讲解认领了全部 song_* 操作，一个都不漏。
    for (const name of names) if (name.startsWith('song_')) expect(owner.get(name), name).toBe('song');
  });

  it('hide the ops of a plugin the project turned off', async () => {
    const root = tempDir();
    expect(describeTools('orchestrator', root).some((t) => t.name === 'song_generate')).toBe(true);
    const out = new Buffer();
    expect(await run(['station', 'builtin', 'song', '--enabled=false', '--project-root', root], out), out.text).toBe(0);
    const names = describeTools('orchestrator', root).map((t) => t.name);
    expect(names.some((n) => n.startsWith('song_'))).toBe(false);
    expect(names).not.toContain('validate_song');
    expect(names).toContain('scene_run');
  });
});
