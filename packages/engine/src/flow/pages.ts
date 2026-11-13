/**
 * 清单到客户端与路线的映射：路线用的站、插件页面的 id 与可读文件、工具名、页面能申请的 am 操作。
 */
import { opPattern, projectPath } from './fields';
import { pluginOps } from '../plugin/registry';
import { builtinFirstPages } from './registered';
import type { Manifest } from './manifest';
import type { ExtraStation, RouteNode, Station } from './types';

/**
 * 插件页面不能调的 am 操作：不可逆的（归档、记忆回滚与导入）、只在一轮对话里有意义的（切页、标步骤）。
 * 内置插件的操作标了 noPageCall 的（要用户本人确认的，例如节拍网格的确认）同样不能调。
 */
const pageDenied = new Set(['archive', 'memory_rollback', 'memory_import', 'memory_retire', 'memory_reject', 'memory_promote', 'film_style_remove', 'studio_show', 'studio_step']);

/** 插件页面能不能申请调这条操作。编排工具能用的（scope 含 orchestrator）由执行进程再查一遍（AM_OP_SCOPE）。 */
export function pageCallableOp(name: string): boolean {
  if (pluginOps().some(({ value }) => value.name === name && value.noPageCall)) return false;
  return opPattern.test(name) && !pageDenied.has(name) && !name.startsWith('station_') && name !== 'config_set';
}

/** 把清单译成路线用的站。 */
export function toExtra(m: Manifest): ExtraStation {
  const nodes = m.nodes.map((n): RouteNode => {
    const node: RouteNode = { id: n.id, label: n.label, step: n.step, declared: { outputs: n.outputs, stale_after: n.stale_after } };
    if (n.state) node.declared!.state = n.state;
    if (n.guide) node.declared!.guide = n.guide;
    if (n.gate) node.gate = true;
    // 站点指向插件自己的页面时，换成客户端里的页面 id。
    if (n.page) node.page = m.pages.some((pg) => pg.id === n.page) ? pageTab(m.id, n.page) : n.page;
    if (n.gate_files.length > 0) node.gateFiles = n.gate_files;
    return node;
  });
  // 站自己声明的文件归到它的第一个普通站点（没有就归第一个站点）上。
  const owner = nodes.find((n) => !n.gate) ?? nodes[0];
  if (owner && m.produces.length > 0) owner.produces = m.produces;
  const station: Station = { id: m.id, name: m.name, nodes, prompt: [] };
  const extra: ExtraStation = { station, after: m.after, replaces: m.replaces };
  if (m.flow) {
    const first = builtinFirstPages().includes(m.flow.first_page) ? m.flow.first_page : pageTab(m.id, m.flow.first_page);
    extra.flow = { id: `x:${m.id}`, name: m.flow.name, stations: m.flow.stations, first_page: first };
  }
  return extra;
}

/** 插件页面在客户端里的页面 id（studio_show 与顶栏都用它）：x:<站>:<页面>。 */
export function pageTab(stationID: string, page: string): string {
  return `x:${stationID}:${page}`;
}

/**
 * 插件页面能不能读项目里的这个文件：页面声明的 reads、站声明会写的文件（produces）与站点的 outputs。
 * 路径先规范化，不能跑出项目、不能是 am 自己的文件。
 */
export function pageMayRead(m: Manifest, rel: string): boolean {
  let p: string;
  try {
    p = projectPath(rel, 'path');
  } catch {
    return false;
  }
  if (p.split('/').some((seg) => seg === '' || seg === '.')) return false;
  const base = p.slice(p.lastIndexOf('/') + 1);
  for (const page of m.pages) {
    for (const r of page.reads) if (r.endsWith('/') ? p.startsWith(r) : p === r) return true;
  }
  for (const rule of m.produces) {
    if (rule.path !== undefined && rule.path === p) return true;
    if (rule.prefix !== undefined && p.startsWith(rule.prefix) && (!rule.base || rule.base.test(base))) return true;
  }
  return m.nodes.some((n) => n.outputs.includes(p));
}

/** 工具名：x_<站 id 把连字符换成下划线>_<操作名>。 */
export function toolName(stationID: string, op: string): string {
  return `x_${stationID.replaceAll('-', '_')}_${op}`;
}
