/**
 * 解析并校验 onset-station.json（清单的类型与字段分级见 manifest.ts）。错误一律带上字段位置。
 */
import * as studioview from '../studioview';
import { builtinPluginIDs } from './builtinplugins';
import { idPattern, isObject, knownFields, relativeInside, str, strings } from './fields';
import {
  checkCompatible,
  type HookEvent,
  HookEvents,
  type Manifest,
  type ManifestCommand,
  ManifestFile,
  type ManifestFlow,
  type ManifestSlot,
  ManifestVersion,
  manifestFieldNames,
  type SlotPage,
  validSemver,
} from './manifest';
import { MotionPromptID, parseMotionEffects } from './motion';
import { checkDeclared } from './parse_declared';
import {
  parseBrowser,
  parseNodes,
  parseOps,
  parsePages,
  parsePermissions,
  parseProduces,
  parseSettings,
} from './parse_sections';
import { allStageTitles, allStations, builtinFirstPages } from './registered';

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
  if (replaces !== '' && (replaces === 'host' || !allStations().some((s) => s.id === replaces))) {
    throw new Error(`station.replaces：没有内置站 ${replaces}`);
  }

  const nodes = parseNodes(raw.nodes ?? []);
  const produces = parseProduces(raw.produces ?? []);
  const ops = parseOps(raw.ops ?? []);
  const names = ops.map((o) => o.name);
  if (new Set(names).size !== names.length) throw new Error('station.ops 里有重名的操作');
  const nodeIDs = nodes.map((n) => n.id);
  if (new Set(nodeIDs).size !== nodeIDs.length) throw new Error('station.nodes 里有重名的站点');

  const pages = parsePages(raw.pages ?? []);
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
    if (!Number.isInteger(every) || (every as number) < 5 || (every as number) > 1440) {
      throw new Error(`${where}.every_minutes 要是 5–1440 的整数`);
    }
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
      if (sid !== id && (sid === 'host' || !allStations().some((b) => b.id === sid))) {
        throw new Error(`flow.stations：没有站 ${sid}（写内置站的 id 或本站的 id ${id}）`);
      }
    }
    if (new Set(stations).size !== stations.length) throw new Error('flow.stations 里有重复的站');
    const first = str(f, 'first_page', 'flow');
    const firstPages = builtinFirstPages();
    if (!firstPages.includes(first) && !pageIDs.includes(first)) {
      throw new Error(`flow.first_page 要是 ${firstPages.join('、')} 或本站页面的 id`);
    }
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
      if (ts !== 'none' && ts !== 'sentence' && ts !== 'word') {
        throw new Error('provides.tts.timestamps 要是 none / sentence / word');
      }
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
  if (new Set(rendererSkills.map((r) => r.name)).size !== rendererSkills.length) {
    throw new Error('station.renderer_skills 里有重名的技能');
  }
  const motionEffects = parseMotionEffects(raw.motion_effects, rendererSkills);
  if (id === MotionPromptID && motionEffects.length > 0) throw new Error(`station.id ${id} 与内置动效来源重名`);
  let filmStyles: Manifest['film_styles'] = null;
  if (raw.film_styles !== undefined) {
    if (!isObject(raw.film_styles)) throw new Error('station.film_styles 要是对象');
    knownFields(raw.film_styles, ['name', 'dir', 'only_referenced'], 'film_styles');
    const dir = str(raw.film_styles, 'dir', 'film_styles');
    relativeInside(dir, 'film_styles.dir');
    filmStyles = { name: str(raw.film_styles, 'name', 'film_styles'), dir };
    const only = raw.film_styles.only_referenced;
    if (only !== undefined && typeof only !== 'boolean') {
      throw new Error('station.film_styles.only_referenced 要是 true 或 false');
    }
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
    if (!Number.isInteger(height) || (height as number) < 80 || (height as number) > 1200) {
      throw new Error(`${where}.height 要是 80–1200 的整数`);
    }
    return { at, page, height: height as number };
  });
  const commands = list('commands').map((c, i): ManifestCommand => {
    const where = `commands[${i}]`;
    knownFields(c, ['name', 'description', 'page', 'prompt'], where);
    const name = str(c, 'name', where);
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(name)) throw new Error(`${where}.name 要是小写字母、数字与连字符`);
    const cmd: ManifestCommand = {
      name,
      description: str(c, 'description', where),
      page: str(c, 'page', where, false),
      prompt: str(c, 'prompt', where, false),
    };
    if ((cmd.page === '') === (cmd.prompt === '')) {
      throw new Error(`${where} 要写 page（打开页面）或 prompt（填进输入框）之一`);
    }
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
    motion_effects: motionEffects,
    film_styles: filmStyles,
    skins,
    slots,
    commands,
  };
  checkDeclared(m);
  return m;
}
