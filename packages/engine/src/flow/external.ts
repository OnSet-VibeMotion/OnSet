/**
 * 第三方站：用户自己添加的站，am 不分发、不维护。设计见 docs/superpowers/specs/2026-11-11-流程插件-design.md。
 *
 * 一个第三方站是一个目录，根上一份 am-station.json（Manifest）。它只能声明：提示词文本、路线上的站点
 * （声明式判断）、会写的文件、子进程执行的操作。代码不进 am 的进程，操作在子进程里跑（run.ts）。
 *
 * 项目里的 article-to-motion.flow.json（LockFile）记下这个项目加了哪些站、从哪来、内容摘要；
 * 从 git 来的站按 commit 存进用户级目录，摘要对不上（被改过）就不用。`link:` 是开发用的本地目录，不核对摘要。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assetsBase } from '../assets';
import { dataDir } from '../envutil';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { StepIDs } from '../studioview';
import { gitHint, usableGit } from '../toolpath';
import { builtinStations, stageTitles } from './builtin';
import type { ExtraStation, PathRule, RouteNode, Station } from './types';

export const ManifestFile = 'am-station.json';
export const LockFile = 'article-to-motion.flow.json';
/** 第三方站的存放目录（默认 <数据目录>/am/stations）。 */
export const StationsDirEnv = 'AM_STATIONS_DIR';

export type ParamType = 'string' | 'boolean' | 'integer' | 'number' | 'strings';

export interface ManifestParam {
  type: ParamType;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface ManifestOp {
  name: string;
  summary: string;
  description?: string;
  examples?: string[];
  /** 第一个元素带 `/` 时是站目录里的相对路径，否则按 PATH 找（如 node、python3）。其余参数原样传。 */
  command: string[];
  params: Record<string, ManifestParam>;
  /** agent：编排工具能调（登记成 x_<站>_<操作> 工具）；user：只有用户在界面上点按钮才执行（发布这类对外动作）。 */
  trigger: 'agent' | 'user';
}

export interface ManifestNode {
  id: string;
  label: string;
  step: string;
  gate?: boolean;
  page?: string;
  outputs: string[];
  stale_after: string[];
  gate_files: string[];
}

/**
 * 插件自己的页面：站目录里的一个 HTML（entry），在客户端的画面面板里以沙箱 iframe 打开（studio/stations.ts）。
 * 页面碰不到 am 的接口，也连不了网，只能经宿主转交：读 reads 里声明的项目文件（以及站自己声明会写的文件）、
 * 请用户确认后执行本站的操作、把一段话填进对话框。
 */
export interface ManifestPage {
  id: string;
  label: string;
  entry: string;
  /** 页面能读的项目文件：以 `/` 结尾是目录前缀，否则是整条路径。 */
  reads: string[];
}

/** 插件的一项设置：设置页按它出表单；secret 类只交给插件自己的子进程，页面与接口都看不到值。 */
export interface ManifestSetting {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'secret';
  description: string;
  options: string[];
  default?: string | number | boolean;
}

/** 插件要的权限，添加时与设置页里给用户看。 */
export interface ManifestPermissions {
  /** 页面能拿到项目摘要（镜头、制作路线、发布信息、画幅、风格）。 */
  project: boolean;
  /** 页面能连的地址（https://域名[:端口]）。不写就完全不能连网。 */
  network: string[];
  /** 页面能请用户确认后调用的 am 操作（只限编排工具本来就能用的那些，见 pageCallableOp）。 */
  uses: string[];
}

/** 事件钩子：事件发生时自动跑本站的一条操作（只限 trigger 为 agent 的操作）。 */
export const HookEvents = ['turn.finished', 'task.finished', 'gate.confirmed', 'film.approved'] as const;
export type HookEvent = (typeof HookEvents)[number];

/** 插件页面能嵌进的自带页面。 */
export const SlotPages = ['script', 'storyboard', 'scene', 'final', 'publish', 'progress'] as const;
export type SlotPage = (typeof SlotPages)[number];

export interface ManifestSlot {
  at: SlotPage;
  page: string;
  /** iframe 高度（像素），缺省 240。 */
  height: number;
}

/** 第三方站带来的流程。stations 里写内置站的 id 与本站自己的 id（本站的站点排在那里）。 */
export interface ManifestFlow {
  name: string;
  stations: string[];
  /** 顶栏第一步：script、beat，或本站页面的 id。 */
  first_page: string;
  /** 这套流程的制作提示词（替换项目里 PROMPT-PRODUCTION.md 的各阶段，am 的公共约定照旧在前）。 */
  prompt: string;
}

/** 对话输入框的斜杠命令：打开本站的页面，或把一段话填进输入框。 */
export interface ManifestCommand {
  name: string;
  description: string;
  page: string;
  prompt: string;
}

export interface Manifest {
  id: string;
  version: string;
  name: string;
  /** 一句话说明它做什么（设置页显示）。 */
  description: string;
  after: string;
  replaces: string;
  prompt: string;
  nodes: ManifestNode[];
  produces: PathRule[];
  ops: ManifestOp[];
  pages: ManifestPage[];
  settings: ManifestSetting[];
  permissions: ManifestPermissions;
  hooks: { on: HookEvent; op: string }[];
  /** 定时：客户端开着、项目打开着时，每隔 every_minutes 分钟跑一次本站的操作（只限 agent 操作）。 */
  schedules: { every_minutes: number; op: string }[];
  /** 插进制作提示词某个阶段末尾的说明（stage 是阶段名，见 flow.stageTitles）。 */
  inserts: { stage: string; file: string }[];
  /** 整套流程（新片型）：项目在设置页选用它后，制作路线、顶栏第一步与制作提示词都换成它的。 */
  flow: ManifestFlow | null;
  /** 这个站提供的配音、对齐工具：项目把 TTS_PROVIDER / ALIGN_PROVIDER 设成 x:<站 id> 时，编排工具用这条操作。 */
  provides: { tts?: { name: string; op: string; timestamps: 'none' | 'sentence' | 'word' }; align?: { name: string; op: string } };
  /**
   * 给渲染器的技能（站目录里含 SKILL.md 的目录）。scenes 为 all 时每个镜头都带上——加上它，已渲染的镜头
   * 会标成要重渲染（渲染输入变了）；opt-in 时只有 scene.json 的 plugin_skills 点名的镜头带上。
   */
  renderer_skills: { name: string; dir: string; summary: string; scenes: 'all' | 'opt-in' }[];
  /** 整片风格库：dir 下每个子目录是一种风格（STYLE.md 必需，SKILL.md、poster.jpg、style.json 可选）。 */
  film_styles: { name: string; dir: string } | null;
  /**
   * 只有内置插件（assets/plugins/）能写：认领的 am 自带操作。项目关掉这个插件时，这些操作不再出现在
   * 编排工具的工具列表里。代码仍在引擎里，认领的只是归属与开关。
   */
  am_ops: string[];
  /**
   * 只有内置插件能写：认领 am 注册的渲染技能（scene.registeredSkills 里的名字）。项目关掉这个插件时，
   * 渲染器拿不到这些技能，提示词里也没有它们那一段——已渲染的镜头因此要重渲染。
   */
  am_skills: string[];
  /** 项目在用这个插件的凭据文件（例如 song.yaml）：存在时不许在这个项目里关掉它。 */
  in_use: string[];
  slots: ManifestSlot[];
  commands: ManifestCommand[];
}

export interface LockEntry {
  id: string;
  version: string;
  /** 添加时写的来源：`link:/绝对路径`、`github:owner/repo#ref`、git 地址加 `#ref`。 */
  source: string;
  /** git 来源的 commit；link 为空。 */
  commit: string;
  /** 站目录的内容摘要；link 为空。 */
  digest: string;
}

export interface Lock {
  version: 1;
  /** 选用了哪个站带来的流程（站 id）；空是内置流程。 */
  flow?: string;
  /** 这个项目关掉的内置插件。 */
  disabled?: string[];
  stations: LockEntry[];
}

/** 一个已加进项目、读得到的第三方站。 */
export interface LoadedStation {
  entry: LockEntry;
  dir: string;
  manifest: Manifest;
  /** 随 ArticleToMotion 下发的内置插件（assets/plugins/），不是用户加的。 */
  builtin?: boolean;
}

// ---------------------------------------------------------------------------
// 清单

const idPattern = /^[a-z][a-z0-9-]{1,39}$/;
const opPattern = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const paramTypes: readonly ParamType[] = ['string', 'boolean', 'integer', 'number', 'strings'];
/** 客户端自己的状态与账，第三方站不能声明会写它们。 */
const reservedPrefixes = ['production/studio/', 'production/usage/', 'production/memory-exams/', '.agents/', '.env'];

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(raw: Record<string, unknown>, key: string, where: string, required = true): string {
  const v = raw[key];
  if (v === undefined && !required) return '';
  if (typeof v !== 'string' || (required && v.trim() === '')) throw new Error(`${where}.${key} 要是非空字符串`);
  return v;
}

function strings(raw: Record<string, unknown>, key: string, where: string): string[] {
  const v = raw[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x === '')) throw new Error(`${where}.${key} 要是字符串数组`);
  return v as string[];
}

