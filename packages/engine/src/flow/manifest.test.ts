import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetTreeDigestCache } from './digest';
import {
  compareSemver,
  experimentalFields,
  installStation,
  loadStations,
  readInstalled,
  stationsDir,
  ManifestFields,
  manifestFieldNames,
  nodeFieldNames,
  parseManifest,
  treeDigest,
  updateStation,
  writeStationForTest,
} from './index';

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

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'my-step',
    version: '1.0.0',
    name: '我的一站',
    nodes: [{ id: 'my-node', label: '我的站点', step: 'final', outputs: ['production/mine/out.json'] }],
    ...over,
  });

function gitRepo(): { repo: string; git: (...args: string[]) => void } {
  const repo = temp('am-flow-repo-');
  fs.cpSync(fake, repo, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'v1');
  return { repo, git };
}

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('manifest version', () => {
  it('reads a manifest without manifest_version as version 1', () => {
    const m = parseManifest(manifest());
    expect(m.manifest_version).toBe(1);
    expect(m.requires).toEqual({ am: '' });
    expect(parseManifest(manifest({ manifest_version: 1 })).manifest_version).toBe(1);
  });

  it('asks for a newer ArticleToMotion when the format is newer, even with fields it does not know', () => {
    expect(() => parseManifest(manifest({ manifest_version: 2, brand_new: true }))).toThrow(/要更新的 ArticleToMotion/);
    expect(() => parseManifest(manifest({ manifest_version: 2, requires: { am: '9.0.0', gpu: true } }))).toThrow(/要更新的 ArticleToMotion/);
    expect(() => parseManifest(manifest({ manifest_version: 0 }))).toThrow(/manifest_version/);
    expect(() => parseManifest(manifest({ manifest_version: '1' }))).toThrow(/manifest_version/);
  });

  it('checks requires.am against the am version', () => {
    const m = manifest({ requires: { am: '0.6.0' } });
    expect(() => parseManifest(m, { amVersion: '0.5.9' })).toThrow(/要 ArticleToMotion 0\.6\.0 或更新的版本，现在是 0\.5\.9/);
    expect(() => parseManifest(m, { amVersion: '0.6.0-rc.1' })).toThrow(/要更新|请先更新/);
    expect(parseManifest(m, { amVersion: '0.6.0' }).requires.am).toBe('0.6.0');
    expect(parseManifest(m, { amVersion: '1.0.0' }).requires.am).toBe('0.6.0');
    // 本地构建（dev）就是最新的代码，不查。
    expect(parseManifest(m, { amVersion: 'dev' }).requires.am).toBe('0.6.0');
    expect(() => parseManifest(manifest({ requires: { am: '>=0.6' } }))).toThrow(/requires\.am/);
    expect(() => parseManifest(manifest({ requires: { node: '22' } }))).toThrow(/不认识的字段：node/);
  });

  it('compares versions like semver', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('v2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10')).toBeLessThan(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareSemver('1.0.0+build.5', '1.0.0')).toBe(0);
  });
});

describe('field tiers', () => {
  it('has one row per field and the agreed tiers', () => {
    const names = manifestFieldNames();
    expect(new Set(names).size).toBe(names.length);
    const tier = (t: string) => ManifestFields.filter((f) => f.tier === t && !f.parent).map((f) => f.name).sort();
    expect(tier('stable')).toEqual(['after', 'description', 'id', 'manifest_version', 'name', 'nodes', 'ops', 'pages', 'permissions', 'produces', 'prompt', 'replaces', 'requires', 'settings', 'version']);
    expect(tier('experimental')).toEqual(['commands', 'film_styles', 'flow', 'hooks', 'inserts', 'provides', 'renderer_skills', 'schedules', 'slots']);
    for (const f of ManifestFields) expect(f.tier === 'experimental').toBe(f.used !== undefined);
    // 站点里的字段：基本的几项稳定，按文件内容定状态与「接下来」是实验性的。
    const nodeTier = (t: string) => ManifestFields.filter((f) => f.tier === t && f.parent === 'nodes').map((f) => f.name).sort();
    expect(nodeFieldNames()).toEqual(['id', 'label', 'step', 'gate', 'page', 'outputs', 'stale_after', 'gate_files', 'state', 'guide']);
    expect(nodeTier('experimental')).toEqual(['nodes.guide', 'nodes.state']);
  });

  it('reports the experimental fields a manifest uses', () => {
    expect(experimentalFields(parseManifest(manifest()))).toEqual([]);
    // 写了空数组不算用到。
    expect(experimentalFields(parseManifest(manifest({ hooks: [], slots: [] })))).toEqual([]);
    const m = parseManifest(fs.readFileSync(path.join(fake, 'am-station.json'), 'utf8'));
    expect(experimentalFields(m)).toEqual(['hooks', 'schedules', 'slots', 'commands', 'inserts', 'flow', 'provides', 'renderer_skills', 'film_styles']);
  });
});

