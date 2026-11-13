import fs from 'node:fs';
import path from 'node:path';
import * as beat from '../beat';
import { builtinFlows, builtinStations, productionPrompt } from './builtin';
import { markPluginSection, stationOwners } from './external';
import { chosenFlow } from './lock';
import type { ExtraStation, Flow, FlowID, PathRule, RouteNode, Station } from './types';

export function station(id: string, extra: readonly ExtraStation[] = []): Station {
  const found = builtinStations.find((s) => s.id === id) ?? extra.find((x) => x.station.id === id)?.station;
  if (!found) throw new Error(`没有这个站：${id}`);
  return found;
}

export function flow(id: FlowID, extra: readonly ExtraStation[] = []): Flow {
  const found = builtinFlows.find((f) => f.id === id) ?? extra.find((x) => x.flow?.id === id)?.flow;
  if (!found) throw new Error(`没有这个流程：${id}`);
  return found;
}

/**
 * 项目用的是哪个流程：锁文件里选了第三方站的流程（article-to-motion.flow.json 的 flow）且那个站读得到时用它；
 * 否则按标记文件推断：有 beat.yaml 是卡点，其余（含歌曲讲解）走口播的路线。
 */
export function detectFlow(root: string, extra: readonly ExtraStation[] = []): FlowID {
  const chosen = chosenFlow(root);
  if (chosen !== '' && extra.some((x) => x.flow?.id === chosen)) return chosen;
  try {
    fs.statSync(path.join(root, beat.ConfigFile));
    return 'beat';
  } catch {
    return 'speech';
  }
}


/** 路线上的一站，连同它属于哪个站。 */
export interface RouteStop {
  station: string;
  node: RouteNode;
}

/**
 * 流程的路线：按站的先后展开站点，再放进项目加的第三方站（ExtraStation）。同一条路线里站点 id 重复直接报错。
 */
export function route(id: FlowID, extra: readonly ExtraStation[] = []): RouteStop[] {
  const out: RouteStop[] = [];
  const def = flow(id, extra);
  for (const sid of def.stations) {
    const replacement = extra.find((x) => x.replaces === sid);
    const s = replacement ? replacement.station : station(sid, extra);
    for (const node of s.nodes) out.push({ station: s.id, node });
  }
  for (const x of extra) {
    // 顶替了内置站、或者本来就写在流程里的站，已经排进去了。
    if (x.replaces !== '' || def.stations.includes(x.station.id)) continue;
    let at = out.length;
    if (x.after !== '') {
      const i = out.findIndex((r) => r.node.id === x.after);
      if (i >= 0) at = i + 1;
    }
    out.splice(at, 0, ...x.station.nodes.map((node) => ({ station: x.station.id, node })));
  }
  const seen = new Set<string>();
  for (const r of out) {
    if (seen.has(r.node.id)) throw new Error(`流程 ${id} 里站点 ${r.node.id} 出现了两次`);
    seen.add(r.node.id);
  }
  return out;
}

/** 可以经界面按钮记确认的关卡及其绑定文件（所有内置站）。 */
export function gateFiles(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of builtinStations) {
    for (const node of s.nodes) {
      if (!node.gateFiles) continue;
      if (out[node.id]) throw new Error(`关卡 ${node.id} 登记了两次`);
      out[node.id] = node.gateFiles;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 文件归站

/** 客户端自己的状态与用量账，不算任何一站的改动。 */
const hostPrefixes = ['production/studio/', 'production/usage/', 'production/memory-exams/'];

/** 规则命中时的具体程度：整条路径 3，前缀加文件名 2，只有前缀 1；同级比前缀长短。未命中为 null。 */
function ruleRank(rule: PathRule, p: string, base: string): [number, number] | null {
  if (rule.path !== undefined) return rule.path === p ? [3, p.length] : null;
  if (rule.prefix === undefined || !p.startsWith(rule.prefix)) return null;
  if (rule.base) return rule.base.test(base) ? [2, rule.prefix.length] : null;
  return [1, rule.prefix.length];
}

/**
 * 改过的文件归到流程里的哪一站；归不到的（Studio 状态、杂项、不在这个流程里的站写的）为空。
 * 几条规则都命中时取最具体的；一样具体时取路线上靠前的。
 */
export function stationOfPath(rel: string, id: FlowID, extra: readonly ExtraStation[] = []): string {
  const p = rel.replaceAll('\\', '/');
  if (hostPrefixes.some((prefix) => p.startsWith(prefix))) return '';
  const base = p.slice(p.lastIndexOf('/') + 1);
  let best = '';
  let bestRank: [number, number] = [0, 0];
  for (const { node } of route(id, extra)) {
    for (const rule of node.produces ?? []) {
      const rank = ruleRank(rule, p, base);
      if (rank && (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1]))) {
        best = node.id;
        bestRank = rank;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 制作提示词

const numerals = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 1–99 的中文数字：十、十一、二十三。 */
export function chineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 99) throw new Error(`阶段编号超出范围：${n}`);
  if (n < 10) return numerals[n];
  const tens = Math.floor(n / 10);
  return (tens === 1 ? '' : numerals[tens]) + '十' + numerals[n % 10];
}

/** 读一段提示词正文：`站/段` → 文本。 */
export type SectionReader = (station: string, section: string) => string;

/**
 * 按段落顺序拼出制作提示词，并把 `{{STAGE:…}}` / `{{STAGE_N:…}}` 换成阶段编号。
 * 段落不存在、阶段名重复、引用了没有的阶段，一律报错。
 */
export function composePrompt(order: readonly string[], read: SectionReader): string {
  const stages = new Map<string, number>();
  const parts: string[] = [];
  for (const ref of order) {
    const slash = ref.indexOf('/');
    const sid = ref.slice(0, slash);
    const sec = slash < 0 ? undefined : builtinStations.find((s) => s.id === sid)?.prompt.find((x) => x.id === ref.slice(slash + 1));
    if (!sec) throw new Error(`没有这段提示词：${ref}`);
    if (sec.stage) {
      if (stages.has(sec.stage)) throw new Error(`阶段 ${sec.stage} 出现了两次`);
      stages.set(sec.stage, stages.size + 1);
    }
    parts.push(read(sid, sec.id));
  }
  const missing: string[] = [];
  const out = parts.join('').replace(/\{\{STAGE(_N)?:([a-z][a-z0-9-]*)\}\}/g, (match: string, numberOnly: string | undefined, name: string) => {
    const n = stages.get(name);
    if (n === undefined) {
      missing.push(match);
      return match;
    }
    return numberOnly ? chineseNumber(n) : `第${chineseNumber(n)}阶段`;
  });
  if (missing.length > 0) throw new Error(`提示词引用了没有的阶段：${missing.join(' ')}`);
  return out;
}

/** 内置的制作提示词（未替换画幅占位符）。正文目录是 preset/gen/templates/production。 */
export function composeProduction(dir: string): string {
  // 内置插件认领的站，它们的段落用标记包住：项目关掉那个插件时运行时整段去掉（flow.applyPluginMarkers）。
  const owners = stationOwners();
  return composePrompt(productionPrompt, (sid, sec) => {
    const text = fs.readFileSync(path.join(dir, sid, sec + '.md'), 'utf8');
    const owner = owners.get(sid);
    return owner ? markPluginSection(owner, text) : text;
  });
}