/** 项目里的相对路径：不能是绝对路径、不能有 `..`、不能碰客户端自己的状态。 */
function projectPath(p: string, where: string): string {
  const norm = p.replaceAll('\\', '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')) throw new Error(`${where}：${p} 要是项目里的相对路径`);
  if (reservedPrefixes.some((r) => norm === r.replace(/\/$/, '') || norm.startsWith(r))) throw new Error(`${where}：${p} 是 am 自己的文件，第三方站不能声明`);
  return norm;
}

function knownFields(raw: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new Error(`${where} 有不认识的字段：${extra.sort(compareBytes).join('、')}`);
}

/** 解析并校验 am-station.json。错误一律带上字段位置。 */
export function parseManifest(text: string, opts: { builtin?: boolean } = {}): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${ManifestFile} 不是合法的 JSON：${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`${ManifestFile} 要是一个对象`);
  knownFields(raw, ['id', 'version', 'name', 'description', 'after', 'replaces', 'prompt', 'nodes', 'produces', 'ops', 'pages', 'settings', 'permissions', 'hooks', 'schedules', 'inserts', 'flow', 'provides', 'renderer_skills', 'film_styles', 'am_ops', 'am_skills', 'in_use', 'slots', 'commands'], ManifestFile);
  const id = str(raw, 'id', 'station');
  if (!idPattern.test(id)) throw new Error(`station.id ${id} 要是小写字母开头的小写字母、数字与连字符（2–40 个字符）`);
  if (builtinStations.some((s) => s.id === id)) throw new Error(`station.id ${id} 与内置站重名`);
  if (!opts.builtin && builtinPluginIDs().includes(id)) throw new Error(`station.id ${id} 与内置插件重名`);
  const replaces = str(raw, 'replaces', 'station', false);
  if (replaces !== '' && (replaces === 'host' || !builtinStations.some((s) => s.id === replaces))) throw new Error(`station.replaces：没有内置站 ${replaces}`);

  const nodesRaw = raw.nodes ?? [];
  if (!Array.isArray(nodesRaw)) throw new Error('station.nodes 要是数组');
  const nodes = nodesRaw.map((n, i): ManifestNode => {
    const where = `nodes[${i}]`;
    if (!isObject(n)) throw new Error(`${where} 要是对象`);
    knownFields(n, ['id', 'label', 'step', 'gate', 'page', 'outputs', 'stale_after', 'gate_files'], where);
    const step = str(n, 'step', where);
    if (!StepIDs.includes(step)) throw new Error(`${where}.step 要是 ${StepIDs.join(' / ')} 之一`);
    const gate = n.gate === true;
    const node: ManifestNode = {
      id: str(n, 'id', where),
      label: str(n, 'label', where),
      step,
      outputs: strings(n, 'outputs', where).map((p) => projectPath(p, `${where}.outputs`)),
      stale_after: strings(n, 'stale_after', where),
      gate_files: strings(n, 'gate_files', where).map((p) => projectPath(p, `${where}.gate_files`)),
    };
    if (!idPattern.test(node.id)) throw new Error(`${where}.id ${node.id} 要是小写字母、数字与连字符`);
    if (gate) node.gate = true;
    if (n.page !== undefined) node.page = str(n, 'page', where);
    if (!gate && node.outputs.length === 0) throw new Error(`${where} 不是关卡，要写 outputs（据此判断做没做）`);
    if (gate && node.gate_files.length === 0) throw new Error(`${where} 是关卡，要写 gate_files（确认的是哪些文件）`);
    return node;
  });

  const producesRaw = raw.produces ?? [];
  if (!Array.isArray(producesRaw)) throw new Error('station.produces 要是数组');
  const produces = producesRaw.map((r, i): PathRule => {
    const where = `produces[${i}]`;
    if (!isObject(r)) throw new Error(`${where} 要是对象`);
    knownFields(r, ['path', 'prefix', 'base'], where);
    if (typeof r.path === 'string') {
      if (r.prefix !== undefined || r.base !== undefined) throw new Error(`${where} 写了 path 就不能再写 prefix / base`);
      return { path: projectPath(r.path, where) };
    }
    const prefix = projectPath(str(r, 'prefix', where), where);
    if (r.base === undefined) return { prefix };
    try {
      return { prefix, base: new RegExp(str(r, 'base', where)) };
    } catch (err) {
      throw new Error(`${where}.base 不是合法的正则：${(err as Error).message}`);
    }
  });

  const opsRaw = raw.ops ?? [];
  if (!Array.isArray(opsRaw)) throw new Error('station.ops 要是数组');
  const ops = opsRaw.map((o, i): ManifestOp => {
    const where = `ops[${i}]`;
    if (!isObject(o)) throw new Error(`${where} 要是对象`);
    knownFields(o, ['name', 'summary', 'description', 'examples', 'command', 'params', 'trigger'], where);
    const name = str(o, 'name', where);
    if (!opPattern.test(name)) throw new Error(`${where}.name ${name} 要是小写加下划线`);
    const command = strings(o, 'command', where);
    if (command.length === 0) throw new Error(`${where}.command 不能为空`);
    if (command[0].includes('/') || command[0].includes('\\')) relativeInside(command[0], `${where}.command[0]`);
    const trigger = o.trigger === undefined ? 'agent' : o.trigger;
    if (trigger !== 'agent' && trigger !== 'user') throw new Error(`${where}.trigger 要是 agent 或 user`);
    const paramsRaw = o.params ?? {};
    if (!isObject(paramsRaw)) throw new Error(`${where}.params 要是对象`);
    const params: Record<string, ManifestParam> = {};
    for (const [key, spec] of Object.entries(paramsRaw)) {
      const pw = `${where}.params.${key}`;
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`${pw}：参数名要是小写加下划线`);
      if (!isObject(spec)) throw new Error(`${pw} 要是对象`);
      knownFields(spec, ['type', 'description', 'required', 'default'], pw);
      if (!paramTypes.includes(spec.type as ParamType)) throw new Error(`${pw}.type 要是 ${paramTypes.join(' / ')} 之一`);
      params[key] = { type: spec.type as ParamType, description: str(spec, 'description', pw) };
      if (spec.required === true) params[key].required = true;
      if (spec.default !== undefined) params[key].default = spec.default;
    }
    const op: ManifestOp = { name, summary: str(o, 'summary', where), command, params, trigger };
    if (o.description !== undefined) op.description = str(o, 'description', where);
    const examples = strings(o, 'examples', where);
    if (examples.length > 0) op.examples = examples;
    return op;
  });
  const names = ops.map((o) => o.name);
  if (new Set(names).size !== names.length) throw new Error('station.ops 里有重名的操作');
  const nodeIDs = nodes.map((n) => n.id);
  if (new Set(nodeIDs).size !== nodeIDs.length) throw new Error('station.nodes 里有重名的站点');

  const pagesRaw = raw.pages ?? [];
  if (!Array.isArray(pagesRaw)) throw new Error('station.pages 要是数组');
  const pages = pagesRaw.map((pg, i): ManifestPage => {
    const where = `pages[${i}]`;
    if (!isObject(pg)) throw new Error(`${where} 要是对象`);
    knownFields(pg, ['id', 'label', 'entry', 'reads'], where);
    const page: ManifestPage = {
      id: str(pg, 'id', where),
      label: str(pg, 'label', where),
      entry: str(pg, 'entry', where),
      reads: strings(pg, 'reads', where).map((p) => projectPath(p, `${where}.reads`)),
    };
    if (!idPattern.test(page.id)) throw new Error(`${where}.id ${page.id} 要是小写字母、数字与连字符`);
    relativeInside(page.entry, `${where}.entry`);
    if (!/\.html?$/.test(page.entry)) throw new Error(`${where}.entry 要是 .html 文件`);
    return page;
  });
  const pageIDs = pages.map((pg) => pg.id);
  if (new Set(pageIDs).size !== pageIDs.length) throw new Error('station.pages 里有重名的页面');

  const settings = parseSettings(raw.settings);
  const permissions = parsePermissions(raw.permissions);
  const list = (key: string): Record<string, unknown>[] => {
    const v = raw[key] ?? [];
    if (!Array.isArray(v) || v.some((x) => !isObject(x))) throw new Error(`station.${key} 要是对象数组`);
    return v as Record<string, unknown>[];
  };
  const hooks = list('hooks').map((h, i) => {
    const where = `hooks[${i}]`;
    knownFields(h, ['on', 'op'], where);
    const on = str(h, 'on', where) as HookEvent;
    if (!HookEvents.includes(on)) throw new Error(`${where}.on 要是 ${HookEvents.join(' / ')} 之一`);
    const op = ops.find((o) => o.name === str(h, 'op', where));
    if (!op) throw new Error(`${where}.op：没有操作 ${String(h.op)}`);
    if (op.trigger !== 'agent') throw new Error(`${where}.op：${op.name} 只能由用户触发，不能挂在事件上自动跑`);
    return { on, op: op.name };
  });
  const schedules = list('schedules').map((sc, i) => {
    const where = `schedules[${i}]`;
    knownFields(sc, ['every_minutes', 'op'], where);
    const every = sc.every_minutes;
    if (!Number.isInteger(every) || (every as number) < 5 || (every as number) > 1440) throw new Error(`${where}.every_minutes 要是 5–1440 的整数`);
    const op = ops.find((o) => o.name === str(sc, 'op', where));
    if (!op) throw new Error(`${where}.op：没有操作 ${String(sc.op)}`);
    if (op.trigger !== 'agent') throw new Error(`${where}.op：${op.name} 只能由用户触发，不能定时跑`);
    return { every_minutes: every as number, op: op.name };
  });
  const inserts = list('inserts').map((ins, i) => {
    const where = `inserts[${i}]`;
    knownFields(ins, ['stage', 'file'], where);
    const stage = str(ins, 'stage', where);
    if (!(stage in stageTitles)) throw new Error(`${where}.stage 要是 ${Object.keys(stageTitles).join(' / ')} 之一`);
    const file = str(ins, 'file', where);
    relativeInside(file, `${where}.file`);
    return { stage, file };
  });
  let flowDef: ManifestFlow | null = null;
  if (raw.flow !== undefined) {
    if (!isObject(raw.flow)) throw new Error('station.flow 要是对象');
    const f = raw.flow;
    knownFields(f, ['name', 'stations', 'first_page', 'prompt'], 'flow');
    const stations = strings(f, 'stations', 'flow');
    if (stations.length === 0) throw new Error('flow.stations 不能为空');
    for (const sid of stations) {
      if (sid !== id && (sid === 'host' || !builtinStations.some((b) => b.id === sid))) throw new Error(`flow.stations：没有站 ${sid}（写内置站的 id 或本站的 id ${id}）`);
    }
    if (new Set(stations).size !== stations.length) throw new Error('flow.stations 里有重复的站');
    const first = str(f, 'first_page', 'flow');
    if (first !== 'script' && first !== 'beat' && !pageIDs.includes(first)) throw new Error(`flow.first_page 要是 script、beat 或本站页面的 id`);
    const fp = str(f, 'prompt', 'flow');
    relativeInside(fp, 'flow.prompt');
    flowDef = { name: str(f, 'name', 'flow'), stations, first_page: first, prompt: fp };
  }
  const provides: Manifest['provides'] = {};
  if (raw.provides !== undefined) {
    if (!isObject(raw.provides)) throw new Error('station.provides 要是对象');
    knownFields(raw.provides, ['tts', 'align'], 'provides');
    const agentOp = (where: string, v: Record<string, unknown>) => {
      const op = ops.find((o) => o.name === str(v, 'op', where));
      if (!op) throw new Error(`${where}.op：没有操作 ${String(v.op)}`);
      if (op.trigger !== 'agent') throw new Error(`${where}.op：${op.name} 要是编排工具能调的操作（trigger: agent）`);
      return op.name;
    };
    const t = raw.provides.tts;
    if (t !== undefined) {
      if (!isObject(t)) throw new Error('provides.tts 要是对象');
      knownFields(t, ['name', 'op', 'timestamps'], 'provides.tts');
      const ts = t.timestamps === undefined ? 'none' : t.timestamps;
      if (ts !== 'none' && ts !== 'sentence' && ts !== 'word') throw new Error('provides.tts.timestamps 要是 none / sentence / word');
      provides.tts = { name: str(t, 'name', 'provides.tts'), op: agentOp('provides.tts', t), timestamps: ts };
    }
    const a = raw.provides.align;
    if (a !== undefined) {
      if (!isObject(a)) throw new Error('provides.align 要是对象');
      knownFields(a, ['name', 'op'], 'provides.align');
      provides.align = { name: str(a, 'name', 'provides.align'), op: agentOp('provides.align', a) };
    }
  }
  const rendererSkills = list('renderer_skills').map((rs, i) => {
    const where = `renderer_skills[${i}]`;
    knownFields(rs, ['name', 'dir', 'summary', 'scenes'], where);
    const name = str(rs, 'name', where);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${where}.name 要是小写字母、数字与连字符`);
    const dir = str(rs, 'dir', where);
    relativeInside(dir, `${where}.dir`);
    const scenes = rs.scenes === undefined ? 'opt-in' : rs.scenes;
    if (scenes !== 'all' && scenes !== 'opt-in') throw new Error(`${where}.scenes 要是 all 或 opt-in`);
    return { name, dir, summary: str(rs, 'summary', where), scenes: scenes as 'all' | 'opt-in' };
  });
  if (new Set(rendererSkills.map((r) => r.name)).size !== rendererSkills.length) throw new Error('station.renderer_skills 里有重名的技能');
  const inUseFiles = strings(raw, 'in_use', 'station').map((p) => projectPath(p, 'station.in_use'));
  let filmStyles: Manifest['film_styles'] = null;
  if (raw.film_styles !== undefined) {
    if (!isObject(raw.film_styles)) throw new Error('station.film_styles 要是对象');
    knownFields(raw.film_styles, ['name', 'dir'], 'film_styles');
    const dir = str(raw.film_styles, 'dir', 'film_styles');
    relativeInside(dir, 'film_styles.dir');
    filmStyles = { name: str(raw.film_styles, 'name', 'film_styles'), dir };
  }
  const amOps = strings(raw, 'am_ops', 'station');
  if (amOps.length > 0 && !opts.builtin) throw new Error('station.am_ops：只有随 ArticleToMotion 下发的内置插件能认领 am 自带的操作');
  for (const name of amOps) if (!/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name)) throw new Error(`station.am_ops：${name} 不是操作名`);
  const amSkills = strings(raw, 'am_skills', 'station');
  if (amSkills.length > 0 && !opts.builtin) throw new Error('station.am_skills：只有随 ArticleToMotion 下发的内置插件能认领 am 的渲染技能');
  const slots = list('slots').map((sl, i): ManifestSlot => {
    const where = `slots[${i}]`;
    knownFields(sl, ['at', 'page', 'height'], where);
    const at = str(sl, 'at', where) as SlotPage;
    if (!SlotPages.includes(at)) throw new Error(`${where}.at 要是 ${SlotPages.join(' / ')} 之一`);
    const page = str(sl, 'page', where);
    if (!pageIDs.includes(page)) throw new Error(`${where}.page：没有页面 ${page}`);
    const height = sl.height === undefined ? 240 : sl.height;
    if (!Number.isInteger(height) || (height as number) < 80 || (height as number) > 1200) throw new Error(`${where}.height 要是 80–1200 的整数`);
    return { at, page, height: height as number };
  });
  const commands = list('commands').map((c, i): ManifestCommand => {
    const where = `commands[${i}]`;
    knownFields(c, ['name', 'description', 'page', 'prompt'], where);
    const name = str(c, 'name', where);
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error(`${where}.name 要是小写字母、数字与连字符`);
    const cmd: ManifestCommand = { name, description: str(c, 'description', where), page: str(c, 'page', where, false), prompt: str(c, 'prompt', where, false) };
    if ((cmd.page === '') === (cmd.prompt === '')) throw new Error(`${where} 要写 page（打开页面）或 prompt（填进输入框）之一`);
    if (cmd.page !== '' && !pageIDs.includes(cmd.page)) throw new Error(`${where}.page：没有页面 ${cmd.page}`);
    return cmd;
  });

  const prompt = str(raw, 'prompt', 'station', false);
  if (prompt !== '') relativeInside(prompt, 'station.prompt');
  return {
    id,
    version: str(raw, 'version', 'station'),
    name: str(raw, 'name', 'station'),
    description: str(raw, 'description', 'station', false),
    after: str(raw, 'after', 'station', false),
    replaces,
    prompt,
    nodes,
    produces,
    ops,
    pages,
    settings,
    permissions,
    hooks,
    schedules,
    inserts,
    flow: flowDef,
    provides,
    renderer_skills: rendererSkills,
    film_styles: filmStyles,
    am_ops: amOps,
    am_skills: amSkills,
    in_use: inUseFiles,
    slots,
    commands,
  };
}

function parseSettings(v: unknown): ManifestSetting[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('station.settings 要是数组');
  const out = v.map((x, i): ManifestSetting => {
    const where = `settings[${i}]`;
    if (!isObject(x)) throw new Error(`${where} 要是对象`);
    knownFields(x, ['key', 'label', 'type', 'description', 'options', 'default'], where);
    const key = str(x, 'key', where);
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`${where}.key 要是小写加下划线`);
    const type = str(x, 'type', where) as ManifestSetting['type'];
    if (!['string', 'number', 'boolean', 'select', 'secret'].includes(type)) throw new Error(`${where}.type 要是 string / number / boolean / select / secret 之一`);
    const options = strings(x, 'options', where);
    if (type === 'select' && options.length === 0) throw new Error(`${where} 是 select，要写 options`);
    const setting: ManifestSetting = { key, label: str(x, 'label', where), type, description: str(x, 'description', where, false), options };
    if (x.default !== undefined) {
      if (type === 'secret') throw new Error(`${where}：密钥不能有缺省值`);
      const d = x.default;
      const ok = type === 'boolean' ? typeof d === 'boolean' : type === 'number' ? typeof d === 'number' : typeof d === 'string' && (type !== 'select' || options.includes(d));
      if (!ok) throw new Error(`${where}.default 与 type 不符`);
      setting.default = d as string | number | boolean;
    }
    return setting;
  });
  const keys = out.map((x) => x.key);
  if (new Set(keys).size !== keys.length) throw new Error('station.settings 里有重名的设置');
  return out;
}

/** 插件页面不能调的 am 操作：不可逆的（归档、记忆回滚与导入）、要用户本人确认的（节拍网格）、只在一轮对话里有意义的（切页、标步骤）。 */
const pageDenied = new Set(['archive', 'memory_rollback', 'memory_import', 'memory_retire', 'memory_reject', 'memory_promote', 'beat_confirm', 'film_style_remove', 'studio_show', 'studio_step']);

/** 插件页面能不能申请调这条操作。编排工具能用的（scope 含 orchestrator）由执行进程再查一遍（AM_OP_SCOPE）。 */
export function pageCallableOp(name: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name) && !pageDenied.has(name) && !name.startsWith('station_') && name !== 'config_set';
}

function parsePermissions(v: unknown): ManifestPermissions {
  if (v === undefined) return { project: false, network: [], uses: [] };
  if (!isObject(v)) throw new Error('station.permissions 要是对象');
  knownFields(v, ['project', 'network', 'uses'], 'permissions');
  const network = strings(v, 'network', 'permissions').map((origin) => {
    let u: URL;
    try {
      u = new URL(origin);
    } catch {
      throw new Error(`permissions.network：${origin} 不是合法的地址`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'wss:') throw new Error(`permissions.network：${origin} 要是 https:// 或 wss://`);
    if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.host.includes('*')) throw new Error(`permissions.network：${origin} 只写到域名（与端口）`);
    return u.origin;
  });
  const uses = strings(v, 'uses', 'permissions');
  for (const name of uses) if (!pageCallableOp(name)) throw new Error(`permissions.uses：插件页面不能调 ${name}`);
  return { project: v.project === true, network, uses };
}


