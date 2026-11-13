import { allFlows, allStations } from './registered';
import { LockFile, readLock } from './lock';
import type { ExtraStation, Flow, FlowID, PathRule, RouteNode, Station } from './types';

export function station(id: string, extra: readonly ExtraStation[] = []): Station {
  const found = allStations().find((s) => s.id === id) ?? extra.find((x) => x.station.id === id)?.station;
  if (!found) throw new Error(`没有这个站：${id}`);
  return found;
}

export function flow(id: FlowID, extra: readonly ExtraStation[] = []): Flow {
  const found = allFlows().find((f) => f.id === id) ?? extra.find((x) => x.flow?.id === id)?.flow;
  if (!found) throw new Error(`没有这个流程：${id}`);
  return found;
}

/** 目录里没有流程记录（不是这一版新建的项目），或记录写坏了。 */
export class MissingFlowRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingFlowRecordError';
  }
}

/**
 * 新建时记下的流程（article-to-motion.flow.json 的 production.id）。没有记录、读不了锁文件、
 * 或记的流程这一版不认得，一律抛 MissingFlowRecordError：项目用哪个流程只看记录，不按 beat.yaml、song.yaml 这类文件推断。
 * 第三方插件带来的流程记成 x:<插件 id>，要这台电脑装着那个插件（extra 里有它的流程）；没装时说清楚缺哪个插件。
 */
export function recordedFlow(root: string, extra: readonly ExtraStation[] = []): FlowID {
  let rec;
  try {
    rec = readLock(root).production;
  } catch (err) {
    throw new MissingFlowRecordError(`读不了 ${LockFile}：${(err as Error).message}`);
  }
  const ids = allFlows()
    .filter((f) => f.prompt)
    .map((f) => f.id);
  if (!rec) {
    throw new MissingFlowRecordError(
      `这个目录没有流程记录：${LockFile} 里要有 "production": {"id": "<${ids.join(' | ')}>", "canvas": "<画幅>"}。` +
        '它不是用这一版 ArticleToMotion 新建的项目（旧版建的项目没有这一段）：请新建一个项目，再把文章与素材拷进去。',
    );
  }
  if (rec.id.startsWith('x:')) {
    if (extra.some((x) => x.flow?.id === rec.id)) return rec.id;
    throw new MissingPluginFlowError(rec.id.slice(2));
  }
  if (!ids.includes(rec.id)) throw new MissingFlowRecordError(`${LockFile} 记的流程 ${rec.id} 不是这一版认得的流程（可选：${ids.join('、')}）`);
  return rec.id;
}

/** 项目的流程来自一个这台电脑上没装（或读不出来、没带流程）的第三方插件。 */
export class MissingPluginFlowError extends MissingFlowRecordError {
  constructor(readonly plugin: string) {
    super(`这个项目用的是插件「${plugin}」带来的做法，这台电脑上没有装这个插件（或者它读不出来了）：在设置的「我的插件」里添加或更新它`);
    this.name = 'MissingPluginFlowError';
  }
}

/** 项目用的是哪个流程：新建时记下的（recordedFlow，没有记录直接报错）。 */
export function detectFlow(root: string, extra: readonly ExtraStation[] = []): FlowID {
  return recordedFlow(root, extra);
}

/** 路线上的一站，连同它属于哪个站。 */
export interface RouteStop {
  station: string;
  node: RouteNode;
}

/**
 * 流程的路线：按站的先后展开站点，再放进插件的站（ExtraStation：内置插件与已装的第三方插件）。同一条路线里站点 id 重复直接报错。
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

/** 可以经界面按钮记确认的关卡及其绑定文件（所有内置站，含内置插件登记的）。 */
export function gateFiles(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of allStations()) {
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
