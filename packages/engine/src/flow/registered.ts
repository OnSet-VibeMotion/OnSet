/**
 * 宿主自带的站、流程、阶段与制作提示词顺序（builtin.ts），并上内置插件在 apply 里登记的（plugin 包）。
 * 凡是要「全部的站」的地方都经这里，不直接读 builtin.ts 的常量：那里只有宿主自己的部分。
 */
import path from 'node:path';
import * as plugin from '../plugin';
import { builtinFlows, builtinStations, productionPrompt, stageTitles } from './builtin';
import type { Flow, Station } from './types';

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

/** 内置流程，插件登记的站按 after 排进它声明的流程里（after 不在这个流程里时接在最后）。 */
export function allFlows(): Flow[] {
  return builtinFlows.map((f) => {
    const stations = [...f.stations];
    for (const { value: s } of plugin.pluginStations()) {
      if (!s.flows.includes(f.id)) continue;
      const at = stations.indexOf(s.after);
      stations.splice(at < 0 ? stations.length : at + 1, 0, s.id);
    }
    return { ...f, stations };
  });
}

/** 自带的站归哪个内置插件（插件 apply 里登记的站）。 */
export function pluginStationOwners(): Map<string, string> {
  return new Map(plugin.pluginStations().map(({ owner, value }) => [value.id, owner]));
}

/**
 * 制作提示词的段落顺序（「站/段」）：宿主的顺序，插件的段落按 after 插进去（插在锚点那一段后面；
 * 同一个锚点后面有几段时按登记顺序）。锚点不存在直接报错。
 */
export function productionOrder(): string[] {
  const order = [...productionPrompt];
  for (const { value: s } of plugin.pluginStations()) {
    // 同一锚点后面有几段时，后登记的跟在先登记的后面。
    const tail = new Map<string, string>();
    for (const sec of s.sections ?? []) {
      const at = order.indexOf(tail.get(sec.after) ?? sec.after);
      if (at < 0) throw new Error(`内置插件的站 ${s.id} 的段落 ${sec.id} 要接在 ${sec.after} 后面，但没有这一段`);
      const ref = `${s.id}/${sec.id}`;
      order.splice(at + 1, 0, ref);
      tail.set(sec.after, ref);
    }
  }
  return order;
}

/** 插件段落的正文文件；宿主自己的段落（正文在 preset/gen/templates/production）为 null。 */
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
  for (const ref of productionOrder()) {
    const [sid, secID] = ref.split('/');
    const stage = stations.find((x) => x.id === sid)?.prompt.find((x) => x.id === secID)?.stage;
    if (stage && titles[stage] !== undefined) out[stage] = titles[stage];
  }
  for (const [k, v] of Object.entries(titles)) if (!(k in out)) out[k] = v;
  return out;
}
