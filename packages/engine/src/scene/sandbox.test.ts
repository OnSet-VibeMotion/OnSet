import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rendererInvocation } from '../tools';
import { sandboxAvailable, sandboxed, sandboxProfile, SandboxExec } from './sandbox';

/** 假的家目录：本项目、另一个项目、~/.ssh 与 onset 的凭据目录。 */
function home(): { home: string; project: string; scene: string; other: string } {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-sandbox-')));
  const project = path.join(h, 'work', 'film');
  const scene = path.join(project, 'scenes', 'scene-001');
  fs.mkdirSync(scene, { recursive: true });
  fs.mkdirSync(path.join(project, '.agents', 'skills', 'scene-kit'), { recursive: true });
  fs.writeFileSync(path.join(project, '.agents', 'skills', 'scene-kit', 'SKILL.md'), 'skill\n');
  fs.writeFileSync(path.join(project, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(project, '.env.local'), 'SECRET=2\n');
  const other = path.join(h, 'work', 'other');
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'notes.md'), 'private\n');
  fs.mkdirSync(path.join(h, '.ssh'));
  fs.writeFileSync(path.join(h, '.ssh', 'id'), 'key\n');
  fs.mkdirSync(path.join(h, '.local', 'share', 'onset', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(h, '.local', 'share', 'onset', 'agent', 'auth.json'), '{}\n');
  return { home: h, project, scene, other };
}

describe('renderer sandbox', () => {
  it('writes the boundary as directories', () => {
    const h = home();
    const profile = sandboxProfile({ sceneDir: h.scene, projectRoot: h.project, env: { HOME: h.home, PATH: '/usr/bin' }, toolStateDirs: [path.join(h.home, '.qoder-cn')], readDirs: [] });
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain(`(subpath "${h.scene}")`);
    expect(profile).toContain(`(deny file-read-data (subpath "${h.home}"))`);
    // 凭据的收回写成 file-read-data：写成 file-read* 会被前面放开项目目录的 allow 压过（实测）。
    expect(profile).toMatch(/\(deny file-read-data file-write\*\n {2}\(regex #"\/\\\.env\$"\)/);
    expect(profile).toContain(`(subpath "${path.join(h.home, '.local', 'share', 'onset', 'agent')}")`);
  });

  it('only exists on macOS', () => {
    expect(sandboxAvailable('linux')).toBe(false);
    expect(sandboxAvailable('win32')).toBe(false);
  });

  // 沙箱管住了目录，渲染器里不再按命令白名单拦（拦了也没人能批准）。
  it('a sandboxed qoder renderer does not filter commands itself', () => {
    const argv = rendererInvocation('qoder', 'prompt', false, { commands: ['ls'], readDirs: ['/p/.agents/skills'], osSandbox: true });
    expect(argv).toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('accept_edits');
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(sandboxed(['/bin/qoderclicn', '-p', 'x'], '(version 1)')).toEqual([SandboxExec, '-p', '(version 1)', '/bin/qoderclicn', '-p', 'x']);
  });

  // 真跑一遍 sandbox-exec（只在 macOS 上）：镜头目录能写，.env、别的项目、~/.ssh、凭据目录读不到，技能能读不能改。
  it.runIf(sandboxAvailable())('really confines a process to its directories', () => {
    const h = home();
    const profile = sandboxProfile({ sceneDir: h.scene, projectRoot: h.project, env: { HOME: h.home, PATH: '/usr/bin:/bin' }, toolStateDirs: [], readDirs: [] });
    const sh = (script: string) => spawnSync(SandboxExec, ['-p', profile, '/bin/sh', '-c', script], { cwd: h.scene, encoding: 'utf8' }).status === 0;
    expect(sh('echo 1 > made.txt')).toBe(true);
    expect(sh('cd .. && ls')).toBe(true);
    expect(sh('cat ../../.agents/skills/scene-kit/SKILL.md')).toBe(true);
    expect(sh('cat ../../.env')).toBe(false);
    expect(sh('cat ../../.env.local')).toBe(false);
    expect(sh(`cat "${path.join(h.other, 'notes.md')}"`)).toBe(false);
    expect(sh(`ls "${path.join(h.home, '.ssh')}"`)).toBe(false);
    expect(sh(`cat "${path.join(h.home, '.local', 'share', 'onset', 'agent', 'auth.json')}"`)).toBe(false);
    // 改技能、写项目根要放在真实家目录里才查得了：这里的假家目录在临时目录下，而临时目录本身可写。
    // .env 不论在哪都由最后一条规则收回，照样写不了。
    expect(sh('echo x >> ../../.env')).toBe(false);
    expect(fs.readFileSync(path.join(h.project, '.env'), 'utf8')).toBe('SECRET=1\n');
  });
});
