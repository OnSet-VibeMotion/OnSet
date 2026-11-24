// HyperFrames 技能树的本机缓存读写与目录拷贝。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../envutil';
import { compareBytes } from '../gojson';
import { manifestFile, PinnedSkillsCommit, PinnedSkillsCount, skillsSubdirsInRepo } from './constants';
import { errorText, goList } from './util';

/** 安装结果。 */
export interface Result {
  /** 写进项目的技能名，已排序。 */
  installed: string[];
  /** 因为与内置技能重名而跳过的上游技能名。 */
  protected: string[];
}

/**
 * 用户级缓存根目录：<数据目录>/hyperframes（envutil.dataDir：XDG_DATA_HOME、Windows 的 LOCALAPPDATA 或 HOME）。
 * 都没有时返回空串（不用缓存），不去猜家目录。
 */
export function defaultCacheDir(env: Record<string, string | undefined>): string {
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'hyperframes');
}

/** 本机缓存里已有校验过的固定版本技能树。 */
export function skillsReady(cacheDir: string): boolean {
  return cachedTree(cacheDir, PinnedSkillsCommit, PinnedSkillsCount) !== '';
}

export function pathExists(file: string): boolean {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 写在缓存目录里，内容是 commit：只有完整搬进去、校验过的技能树才有它。 */
export const cacheMarker = '.onset-commit';

/**
 * 返回 commit 的缓存目录；没有可用缓存时返回空串。
 *
 * 可用的标准与刚克隆下来的一样：标记里的 commit 对得上、拼装出的技能数等于期望。
 * 缓存被人动过（少了目录）就当作没有，重新下载并覆盖。
 */
export function cachedTree(cacheRoot: string | undefined, commit: string, expectSkills: number): string {
  if (!cacheRoot || commit === '' || commit === '-') return '';
  const dir = path.join(cacheRoot, commit);
  let body: string;
  try {
    body = fs.readFileSync(path.join(dir, cacheMarker), 'utf8');
  } catch {
    return '';
  }
  if (body.trim() !== commit) return '';
  let count = 0;
  for (const sub of skillsSubdirsInRepo) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(dir, sub));
    } catch {
      continue;
    }
    for (const name of entries) if (pathExists(path.join(dir, sub, name, manifestFile))) count++;
  }
  return count === expectSkills ? dir : '';
}

/**
 * 把刚克隆、校验过的技能树搬进缓存。先拷进同级临时目录再改名，
 * 别的进程读到的缓存要么没有、要么完整。失败只影响下次要不要联网，不让安装失败。
 */
export function storeCache(cacheRoot: string | undefined, commit: string, clone: string): void {
  if (!cacheRoot || commit === '') return;
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheRoot, '.staging-'));
  try {
    for (const sub of skillsSubdirsInRepo) {
      const source = path.join(clone, sub);
      if (!pathExists(source)) continue;
      copyTree(source, path.join(staging, sub));
    }
    fs.writeFileSync(path.join(staging, cacheMarker), commit + '\n', { mode: 0o644 });
    const target = path.join(cacheRoot, commit);
    fs.rmSync(target, { recursive: true, force: true }); // 被判为不可用的旧缓存
    try {
      fs.renameSync(staging, target);
    } catch (err) {
      if (pathExists(path.join(target, cacheMarker))) return; // 另一个进程刚放好同一份
      throw err;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 按文件名字典序读目录（os.ReadDir 的顺序）。 */
function readDirSorted(dir: string): fs.Dirent[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}

/**
 * 把 sources 各目录下的每个技能目录整体搬进 dest。
 *
 * 收多个来源是因为上游把技能放在仓库的两处（skills/ 与 .agents/skills/）。
 * 判定标准仍是"目录里有 SKILL.md"，与上游安装器的筛选结果实测逐字节一致。
 *
 * 上游技能由 onset 按固定 commit 管理，所以同名目录整体替换而不是合并：残留上
 * 一版的文件会让技能树处于两个版本混合的状态，而那正是固定版本要消除的东西。
 * 随二进制下发的技能受 protectedSkills 保护，永远不会被上游同名技能覆盖。
 */
export function copySkills(
  sources: string[],
  dest: string,
  protectedSkills?: ReadonlySet<string>,
  copied?: (done: number) => void,
): Result {
  fs.mkdirSync(dest, { recursive: true });
  const result: Result = { installed: [], protected: [] };
  const seen = new Map<string, string>();
  for (const source of sources) {
    let entries: fs.Dirent[];
    try {
      entries = readDirSorted(source);
    } catch (err) {
      throw new Error(`无法读取安装产物：${errorText(err)}`, { cause: err });
    }
    for (const entry of entries) {
      const name = entry.name;
      if (!entry.isDirectory()) continue;
      if (!pathExists(path.join(source, name, manifestFile))) continue; // 不是技能目录
      // 两处出现同名技能时哪一份生效取决于遍历顺序，是静默的不确定性。
      const previous = seen.get(name);
      if (previous !== undefined)
        throw new Error(`技能 ${name} 在 ${previous} 与 ${source} 两处重复，无法确定用哪一份`);
      seen.set(name, source);
      if (protectedSkills?.has(name)) {
        result.protected.push(name);
        continue;
      }
      const target = path.join(dest, name);
      fs.rmSync(target, { recursive: true, force: true });
      try {
        copyTree(path.join(source, name), target);
      } catch (err) {
        throw new Error(`拷贝技能 ${name} 失败：${errorText(err)}`, { cause: err });
      }
      result.installed.push(name);
      copied?.(result.installed.length + result.protected.length);
    }
  }
  if (result.installed.length === 0) throw new Error(`安装产物里没有任何技能目录：${goList(sources)}`);
  result.installed.sort(compareBytes);
  result.protected.sort(compareBytes);
  return result;
}

/**
 * 递归拷贝目录。符号链接一律拒绝：上游在 Unix 上用符号链接做的是
 * 「镜像到其他 agent 目录」，指回它自己的 home store；搬进项目后那些链接会指向
 * 一个已经删掉的临时目录，成为静默失效的空技能。
 */
export function copyTree(source: string, dest: string): void {
  const walk = (relative: string) => {
    const from = relative === '' ? source : path.join(source, relative);
    const target = relative === '' ? dest : path.join(dest, relative);
    fs.mkdirSync(target, { recursive: true, mode: 0o755 });
    for (const entry of readDirSorted(from)) {
      const rel = relative === '' ? entry.name : path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`安装产物含符号链接，无法安全搬进项目：${rel}`);
      } else if (entry.isFile()) {
        const file = path.join(source, rel);
        const mode = fs.statSync(file).mode & 0o777;
        const body = fs.readFileSync(file);
        fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true, mode: 0o755 });
        fs.writeFileSync(path.join(dest, rel), body, { mode });
      }
      // 设备、套接字之类一律忽略
    }
  };
  walk('');
}