/** 站目录里的相对路径（命令、提示词），不能跑出站目录。 */
function relativeInside(p: string, where: string): void {
  const norm = p.replaceAll('\\', '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm) || norm.split('/').includes('..')) throw new Error(`${where}：${p} 要是站目录里的相对路径`);
}

/** 把清单译成路线用的站。 */
export function toExtra(m: Manifest): ExtraStation {
  const nodes = m.nodes.map((n): RouteNode => {
    const node: RouteNode = { id: n.id, label: n.label, step: n.step, declared: { outputs: n.outputs, stale_after: n.stale_after } };
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
    const first = m.flow.first_page === 'script' || m.flow.first_page === 'beat' ? m.flow.first_page : pageTab(m.id, m.flow.first_page);
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

// ---------------------------------------------------------------------------
// 目录、摘要与锁文件

export function stationsDir(env: Record<string, string | undefined>): string {
  if (env[StationsDirEnv]) return env[StationsDirEnv]!;
  const data = dataDir(env);
  if (data === '') throw new Error(`算不出第三方站的存放目录：设置 ${StationsDirEnv} 或 HOME`);
  return path.join(data, 'stations');
}

/** 站目录的内容摘要：按字节序列出全部文件（跳过 .git），逐个记相对路径与内容。 */
export function treeDigest(dir: string): string {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`第三方站里不能有符号链接：${child}`);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  walk('');
  files.sort(compareBytes);
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    const body = fs.readFileSync(path.join(dir, rel));
    hash.update(`${rel}\n${body.length}\n`);
    hash.update(body);
  }
  return 'sha256:' + hash.digest('hex');
}

export function readLock(root: string): Lock {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, LockFile), 'utf8');
  } catch {
    return { version: 1, stations: [] };
  }
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.stations)) throw new Error(`${LockFile} 格式不对`);
  const stations = raw.stations.map((e, i): LockEntry => {
    if (!isObject(e)) throw new Error(`${LockFile} 的 stations[${i}] 要是对象`);
    const get = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '');
    if (get('id') === '' || get('source') === '') throw new Error(`${LockFile} 的 stations[${i}] 缺 id 或 source`);
    return { id: get('id'), version: get('version'), source: get('source'), commit: get('commit'), digest: get('digest') };
  });
  const out: Lock = { version: 1, stations };
  if (typeof raw.flow === 'string' && raw.flow !== '') out.flow = raw.flow;
  if (Array.isArray(raw.disabled)) {
    const disabled = raw.disabled.filter((x): x is string => typeof x === 'string').sort(compareBytes);
    if (disabled.length > 0) out.disabled = disabled;
  }
  return out;
}

