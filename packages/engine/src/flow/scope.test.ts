import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lookPath } from '../envutil';
import { MissingError } from '../prereq';
import { installStation, parseManifest, runStationOp, writeStationForTest } from './index';
import { managedPython, resolveCommand } from './run';
import { MaxListedPaths, scopeReport, statProject } from './scope';

const fake = path.join(__dirname, 'testdata', 'fake-publisher');
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

function project(): string {
  const root = temp('onset-scope-project-');
  fs.writeFileSync(path.join(root, 'PROMPT-PRODUCTION.md'), '# 制作\n');
  return root;
}

/** 一个用 {node} 跑一段脚本的站：脚本按 stdin 的 params.files 写文件。 */
function writer(): void {
  const dir = writeStationForTest({
    'onset-station.json': JSON.stringify({
      id: 'my-step',
      version: '1.0.0',
      name: '我的一站',
      nodes: [{ id: 'my-node', label: '我的站点', step: 'final', outputs: ['production/mine/out.json'] }],
      produces: [{ prefix: 'production/mine/' }, { prefix: 'exports/', base: '\\.mp4$' }],
      ops: [{ name: 'write', summary: '写文件', command: ['{node}', 'write.cjs'], params: { files: { type: 'strings', description: '要写的文件' } } }],
    }),
    'write.cjs': `const fs = require('node:fs'); const path = require('node:path');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const f of input.params.files ?? []) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
console.log('onset-result {"n":' + (input.params.files ?? []).length + '}');
`,
  });
  temps.push(dir);
  installStation(`link:${dir}`);
}

/** 没有 node 的 PATH：一个空目录。 */
function bareEnv(): Record<string, string | undefined> {
  const empty = temp('onset-empty-path-');
  return { HOME: process.env.HOME, PATH: empty, ONSET_STATIONS_DIR: process.env.ONSET_STATIONS_DIR, XDG_DATA_HOME: temp('onset-data-') };
}

describe('scope check', () => {
  it('stays quiet when the op writes only what it declared', async () => {
    const root = project();
    writer();
    let out = '';
    const r = await runStationOp(root, 'my-step', 'write', { files: ['production/mine/out.json', 'production/mine/a/b.txt', 'exports/film.mp4'] }, (t) => (out += t), undefined, bareEnv());
    expect(r).toEqual({ ok: true, data: { n: 3 }, exit_code: 0 });
    expect(out).not.toContain('没有声明');
  });

  it('lists files written outside the declared scope', async () => {
    const root = project();
    writer();
    let out = '';
    const r = await runStationOp(root, 'my-step', 'write', { files: ['production/mine/ok.json', 'notes/x.md', 'exports/cover.png'] }, (t) => (out += t), undefined, bareEnv());
    expect(r).toEqual({ ok: true, data: { n: 3 }, exit_code: 0, out_of_scope: ['exports/cover.png', 'notes/x.md'], out_of_scope_more: 0 });
    expect(out).toContain('没有声明会写的项目文件（2 个）');
    expect(out).toContain('  notes/x.md\n');
  });

  it('fails the op when it writes onset’s own files, and says the files stay written', async () => {
    const root = project();
    writer();
    let out = '';
    const r = await runStationOp(root, 'my-step', 'write', { files: ['.agents/skills/x/SKILL.md', '.env', 'production/studio/hack.json', 'production/mine/ok.json'] }, (t) => (out += t), undefined, bareEnv());
    expect(r.ok).toBe(false);
    expect(r.reserved).toEqual(['.agents/skills/x/SKILL.md', '.env', 'production/studio/hack.json']);
    expect(r.out_of_scope).toEqual(r.reserved);
    expect(r.error).toContain('写了片场自己的文件');
    expect(out).toContain('没法自动撤销');
    expect(fs.existsSync(path.join(root, '.env'))).toBe(true);
  });

  it('ignores the state the client itself writes while an op runs', () => {
    const root = project();
    const before = statProject(root);
    for (const f of ['production/studio/tasks.json', 'production/studio/sessions/s.events.jsonl', 'production/studio/inbox/t/1.json', 'node_modules/x/y.js', 'scenes/a/attempts/old.log']) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), 'x');
    }
    const m = parseManifest(fs.readFileSync(path.join(fake, 'onset-station.json'), 'utf8'));
    expect(scopeReport(m, before, statProject(root))).toBeNull();
  });

  it('caps the list and counts the rest', () => {
    const root = project();
    const before = statProject(root);
    for (let i = 0; i < MaxListedPaths + 5; i++) {
      fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(root, 'notes', `n${String(i).padStart(2, '0')}.md`), 'x');
    }
    fs.rmSync(path.join(root, 'PROMPT-PRODUCTION.md'));
    const m = parseManifest(fs.readFileSync(path.join(fake, 'onset-station.json'), 'utf8'));
    const r = scopeReport(m, before, statProject(root))!;
    expect(r.out_of_scope).toHaveLength(MaxListedPaths);
    expect(r.out_of_scope_more).toBe(6);
  });

  it('checks ops started by a hook the same way', async () => {
    const root = project();
    installStation(`link:${fake}`);
    let out = '';
    const r = await runStationOp(root, 'fake-publisher', 'on_event', {}, (t) => (out += t), undefined, bareEnv(), { name: 'film.approved', scribble: true });
    expect(r).toMatchObject({ ok: true, out_of_scope: ['notes/hook.txt'], out_of_scope_more: 0 });
    expect(out).toContain('notes/hook.txt');
  });
});

