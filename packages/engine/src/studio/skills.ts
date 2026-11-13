/**
 * 项目里 HyperFrames 官方技能的后台安装。移植自 internal/studio/skills.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import * as hyperframes from '../hyperframes';
import * as projectinit from '../projectinit';
import { goMap, goValue, methodNotAllowed, writeJSON } from './http';
import type { Server } from './studio';

/** 安装函数：把官方技能装进 dir，进度经 report 汇报。 */
export type SkillInstaller = (signal: AbortSignal, dir: string, report: (p: hyperframes.Progress) => void) => Promise<void>;

/** skillsState 记录各项目 HyperFrames 官方技能的后台安装情况。 */
export class SkillsState {
  readonly running = new Set<string>();
  readonly errors = new Map<string, string>();
  readonly progress = new Map<string, hyperframes.Progress>();
  /** 测试用：换掉安装函数。 */
  install: SkillInstaller | undefined;
}

class InstallError extends Error {
  constructor(err: Error, log: string) {
    super(err.message + '\n' + tail(log, 600), { cause: err });
  }
}

export function tail(text: string, n: number): string {
  const runes = [...text];
  if (runes.length <= n) return text;
  return '…' + runes.slice(runes.length - n).join('');
}

/**
 * 默认的安装函数。模块级变量只为测试：测试的 setup 换成不联网的版本；
 * 浏览器端到端测试起的是真程序，靠 AM_STUDIO_SKIP_SKILL_INSTALL=1 跳过联网。
 */
let installOfficialSkills: SkillInstaller = async (signal, dir, report) => {
  if (process.env.AM_STUDIO_SKIP_SKILL_INSTALL === '1') return;
  let log = '';
  try {
    await projectinit.installSkills(dir, envMap(), { write: (chunk: string) => (log += chunk) }, report, signal);
  } catch (err) {
    if (log.length > 0) throw new InstallError(err as Error, log.trim());
    throw err;
  }
};

/** 测试用：换掉默认的安装函数（Go 的 TestMain 改包级变量）。 */
export function setInstallOfficialSkills(fn: SkillInstaller): void {
  installOfficialSkills = fn;
}

/** skillInstallTimeout 是一次安装的上限：网络差时不能无限挂着。 */
const skillInstallTimeout = 5 * 60 * 1000;

/** installSkills 在后台把官方技能装进项目；已经在装就不重复开。 */
export function installSkills(s: Server, dir: string): void {
  if (s.skills.running.has(dir)) return;
  s.skills.running.add(dir);
  s.skills.errors.delete(dir);
  s.skills.progress.set(dir, { stage: '准备', percent: 0 });
  const install = s.skills.install ?? installOfficialSkills;
  void (async () => {
    let err: Error | null = null;
    try {
      await install(AbortSignal.timeout(skillInstallTimeout), dir, (p) => {
        s.skills.progress.set(dir, p);
      });
    } catch (e) {
      err = e instanceof Error ? e : new Error(String(e));
    }
    s.skills.running.delete(dir);
    s.skills.progress.delete(dir);
    if (err) s.skills.errors.set(dir, err.message);
  })();
}

/** 项目里 HyperFrames 官方技能的状态。progress 只在安装进行中有值。 */
export interface SkillsStatus {
  installed: boolean;
  installing: boolean;
  error?: string;
  progress?: hyperframes.Progress;
}

export function skillsStatusJSON(status: SkillsStatus): Record<string, unknown> {
  return {
    installed: status.installed,
    installing: status.installing,
    error: status.error || undefined,
    progress: status.progress
      ? { stage: status.progress.stage, percent: status.progress.percent, indeterminate: status.progress.indeterminate || undefined }
      : undefined,
  };
}

export function skillsStatus(s: Server, dir: string): SkillsStatus {
  const status: SkillsStatus = { installed: projectinit.skillsInstalled(dir), installing: s.skills.running.has(dir), error: s.skills.errors.get(dir) };
  const progress = s.skills.progress.get(dir);
  if (progress && status.installing) status.progress = { ...progress };
  return status;
}

/** skillsInstallAPI 给缺技能的项目补装（在 Studio 里新建、装到一半断网的项目）。 */
export function skillsInstallAPI(s: Server, request: Request): Response {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  installSkills(s, p.path);
  return writeJSON(202, skillsStatusJSON(skillsStatus(s, p.path)));
}

/** skillsAPI 列出项目里安装的技能与上游技能的来源记录。 */
export function skillsAPI(s: Server): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const dir = path.join(p.path, '.agents', 'skills');
  const skills: { name: string; has_skill_md: boolean }[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) skills.push({ name: entry.name, has_skill_md: fs.existsSync(path.join(dir, entry.name, 'SKILL.md')) });
    }
  } catch {
    // 没有技能目录。
  }
  let upstream: unknown = null;
  try {
    upstream = goValue(JSON.parse(fs.readFileSync(path.join(dir, hyperframes.ManifestFile), 'utf8')));
  } catch {
    upstream = null;
  }
  return writeJSON(
    200,
    goMap({ skills, upstream, pinned_hyperframes: hyperframes.PinnedVersion, status: skillsStatusJSON(skillsStatus(s, p.path)) }),
  );
}