function writeLock(root: string, lock: Lock): void {
  const file = path.join(root, LockFile);
  if (lock.stations.length === 0 && !lock.flow && !(lock.disabled ?? []).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  atomicWrite(file, marshalIndent(lock) + '\n', 0o644);
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
function sourceDir(entry: LockEntry, env: Record<string, string | undefined>): string {
  const src = parseSource(entry.source);
  if (src.kind === 'link') return src.dir;
  return path.join(stationsDir(env), entry.id, entry.commit);
}

function readManifest(dir: string): Manifest {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, ManifestFile), 'utf8');
  } catch {
    throw new Error(`${dir} 里没有 ${ManifestFile}`);
  }
  return parseManifest(text);
}

/** 检查一个读得到的站：提示词文件在、命令文件在。 */
function checkFiles(dir: string, m: Manifest): void {
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

/**
 * 读出项目加的全部第三方站。读不到、摘要对不上、清单坏了的站不返回，原因放进 problems：
 * 制作路线、提示词照常工作，界面把问题告诉用户。
 */
export function loadProjectStations(root: string, env: Record<string, string | undefined> = process.env): { stations: LoadedStation[]; problems: string[] } {
  const out: LoadedStation[] = [];
  const problems: string[] = [];
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch (err) {
    return { stations: [], problems: [(err as Error).message] };
  }
  for (const entry of lock.stations) {
    try {
      const dir = sourceDir(entry, env);
      if (!fs.existsSync(dir)) throw new Error(`本机没有这个站（${entry.source}），在设置里重新添加`);
      if (entry.digest !== '' && treeDigest(dir) !== entry.digest) throw new Error(`内容和添加时不一样了（${dir}），为安全起见不用它；在设置里重新添加`);
      const manifest = readManifest(dir);
      if (manifest.id !== entry.id) throw new Error(`清单里的 id 是 ${manifest.id}，与记录的 ${entry.id} 不符`);
      checkFiles(dir, manifest);
      out.push({ entry, dir, manifest });
    } catch (err) {
      problems.push(`第三方站 ${entry.id}：${(err as Error).message}`);
    }
  }
  // 内置插件：默认启用，项目关掉的（锁文件 disabled）不算。排在第三方站前面，按 id 排序。
  const disabled = new Set(lock.disabled ?? []);
  const builtins = builtinPlugins().filter((b) => !disabled.has(b.manifest.id));
  return { stations: [...builtins, ...out], problems };
}

// ---------------------------------------------------------------------------
// 内置插件

/** 内置插件的目录：assets/plugins/<id>/am-station.json，随客户端下发（extraResources 带着整棵 assets）。 */
export function builtinPluginsDir(): string {
  return path.join(assetsBase(), 'assets', 'plugins');
}

let builtinCache: { dir: string; plugins: LoadedStation[] } | null = null;

/** 全部内置插件（按 id 排序）。清单坏了直接报错：那是 ArticleToMotion 自己的 bug，不能静默少一个功能。 */
export function builtinPlugins(): LoadedStation[] {
  let dir: string;
  try {
    dir = builtinPluginsDir();
  } catch {
    return [];
  }
  if (builtinCache && builtinCache.dir === dir) return builtinCache.plugins;
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort(compareBytes);
  } catch {
    names = [];
  }
  const plugins = names.map((name): LoadedStation => {
    const pluginDir = path.join(dir, name);
    const manifest = parseManifest(fs.readFileSync(path.join(pluginDir, ManifestFile), 'utf8'), { builtin: true });
    if (manifest.id !== name) throw new Error(`内置插件 ${name} 的 id 写成了 ${manifest.id}`);
    checkFiles(pluginDir, manifest);
    return { entry: { id: manifest.id, version: manifest.version, source: 'builtin', commit: '', digest: '' }, dir: pluginDir, manifest, builtin: true };
  });
  builtinCache = { dir, plugins };
  return plugins;
}

