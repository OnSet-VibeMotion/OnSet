/**
 * 内置插件的登记表。apply(ctx) 在登记时立刻执行，登记的东西按插件记下；各层按需来取。
 *
 * 全部内置插件集中在 plugins/index.ts 登记（理由同 filmstyle/sources：散在各处 import 就会漏），
 * 本包的入口 index.ts 导入它，所以凡是经 `../plugin` 取登记表的地方都拿得到。测试可以另登记假插件，
 * registerBuiltin 返回的函数把它撤掉。
 */
import path from 'node:path';
import { assetsBase } from '../assets';
import { builtinStations } from '../flow/builtin';
import type { BuiltinPlugin, PluginContext, PluginOp, PluginPage, PluginRoute, PluginStation, PluginValidator } from './types';

interface Applied {
  id: string;
  dir: () => string;
  stations: PluginStation[];
  ops: PluginOp[];
  pages: PluginPage[];
  routes: PluginRoute[];
  validators: PluginValidator[];
}

/** 按登记顺序。 */
const applied: Applied[] = [];

type OpListener = { add: (op: PluginOp, owner: string) => void; remove: (op: PluginOp, owner: string) => void };
const opListeners: OpListener[] = [];

/** 内置插件的缺省目录：assets/plugins/<id>/（与 flow.builtinPluginsDir 同一处，这里不 import flow 免得成环）。 */
function defaultDir(id: string): string {
  return path.join(assetsBase(), 'assets', 'plugins', id);
}

/** 登记一个内置插件：立刻执行它的 apply。id、站、操作、页面、接口重复直接报错。返回撤销登记的函数（测试用）。 */
export function registerBuiltin(plugin: BuiltinPlugin): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(plugin.id)) throw new Error(`内置插件 id ${plugin.id} 要是小写字母、数字与连字符`);
  if (applied.some((a) => a.id === plugin.id)) throw new Error(`内置插件 ${plugin.id} 登记了两次`);
  const entry: Applied = { id: plugin.id, dir: () => plugin.dir ?? defaultDir(plugin.id), stations: [], ops: [], pages: [], routes: [], validators: [] };
  const where = `内置插件 ${plugin.id}`;
  const ctx: PluginContext = {
    id: plugin.id,
    get dir() {
      return entry.dir();
    },
    station(s) {
      if (s.id === 'host' || builtinStations.some((b) => b.id === s.id) || allApplied(entry).some((a) => a.stations.some((x) => x.id === s.id))) {
        throw new Error(`${where}：站 ${s.id} 已经有了`);
      }
      for (const node of s.nodes) {
        const judge = s.judges?.[node.id];
        if (!node.gate && !judge?.output) throw new Error(`${where}：站点 ${s.id}:${node.id} 没有判断函数`);
      }
      for (const id of Object.keys(s.judges ?? {})) if (!s.nodes.some((n) => n.id === id)) throw new Error(`${where}：判断函数 ${id} 没有对应的站点`);
      entry.stations.push(s);
    },
    op(op) {
      if (allApplied(entry).some((a) => a.ops.some((o) => o.name === op.name))) throw new Error(`${where}：操作 ${op.name} 已经有了`);
      entry.ops.push(op);
    },
    page(p) {
      if (allApplied(entry).some((a) => a.pages.some((x) => x.id === p.id))) throw new Error(`${where}：页面 ${p.id} 已经有了`);
      entry.pages.push(p);
    },
    route(r) {
      if (allApplied(entry).some((a) => a.routes.some((x) => x.pattern === r.pattern))) throw new Error(`${where}：接口 ${r.pattern} 已经有了`);
      entry.routes.push(r);
    },
    validator(v) {
      if (allApplied(entry).some((a) => a.validators.some((x) => x.id === v.id))) throw new Error(`${where}：校验器 ${v.id} 已经有了`);
      entry.validators.push(v);
    },
  };
  plugin.apply(ctx);
  applied.push(entry);
  for (const op of entry.ops) for (const l of opListeners) l.add(op, entry.id);
  return () => {
    const i = applied.indexOf(entry);
    if (i < 0) return;
    applied.splice(i, 1);
    for (const op of entry.ops) for (const l of opListeners) l.remove(op, entry.id);
  };
}

function allApplied(pending: Applied): Applied[] {
  return [...applied, pending];
}

/** 登记过的内置插件 id（按登记顺序）。 */
export function appliedPluginIDs(): string[] {
  return applied.map((a) => a.id);
}

/** 插件目录。 */
export function pluginDir(id: string): string {
  const a = applied.find((x) => x.id === id);
  if (!a) throw new Error(`没有登记内置插件 ${id}`);
  return a.dir();
}

export interface Owned<T> {
  owner: string;
  value: T;
}

function collect<T>(pick: (a: Applied) => T[]): Owned<T>[] {
  return applied.flatMap((a) => pick(a).map((value) => ({ owner: a.id, value })));
}

export const pluginStations = (): Owned<PluginStation>[] => collect((a) => a.stations);
export const pluginOps = (): Owned<PluginOp>[] => collect((a) => a.ops);
export const pluginPages = (): Owned<PluginPage>[] => collect((a) => a.pages);
export const pluginRoutes = (): Owned<PluginRoute>[] => collect((a) => a.routes);
export const pluginValidators = (): Owned<PluginValidator>[] => collect((a) => a.validators);

/**
 * 订阅插件登记的操作：已有的立刻补发，之后登记、撤销的照发。cli 的操作表经它 defineOp（plugin_ops.ts）。
 * 返回取消订阅的函数。
 */
export function onPluginOps(add: OpListener['add'], remove: OpListener['remove']): () => void {
  const l = { add, remove };
  opListeners.push(l);
  for (const { owner, value } of pluginOps()) add(value, owner);
  return () => {
    const i = opListeners.indexOf(l);
    if (i >= 0) opListeners.splice(i, 1);
  };
}