describe('station runtimes', () => {
  it('runs {node} scripts without a node on PATH', async () => {
    const root = project();
    installStation(`link:${fake}`);
    const env = bareEnv();
    expect(() => lookPath('node', env.PATH!)).toThrow();
    let out = '';
    const r = await runStationOp(root, 'fake-publisher', 'send', { platform: 'douyin' }, (t) => (out += t), undefined, env);
    expect(r).toEqual({ ok: true, data: { platform: 'douyin', url: 'https://example.invalid/douyin/1' }, exit_code: 0 });
    expect(out).toContain('已发到 douyin');
  });

  it('resolves the script against the station directory', () => {
    const cmd = resolveCommand(['{node}', 'bin/a.js', '{station_dir}/x'], '/st', process.env, '');
    expect(cmd.file).toBe(process.execPath);
    expect(cmd.args).toEqual([path.join('/st', 'bin/a.js'), '/st/x']);
    expect(() => resolveCommand(['{node}'], '/st', process.env, '')).toThrow('要接着写脚本');
  });

  it('tells the author to use the placeholder when a bare node or python is missing', () => {
    expect(() => resolveCommand(['node', 'a.js'], '/st', process.env, temp('onset-empty-'))).toThrow('改成 "{node}"');
    expect(() => resolveCommand(['python3', 'a.py'], '/st', process.env, temp('onset-empty-'))).toThrow('改成 "{python}"');
  });

  it('uses the Python onset setup installed, and never downloads one', () => {
    const data = temp('onset-data-');
    const env = { XDG_DATA_HOME: data, HOME: data };
    expect(() => managedPython(env)).toThrow(MissingError);
    const base = path.join(data, 'onset', 'python');
    for (const name of ['cpython-3.13.1-macos-aarch64-none', 'cpython-3.12.9-macos-aarch64-none', 'cpython-3.12.12-macos-aarch64-none', 'cpython-3.14.0+freethreaded-macos-aarch64-none']) {
      const bin = process.platform === 'win32' ? path.join(base, name, 'python.exe') : path.join(base, name, 'bin', 'python3');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '');
    }
    expect(managedPython(env)).toContain('cpython-3.12.12-');
    const cmd = resolveCommand(['{python}', '-m', 'mod'], '/st', env, '');
    expect(cmd.args).toEqual(['-m', 'mod']);
  });
});