/** 内置插件的 id（第三方站不能重名）。 */
export function builtinPluginIDs(): string[] {
  return builtinPlugins().map((p) => p.manifest.id);
}

/** 这个项目关掉的内置插件认领的 am 操作：工具服务据此把它们从工具列表里拿掉。 */
export function disabledAmOps(root: string): Set<string> {
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch {
    return new Set();
  }
  const disabled = new Set(lock.disabled ?? []);
  return new Set(builtinPlugins().filter((p) => disabled.has(p.manifest.id)).flatMap((p) => p.manifest.am_ops));
}

/**
 * 镜头所在项目关掉的内置插件认领的渲染技能。从镜头目录向上找有锁文件的项目根；没有锁文件就一个都没关。
 */
export function disabledAmSkills(sceneDir: string): Set<string> {
  let current = path.resolve(sceneDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(current, LockFile))) {
      let lock: Lock;
      try {
        lock = readLock(current);
      } catch {
        return new Set();
      }
      const disabled = new Set(lock.disabled ?? []);
      return new Set(builtinPlugins().filter((p) => disabled.has(p.manifest.id)).flatMap((p) => p.manifest.am_skills));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return new Set();
}

/**
 * 打开或关掉这个项目的一个内置插件。项目正在用它（清单的 in_use 文件存在，例如歌曲讲解的 song.yaml）时不许关：
 * 关了它，正在做的片子就少了工具。
 */
