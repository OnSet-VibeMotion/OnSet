/**
 * 宿主自带的站、流程、阶段与制作提示词顺序（builtin.ts），并上内置插件在 apply 里登记的（plugin 包）。
 * 凡是要「全部的站」的地方都经这里，不直接读 builtin.ts 的常量：那里只有宿主自己的部分。
 */
import path from 'node:path';
import { assetsBase } from '../assets';
import * as plugin from '../plugin';
import { builtinFlows, builtinStations, productionPrompt, stageTitles } from './builtin';
import type { Flow, Station } from './types';

/** 宿主段落的正文目录：assets/prompts/<站>/<段>.md（随客户端下发，运行期组合与生成器读同一份）。 */
export function sectionsDir(): string {
  return path.join(assetsBase(), 'assets', 'prompts');
}

/** 一段在哪些流程里（不写时用站的 flows）。 */
function sectionFlows(s: plugin.PluginStation, sec: plugin.PluginSection): readonly string[] {
  return sec.flows ?? s.flows;
}

/** 宿主的站加内置插件登记的站（插件的站排在后面，按登记顺序）。 */
export function allStations(): Station[] {
  return [
    ...builtinStations,
    ...plugin.pluginStations().map(({ value: s }): Station => ({
      id: s.id,
      name: s.name,
      nodes: s.nodes,
      prompt: (s.sections ?? []).map((sec) => (sec.stage ? { id: sec.id, stage: sec.stage } : { id: sec.id })),
    })),
  ];
}

/** 把插件登记的站按 after 排进流程的路线（after 不在这个流程里时接在最后）。 */
function withPluginStations(id: string, base: readonly string[]): string[] {
  const stations = [...base];
  for (const { value: s } of plugin.pluginStations()) {
    if (!s.flows.includes(id) || stations.includes(s.id)) continue;
    const at = stations.indexOf(s.after);
    stations.splice(at < 0 ? stations.length : at + 1, 0, s.id);
  }
  return stations;
}

/**
 * 内置流程加内置插件登记的流程（例如歌曲讲解）。插件登记的站按 after 排进它声明的流程里；
 * 写了 base 的插件流程沿用那个流程（排好插件站之后）的路线。
 */
export function allFlows(): Flow[] {
  const host = builtinFlows.map((f): Flow => ({ ...f, stations: withPluginStations(f.id, f.stations) }));
  const extra = plugin.pluginFlows().map(({ value: f }): Flow => {
    const base = f.base ? host.find((h) => h.id === f.base) : undefined;
    if (f.base && !base) throw new Error(`内置插件的流程 ${f.id} 沿用的流程 ${f.base} 不存在`);
    const out: Flow = { id: f.id, name: f.name, stations: base ? [...base.stations] : withPluginStations(f.id, f.stations ?? []), prompt: [...f.prompt], first_page: f.first_page };
    if (f.land_first) out.land_first = true;
    if (f.stage_aliases) out.stage_aliases = { ...f.stage_aliases };
    if (f.marker) out.marker = f.marker;
    if (f.excludes) out.excludes = f.excludes;
    return out;
  });
  return [...host, ...extra];
}

/**
 * 把插件的段落按 after 插进一个段落顺序（插在锚点那一段后面；同一个锚点后面有几段时按登记顺序）。
 * keep 决定哪些段落参与。锚点不存在直接报错。
 */
function insertAfter(base: readonly string[], keep: (s: plugin.PluginStation, sec: plugin.PluginSection) => boolean, where: string): string[] {
  const order = [...base];
  for (const { value: s } of plugin.pluginStations()) {
    // 同一锚点后面有几段时，后登记的跟在先登记的后面。
    const tail = new Map<string, string>();
    for (const sec of s.sections ?? []) {
      if (sec.after === undefined || !keep(s, sec)) continue;
      const at = order.indexOf(tail.get(sec.after) ?? sec.after);
      if (at < 0) throw new Error(`内置插件的站 ${s.id} 的段落 ${sec.id} 要接在 ${sec.after} 后面，但${where}里没有这一段`);
      const ref = `${s.id}/${sec.id}`;
      order.splice(at + 1, 0, ref);
      tail.set(sec.after, ref);
    }
  }
  return order;
}

/** 接在流程提示词最后的插件段落（append）：「站/段」，按登记顺序。 */
export function appendedSections(id: string): string[] {
  const out: string[] = [];
  for (const { value: s } of plugin.pluginStations()) {
    for (const sec of s.sections ?? []) if (sec.append && sectionFlows(s, sec).includes(id)) out.push(`${s.id}/${sec.id}`);
  }
  return out;
}

/**
 * 一个流程（内置的或内置插件登记的）运行期的制作提示词段落顺序：流程自己的顺序，插件的段落按 after 插进去，
 * append 的段落接在最后。没有这个流程或它没有段落顺序（第三方流程）时报错。
 */
export function flowPrompt(id: string): string[] {
  const f = allFlows().find((x) => x.id === id);
  if (!f?.prompt) throw new Error(`流程 ${id} 没有内置的提示词段落顺序`);
  return [...insertAfter(f.prompt, (s, sec) => sectionFlows(s, sec).includes(id), `流程 ${id} 的提示词`), ...appendedSections(id)];
}

/** 自带的站归哪个内置插件（插件 apply 里登记的站）。 */
export function pluginStationOwners(): Map<string, string> {
  return new Map(plugin.pluginStations().map(({ owner, value }) => [value.id, owner]));
}

/**
 * 生成的 PROMPT-PRODUCTION.md 的段落顺序（「站/段」）：口播流程的宿主顺序，插件进口播流程、写了 after 的段落插进去。
 * append 的段落不在里面（老项目由清单的 prompt 在运行时接上）。
 */
export function productionOrder(): string[] {
  return insertAfter(productionPrompt, (s, sec) => sectionFlows(s, sec).includes('speech'), '制作提示词');
}

/** 插件段落的正文文件；宿主自己的段落（正文在 assets/prompts）为 null。 */
export function pluginSectionFile(station: string, section: string): string | null {
  for (const { owner, value: s } of plugin.pluginStations()) {
    if (s.id !== station) continue;
    const sec = (s.sections ?? []).find((x) => x.id === section);
    if (sec) return path.join(plugin.pluginDir(owner), sec.file);
  }
  return null;
}

/**
 * 各阶段的标题（「## 第六阶段：<标题>」冒号后面那段），宿主的加上插件段落声明的；按阶段在制作提示词里的先后排。
 * 第三方站往某个阶段里插说明时按标题找。
 */
export function allStageTitles(): Record<string, string> {
  const titles: Record<string, string> = { ...stageTitles };
  for (const { value: s } of plugin.pluginStations()) {
    for (const sec of s.sections ?? []) {
      if (!sec.stage) continue;
      if (!sec.title) throw new Error(`内置插件的站 ${s.id} 的阶段 ${sec.stage} 没有标题`);
      titles[sec.stage] = sec.title;
    }
  }
  const stations = allStations();
  const out: Record<string, string> = {};
  const refs = [...productionOrder(), ...allFlows().flatMap((f) => (f.prompt ? flowPrompt(f.id) : []))];
  for (const ref of refs) {
    const [sid, secID] = ref.split('/');
    const stage = stations.find((x) => x.id === sid)?.prompt.find((x) => x.id === secID)?.stage;
    if (stage && titles[stage] !== undefined) out[stage] = titles[stage];
  }
  for (const [k, v] of Object.entries(titles)) if (!(k in out)) out[k] = v;
  return out;
}
