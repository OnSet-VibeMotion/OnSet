/**
 * 第三方站操作的越界检查：操作前后各扫一遍项目树（只 stat，不读内容），变了的文件里不在本站声明范围
 * （produces、站点 outputs）之内的算越界；写到 onset 自己的文件（ReservedPrefixes）的，操作按失败处理。
 *
 * 这不是沙箱：插件的操作是用户电脑上的普通程序，越界的文件已经写了。检查只负责照实告诉用户与编排工具。
 *
 * 跳过的目录与 Studio 的轮次快照一致（fsutil.ProjectSkippedDirs），只有两处不同：
 * - 项目根的 .agents 照样扫：它是 onset 自己的技能树，写进去要算失败；
 * - production/studio 里 onset 自己边跑边写的状态（任务、会话、收件、快照……）不算：操作进行中客户端本来就在写它们，
 *   分不清是谁写的。production/studio/blobs 整个不进（文件多，且只有 Studio 写）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ProjectSkippedDirs, walkDir } from '../fsutil';
import { compareBytes } from '../gojson';
import type { Manifest } from './external';

/** onset 自己的文件，第三方站不能写。清单校验（fields.ts）用的也是这一份。 */
export const ReservedPrefixes: readonly string[] = ['production/studio/', 'production/usage/', 'production/memory-exams/', '.agents/', '.env'];

/** 操作进行中客户端自己会写的状态：不计入（分不清是谁写的）。 */
const hostChurn: readonly string[] = [
  'production/studio/tasks.json',
  'production/studio/step.json',
  'production/studio/gates.json',
  'production/studio/permissions.json',
  'production/studio/sessions/',
  'production/studio/inbox/',
  'production/studio/turns/',
  'production/studio/blobs/',
  'production/studio/uploads/',
  'production/studio/attachments/',
];

/** 列出的越界文件最多这么多条，其余只给条数。 */
export const MaxListedPaths = 20;

/** 项目树的 stat 快照：相对路径（`/` 分隔）→「大小:修改时间纳秒」。 */
export type StatSnapshot = Record<string, string>;

function matches(p: string, prefix: string): boolean {
  return prefix.endsWith('/') ? p.startsWith(prefix) : p === prefix || p.startsWith(prefix);
}

/** 扫一遍项目，只 stat。 */
export function statProject(root: string): StatSnapshot {
  const out: StatSnapshot = {};
  const blobs = path.join(root, 'production', 'studio', 'blobs');
  walkDir(root, (file, entry) => {
    if (!entry) return;
    if (entry.isDirectory()) {
      if (file === blobs) return 'skip';
      if (entry.name === '.agents' && path.dirname(file) === root) return undefined;
      return ProjectSkippedDirs.has(entry.name) ? 'skip' : undefined;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) return;
    try {
      const info = fs.lstatSync(file, { bigint: true });
      out[path.relative(root, file).split(path.sep).join('/')] = `${info.size}:${info.mtimeNs}`;
    } catch {
      // 竞态删除：当成不存在。
    }
  });
  return out;
}

/** 两次快照之间新增、改过、删掉的文件（去掉客户端自己的状态），按字节序。 */
export function changedFiles(before: StatSnapshot, after: StatSnapshot): string[] {
  const out = new Set<string>();
  for (const [file, state] of Object.entries(after)) if (before[file] !== state) out.add(file);
  for (const file of Object.keys(before)) if (!Object.hasOwn(after, file)) out.add(file);
  return [...out].filter((p) => !hostChurn.some((h) => matches(p, h))).sort(compareBytes);
}

/** 这个路径是不是 onset 自己的文件。 */
export function isReservedPath(rel: string): boolean {
  const p = rel.replaceAll('\\', '/');
  return ReservedPrefixes.some((r) => p === r.replace(/\/$/, '') || p.startsWith(r));
}

/** 这个路径在不在站声明会写的范围里：produces（整条路径 / 前缀 / 前缀加文件名）与站点的 outputs。 */
export function declaredPath(m: Manifest, rel: string): boolean {
  const p = rel.replaceAll('\\', '/');
  const base = p.slice(p.lastIndexOf('/') + 1);
  for (const rule of m.produces) {
    if (rule.path !== undefined && rule.path === p) return true;
    if (rule.prefix !== undefined && p.startsWith(rule.prefix) && (!rule.base || rule.base.test(base))) return true;
  }
  return m.nodes.some((n) => n.outputs.includes(p));
}

/** 一次操作的越界情况。 */
export interface ScopeReport {
  /** 越界的文件（onset 自己的文件排在前面），最多 MaxListedPaths 条。 */
  out_of_scope: string[];
  /** 没列出来的越界文件还有几个。 */
  out_of_scope_more: number;
  /** 其中写到 onset 自己的文件的（也受上限约束）。 */
  reserved: string[];
}

/** 比对前后两次快照，得出越界情况；没有越界时返回 null。 */
export function scopeReport(m: Manifest, before: StatSnapshot, after: StatSnapshot): ScopeReport | null {
  const outside = changedFiles(before, after).filter((p) => !declaredPath(m, p));
  if (outside.length === 0) return null;
  const reserved = outside.filter(isReservedPath);
  const ordered = [...reserved, ...outside.filter((p) => !isReservedPath(p))];
  return {
    out_of_scope: ordered.slice(0, MaxListedPaths),
    out_of_scope_more: Math.max(0, ordered.length - MaxListedPaths),
    reserved: reserved.slice(0, MaxListedPaths),
  };
}

/** 写给编排工具与用户看的说明，接在操作输出的末尾。 */
export function scopeText(stationName: string, r: ScopeReport): string {
  const total = r.out_of_scope.length + r.out_of_scope_more;
  const lines = [`注意：插件「${stationName}」这次改了它没有声明会写的项目文件（${total} 个）：`];
  for (const p of r.out_of_scope) lines.push(`  ${p}${isReservedPath(p) ? '（片场自己的文件）' : ''}`);
  if (r.out_of_scope_more > 0) lines.push(`  ……另有 ${r.out_of_scope_more} 个`);
  if (r.reserved.length > 0) {
    lines.push('它写了片场自己的文件，这次操作按失败处理。文件已经写了，没法自动撤销：可以回退包含这次操作的那一轮对话，或者用 git 恢复。');
  } else {
    lines.push('这些文件已经写了；要是不该改，可以回退包含这次操作的那一轮对话，或者用 git 恢复。');
  }
  return lines.join('\n') + '\n';
}