export function setBuiltinEnabled(root: string, id: string, enabled: boolean): Lock {
  const plugin = builtinPlugins().find((p) => p.manifest.id === id);
  if (!plugin) throw new Error(`没有内置插件 ${id}`);
  if (!enabled) {
    const busy = inUse(root, plugin.manifest);
    if (busy !== '') throw new Error(`这个项目正在用「${plugin.manifest.name}」（有 ${busy}），不能关掉`);
  }
  const lock = readLock(root);
  const disabled = new Set(lock.disabled ?? []);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  const next: Lock = { ...lock };
  if (disabled.size > 0) next.disabled = [...disabled].sort(compareBytes);
  else delete next.disabled;
  writeLock(root, next);
  return next;
}

/** 项目在用这个内置插件的凭据文件（清单 in_use 里第一个存在的）；没有为空。 */
export function inUse(root: string, m: Manifest): string {
  return m.in_use.find((rel) => fs.existsSync(path.join(root, rel))) ?? '';
}

/** 项目路线用的第三方站。 */
export function projectExtras(root: string, env: Record<string, string | undefined> = process.env): ExtraStation[] {
  return loadProjectStations(root, env).stations.map((s) => toExtra(s.manifest));
}

/** 把站加进项目（同 id 的换成新的），返回新锁文件。 */
export function addToProject(root: string, entry: LockEntry): Lock {
  const lock = readLock(root);
  const others = lock.stations.filter((e) => e.id !== entry.id);
  const next: Lock = { ...lock, stations: [...others, entry].sort((a, b) => compareBytes(a.id, b.id)) };
  writeLock(root, next);
  return next;
}

