/**
 * 记忆面板。移植自 internal/studio/memory.go。
 *
 * 读接口直接读记忆库（只读，不记快照）；面板上的操作都经 am memory 子命令。
 * 唯一的例外是对话信号（recordUtterance）：每轮结束、每次回退各追加一段经历，
 * 只增不改，不碰项目文件，为它每轮起一个子进程不值得。
 */
import path from 'node:path';
import * as config from '../config';
import { envMap } from '../envutil';
import { formatFixed, goTrimSpace } from '../gofmt';
import { sortedKeys } from '../gojson';
import * as memory from '../memory';
import * as scene from '../scene';
import * as tools from '../tools';
import { DecodeError, decodeJSON, fieldBool, fieldInt, fieldNumberPtr, fieldNumbers, fieldString, fieldStrings, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { discoverScenes, fileExists } from './scenes';
import type { Project, Server } from './studio';
import { addTask, runStudioOp, runTask, runWriteTask, writeTaskError } from './tasks';
import type { Turn } from './turns';

function memoryStore(s: Server): { p: Project; cfg: config.Config; store: memory.Store } | Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let cfg: config.Config;
  try {
    cfg = config.load(p.path, null);
  } catch (err) {
    return writeError(400, 'invalid_config', (err as Error).message);
  }
  let store: memory.Store;
  try {
    store = memory.open(cfg.memory.dir);
  } catch (err) {
    return writeError(500, 'memory_unavailable', (err as Error).message);
  }
  return { p, cfg, store };
}

/** 对象与它的 map[string]string 标签表：按键排序写出。 */
function labels(table: Readonly<Record<string, string>>): Record<string, unknown> {
  return sortedKeys({ ...table });
}

/** GET /api/memory：记忆面板的全部数据。 */
export function memoryAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const opened = memoryStore(s);
  if (opened instanceof Response) return opened;
  const { p, cfg, store } = opened;
  try {
    const env = envMap();
    const status = store.status(false, (r) => store.currentModel(r, env));
    const all = store.memories().memories;
    const stats = memory.statsToJSON(store.stats());
    const rows = all.map((m) => ({
      ...memory.memoryToJSON(m),
      stats: Object.hasOwn(stats, m.name) ? stats[m.name] : null,
      // examinable 为 false 的试用经验只由整片检查判定，考不了，要人确认生效。
      examinable: m.kind === memory.KindLesson && memory.examinableLesson(m),
    }));
    const events = store.timeline();
    // 经历事件可能成百上千条，面板只要最近的；整理、考试这些节点事件全留。
    // 记忆库所有项目共用：本项目与其他项目的经历各留最近 50 条，网页默认只显示本项目的。
    const project = memory.projectName(p.path);
    const timeline: unknown[] = [];
    let mine = 0;
    let others = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === memory.EventEpisode) {
        if (events[i].project === project) {
          if (++mine > 50) continue;
        } else if (++others > 50) continue;
      }
      timeline.push(memory.eventToJSON(events[i]));
    }
    const views = store.exams().map((exam) => {
      const cells = (exam.cells ?? []).map((cell) => {
        const c: Record<string, unknown> = memory.cellToJSON(cell);
        // output 是这一格产物相对项目根的路径，供缩略图读取；不在项目里时不写。
        if (path.isAbsolute(cell.workdir)) {
          const rel = path.relative(p.path, path.join(cell.workdir, 'out.mp4'));
          if (!rel.startsWith('..') && fileExists(path.join(p.path, rel))) c.output = rel.split(path.sep).join('/');
        }
        return c;
      });
      // Go 的 examView 内嵌 ExamResult、再用自己的 cells 遮住它：cells 排在最后。
      const { cells: _hidden, ...rest } = memory.examResultToJSON(exam);
      return { ...rest, cells };
    });
    const episodes = store.episodes();
    let runs: memory.RunSummary[] = [];
    try {
      runs = memory.runReport(episodes).filter((r) => r.project === project);
    } catch {
      runs = [];
    }
    if (runs.length > 12) runs = runs.slice(runs.length - 12);
    const snapshots = store.snapshotIDs() ?? [];
    return writeJSON(
      200,
      goMap({
        enabled: cfg.memory.enabled,
        dir: store.dir,
        project,
        pinned: cfg.memory.snapshot,
        budget: cfg.memory.recallBudget,
        renderer: cfg.renderer,
        status: memory.statusReportToJSON(status),
        memories: rows,
        timeline,
        exams: views,
        snapshots,
        runs: runs.map(memory.runSummaryToJSON),
        pending: pendingProblems(episodes, status.last_consolidated),
        // 面板显示的大白话：校验器、事件类型与镜头特征都不直接露出 ID。
        labels: goMap({ checks: labels(memory.CheckerLabels), events: labels(memory.EventLabels), features: labels(memory.FeatureDescriptions) }),
      }),
    );
  } catch (err) {
    return writeError(500, 'memory_unavailable', (err as Error).message);
  }
}

