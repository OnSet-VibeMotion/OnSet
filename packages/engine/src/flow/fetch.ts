/**
 * 第三方站的来源与下载：来源怎么写、git 来源按 ref 克隆并按 commit 存进用户级目录（StationsDirEnv）、
 * 读清单与检查站目录里的文件。`link:` 是开发用的本地目录，不核对摘要。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../envutil';
import { gitHint, usableGit } from '../toolpath';
import { treeDigest } from './digest';
import type { LockEntry } from './lock';
import { ManifestFile, type Manifest } from './manifest';
import { parseManifest } from './parse';

/** 第三方站的存放目录（默认 <数据目录>/am/stations）。 */
export const StationsDirEnv = 'AM_STATIONS_DIR';

export function stationsDir(env: Record<string, string | undefined>): string {
  if (env[StationsDirEnv]) return env[StationsDirEnv]!;
  const data = dataDir(env);
  if (data === '') throw new Error(`算不出第三方站的存放目录：设置 ${StationsDirEnv} 或 HOME`);
  return path.join(data, 'stations');
}

/** 来源解析成 git 地址与 ref，或本地目录。 */
export function parseSource(spec: string): { kind: 'link'; dir: string } | { kind: 'git'; url: string; ref: string } {
  const s = spec.trim();
  if (s.startsWith('link:')) {
    const dir = s.slice('link:'.length);
    if (!path.isAbsolute(dir)) throw new Error(`link: 后面要是绝对路径：${dir}`);
    return { kind: 'link', dir };
  }
  if (path.isAbsolute(s)) return { kind: 'link', dir: s };
  const hash = s.lastIndexOf('#');
  const head = hash >= 0 ? s.slice(0, hash) : s;
  const ref = hash >= 0 ? s.slice(hash + 1) : '';
  if (head.startsWith('github:')) {
    const repo = head.slice('github:'.length);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`github: 后面要是 owner/repo：${repo}`);
    return { kind: 'git', url: `https://github.com/${repo}.git`, ref };
  }
  if (/^(https:\/\/|git@|ssh:\/\/|file:\/\/)/.test(head)) return { kind: 'git', url: head, ref };
  throw new Error(`认不出来源 ${s}：写 link:/绝对路径、github:owner/repo#ref 或 git 地址#ref`);
}

/** 某个来源在本机的目录：link 就是它自己，git 按 commit 存在 stationsDir 下。 */
export function sourceDir(entry: LockEntry, env: Record<string, string | undefined>): string {
  const src = parseSource(entry.source);
  if (src.kind === 'link') return src.dir;
  return path.join(stationsDir(env), entry.id, entry.commit);
}

export function readManifest(dir: string): Manifest {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, ManifestFile), 'utf8');
  } catch {
    throw new Error(`${dir} 里没有 ${ManifestFile}`);
  }
  return parseManifest(text);
}

/** 检查一个读得到的站：提示词文件在、命令文件在。 */
export function checkFiles(dir: string, m: Manifest): void {
  if (m.prompt !== '' && !fs.existsSync(path.join(dir, m.prompt))) throw new Error(`站 ${m.id} 缺提示词文件 ${m.prompt}`);
  for (const op of m.ops) {
    if (op.command[0].includes('/') && !fs.existsSync(path.join(dir, op.command[0]))) throw new Error(`站 ${m.id} 的操作 ${op.name} 缺命令文件 ${op.command[0]}`);
  }
  for (const page of m.pages) {
    if (!fs.existsSync(path.join(dir, page.entry))) throw new Error(`站 ${m.id} 的页面 ${page.id} 缺文件 ${page.entry}`);
  }
  if (m.film_styles && !fs.existsSync(path.join(dir, m.film_styles.dir))) throw new Error(`站 ${m.id} 缺风格库目录 ${m.film_styles.dir}`);
  for (const rs of m.renderer_skills) {
    if (!fs.existsSync(path.join(dir, rs.dir, 'SKILL.md'))) throw new Error(`站 ${m.id} 的渲染技能 ${rs.name} 缺 ${rs.dir}/SKILL.md`);
  }
  if (m.flow && !fs.existsSync(path.join(dir, m.flow.prompt))) throw new Error(`站 ${m.id} 缺流程的制作提示词 ${m.flow.prompt}`);
  for (const ins of m.inserts) {
    if (!fs.existsSync(path.join(dir, ins.file))) throw new Error(`站 ${m.id} 缺插入说明 ${ins.file}`);
  }
}

/**
 * 取来一个站（git 按 ref 克隆、记 commit；link 直接读），校验清单，返回锁文件里的一项。
 * 只做下载与校验，不改项目。
 */
export function fetchStation(spec: string, env: Record<string, string | undefined>, log: (line: string) => void = () => {}): { entry: LockEntry; dir: string; manifest: Manifest } {
  const src = parseSource(spec);
  if (src.kind === 'link') {
    const manifest = readManifest(src.dir);
    checkFiles(src.dir, manifest);
    return { entry: { id: manifest.id, version: manifest.version, source: `link:${src.dir}`, commit: '', digest: '' }, dir: src.dir, manifest };
  }
  const git = usableGit(env);
  if (git === '') throw new Error(`添加 git 来源的站要用 git：${gitHint()}`);
  const store = stationsDir(env);
  fs.mkdirSync(store, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(store, '.fetch-'));
  try {
    const run = (args: string[], cwd?: string) => {
      log(`git ${args.join(' ')}`);
      const r = spawnSync(git, args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args[0]} 失败：${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join('\n')}`);
      return r.stdout.trim();
    };
    const checkout = path.join(tmp, 'src');
    run(['clone', '--quiet', src.url, checkout]);
    if (src.ref !== '') run(['checkout', '--quiet', src.ref], checkout);
    const commit = run(['rev-parse', 'HEAD'], checkout);
    const manifest = readManifest(checkout);
    checkFiles(checkout, manifest);
    fs.rmSync(path.join(checkout, '.git'), { recursive: true, force: true });
    const digest = treeDigest(checkout);
    const final = path.join(store, manifest.id, commit);
    if (fs.existsSync(final)) {
      if (treeDigest(final) !== digest) fs.rmSync(final, { recursive: true, force: true });
    }
    if (!fs.existsSync(final)) {
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.renameSync(checkout, final);
    }
    return { entry: { id: manifest.id, version: manifest.version, source: spec.trim(), commit, digest }, dir: final, manifest };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** 测试与开发用：在临时目录里写一个站。 */
export function writeStationForTest(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-station-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, { mode: rel.startsWith('bin/') ? 0o755 : 0o644 });
  }
  return dir;
}