export function removeFromProject(root: string, id: string): Lock {
  const lock = readLock(root);
  if (!lock.stations.some((e) => e.id === id)) throw new Error(`这个项目没有加第三方站 ${id}`);
  // 去掉的站带着项目选用的流程：回到内置流程。
  const next: Lock = { ...lock, stations: lock.stations.filter((e) => e.id !== id) };
  if (next.flow === id) delete next.flow;
  writeLock(root, next);
  return next;
}

/** 选用某个站带来的流程（id 为空回到内置流程）。 */
export function setProjectFlow(root: string, id: string, env: Record<string, string | undefined> = process.env): Lock {
  const lock = readLock(root);
  if (id !== '') {
    const s = loadProjectStations(root, env).stations.find((x) => x.manifest.id === id);
    if (!s) throw new Error(`这个项目没有加第三方站 ${id}`);
    if (!s.manifest.flow) throw new Error(`第三方站 ${s.manifest.name} 没有带流程`);
  }
  const next: Lock = { ...lock };
  if (id !== '') next.flow = id;
  else delete next.flow;
  writeLock(root, next);
  return next;
}

/** 项目选用的第三方流程的站；没选或读不到为 null。 */
export function activeFlowStation(root: string, stations: readonly LoadedStation[]): LoadedStation | null {
  let lock: Lock;
  try {
    lock = readLock(root);
  } catch {
    return null;
  }
  if (!lock.flow) return null;
  const s = stations.find((x) => x.manifest.id === lock.flow);
  return s?.manifest.flow ? s : null;
}

/**
 * 把第三方站的阶段说明插进项目的制作提示词：按阶段标题找到「## 第N阶段：<标题>」，插在这一阶段末尾
 * （下一个「## 」标题之前）。找不到这个阶段（老项目、别的流程）就接在最后，注明原本要插在哪。
 */
