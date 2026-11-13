import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Progress } from '../hyperframes';
import { installSkills, skillsStatus, type SkillsStatus } from './skills';
import { Server } from './studio';
import { setEnv, sleep, studioRequest, tempDir } from './testsupport';

describe('skills', () => {
  // 新建项目与 am init 同一条路——卡点、多角色对话写出各自的模式文件，并在后台装官方技能；装失败的项目可以补装。
  it('create honours modes and installs skills', async () => {
    const home = tempDir();
    setEnv('HOME', home);
    const s = new Server({ configPath: path.join(tempDir(), 'projects.json') });
    const calls: string[] = [];
    let fail = true;
    s.skills.install = async (_signal, dir, report) => {
      const failing = fail;
      report({ stage: '下载技能仓库', percent: 40 });
      calls.push(dir);
      if (failing) throw new Error('没有网络');
    };
    const wait = async (dir: string): Promise<SkillsStatus> => {
      let deadline = Date.now() + 5000;
      while (calls.length === 0 && Date.now() < deadline) await sleep(5);
      const got = calls.shift();
      expect(got, '没有开始装技能').toBe(dir);
      deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = skillsStatus(s, dir);
        if (!status.installing) return status;
        await sleep(10);
      }
      throw new Error('安装没有结束');
    };

    let { status, body } = await studioRequest(s, 'POST', '/api/projects/create', JSON.stringify({ parent: home, name: 'beat-film', delivery: 'beat' }));
    expect(status, JSON.stringify(body)).toBe(201);
    const beatDir = body.project.path as string;
    expect(fs.existsSync(path.join(beatDir, 'beat.yaml')), '卡点项目要有 beat.yaml').toBe(true);
    let got = await wait(beatDir);
    expect(got.error, '装失败要记下原因').toBeTruthy();
    expect(got.installed).toBe(false);

    // 补装成功。
    fail = false;
    ({ status } = await studioRequest(s, 'POST', '/api/skills/install'));
    expect(status).toBe(202);
    got = await wait(beatDir);
    expect(got.error, '补装后不该再有错误').toBeUndefined();

    ({ status, body } = await studioRequest(s, 'POST', '/api/projects/create', JSON.stringify({ parent: home, name: 'cast-film', narration: 'cast' })));
    expect(status).toBe(201);
    const castDir = body.project.path as string;
    for (const name of ['cast.yaml', 'cast']) expect(fs.existsSync(path.join(castDir, name)), `多角色对话项目缺 ${name}`).toBe(true);
    await wait(castDir);
    ({ status, body } = await studioRequest(s, 'GET', '/api/skills'));
    expect(status).toBe(200);
    expect(body.status.installed, '没有来源记录就不算装过').toBe(false);
  });

  // 安装进行中，状态里带着当前一步与整体百分比；装完就不再有进度。
  it('skills status carries progress', async () => {
    const s = new Server({ configPath: path.join(tempDir(), 'projects.json') });
    let reported!: () => void;
    const reportedP = new Promise<void>((resolve) => (reported = resolve));
    let release!: () => void;
    const releaseP = new Promise<void>((resolve) => (release = resolve));
    s.skills.install = async (_signal, _dir, report: (p: Progress) => void) => {
      report({ stage: '下载技能仓库', percent: 35 });
      reported();
      await releaseP;
    };
    const dir = tempDir();
    installSkills(s, dir);
    await reportedP;
    let status = skillsStatus(s, dir);
    expect(status.installing).toBe(true);
    expect(status.progress).toEqual({ stage: '下载技能仓库', percent: 35 });
    release();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && skillsStatus(s, dir).installing) await sleep(10);
    status = skillsStatus(s, dir);
    expect(status.installing).toBe(false);
    expect(status.progress, '装完不该还有进度').toBeUndefined();
  });
});
