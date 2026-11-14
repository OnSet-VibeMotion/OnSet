import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allOps } from './ops/op';
import { Buffer, run, tempDir } from './testutil';
import { callTarget, describeTools, prepareCall } from './toolsmcp';

const fake = path.resolve(__dirname, '..', '..', 'engine', 'src', 'flow', 'testdata', 'fake-publisher');

/** 先看后装：取回假发布插件看清它要什么，再装上（用户级，对所有项目生效）；返回一个空的项目目录。 */
async function projectWithFake(): Promise<string> {
  const root = tempDir();
  const out = new Buffer();
  expect(await run(['station', 'add', `link:${fake}`], out), out.text).toBe(0);
  expect(out.text).toContain('第三方插件 假发布（fake-publisher 0.1.0）');
  expect(out.text).toContain('[按钮] send');
  expect(out.text).toContain('[工具] x_fake_publisher_status');
  // 操作与页面分开说：操作是电脑上的普通程序，页面才受权限约束。
  expect(out.text).toContain('它的操作是在你电脑上运行的程序，能读写你的文件、能联网');
  expect(out.text).toContain('它的页面在沙箱里运行，只能做清单里申请过的事：\n  看项目：');
  expect(out.text).toContain('[自动执行] 你确认一个审核关卡后');
  expect(out.text).toContain('[做法] 新建项目时能选「快剪」');
  expect(out.text).toContain('[实验性] 用到了实验性能力：hooks、schedules、slots、commands、inserts、flow、provides、renderer_skills、film_styles，以后的版本可能调整');
  expect(out.text).toContain('还没有装上');
  // 只看了没装：别的命令看不到它。
  const listed = new Buffer();
  expect(await run(['station', 'list'], listed), listed.text).toBe(0);
  expect(listed.text).toContain('没有装第三方插件');
  const token = /station_install\(\{"staged": "([0-9a-f]+)"\}\)/.exec(out.text)![1];
  const installed = new Buffer();
  expect(await run(['station', 'install', token], installed), installed.text).toBe(0);
  expect(installed.text).toContain('已装上第三方插件 fake-publisher 0.1.0，对所有项目生效');
  return root;
}

describe('station ops', () => {
  it('are not tools the orchestrator can call', () => {
    for (const name of ['station_add', 'station_install', 'station_discard', 'station_remove', 'station_list', 'station_run', 'station_update']) {
      expect(allOps().find((op) => op.name === name)?.scopes, name).toEqual(['cli']);
    }
    // 流程只在新建时定：没有给已有项目换流程的操作。
    expect(allOps().some((op) => op.name === 'station_flow')).toBe(false);
    expect(describeTools('orchestrator').some((t) => t.name.startsWith('station_'))).toBe(false);
  });

  it('installs once for every project, runs, lists and removes a plugin', async () => {
    const root = await projectWithFake();
    const out = new Buffer();
    expect(await run(['station', 'run', 'fake-publisher', 'send', '--params', '{"platform": "douyin"}', '--project-root', root], out), out.text).toBe(0);
    expect(out.text).toContain('已发到 douyin');
    expect(fs.existsSync(path.join(root, 'production', 'publish', 'receipts.json'))).toBe(true);

    const bad = new Buffer();
    expect(await run(['station', 'run', 'fake-publisher', 'send', '--params', '{}', '--project-root', root], bad)).toBe(1);
    expect(bad.text).toContain('缺参数 platform');

    // 写了清单没声明的文件：照实列在输出末尾，操作照样算成功。
    const stray = new Buffer();
    expect(await run(['station', 'run', 'fake-publisher', 'scribble', '--project-root', root], stray), stray.text).toBe(0);
    expect(stray.text).toContain('没有声明会写的项目文件（1 个）：\n  notes/scribble.txt');

    // 另一个项目不用再装就能用。
    const other = tempDir();
    const again = new Buffer();
    expect(await run(['station', 'run', 'fake-publisher', 'send', '--params', '{"platform": "bilibili"}', '--project-root', other], again), again.text).toBe(0);
    expect(fs.existsSync(path.join(other, 'production', 'publish', 'receipts.json'))).toBe(true);

    const list = new Buffer();
    expect(await run(['station', 'list'], list), list.text).toBe(0);
    expect(list.text).toContain('fake-publisher 0.1.0  假发布');

    const update = new Buffer();
    expect(await run(['station', 'update', 'fake-publisher'], update), update.text).toBe(1);
    expect(update.text).toContain('来自本机目录');
    expect(update.text).toContain('不需要更新');

    // 取消：暂存清掉，已装的不变。
    const staged = new Buffer();
    expect(await run(['station', 'add', `link:${fake}`], staged), staged.text).toBe(0);
    const token = /station_discard\(\{"staged": "([0-9a-f]+)"\}\)/.exec(staged.text)![1];
    expect(await run(['station', 'discard', token], new Buffer())).toBe(0);
    expect(await run(['station', 'install', token], new Buffer())).toBe(1);

    expect(await run(['station', 'remove', 'fake-publisher'], new Buffer())).toBe(0);
    // 项目里不留插件的记录。
    expect(fs.existsSync(path.join(root, 'onset.flow.json'))).toBe(false);
    const gone = new Buffer();
    expect(await run(['station', 'run', 'fake-publisher', 'status', '--project-root', other], gone)).toBe(1);
    expect(gone.text).toContain('没有装插件 fake-publisher');
  });
});