export function insertStageSections(prompt: string, stations: readonly LoadedStation[]): string {
  let out = prompt;
  const orphans: string[] = [];
  for (const s of stations) {
    for (const ins of s.manifest.inserts) {
      const body = fs.readFileSync(path.join(s.dir, ins.file), 'utf8').trim();
      const title = stageTitles[ins.stage];
      const block = `### 第三方站「${s.manifest.name}」的补充\n\n以下由用户添加的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供；与本阶段上面的约定冲突时以上面为准。\n\n${body}\n\n`;
      const lines = out.split('\n');
      const at = lines.findIndex((l) => l.startsWith('## ') && l.endsWith('：' + title));
      if (at < 0) {
        orphans.push(`### 第三方站「${s.manifest.name}」对「${title}」阶段的补充\n\n（这个项目的说明里没有这一阶段，按相应的步骤理解。）\n\n${body}`);
        continue;
      }
      let next = lines.findIndex((l, i) => i > at && l.startsWith('## '));
      if (next < 0) next = lines.length;
      // 插在下一节标题之前，前面留一个空行。
      const before = lines.slice(0, next);
      while (before.length > 0 && before[before.length - 1] === '') before.pop();
      out = [...before, '', ...block.trimEnd().split('\n'), '', ...lines.slice(next)].join('\n');
    }
  }
  if (orphans.length > 0) out = out.replace(/\n*$/, '\n\n') + orphans.join('\n\n') + '\n';
  return out;
}

/**
 * 第三方站的提示词，接在项目制作提示词后面。每一站一节，开头说明来源，并声明冲突时以上面为准。
 */
export function extraPrompt(stations: readonly LoadedStation[], existing = ''): string {
  const parts: string[] = [];
  for (const s of stations) {
    if (s.manifest.prompt === '') continue;
    const body = fs.readFileSync(path.join(s.dir, s.manifest.prompt), 'utf8').trim();
    if (s.builtin) {
      // 内置插件的说明原样接上（它本来就是制作说明的一部分，自带标题）。老项目的提示词里已经有这一节时不重复。
      const heading = body.split('\n')[0];
      if (heading !== '' && existing.includes(heading)) continue;
      parts.push(body);
      continue;
    }
    const tools = s.manifest.ops.filter((o) => o.trigger === 'agent').map((o) => '`' + toolName(s.manifest.id, o.name) + '`');
    const userOps = s.manifest.ops.filter((o) => o.trigger === 'user').map((o) => o.summary);
    const lines = [
      `## 第三方站：${s.manifest.name}`,
      '',
      `以下一节由用户添加的第三方插件「${s.manifest.name}」（${s.manifest.id} ${s.manifest.version}）提供，不是本说明的一部分；与上面的约定冲突时以上面为准。`,
    ];
    if (tools.length > 0) lines.push(`它给你的工具：${tools.join('、')}（用 tool_help 查用法）。`);
    if (userOps.length > 0) lines.push(`这些动作只能由用户在客户端里点按钮执行，你不能代做，做到那一步时请用户去点：${userOps.join('；')}。`);
    const tsNames = { none: '不带时间戳，voice.srt 照常由强制对齐生成', sentence: '带句级时间戳', word: '带字级时间戳' } as const;
    if (s.manifest.provides.tts) {
      const p = s.manifest.provides.tts;
      lines.push(`它提供配音「${p.name}」（${tsNames[p.timestamps]}）：TTS_PROVIDER 是 \`x:${s.manifest.id}\` 时，用 \`${toolName(s.manifest.id, p.op)}\` 合成配音，产物要求与其他配音路径相同。`);
    }
    if (s.manifest.provides.align) {
      const p = s.manifest.provides.align;
      lines.push(`它提供字幕对齐「${p.name}」：ALIGN_PROVIDER 是 \`x:${s.manifest.id}\` 时，用 \`${toolName(s.manifest.id, p.op)}\` 做强制对齐，结果照样交给 \`align_build()\`。`);
    }
    for (const rs of s.manifest.renderer_skills) {
      lines.push(
        rs.scenes === 'all'
          ? `它给渲染器带了技能「${rs.name}」（${rs.summary}），每个镜头都会用上，你不用做什么。`
          : `它给渲染器带了技能「${rs.name}」（${rs.summary}）：要哪个镜头用，就在那个镜头 scene.json 的 plugin_skills 里加 "${s.manifest.id}/${rs.name}"。`,
      );
    }
    for (const page of s.manifest.pages) lines.push(`它在客户端里有自己的页面「${page.label}」，要用户看时运行 \`studio_show({"page": "${pageTab(s.manifest.id, page.id)}"})\`。`);
    lines.push('', body);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
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

/**
 * 镜头要带上的第三方渲染技能：键是 plugin:<站>/<技能>，值是技能目录的绝对路径。
 * 从镜头目录向上找到有锁文件的项目根；读不出来的站不算（制作提示词那边会报错）。
 * 点名了却没有的技能直接报错：降级成「不用」会一路静默到成片。
 */
export function pluginSkillsFor(sceneDir: string, named: readonly string[], env: Record<string, string | undefined> = process.env): Record<string, string> {
  let root = '';
  let current = path.resolve(sceneDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(current, LockFile))) {
      root = current;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const out: Record<string, string> = {};
  const stations = root === '' ? [] : loadProjectStations(root, env).stations;
  for (const s of stations) {
    for (const rs of s.manifest.renderer_skills) {
      const ref = `${s.manifest.id}/${rs.name}`;
      if (rs.scenes === 'all' || named.includes(ref)) out[`plugin:${ref}`] = path.join(s.dir, rs.dir);
    }
  }
  for (const ref of named) {
    if (!(`plugin:${ref}` in out)) throw new Error(`镜头要用的插件技能 ${ref} 不在这个项目加的第三方站里`);
  }
  return out;
}
