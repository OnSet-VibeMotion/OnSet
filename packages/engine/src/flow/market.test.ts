import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchArchive, githubArchiveURL, installStaged, readInstalled, stageStation, stageUpdate, stationsDir, StagingDir, treeDigest, withGitProxy } from './index';
import type { InstalledEntry } from './installed';
import * as market from './market';

const fake = path.join(__dirname, 'testdata', 'fake-publisher');
const temps: string[] = [];
afterEach(() => {
  market.useHttpFetch(null);
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const hasGit = spawnSync('git', ['--version']).status === 0;

const c1 = 'a'.repeat(40);
const c2 = 'b'.repeat(40);
const c3 = 'c'.repeat(40);

const plugin = (over: Record<string, unknown> = {}) => ({
  id: 'onset-publisher',
  name: '自动发布',
  description: '把成片发出去',
  author: { name: '某人', url: 'https://example.com' },
  source: 'github:someone/onset-publisher',
  icon: 'icons/onset-publisher.png',
  versions: [
    { version: '0.1.0', ref: 'v0.1.0', commit: c1, requires_onset: '1.0.0' },
    { version: '0.2.0', ref: 'v0.2.0', commit: c2, requires_onset: '2.0.0' },
    { version: '0.3.0', ref: 'v0.3.0', commit: c3, requires_onset: '9.0.0' },
  ],
  ...over,
});
const catalogText = (plugins: unknown[] = [plugin()], over: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, plugins, ...over });

const entry = (over: Partial<InstalledEntry> = {}): InstalledEntry => ({
  id: 'onset-publisher',
  version: '0.1.0',
  source: `github:someone/onset-publisher#${c1}`,
  commit: c1,
  digest: 'x',
  role: { flow: false, replaces: '', after: '', nodes: false },
  ...over,
});

describe('parseCatalog', () => {
  it('reads a well-formed catalog', () => {
    const c = market.parseCatalog(catalogText());
    expect(c.plugins[0]).toMatchObject({ id: 'onset-publisher', tags: [], license: '', screenshots: [], icon: 'icons/onset-publisher.png' });
    expect(c.plugins[0].versions).toHaveLength(3);
  });

  it('asks for a newer OnSet when the format is newer', () => {
    expect(() => market.parseCatalog(catalogText([], { schema: 2, brand_new: 1 }))).toThrow(/要更新的片场/);
  });

  it.each([
    ['bad id', plugin({ id: 'Bad_ID' }), /id 只能用/],
    ['ref in source', plugin({ source: 'github:someone/x#main' }), /不带 #ref/],
    ['link source', plugin({ source: 'link:/tmp/x' }), /source 要是/],
    ['no versions', plugin({ versions: [] }), /至少写一版/],
    ['short commit', plugin({ versions: [{ version: '1.0.0', commit: 'abc' }] }), /40 位/],
    ['bad version', plugin({ versions: [{ version: 'latest', commit: c1 }] }), /x\.y\.z/],
    ['escaping icon', plugin({ icon: '../secret.png' }), /相对路径或 https/],
    ['http homepage', plugin({ homepage: 'http://example.com' }), /homepage 要是 https/],
  ])('rejects %s', (_name, p, err) => {
    expect(() => market.parseCatalog(catalogText([p]))).toThrow(err);
  });

  it('ignores fields it does not know, so a newer catalog still reads on an older client', () => {
    const c = market.parseCatalog(catalogText([plugin({ extra: 1, versions: [{ version: '1.0.0', commit: c1, signature: 'x' }] })], { mirrors: [] }));
    expect(c.plugins[0].versions[0].version).toBe('1.0.0');
  });

  it('rejects duplicate ids and versions', () => {
    expect(() => market.parseCatalog(catalogText([plugin(), plugin()]))).toThrow(/出现了两次/);
    expect(() => market.parseCatalog(catalogText([plugin({ versions: [{ version: '1.0.0', commit: c1 }, { version: '1.0.0', commit: c2 }] })]))).toThrow(/出现了两次/);
  });
});

describe('versions and states', () => {
  const p = market.parseCatalog(catalogText()).plugins[0];

  it('picks the newest version this OnSet can run', () => {
    expect(market.pickVersion(p, '2.5.0')?.version).toBe('0.2.0');
    expect(market.pickVersion(p, '0.9.0')).toBeNull();
    // 开发版不查最低版本。
    expect(market.pickVersion(p, 'dev')?.version).toBe('0.3.0');
    expect(market.versionSource(p, p.versions[1])).toBe(`github:someone/onset-publisher#${c2}`);
  });

  it('compares with what is installed', () => {
    expect(market.marketItem(p, undefined, '2.0.0').state).toBe('available');
    expect(market.marketItem(p, undefined, '0.1.0')).toMatchObject({ state: 'incompatible', requires_onset: '9.0.0', latest: null });
    expect(market.marketItem(p, entry(), '2.0.0')).toMatchObject({ state: 'update', latest_source: `github:someone/onset-publisher#${c2}`, installed_version: '0.1.0' });
    expect(market.marketItem(p, entry({ commit: c2, version: '0.2.0' }), '2.0.0').state).toBe('installed');
    // 同一个仓库的不同写法算同一个来源。
    expect(market.marketItem(p, entry({ source: 'https://github.com/SomeOne/onset-publisher.git#main' }), '2.0.0').state).toBe('update');
    expect(market.marketItem(p, entry({ source: 'github:other/onset-publisher#main' }), '2.0.0').state).toBe('other_source');
    // 装着的比目录里的新：不提示更新。
    expect(market.marketItem(p, entry({ commit: 'd'.repeat(40), version: '0.5.0' }), '2.0.0').state).toBe('installed');
    expect(market.marketItem(p, undefined, '2.0.0', new Set(['onset-publisher'])).state).toBe('builtin');
  });

  it('only accepts a commit the catalog lists', () => {
    const c = market.parseCatalog(catalogText());
    expect(market.catalogVersion(c, 'onset-publisher', c2).version.version).toBe('0.2.0');
    expect(() => market.catalogVersion(c, 'onset-publisher', 'e'.repeat(40))).toThrow(/没有 commit/);
    expect(() => market.catalogVersion(c, 'nope', c1)).toThrow(/没有 nope/);
  });
});

describe('fetching the catalog', () => {
  it('falls back to the next address and caches what it got', async () => {
    const env = { ONSET_STATIONS_DIR: temp('onset-stations-') };
    const seen: string[] = [];
    market.useHttpFetch(async (url) => {
      seen.push(url);
      if (url.includes('first')) throw new Error('ECONNRESET');
      return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(catalogText()) };
    });
    const got = await market.refreshCatalog(env, ['https://first.example/index.json', 'https://second.example/index.json']);
    expect(seen).toEqual(['https://first.example/index.json', 'https://second.example/index.json']);
    expect(got.url).toBe('https://second.example/index.json');
    expect(market.readCachedCatalog(env)?.catalog.plugins[0].id).toBe('onset-publisher');
  });

  it('lists every address that failed and keeps the old cache', async () => {
    const env = { ONSET_STATIONS_DIR: temp('onset-stations-') };
    market.useHttpFetch(async () => ({ status: 200, contentType: '', body: new TextEncoder().encode(catalogText()) }));
    await market.refreshCatalog(env, ['https://ok.example/index.json']);
    market.useHttpFetch(async (url) => {
      if (url.includes('a.example')) return { status: 404, contentType: '', body: new Uint8Array() };
      return { status: 200, contentType: '', body: new TextEncoder().encode('{"schema": 1, "plugins": "x"}') };
    });
    await expect(market.refreshCatalog(env, ['https://a.example/index.json', 'https://b.example/index.json'])).rejects.toThrow(/HTTP 404.*plugins 要是数组/);
    expect(market.readCachedCatalog(env)?.url).toBe('https://ok.example/index.json');
  });

  it('reads a local catalog from file://', async () => {
    const dir = temp('onset-catalog-');
    fs.writeFileSync(path.join(dir, 'index.json'), catalogText());
    const env = { ONSET_STATIONS_DIR: temp('onset-stations-') };
    const got = await market.refreshCatalog(env, [`file://${dir}/index.json`]);
    expect(got.catalog.plugins).toHaveLength(1);
    expect(market.assetURL(got.url, 'icons/a.png')).toBe(`file://${dir}/icons/a.png`);
  });

  it('only takes real images, by their bytes', async () => {
    const env = { ONSET_STATIONS_DIR: temp('onset-stations-') };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    let calls = 0;
    market.useHttpFetch(async (url) => {
      calls++;
      return { status: 200, contentType: 'image/png', body: url.endsWith('.svg') ? new TextEncoder().encode('<svg onload="x()"/>') : png };
    });
    expect((await market.marketImage(env, 'https://cdn.example/i.png')).type).toBe('image/png');
    // 第二次从缓存读。
    expect((await market.marketImage(env, 'https://cdn.example/i.png')).type).toBe('image/png');
    expect(calls).toBe(1);
    await expect(market.marketImage(env, 'https://cdn.example/i.svg')).rejects.toThrow(/不是 PNG/);
  });
});

function gitRepo(): { repo: string; commit: (msg: string) => string; edit: (fn: (m: Record<string, unknown>) => void) => void } {
  const repo = temp('onset-market-repo-');
  fs.cpSync(fake, repo, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  const commit = (msg: string) => {
    git('add', '.');
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const edit = (fn: (m: Record<string, unknown>) => void) => {
    const file = path.join(repo, 'onset-station.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fn(m);
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
  };
  return { repo, commit, edit };
}

describe('installing from the catalog goes through staging', () => {
  it('stages the listed commit and refuses a different id or commit', () => {
    if (!hasGit) return;
    const { repo, commit } = gitRepo();
    const v1 = commit('v1');
    const env = { ...process.env, ONSET_STATIONS_DIR: temp('onset-stations-') };
    const staging = () => fs.readdirSync(path.join(stationsDir(env), StagingDir)).filter((n) => /^[0-9a-f]{16}$/.test(n));
    expect(() => stageStation(`file://${repo}#${v1}`, env, () => {}, { id: 'something-else' })).toThrow(/不是插件中心列的 something-else/);
    expect(() => stageStation(`file://${repo}#main`, env, () => {}, { commit: 'e'.repeat(40) })).toThrow(/不是插件中心列的/);
    // 对不上的暂存已清掉。
    expect(staging()).toEqual([]);
    const ok = stageStation(`file://${repo}#${v1}`, env, () => {}, { id: 'fake-publisher', commit: v1 });
    // 只是暂存，还没装。
    expect(readInstalled(stationsDir(env)).plugins).toEqual([]);
    installStaged(ok.token, env);
    expect(readInstalled(stationsDir(env)).plugins[0]).toMatchObject({ id: 'fake-publisher', commit: v1, source: `file://${repo}#${v1}` });
  });

  it('updates to the commit the catalog lists, from the same repository only', () => {
    if (!hasGit) return;
    const { repo, commit, edit } = gitRepo();
    const v1 = commit('v1');
    const env = { ...process.env, ONSET_STATIONS_DIR: temp('onset-stations-') };
    installStaged(stageStation(`file://${repo}#${v1}`, env).token, env);
    edit((m) => (m.version = '0.2.0'));
    const v2 = commit('v2');
    // 钉在 commit 上的来源，照旧按已装的来源取不到新版本。
    expect(stageUpdate('fake-publisher', env).preview.update?.changed).toBe(false);
    const other = gitRepo();
    expect(() => stageUpdate('fake-publisher', env, () => {}, { source: `file://${other.repo}#main` })).toThrow(/不能换成/);
    expect(() => stageUpdate('fake-publisher', env, () => {}, { source: `file://${repo}#${v2}`, expect: { commit: v1 } })).toThrow(/不是插件中心列的/);
    const up = stageUpdate('fake-publisher', env, () => {}, { source: `file://${repo}#${v2}`, expect: { commit: v2 } });
    expect(up.preview.update).toMatchObject({ changed: true, old_version: '0.1.0', new_version: '0.2.0', commit_after: v2 });
    expect(readInstalled(stationsDir(env)).plugins[0].commit).toBe(v1);
    installStaged(up.token, env);
    expect(readInstalled(stationsDir(env)).plugins[0]).toMatchObject({ version: '0.2.0', commit: v2, source: `file://${repo}#${v2}` });
  });
});

describe('withGitProxy', () => {
  it('sets the proxy for git only and keeps earlier parameters', () => {
    expect(withGitProxy({ A: '1' }, '')).toEqual({ A: '1' });
    expect(withGitProxy({}, 'http://127.0.0.1:7890').GIT_CONFIG_PARAMETERS).toBe("'http.proxy'='http://127.0.0.1:7890'");
    expect(withGitProxy({ GIT_CONFIG_PARAMETERS: "'a.b'='c'" }, 'socks5://h:1').GIT_CONFIG_PARAMETERS).toBe("'a.b'='c' 'http.proxy'='socks5://h:1'");
    expect(withGitProxy({}, 'http://h:1').HTTPS_PROXY).toBeUndefined();
    expect(() => withGitProxy({}, "http://h'x")).toThrow(/引号/);
  });
});

describe('yanked and deprecated', () => {
  const p = (over: Record<string, unknown> = {}) =>
    market.parseCatalog(
      catalogText([
        plugin({
          versions: [
            { version: '0.1.0', commit: c1 },
            { version: '0.2.0', commit: c2, yanked: '会删掉项目里的封面' },
          ],
          ...over,
        }),
      ]),
    ).plugins[0];

  it('never offers a yanked version and tells whoever has it', () => {
    expect(market.pickVersion(p(), '2.0.0')?.version).toBe('0.1.0');
    // 装着撤回的那一版：给换回能用的一版，哪怕版本号更低。
    expect(market.marketItem(p(), entry({ commit: c2, version: '0.2.0' }), '2.0.0')).toMatchObject({ state: 'update', installed_yanked: '会删掉项目里的封面', latest: { version: '0.1.0' } });
    // 从别的仓库装的同名插件不受这个仓库的撤回影响。
    expect(market.marketItem(p(), entry({ commit: c2, source: `github:other/onset-publisher#${c2}` }), '2.0.0').installed_yanked).toBe('');
    const all = market.parseCatalog(catalogText([plugin({ versions: [{ version: '0.1.0', commit: c1, yanked: '坏了' }] })])).plugins[0];
    expect(market.marketItem(all, undefined, '2.0.0').state).toBe('unavailable');
  });

  it('stops offering a deprecated plugin but keeps it working for those who have it', () => {
    const d = p({ deprecated: '作者改做 onset-publisher-2 了' });
    expect(market.marketItem(d, undefined, '2.0.0')).toMatchObject({ state: 'unavailable', latest: null });
    expect(market.marketItem(d, entry(), '2.0.0').state).toBe('installed');
  });

  it('reads maintainers and checks the digest format', () => {
    expect(p({ maintainers: ['someone'] }).maintainers).toEqual(['someone']);
    expect(() => market.parseCatalog(catalogText([plugin({ versions: [{ version: '1.0.0', commit: c1, digest: 'md5:x' }] })]))).toThrow(/digest/);
  });
});

describe('installing without git', () => {
  const hasTar = spawnSync('tar', ['--version']).status === 0 && spawnSync('curl', ['--version']).status === 0;

  it('builds the codeload address only for a GitHub commit', () => {
    expect(githubArchiveURL(`github:someone/onset-publisher#${c1}`)).toBe(`https://codeload.github.com/someone/onset-publisher/tar.gz/${c1}`);
    expect(githubArchiveURL(`https://github.com/someone/onset-publisher.git#${c1}`)).toBe(`https://codeload.github.com/someone/onset-publisher/tar.gz/${c1}`);
    expect(githubArchiveURL('github:someone/onset-publisher#v0.1.0')).toBe('');
    expect(githubArchiveURL(`https://gitlab.com/someone/x.git#${c1}`)).toBe('');
  });

  /** 照 GitHub 的样子打一个包：顶层一个 <仓库>-<commit> 目录。 */
  function pack(): { url: string; digest: string } {
    const root = temp('onset-archive-');
    const top = path.join(root, `onset-publisher-${c1}`);
    fs.cpSync(fake, top, { recursive: true });
    const file = path.join(root, 'plugin.tar.gz');
    const r = spawnSync('tar', ['-czf', file, '-C', root, path.basename(top)]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return { url: `file://${file}`, digest: treeDigest(top) };
  }

  it('downloads, checks the digest and stages without cloning', async () => {
    if (!hasTar) return;
    const env = { ...process.env, ONSET_STATIONS_DIR: temp('onset-stations-'), PATH: '/usr/bin:/bin' };
    const { url, digest } = pack();
    const dest = path.join(temp('onset-fetch-'), 'src');
    await fetchArchive(url, digest, dest, env);
    const staged = stageStation(`github:someone/onset-publisher#${c1}`, env, () => {}, { id: 'fake-publisher', commit: c1 }, dest);
    expect(staged.entry).toMatchObject({ id: 'fake-publisher', commit: c1, digest, source: `github:someone/onset-publisher#${c1}` });
    installStaged(staged.token, env);
    expect(readInstalled(stationsDir(env)).plugins[0].digest).toBe(digest);
  });

  it('throws away an archive whose content does not match', async () => {
    if (!hasTar) return;
    const { url } = pack();
    const dest = path.join(temp('onset-fetch-'), 'src');
    await expect(fetchArchive(url, 'sha256:' + '0'.repeat(64), dest, process.env)).rejects.toThrow(/插件中心记的是/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(dest + '.tar.gz')).toBe(false);
  });
});