/**
 * 上次整理之后还没整理的问题，按校验器归组：面板要讲「记下了哪些问题、各出现几次、在哪些镜头」，
 * 而不是一串渲染日志。口径与 status 的 pending_failures 相同（考试不算）；
 * 同一次经历里同一个问题报了几处只算一次。
 */
function pendingProblems(episodes: memory.Episode[], since: string): { check: string; count: number; scenes: { project: string; scene: string }[] }[] {
  const groups = new Map<string, { check: string; count: number; scenes: { project: string; scene: string }[] }>();
  for (const e of episodes) {
    if (e.created_at <= since || e.source === memory.SourceExam || !memory.failure(e)) continue;
    const checks = e.checks?.length ? e.checks : [memory.CheckerHuman];
    for (const check of new Set(checks)) {
      let g = groups.get(check);
      if (!g) groups.set(check, (g = { check, count: 0, scenes: [] }));
      g.count++;
      if (e.scene_id && !g.scenes.some((x) => x.project === e.project && x.scene === e.scene_id)) g.scenes.push({ project: e.project, scene: e.scene_id });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.check < b.check ? -1 : 1));
}

/** GET /api/memory/recall?scene=…[&renderer=…]：「本镜头想起了什么」。 */
export function memoryRecallAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const opened = memoryStore(s);
  if (opened instanceof Response) return opened;
  const { p, cfg, store } = opened;
  const query = new URL(request.url).searchParams;
  const id = query.get('scene') ?? '';
  for (const summary of discoverScenes(p.path)) {
    if (summary.id !== id) continue;
    let sc: scene.Scene;
    try {
      sc = scene.load(summary.directory);
    } catch (err) {
      return writeError(400, 'invalid_scene', (err as Error).message);
    }
    const renderer = query.get('renderer') || sc.renderer || cfg.renderer;
    let result: memory.RecallResult;
    try {
      result = store.recallScene(sc, {
        snapshot: cfg.memory.snapshot,
        budget: cfg.memory.recallBudget,
        renderer,
        model: store.currentModel(renderer, envMap()),
      });
    } catch (err) {
      return writeError(400, 'recall_failed', (err as Error).message);
    }
    return writeJSON(200, goMap({ recall: memory.recallResultToJSON(result), reasons: result.items.map(memory.recallReason), section: memory.recallSection(result) }));
  }
  return writeError(404, 'scene_not_found', '镜头不存在');
}

const actionLabels: Record<string, string> = { promote: '确认生效 ', reject: '拒绝 ', retire: '沉睡 ' };

/**
 * POST /api/memory/actions/{action}：面板能触发的 am memory 子命令。参数只取白名单里的字段，
 * 不接受任意命令行。
 */
