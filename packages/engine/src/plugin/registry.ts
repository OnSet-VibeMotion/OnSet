/**
 * 内置插件的登记表。apply(ctx) 在登记时立刻执行，登记的东西按插件记下；各层按需来取。
 *
 * 全部内置插件集中在 plugins/index.ts 登记（理由同 filmstyle/sources：散在各处 import 就会漏），
 * 本包的入口 index.ts 导入它，所以凡是经 `../plugin` 取登记表的地方都拿得到。测试可以另登记假插件，
 * registerBuiltin 返回的函数把它撤掉。
 */
import path from 'node:path';
import { assetsBase } from '../assets';
import { builtinFlows, builtinStations } from '../flow/builtin';
import type { SceneBlock } from '../scene/block';
import type { SkillDescriptor } from '../scene/skills';
import type {
  BuiltinPlugin,
  PluginContext,
  PluginFlow,
  PluginNarration,
  PluginOp,
  PluginOpGroup,
  PluginPage,
  PluginChildEnv,
  PluginCommand,
  PluginPreset,
  PluginPrereq,
  PluginRenderCheck,
  PluginRoute,
  PluginStation,
  PluginStep,
  PluginValidator,
} from './types';

interface Applied {
  id: string;
  dir: () => string;
  stations: PluginStation[];
  flows: PluginFlow[];
  ops: PluginOp[];
  pages: PluginPage[];
  routes: PluginRoute[];
  validators: PluginValidator[];
  skills: SkillDescriptor[];
  blocks: SceneBlock[];
  narrations: PluginNarration[];
  presets: PluginPreset[];
  inUse: ((root: string) => string)[];
  renderChecks: PluginRenderCheck[];
  opGroups: PluginOpGroup[];
  prereqs: PluginPrereq[];
  childEnvs: PluginChildEnv[];
  steps: PluginStep[];
  commands: PluginCommand[];
}

/** 按登记顺序。 */
const applied: Applied[] = [];

/**
 * 随客户端下发的内置插件先排队，第一次有人来取登记表时才逐个 apply（deferBuiltin）。
 * 插件的代码要用 scene、flow 里的常量与函数，而这两个包又经登记表取插件登记的东西：
 * 模块加载期立刻 apply 的话，从 scene 进来的那条加载链上 scene 还没执行完，插件拿到的是未初始化的绑定。
 */
const pending: BuiltinPlugin[] = [];

let flushing = false;

function flush(): void {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.length > 0) registerBuiltin(pending.shift()!);
  } finally {
    flushing = false;
  }
}

/** 排队登记一个内置插件（plugins/index.ts 用）：第一次取登记表时 apply。 */
export function deferBuiltin(plugin: BuiltinPlugin): void {
  pending.push(plugin);
}

type OpListener = { add: (op: PluginOp, owner: string) => void; remove: (op: PluginOp, owner: string) => void };
const opListeners: OpListener[] = [];

/** 内置插件的缺省目录：assets/plugins/<id>/（与 flow.builtinPluginsDir 同一处，这里不 import flow 免得成环）。 */
function defaultDir(id: string): string {
  return path.join(assetsBase(), 'assets', 'plugins', id);
}

