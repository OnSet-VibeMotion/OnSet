/**
 * 插件清单与状态序列化（供 /api/stations 与设置更新后返回）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import * as flow from '../flow';
import * as plugin from '../plugin';
import { listSkins, petPageIDs } from './skins';
import { getLastRun } from './stations_run';
import { pageURL } from './stations_ui';

/** 提示词全文给界面看（添加后可以核对它让编排工具做什么），过长截断。 */
const maxPromptChars = 20000;

export function stationJSON(root: string, s: flow.LoadedStation): Record<string, unknown> {
  let prompt = '';
  if (s.manifest.prompt !== '') {
    try {
      prompt = fs.readFileSync(path.join(s.dir, s.manifest.prompt), 'utf8');
    } catch {
      prompt = '';
    }
  }
  if (prompt.length > maxPromptChars) prompt = prompt.slice(0, maxPromptChars) + '\n…';
  const m = s.manifest;
  const pageInfo = (id: string) => m.pages.find((pg) => pg.id === id)!;
  const settings = flow.publicSettings(envMap(), m);
  // 被皮肤拿去当桌宠的页面：插件菜单不列。
  const petPages = petPageIDs(s);
  // 内置插件的站、操作、渲染技能、页面在 apply 里登记，不在清单里：另列在 contents 里，设置页「详情」照实显示
  // 这个功能带了什么（不并进 nodes、pages：那两样给第三方站的页面与路线用）。
  const owned = <T>(list: plugin.Owned<T>[]) =>
    s.builtin ? list.filter((x) => x.owner === m.id).map((x) => x.value) : [];
  const contents = s.builtin
    ? {
        nodes: owned(plugin.pluginStations()).flatMap((st) => st.nodes.map((n) => n.label)),
        ops: owned(plugin.pluginOps())
          .filter((o) => (o.scopes ?? ['orchestrator']).includes('orchestrator'))
          .map((o) => ({ name: o.name, summary: o.summary, verb: o.verb ?? '' })),
        skills: owned(plugin.pluginSkills()).map((sk) => sk.name),
        blocks: owned(plugin.pluginSceneBlocks()).map((b) => b.key),
        pages: owned(plugin.pluginPages()).map((pg) => pg.label),
        flows: owned(plugin.pluginFlows()).map((f) => f.name),
        film_styles: owned(plugin.pluginFilmStyleSources()).map((src) => src.name()),
        skins: owned(plugin.pluginSkins()).map((sk) => sk.name),
      }
    : null;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description,
    builtin: s.builtin === true,
    contents,
    source: s.entry.source,
    commit: s.entry.commit,
    linked: s.entry.commit === '',
    /** 用到的实验性字段（以后的版本可能调整）。内置插件不标。 */
    experimental: s.builtin ? [] : flow.experimentalFields(m),
    replaces: m.replaces,
    after: m.after,
    prompt,
    nodes: m.nodes.map((n) => ({ id: n.id, label: n.label, step: n.step, gate: n.gate === true })),
    pages: m.pages.map((pg) => ({
      id: pg.id,
      label: pg.label,
      tab: flow.pageTab(m.id, pg.id),
      url: pageURL(m.id, pg.entry),
      reads: pg.reads,
      ...(petPages.includes(pg.id) ? { pet: true } : {}),
    })),
    skins: s.builtin
      ? []
      : listSkins()
          .skins.filter((e) => e.key.startsWith(m.id + '/'))
          .map((e) => e.skin.name),
    ops: m.ops.map((o) => ({
      name: o.name,
      tool: o.trigger === 'agent' ? flow.toolName(m.id, o.name) : '',
      summary: o.summary,
      description: o.description ?? '',
      trigger: o.trigger,
      /** false：不需要项目，设置页里没打开项目也能点。 */
      project: o.project !== false,
      /** 返回列表（账号卡片这类），设置里自动执行并画成卡片。 */
      list: o.list === true,
      /** false：设置里不给它出按钮表单。 */
      form: o.form !== false,
      params: Object.entries(o.params).map(([key, p]) => ({
        key,
        type: p.type,
        description: p.description,
        required: p.required === true,
        default: p.default,
      })),
      last_run: getLastRun(root, m.id, o),
    })),
    settings: m.settings.map((x) => ({
      key: x.key,
      label: x.label,
      type: x.type,
      description: x.description,
      options: x.options,
      default: x.default,
      ...(x.type === 'secret' ? { set: settings.secrets_set[x.key] === true } : { value: settings.values[x.key] }),
    })),
    permissions: m.permissions,
    browser: m.browser,
    hooks: m.hooks,
    schedules: m.schedules,
    inserts: m.inserts.map((ins) => ins.stage),
    provides: { tts: m.provides.tts?.name ?? '', align: m.provides.align?.name ?? '' },
    renderer_skills: m.renderer_skills.map((r) => ({ name: r.name, summary: r.summary, scenes: r.scenes })),
    film_styles: m.film_styles?.name ?? '',
    flow: m.flow ? { name: m.flow.name, stations: m.flow.stations, first_tab: toFirstTab(m) } : null,
    slots: m.slots.map((sl) => ({
      at: sl.at,
      page: sl.page,
      height: sl.height,
      tab: flow.pageTab(m.id, sl.page),
      url: pageURL(m.id, pageInfo(sl.page).entry),
    })),
    commands: m.commands.map((c) => ({ ...c, tab: c.page ? flow.pageTab(m.id, c.page) : '' })),
  };
}

function toFirstTab(m: flow.Manifest): string {
  if (!m.flow) return '';
  return flow.builtinFirstPages().includes(m.flow.first_page)
    ? m.flow.first_page
    : flow.pageTab(m.id, m.flow.first_page);
}

/** 全部插件；root 是当前项目（没有打开项目为空），只用来带上这个项目里最近一次执行的结果。 */
export function listStations(root: string): Record<string, unknown> {
  const { stations, problems } = flow.loadStations();
  return {
    stations: stations.map((s) => stationJSON(root, s)),
    // 读不出来的插件：设置页显示原因，给「更新 / 去掉」。
    problems: problems.map((p) => ({
      id: p.id,
      message: p.message,
      linked: p.entry ? flow.parseSource(p.entry.source).kind === 'link' : false,
    })),
  };
}