export async function memoryActionAPI(s: Server, request: Request, rest: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const action = rest.replace(/^\/+|\/+$/g, '');
  let req: { name: string; to: number; renderers: string[]; scene_id: string; verdict: string; note: string; seconds: number | null; region: number[]; global: boolean; final: boolean };
  try {
    const body = await decodeJSON(request);
    req = {
      name: fieldString(body, 'name'),
      to: fieldInt(body, 'to'),
      renderers: fieldStrings(body, 'renderers'),
      scene_id: fieldString(body, 'scene_id'),
      verdict: fieldString(body, 'verdict'),
      note: fieldString(body, 'note'),
      seconds: fieldNumberPtr(body, 'seconds'),
      region: fieldNumbers(body, 'region'),
      global: fieldBool(body, 'global'),
      final: fieldBool(body, 'final'),
    };
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  let name: string;
  let params: Record<string, unknown> = {};
  let label = '';
  switch (action) {
    case 'consolidate':
      // final：用户在成片页确认这一版可用。这是整理的时机：一部片子做完，这次制作里的问题都齐了。
      // 已有整理在跑时不重复起（对话里确认时编排工具也会整理一次，第二次只会发现没有新问题）。
      for (const t of s.tasks.tasks.values()) {
        if (t.type === 'memory.consolidate' && (t.status === 'queued' || t.status === 'running')) return writeJSON(202, goMap({ task_id: t.task_id }));
      }
      name = 'memory_consolidate';
      label = req.final ? '成片已确认：整理这次制作的记忆' : '整理记忆';
      break;
    case 'exam':
      if (req.renderers.length === 0) return writeError(400, 'invalid_renderers', '至少选一个渲染工具');
      for (const renderer of req.renderers) {
        if (!tools.ValidTools.has(renderer)) return writeError(400, 'invalid_renderers', '无效的渲染工具：' + renderer);
      }
      name = 'memory_exam';
      params = { renderers: req.renderers.join(',') };
      label = '记忆考试';
      if (req.name !== '') {
        if (!memory.validName(req.name)) return writeError(400, 'invalid_name', '记忆名不合法');
        params.retest = req.name;
        label = '重考 ' + req.name;
      }
      break;
    case 'rollback':
      if (req.to < 1) return writeError(400, 'invalid_snapshot', '要给出快照号');
      name = 'memory_rollback';
      params = { to: req.to };
      label = `回退到快照 #${req.to}`;
      break;
    case 'promote':
    case 'reject':
    case 'retire':
      if (!memory.validName(req.name)) return writeError(400, 'invalid_name', '记忆名不合法');
      name = 'memory_' + action;
      params = { name: req.name };
      label = actionLabels[action] + req.name;
      break;
    case 'remember': {
      if (goTrimSpace(req.note) === '') return writeError(400, 'empty_note', '偏好内容为空');
      try {
        const out = await runStudioOp(s, request.signal, p, 'memory_remember', { text: req.note, global: req.global });
        return writeJSON(200, goMap({ message: goTrimSpace(out.text) }));
      } catch (err) {
        return writeError(400, 'remember_failed', (err as Error).message);
      }
    }
    case 'feedback': {
      let directory = '';
      for (const sc of discoverScenes(p.path)) if (sc.id === req.scene_id) directory = sc.directory;
      if (directory === '') return writeError(404, 'scene_not_found', '镜头不存在');
      if (req.verdict !== 'up' && req.verdict !== 'down') return writeError(400, 'invalid_verdict', '反馈只能是 up 或 down');
      const feedback: Record<string, unknown> = { scene: directory, [req.verdict]: true, note: req.note };
      if (req.seconds !== null) feedback.at = Number(formatFixed(req.seconds, 3));
      if (req.region.length === 4) feedback.region = req.region.map((v) => formatFixed(v, 4)).join(',');
      // 反馈只写一段经历，很快，直接同步返回。
      try {
        const out = await runStudioOp(s, request.signal, p, 'memory_feedback', feedback);
        return writeJSON(200, goMap({ message: goTrimSpace(out.text) }));
      } catch (err) {
        return writeError(400, 'feedback_failed', (err as Error).message);
      }
    }
    default:
      return writeError(404, 'unknown_action', '不支持的操作：' + action);
  }
  const work = async (signal: AbortSignal): Promise<void> => {
    await runStudioOp(s, signal, p, name, params);
  };
  // 考试会在项目的 production/memory-exams 下渲染，占项目写权；其余只改记忆库。
  if (action === 'exam') {
    try {
      const t = runWriteTask(s, p, 'memory.exam', label, work);
      return writeJSON(202, goMap({ task_id: t.task_id }));
    } catch (err) {
      return writeTaskError(err);
    }
  }
  const t = addTask(s, 'memory.' + action, label);
  runTask(s, t, work);
  return writeJSON(202, goMap({ task_id: t.task_id }));
}

/** preferenceBrief 是这一轮要交给编排工具的用户偏好段与摘要；记忆关闭或读不到时为空。 */
export function preferenceBrief(p: Project, cfg: config.Config): [string, string] {
  if (!cfg.memory.enabled) return ['', ''];
  // 建好记忆库：codex 沙箱只能把已存在的目录加进可写范围（见 OrchestratorAccess）。
  try {
    memory.open(cfg.memory.dir);
  } catch {
    // 与 Go 版一样忽略。
  }
  try {
    const { text, digest } = memory.openReadOnly(cfg.memory.dir).preferenceBrief(memory.projectName(p.path), cfg.memory.snapshot);
    return [text, digest];
  } catch {
    return ['', ''];
  }
}

/**
 * recordUtterance 把用户在这一轮说的话（或回退了这一轮）写成对话经历，
 * 整理时从反复提的要求与回退里归纳偏好。失败只是少一条信号，不影响对话。
 */
export function recordUtterance(p: Project, turn: Turn, reverted: boolean): void {
  let cfg: config.Config;
  try {
    cfg = config.load(p.path, null);
  } catch {
    return;
  }
  if (!cfg.memory.enabled || goTrimSpace(turn.message) === '') return;
  try {
    memory.open(cfg.memory.dir).recordUtterance({ projectDir: p.path, session: turn.session_id, turn: turn.turn_id, message: turn.message, reverted });
  } catch {
    // 少一条信号，不影响对话。
  }
}
