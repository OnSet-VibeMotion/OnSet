/**
 * 制作路线：把整片制作拆成十几站，告诉用户做过什么、现在在哪、在等谁。
 *
 * 每一站做没做只看项目里的产物（不靠编排工具汇报，它会忘、会标错）；上游产物比下游新时，下游标成
 * 「上游改过」。审核关卡另记用户的确认（`production/studio/gates.json`，界面的「确认」按钮写）：
 * 记下确认时相关文件的状态，文件之后又变了就算「改过，要重新确认」；没有记录但下游已经做了的，算
 * 「已经过了」（在对话里点头的、老项目）。「做了什么」取自轮次记录：每一轮改过的文件按路径归到站上。
 */
import * as flow from '../flow';
import * as studioview from '../studioview';
import { emitStudioEvent } from './events';
import { writeError, writeJSON } from './http';
import {
  computeStations,
  latestOutput,
  type ProgressResponse,
  readProgress,
  type Station,
  type StationTurn,
  stationOfPath,
} from './progress_compute';
import {
  assertPilotGateUnlocked,
  bareWords,
  type GateRecord,
  gateFilesFor,
  gateIDs,
  gatesPath,
  readGates,
  recordGate,
} from './progress_gates';
import { stationDefs } from './progress_judges';
import { scheduleGateHandoff } from './sessions';
import type { Server } from './studio';

export {
  assertPilotGateUnlocked,
  computeStations,
  gateIDs,
  gatesPath,
  latestOutput,
  type ProgressResponse,
  readGates,
  readProgress,
  recordGate,
  type Station,
  type StationTurn,
  stationDefs,
  stationOfPath,
};

/**
 * 用户在对话里确认了关卡（编排工具调 studio_confirm）：记下它，与界面上点「确认」同一份记录，另存用户的原话。
 * 编排工具不能替用户确认：said 必须真的出现在这一轮用户发的话里（message），不然拒绝。
 * 没指定关卡时记路线上此刻在等用户确认的那一个。
 */
export function confirmGateFromChat(
  root: string,
  message: string,
  said: string,
  gate = '',
  now = new Date(),
): { gate: string; label: string; record: GateRecord } {
  const quote = said.trim();
  if (bareWords(quote).length < 2) throw new Error('said 要写用户确认时的原话');
  if (!bareWords(message).includes(bareWords(quote))) {
    throw new Error('这一轮用户的话里没有「' + quote + '」：只有用户在对话里明确确认了，才能记下关卡');
  }
  const progress = readProgress(root);
  const files = gateFilesFor(root);
  let id = gate.trim();
  if (id !== '') {
    if (!files[id] && files[`gate-${id}`]) id = `gate-${id}`;
    if (!files[id]) throw new Error(`没有这个审核关卡：${id}（可选：${gateIDs(root).join('、')}）`);
  } else {
    const current = progress.stations.find((st) => st.id === progress.current);
    if (!current?.gate || !files[current.id]) throw new Error('路线上现在没有在等用户确认的关卡');
    id = current.id;
  }
  const label = progress.stations.find((st) => st.id === id)?.label ?? id;
  return { gate: id, label, record: recordGate(root, id, now, quote) };
}

/** 一页上的「确认」按钮记到哪个关卡：关卡 id 与内置插件登记的确认时发给 AI 的话（宿主关卡的话在界面里）。 */
export interface PageGate {
  id: string;
  confirm?: string;
}

/**
 * 这个项目当前流程的路线上，page 是这一页的第一个审核关卡（口播的分镜页是 gate-storyboard，卡点的是
 * gate-beat-storyboard）；没有为 null。界面的确认按钮按它记，不写死关卡 id。
 */
export function pageGate(root: string, page: string): PageGate | null {
  const extras = flow.stationExtras();
  let id: flow.FlowID;
  try {
    id = flow.detectFlow(root, extras);
  } catch {
    return null;
  }
  const def = stationDefs(id, extras, { pilotGate: flow.isPilotGateEnabled(root) }).find(
    (d) => d.gate && d.page === page,
  );
  if (!def) return null;
  return def.guide?.confirm ? { id: def.id, confirm: def.guide.confirm } : { id: def.id };
}

