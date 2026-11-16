/**
 * 解析并校验 onset-station.json（清单的类型与字段分级见 manifest.ts）。错误一律带上字段位置。
 */
import { stepIDs } from '../studioview';
import { allStageTitles, allStations, builtinFirstPages } from './registered';
import { builtinPluginIDs } from './builtinplugins';
import { pageCallableOp, pageMayRead, pageTab } from './pages';
import { idPattern, isObject, knownFields, opPattern, projectPath, relativeInside, str, strings } from './fields';
import {
  checkCompatible,
  HookEvents,
  ManifestFile,
  manifestFieldNames,
  nodeFieldNames,
  opFieldNames,
  ManifestVersion,
  validSemver,
  type HookEvent,
  type Manifest,
  type ManifestCommand,
  type ManifestFlow,
  type ManifestNode,
  type ManifestOp,
  type ManifestPage,
  type ManifestParam,
  type ManifestPermissions,
  type ManifestSetting,
  type ManifestSlot,
  type ParamType,
  type SlotPage,
} from './manifest';
import * as studioview from '../studioview';
import type { DeclaredGuide, DeclaredGuideAction, DeclaredOutcome, DeclaredState, DeclaredValue, PathRule } from './types';

const paramTypes: readonly ParamType[] = ['string', 'boolean', 'integer', 'number', 'strings'];

export interface ParseOptions {
  /** 随片场下发的内置插件（assets/plugins/）：id 可以就是内置插件的 id。 */
  builtin?: boolean;
  /** 拿来比 requires.onset 的 onset 版本；缺省是当前 onset 的版本（manifest.onsetVersion）。 */
  onsetVersion?: string;
}

/** 清单格式版本与 requires：先于其他字段检查，新格式的清单才能报「要更新 onset」而不是「不认识的字段」。 */
function parseHeader(raw: Record<string, unknown>): Pick<Manifest, 'manifest_version' | 'requires'> {
  const mv = raw.manifest_version === undefined ? 1 : raw.manifest_version;
  if (!Number.isInteger(mv) || (mv as number) < 1) throw new Error('station.manifest_version 要是正整数（现在是 1）');
  const requires = { onset: '' };
  if (raw.requires !== undefined) {
    if (!isObject(raw.requires)) throw new Error('station.requires 要是对象');
    // 新格式的清单可能在 requires 里写这一版不认识的要求：格式版本更新时交给 checkCompatible 报「要更新」。
    if ((mv as number) <= ManifestVersion) knownFields(raw.requires, ['onset'], 'requires');
    const onset = str(raw.requires, 'onset', 'requires', false).trim();
    if (onset !== '' && !validSemver(onset)) throw new Error(`requires.onset 要是 x.y.z 形式的版本号：${onset}`);
    requires.onset = onset;
  }
  return { manifest_version: mv as number, requires };
}