/** 登记一个内置插件：立刻执行它的 apply。id、站、操作、页面、接口重复直接报错。返回撤销登记的函数（测试用）。 */
export function registerBuiltin(plugin: BuiltinPlugin): () => void {
  flush();
  if (!/^[a-z][a-z0-9-]*$/.test(plugin.id)) throw new Error(`内置插件 id ${plugin.id} 要是小写字母、数字与连字符`);
  if (applied.some((a) => a.id === plugin.id)) throw new Error(`内置插件 ${plugin.id} 登记了两次`);
  const entry: Applied = { id: plugin.id, dir: () => plugin.dir ?? defaultDir(plugin.id), stations: [], flows: [], ops: [], pages: [], routes: [], validators: [], skills: [], blocks: [], narrations: [], presets: [], inUse: [], renderChecks: [], opGroups: [], prereqs: [], childEnvs: [], steps: [], commands: [] };
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
    flow(f) {
      if (!/^[a-z][a-z0-9-]*$/.test(f.id)) throw new Error(`${where}：流程 id ${f.id} 要是小写字母、数字与连字符`);
      if (builtinFlows.some((b) => b.id === f.id) || allApplied(entry).some((a) => a.flows.some((x) => x.id === f.id))) throw new Error(`${where}：流程 ${f.id} 已经有了`);
      if (!f.base && !f.stations) throw new Error(`${where}：流程 ${f.id} 要写 stations 或 base`);
      entry.flows.push(f);
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
    skill(desc) {
      if (allApplied(entry).some((a) => a.skills.some((x) => x.name === desc.name))) throw new Error(`${where}：渲染技能 ${desc.name} 已经有了`);
      entry.skills.push(desc);
    },
    sceneBlock(block) {
      if (allApplied(entry).some((a) => a.blocks.some((x) => x.key === block.key))) throw new Error(`${where}：镜头扩展块 ${block.key} 已经有了`);
      entry.blocks.push(block as SceneBlock);
    },
    narration(n) {
      if (n.id === 'solo' || allApplied(entry).some((a) => a.narrations.some((x) => x.id === n.id))) throw new Error(`${where}：叙事模式 ${n.id} 已经有了`);
      entry.narrations.push(n);
    },
    preset(p) {
      if (allApplied(entry).some((a) => a.presets.some((x) => x.id === p.id))) throw new Error(`${where}：新建选项 ${p.id} 已经有了`);
      entry.presets.push(p);
    },
    inUse(judge) {
      entry.inUse.push(judge);
    },
    renderCheck(c) {
      entry.renderChecks.push(c);
    },
    opGroup(g) {
      entry.opGroups.push(g);
    },
    prereq(p) {
      if (allApplied(entry).some((a) => a.prereqs.some((x) => x.id === p.id))) throw new Error(`${where}：前置资源 ${p.id} 已经有了`);
      entry.prereqs.push(p);
    },
    childEnv(e) {
      if (allApplied(entry).some((a) => a.childEnvs.some((x) => x.key === e.key))) throw new Error(`${where}：环境变量 ${e.key} 已经有了`);
      entry.childEnvs.push(e);
    },
    step(st) {
      if (allApplied(entry).some((a) => a.steps.some((x) => x.id === st.id))) throw new Error(`${where}：步骤 ${st.id} 已经有了`);
      entry.steps.push(st);
    },
    command(c) {
      if (allApplied(entry).some((a) => a.commands.some((x) => x.id === c.id))) throw new Error(`${where}：命令 ${c.id} 已经有了`);
      entry.commands.push(c);
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
  flush();
  return applied.map((a) => a.id);
}

/** 插件目录。 */
export function pluginDir(id: string): string {
  flush();
  const a = applied.find((x) => x.id === id);
  if (!a) throw new Error(`没有登记内置插件 ${id}`);
  return a.dir();
}

export interface Owned<T> {
  owner: string;
  value: T;
}

function collect<T>(pick: (a: Applied) => T[]): Owned<T>[] {
  flush();
  return applied.flatMap((a) => pick(a).map((value) => ({ owner: a.id, value })));
}

export const pluginStations = (): Owned<PluginStation>[] => collect((a) => a.stations);
export const pluginFlows = (): Owned<PluginFlow>[] => collect((a) => a.flows);
export const pluginOps = (): Owned<PluginOp>[] => collect((a) => a.ops);
export const pluginPages = (): Owned<PluginPage>[] => collect((a) => a.pages);
export const pluginRoutes = (): Owned<PluginRoute>[] => collect((a) => a.routes);
export const pluginValidators = (): Owned<PluginValidator>[] => collect((a) => a.validators);
export const pluginSkills = (): Owned<SkillDescriptor>[] => collect((a) => a.skills);
export const pluginSceneBlocks = (): Owned<SceneBlock>[] => collect((a) => a.blocks);
export const pluginNarrations = (): Owned<PluginNarration>[] => collect((a) => a.narrations);
export const pluginPresets = (): Owned<PluginPreset>[] => collect((a) => a.presets);
export const pluginRenderChecks = (): Owned<PluginRenderCheck>[] => collect((a) => a.renderChecks);
export const pluginOpGroups = (): Owned<PluginOpGroup>[] => collect((a) => a.opGroups);
export const pluginPrereqs = (): Owned<PluginPrereq>[] => collect((a) => a.prereqs);
export const pluginChildEnvs = (): Owned<PluginChildEnv>[] => collect((a) => a.childEnvs);
export const pluginSteps = (): Owned<PluginStep>[] => collect((a) => a.steps);
export const pluginCommands = (): Owned<PluginCommand>[] => collect((a) => a.commands);

/** 项目在用这个内置插件的凭据（第一个给出非空的判断）；插件没登记判断或没在用时为空串。 */
export function pluginInUse(id: string, root: string): string {
  flush();
  for (const judge of applied.find((a) => a.id === id)?.inUse ?? []) {
    const evidence = judge(root);
    if (evidence !== '') return evidence;
  }
  return '';
}

/** 这个插件登记了什么（设置页「详情」照实列出）。 */
export function pluginContents(id: string): { stations: string[]; ops: string[]; skills: string[]; blocks: string[]; pages: string[]; flows: string[]; prereqs: string[] } {
  flush();
  const a = applied.find((x) => x.id === id);
  if (!a) return { stations: [], ops: [], skills: [], blocks: [], pages: [], flows: [], prereqs: [] };
  return {
    stations: a.stations.map((s) => s.id),
    ops: a.ops.map((o) => o.name),
    skills: a.skills.map((s) => s.name),
    blocks: a.blocks.map((b) => b.key),
    pages: a.pages.map((p) => p.id),
    flows: a.flows.map((f) => f.id),
    prereqs: a.prereqs.map((p) => p.name),
  };
}

/**
 * 订阅插件登记的操作：已有的立刻补发，之后登记、撤销的照发。cli 的操作表经它 defineOp（plugin_ops.ts）。
 * 返回取消订阅的函数。
 */
export function onPluginOps(add: OpListener['add'], remove: OpListener['remove']): () => void {
  const l = { add, remove };
  flush();
  opListeners.push(l);
  for (const { owner, value } of pluginOps()) add(value, owner);
  return () => {
    const i = opListeners.indexOf(l);
    if (i >= 0) opListeners.splice(i, 1);
  };
}