describe('third-party tools', () => {
  it('registers only agent-triggered ops and routes them to station_run', async () => {
    const root = await projectWithFake();
    const tools = describeTools('orchestrator', root);
    // 另一个项目同样有这些工具。
    expect(describeTools('orchestrator', tempDir()).some((t) => t.name === 'x_fake_publisher_status')).toBe(true);
    const names = tools.map((t) => t.name);
    expect(names).toContain('x_fake_publisher_status');
    expect(names.some((n) => n.includes('send'))).toBe(false);
    expect(describeTools('renderer', root).some((t) => t.name.startsWith('x_'))).toBe(false);

    const status = tools.find((t) => t.name === 'x_fake_publisher_status')!;
    expect(status.description).toContain('第三方站「假发布」');
    expect(status.help).toContain('不是 onset 自带的工具');
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
    const { OpScopeEnv } = await import('@onset/engine/opworker');
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
  it('register ops that land in the op table, each op by one plugin', async () => {
    const registry = await import('@onset/engine/plugin');
    const names = new Set(allOps().map((o) => o.name));
    const owner = new Map<string, string>();
    // 内置插件在 apply 里登记的操作进了操作表。
    for (const { owner: id, value } of registry.pluginOps()) {
      expect(names.has(value.name), `${id} 登记的操作 ${value.name} 不在操作表里`).toBe(true);
      expect(owner.get(value.name), `${value.name} 被两个内置插件认领`).toBeUndefined();
      owner.set(value.name, id);
    }
    // 歌曲讲解认领了全部 song_* 操作，多角色对话认领了全部 cast_* / dialogue_* 操作，一个都不漏。
    for (const name of names) if (name.startsWith('song_')) expect(owner.get(name), name).toBe('song');
    for (const name of names) if (name.startsWith('cast_') || name.startsWith('dialogue_')) expect(owner.get(name), name).toBe('cast');
    expect(owner.get('validate_cast')).toBe('cast');
    expect(owner.get('validate_publish')).toBe('publishing');
  });

  it('are always on: their ops are listed in every project and there is no switch', () => {
    const root = tempDir();
    // 锁文件里的 disabled、stations 直接忽略。
    fs.writeFileSync(path.join(root, 'onset.flow.json'), JSON.stringify({ version: 1, stations: [], disabled: ['song', 'publishing'] }));
    const names = describeTools('orchestrator', root).map((t) => t.name);
    expect(names).toContain('song_generate');
    expect(names).toContain('validate_publish');
  });

});
