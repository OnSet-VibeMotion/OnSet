/**
 * 剪映导出包路径与目标目录安全校验。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 清理素材包名称，拒绝路径穿越或空名。 */
export function sanitizeBundleName(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed === '.' ||
    trimmed === '..'
  ) {
    throw new Error(`非法的导出包名称：${raw}`);
  }
  const clean = trimmed.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]/g, '_').replace(/^\.+/, '');
  if (clean === '') throw new Error(`导出包名称不能为空：${raw}`);
  return clean;
}

const protectedProjectDirs = new Set(['scenes', 'production', 'assets', '.git', '.onset']);

/** 确认已存在的非空目录归属本导出器（shots.json 的 generator === 'onset-jianying-export'），避免误删用户目录。 */
export function assertOwnedExportDir(target: string): void {
  if (!fs.existsSync(target)) return;
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`输出目标不是普通目录：${target}`);
  if (fs.readdirSync(target).length === 0) return;
  const marker = path.join(target, 'shots.json');
  try {
    const mst = fs.lstatSync(marker);
    if (!mst.isFile()) throw new Error('not file');
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as Record<string, unknown>;
    if (parsed.generator === 'onset-jianying-export') return;
  } catch {
    // 非剪映导出产物，统一拒绝。
  }
  throw new Error(`输出目录不是剪映导出包且非空，拒绝覆盖：${target}`);
}

/** 解析目标路径中最近已存在的祖先目录真实路径，再拼回尚不存在的末段，防范目录符号链接绕过。 */
function resolveCanonicalTarget(target: string): string {
  const tail: string[] = [];
  let cur = path.resolve(target);
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  const realBase = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
  return tail.length > 0 ? path.join(realBase, ...tail) : realBase;
}

/**
 * 解析并校验剪映素材包输出目录：
 * - 留空时默认落到 <project>/exports/jianying-<name>/；
 * - 相对路径必须落在项目根目录内（解析祖先符号链接后仍需落在项目内），拒绝 `..` 与符号链接穿越；
 * - 拒绝指向项目根目录本身、其祖先目录（含文件系统根），以及受保护的项目目录；
 * - 拒绝非空目标目录（overwrite=true 时也只允许覆盖已有剪映导出包）。
 */
export function resolveExportDir(
  projectRoot: string,
  dest: string | undefined,
  name: string,
  overwrite: boolean,
): string {
  const resolvedRoot = fs.realpathSync(projectRoot);
  const safeName = sanitizeBundleName(name);
  let rawTarget: string;
  let isRelativeDest = false;
  if (!dest || dest.trim() === '') {
    rawTarget = path.join(resolvedRoot, 'exports', `jianying-${safeName}`);
    isRelativeDest = true;
  } else {
    const raw = dest.trim();
    if (raw.includes('\0')) throw new Error('输出目录路径包含非法空字节');
    if (path.isAbsolute(raw)) {
      rawTarget = path.resolve(raw);
    } else {
      rawTarget = path.resolve(resolvedRoot, raw);
      isRelativeDest = true;
    }
  }
  // 若末段本身存在且为符号链接，先行拦截
  try {
    const lst = fs.lstatSync(rawTarget);
    if (lst.isSymbolicLink() || !lst.isDirectory()) throw new Error(`输出目标不是普通目录：${rawTarget}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const target = resolveCanonicalTarget(rawTarget);
  if (isRelativeDest) {
    const rel = path.relative(resolvedRoot, target);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new Error(`输出目录不能越出项目根目录：${dest ?? target}`);
    }
  }
  const relFromTarget = path.relative(target, resolvedRoot);
  if (
    target === resolvedRoot ||
    (relFromTarget !== '' &&
      relFromTarget !== '..' &&
      !relFromTarget.startsWith('..' + path.sep) &&
      !path.isAbsolute(relFromTarget))
  ) {
    throw new Error(`输出目录不能是项目根目录或其上级目录：${target}`);
  }
  const relToRoot = path.relative(resolvedRoot, target).split(path.sep).join('/');
  const firstSeg = relToRoot.split('/')[0];
  if (relToRoot !== '' && !relToRoot.startsWith('..') && protectedProjectDirs.has(firstSeg)) {
    throw new Error(`输出目录不能落在受保护的项目子目录下：${relToRoot}`);
  }
  if (fs.existsSync(target)) {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`输出目标不是普通目录：${target}`);
    if (fs.readdirSync(target).length > 0) {
      if (!overwrite) {
        throw new Error(`输出目录已存在且非空，拒绝覆盖：${target}（如需覆盖请设置 overwrite=true）`);
      }
      assertOwnedExportDir(target);
    }
  }
  return target;
}