export async function progressAPI(s: Server, request: Request, rest: string): Promise<Response> {
  let root: string;
  try {
    root = s.currentProject().path;
  } catch (err) {
    return writeError(404, 'no_project', (err as Error).message);
  }
  if (rest === '') {
    if (request.method !== 'GET') return writeError(405, 'method_not_allowed', '只支持 GET');
    try {
      return writeJSON(200, readProgress(root));
    } catch (err) {
      // 没有流程记录的目录（不是这一版新建的项目）：路线无从排起，照实说缺什么。
      if (err instanceof flow.MissingFlowRecordError) return writeError(409, 'no_flow_record', err.message);
      throw err;
    }
  }
  const match = /^gates\/([a-z-]+)$/.exec(rest);
  if (!match) return writeError(404, 'not_found', 'Studio API 路径不存在');
  if (request.method !== 'POST') return writeError(405, 'method_not_allowed', '只支持 POST');
  if (!gateFilesFor(root)[match[1]]) return writeError(404, 'not_found', `没有这个审核关卡：${match[1]}`);
  try {
    const record = recordGate(root, match[1]);
    const label =
      (match[1] === flow.PilotGateID
        ? flow.pilotGateNode.label
        : flow
            .allStations()
            .flatMap((st) => st.nodes)
            .find((n) => n.id === match[1])?.label) ?? match[1];
    scheduleGateHandoff(s, root, match[1], label);
    emitStudioEvent(s, s.currentProject(), 'gate.confirmed', { gate: match[1] });
    return writeJSON(200, record);
  } catch (err) {
    return writeError(400, 'invalid_request', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// 流程声明：界面按它排顶栏，不按片型写死

/** /api/state 的 flow：这个项目用的流程，以及顶栏据此怎么排。 */
export interface FlowView {
  /** 流程 id：speech、beat、song，或第三方的 x:<站>。 */
  id: string;
  name: string;
  /** 顶栏第一步打开哪一页。 */
  first_page: string;
  /** 顶栏的步骤（页面 id），第一步是 first_page，其余是宿主的骨架（studioview.stepIDs() 里不是「第一步页」的那几个）。 */
  steps: string[];
  /** 别的流程的第一步页（这个项目用不上）：不在顶栏与更多页面里列（编排工具仍能切过去）。 */
  hidden_pages: string[];
  /** 这几个步骤标记都算第一步（编排工具 studio_step 标的 script / beat 落在第一步上）。 */
  first_steps: string[];
  /** 还没有镜头时打开项目先落在这一页；用不上的页（hidden_pages）也改切到它。空是不落。 */
  land_page: string;
}

export function flowView(root: string): FlowView {
  const extras = flow.stationExtras();
  const id = flow.detectFlow(root, extras);
  const def = flow.flow(id, extras);
  const firstPages = flow.builtinFirstPages();
  // 第三方流程的第一页可以是自带的第一页（口播稿、节拍）或插件自己的页面：用不上的自带第一页、
  // 落在哪一页按第一页是自带的哪一页的那个片型；是插件页面时按口播。
  const base = id.startsWith('x:')
    ? (flow.allFlows().find((f) => f.prompt && (f.first_page ?? 'script') === def.first_page) ?? flow.flow('speech'))
    : def;
  const baseFirst = base.first_page ?? 'script';
  const first = def.first_page ?? baseFirst;
  return {
    id,
    name: def.name,
    first_page: first,
    steps: [first, ...stepsAfterFirst(firstPages)],
    hidden_pages: firstPages.filter((p) => p !== baseFirst),
    first_steps: [...new Set([first, ...firstPages])],
    land_page: base.land_first ? baseFirst : '',
  };
}

/** 宿主骨架里第一步之后的步骤。 */
function stepsAfterFirst(firstPages: readonly string[]): string[] {
  return studioview.stepIDs().filter((s) => !firstPages.includes(s));
}
