/**
 * 记忆面板的写操作与对话信号（偏好摘要、记录对话经历）。
 */
import * as config from '../config';
import { formatFixed, goTrimSpace } from '../gofmt';
import * as memory from '../memory';
import * as series from '../series';
import * as tools from '../tools';
import { emitStudioEvent } from './events';
import {
  DecodeError,
  decodeJSON,
  fieldBool,
  fieldInt,
  fieldNumberPtr,
  fieldNumbers,
  fieldString,
  fieldStrings,
  goMap,
  methodNotAllowed,
  writeError,
  writeJSON,
} from './http';
import { canApproveLatestReview } from './reviewreport';
import { discoverScenes } from './scenes';
import type { Project, Server } from './studio';
import { addTask, runStudioOp, runTask, runWriteTask, writeTaskError } from './tasks';
import type { Turn } from './turns';

const actionLabels: Record<string, string> = { promote: '确认生效 ', reject: '拒绝 ', retire: '沉睡 ' };

/**
 * POST /api/memory/actions/{action}：面板能触发的 onset memory 子命令。参数只取白名单里的字段，
 * 不接受任意命令行。
 */
export async function memoryActionAPI(s: Server, request: Request, rest: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const action = rest.replace(/^\/+|\/+$/g, '');
  let req: {
    name: string;
    trial: string;
    scenes: string[];
    holdoutOnly: boolean;
    to: number;
    renderers: string[];
    scene_id: string;
    verdict: string;
    note: string;
    seconds: number | null;
    region: number[];
    global: boolean;
    scope: string;
    final: boolean;
    video: string;
    videoSha256: string;
  };
  try {
    const body = await decodeJSON(request);
    req = {
      name: fieldString(body, 'name'),
      trial: fieldString(body, 'trial'),
      scenes: fieldStrings(body, 'scenes'),
      holdoutOnly: fieldBool(body, 'holdout_only'),
      to: fieldInt(body, 'to'),
      renderers: fieldStrings(body, 'renderers'),
      scene_id: fieldString(body, 'scene_id'),
      verdict: fieldString(body, 'verdict'),
      note: fieldString(body, 'note'),
      seconds: fieldNumberPtr(body, 'seconds'),
      region: fieldNumbers(body, 'region'),
      global: fieldBool(body, 'global'),
      scope: fieldString(body, 'scope'),
      final: fieldBool(body, 'final'),
      video: fieldString(body, 'video'),
      videoSha256: fieldString(body, 'video_sha256'),
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
      if (req.final && !canApproveLatestReview(p.path, req.video, req.videoSha256)) {
        return writeError(409, 'film_review_required', '当前视频需要重新通过交付复查，才能确认发布。');
      }
      // final：用户在成片页确认这一版可用。这是整理的时机：一部片子做完，这次制作里的问题都齐了。
      // 已有整理在跑时不重复起（对话里确认时编排工具也会整理一次，第二次只会发现没有新问题）。
      for (const t of s.tasks.tasks.values()) {
        if (t.type === 'memory.consolidate' && (t.status === 'queued' || t.status === 'running')) {
          return writeJSON(202, goMap({ task_id: t.task_id }));
        }
      }
      name = 'memory_consolidate';
      label = req.final ? '成片已确认：整理这次制作的记忆' : '整理记忆';
      // 用户在成片页确认这一版可用：第三方站可以挂在这上面（例如自动发布、通知）。
      if (req.final) emitStudioEvent(s, p, 'film.approved', {});
      break;
    case 'exam':
      if (req.renderers.length === 0) return writeError(400, 'invalid_renderers', '至少选一个渲染工具');
      for (const renderer of req.renderers) {
        if (!tools.ValidRenderers.has(renderer))
          return writeError(400, 'invalid_renderers', '无效的渲染工具：' + renderer);
      }
      name = 'memory_exam';
      params = { renderers: req.renderers.join(',') };
      label = '记忆考试';
      if (req.trial !== '') {
        if (!memory.validName(req.trial)) return writeError(400, 'invalid_name', '记忆名不合法');
        if (req.name !== '') return writeError(400, 'invalid_exam', '试用考试与生效经验重考不能同时指定');
        params.trial = req.trial;
        label = '考试 ' + req.trial;
      }
      if (req.name !== '') {
        if (!memory.validName(req.name)) return writeError(400, 'invalid_name', '记忆名不合法');
        params.retest = req.name;
        label = '重考 ' + req.name;
      }
      if (req.scenes.length > 0) {
        const allScenes = discoverScenes(p.path);
        const dirs: string[] = [];
        for (const id of new Set(req.scenes)) {
          const selected = allScenes.find((sc) => sc.id === id);
          if (!selected) return writeError(400, 'invalid_scene', '考试镜头不存在：' + id);
          dirs.push(selected.directory);
        }
        params.holdout = dirs;
      }
      if (req.holdoutOnly) {
        if (req.scenes.length === 0) return writeError(400, 'invalid_scene', '仅验证新镜头时必须选择镜头');
        params.holdout_only = true;
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
        const params: Record<string, unknown> = { text: req.note, global: req.global };
        if (req.scope !== '') params.scope = req.scope;
        const out = await runStudioOp(s, request.signal, p, 'memory_remember', params);
        return writeJSON(200, goMap({ message: goTrimSpace(out.text) }));
      } catch (err) {
        return writeError(400, 'remember_failed', (err as Error).message);
      }
    }
    case 'scope': {
      if (!memory.validName(req.name)) return writeError(400, 'invalid_name', '记忆名不合法');
      if (!['project', 'series', 'global'].includes(req.scope)) {
        return writeError(400, 'invalid_scope', '作用范围必须是 project、series 或 global');
      }
      let cfg: config.Config;
      try {
        cfg = config.load(p.path, null);
      } catch (err) {
        return writeError(400, 'config_error', (err as Error).message);
      }
      let targetScope = '';
      if (req.scope === 'project') {
        targetScope = memory.projectName(p.path);
      } else if (req.scope === 'series') {
        const binding = series.readBinding(p.path);
        if (!binding) return writeError(400, 'no_series', '当前项目没有归属任何专栏');
        targetScope = memory.seriesScope(binding.series_id);
      }
      try {
        const { memory: updated, snapshot } = memory.open(cfg.memory.dir).setPreferenceScope(req.name, targetScope);
        return writeJSON(
          200,
          goMap({
            name: updated.name,
            scope: updated.scope,
            snapshot: snapshot?.id ?? 0,
            message: `已更新偏好作用范围`,
          }),
        );
      } catch (err) {
        return writeError(400, 'scope_failed', (err as Error).message);
      }
    }
    case 'feedback': {
      let directory = '';
      for (const sc of discoverScenes(p.path)) if (sc.id === req.scene_id) directory = sc.directory;
      if (directory === '') return writeError(404, 'scene_not_found', '镜头不存在');
      if (req.verdict !== 'up' && req.verdict !== 'down') {
        return writeError(400, 'invalid_verdict', '反馈只能是 up 或 down');
      }
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
    let seriesId = '';
    try {
      seriesId = series.readBinding(p.path)?.series_id ?? '';
    } catch {
      seriesId = '';
    }
    const { text, digest } = memory
      .openReadOnly(cfg.memory.dir)
      .preferenceBrief(memory.projectName(p.path), cfg.memory.snapshot, seriesId);
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
    memory.open(cfg.memory.dir).recordUtterance({
      projectDir: p.path,
      session: turn.session_id,
      turn: turn.turn_id,
      message: turn.message,
      reverted,
    });
  } catch {
    // 少一条信号，不影响对话。
  }
}