/** 解析并校验 onset-station.json。错误一律带上字段位置。 */
export function parseManifest(text: string, opts: ParseOptions = {}): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${ManifestFile} 不是合法的 JSON：${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`${ManifestFile} 要是一个对象`);
  const header = parseHeader(raw);
  checkCompatible({ id: typeof raw.id === 'string' ? raw.id : '?', ...header }, opts.onsetVersion);
  knownFields(raw, manifestFieldNames(), ManifestFile);
  const id = str(raw, 'id', 'station');
  if (!idPattern.test(id)) throw new Error(`station.id ${id} 要是小写字母开头的小写字母、数字与连字符（2–40 个字符）`);
  if (allStations().some((s) => s.id === id)) throw new Error(`station.id ${id} 与内置站重名`);
  if (!opts.builtin && builtinPluginIDs().includes(id)) throw new Error(`station.id ${id} 与内置插件重名`);
  const replaces = str(raw, 'replaces', 'station', false);
  if (replaces !== '' && (replaces === 'host' || !allStations().some((s) => s.id === replaces))) throw new Error(`station.replaces：没有内置站 ${replaces}`);

  const nodesRaw = raw.nodes ?? [];
  if (!Array.isArray(nodesRaw)) throw new Error('station.nodes 要是数组');
  const nodes = nodesRaw.map((n, i): ManifestNode => {
    const where = `nodes[${i}]`;
    if (!isObject(n)) throw new Error(`${where} 要是对象`);
    knownFields(n, nodeFieldNames(), where);
    const step = str(n, 'step', where);
    if (!stepIDs().includes(step)) throw new Error(`${where}.step 要是 ${stepIDs().join(' / ')} 之一`);
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
    if (n.state !== undefined) {
      if (gate) throw new Error(`${where} 是关卡，不能写 state（关卡看用户的确认）`);
      node.state = parseState(n.state, `${where}.state`);
    }
    if (n.guide !== undefined) node.guide = parseGuide(n.guide, `${where}.guide`);
    if (!gate && node.outputs.length === 0 && !node.state) throw new Error(`${where} 不是关卡，要写 outputs 或 state（据此判断做没做）`);
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
    knownFields(o, opFieldNames(), where);
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
    if (o.project !== undefined) {
      if (typeof o.project !== 'boolean') throw new Error(`${where}.project 要是 true 或 false`);
      if (o.project === false && trigger !== 'user') throw new Error(`${where}.project：只有 trigger: user 的操作能不需要项目`);
      if (o.project === false) op.project = false;
    }
    if (o.list !== undefined) {
      if (typeof o.list !== 'boolean') throw new Error(`${where}.list 要是 true 或 false`);
      if (o.list) {
        if (trigger !== 'user' || o.project !== false) throw new Error(`${where}.list：只有 trigger: user、project: false 的操作能返回列表`);
        if (Object.values(params).some((p) => p.required)) throw new Error(`${where}.list：返回列表的操作不能有必填参数（宿主会自动执行它）`);
        op.list = true;
      }
    }
    if (o.form !== undefined) {
      if (typeof o.form !== 'boolean') throw new Error(`${where}.form 要是 true 或 false`);
      if (o.form === false && trigger !== 'user') throw new Error(`${where}.form：只有 trigger: user 的操作才有按钮表单`);
      if (o.form === false) op.form = false;
    }
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
    const titles = allStageTitles();
  if (!(stage in titles)) throw new Error(`${where}.stage 要是 ${Object.keys(titles).join(' / ')} 之一`);
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
      if (sid !== id && (sid === 'host' || !allStations().some((b) => b.id === sid))) throw new Error(`flow.stations：没有站 ${sid}（写内置站的 id 或本站的 id ${id}）`);
    }
    if (new Set(stations).size !== stations.length) throw new Error('flow.stations 里有重复的站');
    const first = str(f, 'first_page', 'flow');
    const firstPages = builtinFirstPages();
    if (!firstPages.includes(first) && !pageIDs.includes(first)) throw new Error(`flow.first_page 要是 ${firstPages.join('、')} 或本站页面的 id`);
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
  let filmStyles: Manifest['film_styles'] = null;
  if (raw.film_styles !== undefined) {
    if (!isObject(raw.film_styles)) throw new Error('station.film_styles 要是对象');
    knownFields(raw.film_styles, ['name', 'dir', 'only_referenced'], 'film_styles');
    const dir = str(raw.film_styles, 'dir', 'film_styles');
    relativeInside(dir, 'film_styles.dir');
    filmStyles = { name: str(raw.film_styles, 'name', 'film_styles'), dir };
    const only = raw.film_styles.only_referenced;
    if (only !== undefined && typeof only !== 'boolean') throw new Error('station.film_styles.only_referenced 要是 true 或 false');
    if (only === true) filmStyles.only_referenced = true;
  }
  const skins = strings(raw, 'skins', 'station');
  skins.forEach((f, i) => {
    relativeInside(f, `station.skins[${i}]`);
    if (!f.endsWith('.json')) throw new Error(`station.skins[${i}]：${f} 要是 .json 文件`);
  });
  if (new Set(skins).size !== skins.length) throw new Error('station.skins 里有重复的文件');
  const slots = list('slots').map((sl, i): ManifestSlot => {
    const where = `slots[${i}]`;
    knownFields(sl, ['at', 'page', 'height'], where);
    const at = str(sl, 'at', where) as SlotPage;
    const slotPages = studioview.slotPages();
    if (!slotPages.includes(at)) throw new Error(`${where}.at 要是 ${slotPages.join(' / ')} 之一`);
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
  const m: Manifest = {
    ...header,
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
    ...(raw.browser === undefined ? {} : { browser: parseBrowser(raw.browser) }),
    hooks,
    schedules,
    inserts,
    flow: flowDef,
    provides,
    renderer_skills: rendererSkills,
    film_styles: filmStyles,
    skins,
    slots,
    commands,
  };
  checkDeclared(m);
  return m;
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

// ---------------------------------------------------------------------------
// 站点的声明式状态（nodes[].state）与「接下来」（nodes[].guide）

const keySegment = /^[A-Za-z0-9_-]+$/;

function isScalar(x: unknown): x is DeclaredValue {
  return typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
}

function parseOutcome(v: unknown, where: string): DeclaredOutcome {
  if (!isObject(v)) throw new Error(`${where} 要是对象`);
  knownFields(v, ['status', 'detail', 'waiting', 'guide'], where);
  const status = v.status === undefined ? 'todo' : v.status;
  if (status !== 'todo' && status !== 'doing' && status !== 'done') throw new Error(`${where}.status 要是 todo / doing / done 之一`);
  const out: DeclaredOutcome = { status };
  if (v.detail !== undefined) out.detail = str(v, 'detail', where);
  if (v.waiting !== undefined) {
    if (v.waiting !== 'user' && v.waiting !== 'ai') throw new Error(`${where}.waiting 要是 user 或 ai`);
    out.waiting = v.waiting;
  }
  if (v.guide !== undefined) out.guide = parseGuide(v.guide, `${where}.guide`);
  return out;
}

function parseState(v: unknown, where: string): DeclaredState {
  if (!isObject(v)) throw new Error(`${where} 要是对象`);
  knownFields(v, ['file', 'json', 'frontmatter', 'cases', 'otherwise', 'missing', 'invalid', 'no_field'], where);
  const file = projectPath(str(v, 'file', where), `${where}.file`);
  if ((v.json === undefined) === (v.frontmatter === undefined)) throw new Error(`${where} 要写 json 或 frontmatter 之一（读哪个字段）`);
  const format = v.json !== undefined ? 'json' : 'frontmatter';
  const key = str(v, format, where).split('.');
  if (key.some((k) => !keySegment.test(k))) throw new Error(`${where}.${format} 要是用 . 分隔的键（字母、数字、下划线与连字符）`);
  if (!Array.isArray(v.cases) || v.cases.length === 0) throw new Error(`${where}.cases 要是非空数组`);
  const cases = v.cases.map((c, i) => {
    const cw = `${where}.cases[${i}]`;
    if (!isObject(c)) throw new Error(`${cw} 要是对象`);
    const { is, ...rest } = c;
    const raw = Array.isArray(is) ? is : [is];
    if (raw.length === 0 || !raw.every(isScalar)) throw new Error(`${cw}.is 要是字符串、数字、布尔，或它们的数组`);
    return { is: raw, ...parseOutcome(rest, cw) };
  });
  const state: DeclaredState = { file, format, key, cases };
  for (const k of ['otherwise', 'missing', 'invalid', 'no_field'] as const) {
    if (v[k] !== undefined) state[k] = parseOutcome(v[k], `${where}.${k}`);
  }
  return state;
}

function parseGuide(v: unknown, where: string): DeclaredGuide {
  if (!isObject(v)) throw new Error(`${where} 要是对象`);
  knownFields(v, ['ai', 'user', 'actions'], where);
  const guide: DeclaredGuide = {};
  if (v.ai !== undefined) guide.ai = str(v, 'ai', where);
  if (v.user !== undefined) guide.user = str(v, 'user', where);
  if (v.actions !== undefined) {
    if (!Array.isArray(v.actions)) throw new Error(`${where}.actions 要是数组`);
    guide.actions = v.actions.map((a, i): DeclaredGuideAction => {
      const aw = `${where}.actions[${i}]`;
      if (!isObject(a)) throw new Error(`${aw} 要是对象`);
      knownFields(a, ['label', 'say', 'draft', 'page', 'op'], aw);
      const label = str(a, 'label', aw);
      const kinds = (['say', 'draft', 'page', 'op'] as const).filter((k) => a[k] !== undefined);
      if (kinds.length !== 1) throw new Error(`${aw} 要在 say、draft、page、op 里写且只写一个`);
      const kind = kinds[0];
      const value = str(a, kind, aw);
      if (kind === 'page') return { kind, label, page: value };
      if (kind === 'op') return { kind, label, station: '', op: value, summary: '' };
      return { kind, label, text: value };
    });
  }
  return guide;
}

/** 整份清单解析完再查：state 读的文件要在本站能读的范围里，按钮指向的操作与页面要存在。 */
function checkDeclared(m: Manifest): void {
  const fixGuide = (g: DeclaredGuide | undefined, where: string) => {
    g?.actions?.forEach((a, i) => {
      const aw = `${where}.actions[${i}]`;
      if (a.kind === 'page') {
        if (m.pages.some((pg) => pg.id === a.page)) a.page = pageTab(m.id, a.page);
        else if (!studioview.viewPage(a.page)) throw new Error(`${aw}.page：没有页面 ${a.page}`);
      }
      if (a.kind === 'op') {
        const op = m.ops.find((o) => o.name === a.op);
        if (!op) throw new Error(`${aw}.op：没有操作 ${a.op}`);
        if (op.trigger !== 'user') throw new Error(`${aw}.op：${op.name} 不是 trigger: user 的操作`);
        if (Object.values(op.params).some((p) => p.required)) throw new Error(`${aw}.op：${op.name} 有必填参数，按钮填不了，改用 page 指向能填参数的页面`);
        a.station = m.id;
        a.summary = op.summary;
      }
    });
  };
  m.nodes.forEach((n, i) => {
    const where = `nodes[${i}]`;
    fixGuide(n.guide, `${where}.guide`);
    if (!n.state) return;
    if (!pageMayRead(m, n.state.file)) throw new Error(`${where}.state.file：${n.state.file} 不在本站的 produces、outputs 或页面 reads 里`);
    n.state.cases.forEach((c, j) => fixGuide(c.guide, `${where}.state.cases[${j}].guide`));
    for (const k of ['otherwise', 'missing', 'invalid', 'no_field'] as const) fixGuide(n.state[k]?.guide, `${where}.state.${k}.guide`);
  });
}

function parseBrowser(value: unknown): { origins: string[] } {
  if (!isObject(value)) throw new Error('browser 要是对象');
  knownFields(value, ['origins'], 'browser');
  const origins = strings(value, 'origins', 'browser');
  if (origins.length === 0 || origins.length > 20) throw new Error('browser.origins 要有 1–20 个 HTTPS 来源');
  return { origins: [...new Set(origins.map(origin => {
    let url: URL;
    try { url = new URL(origin); } catch { throw new Error('browser.origins 地址无效'); }
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.hostname.includes('*')) throw new Error('browser.origins 只写 HTTPS 来源（域名与可选端口）');
    return url.origin;
  }))] };
}