describe('digest cache', () => {
  it('still refuses a station whose content changed after it was loaded', () => {
    if (!hasGit) return;
    const { repo } = gitRepo();
    const env = { ...process.env, AM_STATIONS_DIR: temp('am-stations-') };
    const got = installStation(`file://${repo}#main`, env);
    expect(loadStations(env).problems).toEqual([]);
    expect(loadStations(env).problems).toEqual([]);

    // 同样大小的改动，还把 mtime 改回原样：ctime 照样变，仍然重算。
    const file = path.join(got.dir, 'prompt.md');
    const before = fs.statSync(file);
    const body = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, body.replace(/.$/su, body.endsWith('X') ? 'Y' : 'X'));
    fs.utimesSync(file, before.atime, before.mtime);
    expect(fs.statSync(file).size).toBe(before.size);
    const after = loadStations(env);
    expect(after.stations.filter((s) => !s.builtin)).toEqual([]);
    expect(after.problems[0].message).toContain('内容和添加时不一样了');
  });

  it('recomputes when a file is added, and agrees with a fresh computation', () => {
    const dir = writeStationForTest({ 'am-station.json': manifest(), 'a.txt': 'a' });
    temps.push(dir);
    const first = treeDigest(dir);
    expect(treeDigest(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
    const second = treeDigest(dir);
    expect(second).not.toBe(first);
    resetTreeDigestCache();
    expect(treeDigest(dir)).toBe(second);
    fs.rmSync(path.join(dir, 'b.txt'));
    expect(treeDigest(dir)).toBe(first);
  });
});

describe('station update', () => {
  it('fetches the recorded source again and reports what changed', () => {
    if (!hasGit) return;
    const { repo, git } = gitRepo();
    const env = { ...process.env, AM_STATIONS_DIR: temp('am-stations-') };
    const got = installStation(`file://${repo}#main`, env);

    const same = updateStation('fake-publisher', env);
    expect(same.changed).toBe(false);
    expect(same.new_permissions).toEqual([]);
    expect(same.new_experimental).toEqual([]);

    const file = path.join(repo, 'am-station.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw.version = '0.2.0';
    (raw.permissions as Record<string, unknown>).network = ['https://api.example.com'];
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    git('commit', '-qam', 'v2');

    const up = updateStation('fake-publisher', env);
    expect(up.changed).toBe(true);
    expect(up.old_version).toBe('0.1.0');
    expect(up.new_version).toBe('0.2.0');
    expect(up.after.commit).not.toBe(got.entry.commit);
    expect(up.new_permissions).toEqual(['连网：https://api.example.com']);
    expect(up.experimental.length).toBeGreaterThan(0);
    expect(readInstalled(stationsDir(env)).plugins[0]).toEqual(up.after);
    expect(loadStations(env).problems).toEqual([]);
  });

  it('leaves a linked station alone', () => {
    installStation(`link:${fake}`);
    const file = path.join(stationsDir(process.env), 'installed.json');
    const before = fs.readFileSync(file, 'utf8');
    const up = updateStation('fake-publisher');
    expect(up.linked).toBe(true);
    expect(up.changed).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(() => updateStation('nope')).toThrow(/没有装插件 nope/);
  });
});

describe('authoring doc', () => {
  it('lists exactly the top-level fields the parser accepts, with their tiers', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'plugin-authoring.md'), 'utf8');
    // 「顶层字段」表：每行 | `字段` | 分级 | …
    // 到下一个小节（站点、操作……的字段表）为止。
    const section = doc.slice(doc.indexOf('## 顶层字段'), doc.indexOf('\n### ', doc.indexOf('## 顶层字段') + 1));
    const rows = [...section.matchAll(/^\| `([a-z_]+)` \| (稳定|实验性) \|/gm)].map((m) => [m[1], m[2]]);
    const tierName = { stable: '稳定', experimental: '实验性' } as const;
    expect(rows.map((r) => r[0]).sort()).toEqual(manifestFieldNames().sort());
    for (const [name, tier] of rows) expect(tier).toBe(tierName[ManifestFields.find((f) => f.name === name)!.tier]);
  });

  it('lists exactly the node fields the parser accepts, with their tiers', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'docs', 'plugin-authoring.md'), 'utf8');
    const start = doc.indexOf('### 站点（`nodes`）');
    const section = doc.slice(start, doc.indexOf('\n### ', start + 1));
    const rows = [...section.matchAll(/^\| `([a-z_]+)` \| (稳定|实验性) \|/gm)].map((m) => [m[1], m[2]]);
    const tierName = { stable: '稳定', experimental: '实验性' } as const;
    expect(rows.map((r) => r[0])).toEqual(nodeFieldNames());
    for (const [name, tier] of rows) expect(tier).toBe(tierName[ManifestFields.find((f) => f.name === `nodes.${name}`)!.tier]);
  });
});
