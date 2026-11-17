/**
 * 试镜页的接口（@onset/engine/audition）：
 *
 *   GET  /api/auditions[?scene=<镜头>]   试镜列表，新的在前；评判之前只给标号与进度（blindJSON）
 *   GET  /api/auditions/recommend?scene=<镜头>  按以往的评判，这类镜头谁赢得最多（只是推荐）
 *   POST /api/auditions                  开一场：{scene_id, contestants: [{renderer, model, designer?: {renderer, model}}], with_memory}，
 *                                        或人评考试 {scene_id, exam: <学习关系编号>}；写任务跑 scene_audition
 *   GET  /api/auditions/{编号}            一场试镜
 *   GET  /api/auditions/{编号}/activity   各选手的实时制作过程，盲评时只返回固定动作标签
 *   POST /api/auditions/{编号}/vote       评判：{kind, winner, note}
 *   POST /api/auditions/{编号}/adopt      采用：{slot}，写任务跑 scene_audition_adopt
 *   POST /api/auditions/{编号}/retry      重试失败或中断的选手：{slot}
 *
 * 评判在进程里直接写（与关卡确认一样是 Studio 自己的状态，只碰 production/studio/），并追加进记忆库目录的
 * auditions.jsonl；渲染与采用会动镜头，走写任务、占项目写锁。
 */
import path from 'node:path';
import * as audition from '../audition';
import * as config from '../config';
import * as memory from '../memory';
import { auditionActivity } from './audition_activity';
import { load as loadScene } from '../scene';
import { ValidRenderers } from '../tools';
import { DecodeError, decodeJSON, fieldBool, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { discoverScenes } from './scenes';
import type { Server } from './studio';
import { runStudioOp, runWriteTask, writeTaskError } from './tasks';

/** /api/auditions：列表与开一场。 */
export async function auditionsAPI(s: Server, request: Request): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  if (request.method === 'GET') {
    const sceneID = new URL(request.url).searchParams.get('scene') ?? '';
    const list = audition.list(p.path).filter((a) => sceneID === '' || a.scene_id === sceneID);
    return writeJSON(200, goMap({ auditions: list.map(audition.blindJSON) }));
  }
  if (request.method !== 'POST') return methodNotAllowed('GET, POST');
  let body: Record<string, unknown>;
  const entries: audition.Entry[] = [];
  let sceneID = '';
  let withMemory = true;
  let exam = '';
  try {
    body = await decodeJSON(request);
    sceneID = fieldString(body, 'scene_id');
    exam = fieldString(body, 'exam').trim();
    withMemory = body.with_memory === undefined ? true : fieldBool(body, 'with_memory');
    const raw = body.contestants ?? [];
    if (!Array.isArray(raw)) throw new DecodeError('contestants 要是数组');
    for (const item of raw) {
      if (item === null || typeof item !== 'object') throw new DecodeError('contestants 的每一项要是对象');
      const o = item as Record<string, unknown>;
      const d = o.designer && typeof o.designer === 'object' ? (o.designer as Record<string, unknown>) : null;
      const designer = d && fieldString(d, 'renderer').trim() !== '' ? { renderer: fieldString(d, 'renderer').trim(), model: fieldString(d, 'model').trim() } : null;
      entries.push({ renderer: fieldString(o, 'renderer').trim(), model: fieldString(o, 'model').trim(), designer });
    }
  } catch (err) {
    return writeError(400, 'invalid_request', (err as Error).message);
  }
  const tools = entries.flatMap((e) => (e.designer ? [e, e.designer] : [e]));
  for (const e of tools) {
    if (!ValidRenderers.has(e.renderer)) return writeError(400, 'invalid_agent', `渲染工具无效：${e.renderer || '（空）'}`);
    // 模型名里不能有逗号与 <：经 scene_audition 的 contestants 参数按它们分开。
    if (e.model.includes(',') || e.model.includes('<')) return writeError(400, 'invalid_model', `模型名不能有逗号或 <：${e.model}`);
  }
  if (exam === '' && (entries.length < audition.MinContestants || entries.length > audition.MaxContestants)) {
    return writeError(400, 'invalid_contestants', `选手要 ${audition.MinContestants}–${audition.MaxContestants} 位`);
  }
  const sc = discoverScenes(p.path).find((x) => x.id === sceneID);
  if (!sc) return writeError(404, 'scene_not_found', '镜头不存在');
  const label = (e: { renderer: string; model: string }) => (e.model === '' ? e.renderer : `${e.renderer}:${e.model}`);
  const contestants = entries.map((e) => label(e) + (e.designer ? '<' + label(e.designer) : '')).join(',');
  const params: Record<string, unknown> = exam !== '' ? { scene: sc.directory, exam } : { scene: sc.directory, contestants, with_memory: withMemory };
  try {
    const t = runWriteTask(s, p, 'scene.audition', exam !== '' ? `人评考试 ${sceneID}` : `试镜 ${sceneID}：${entries.length} 位选手`, async (signal) => {
      await runStudioOp(s, signal, p, 'scene_audition', params);
    });
    return writeJSON(202, goMap({ task_id: t.task_id, scene_id: sceneID }));
  } catch (err) {
    return writeTaskError(err);
  }
}

/** /api/auditions/{编号}[/vote|/adopt]。 */
export async function auditionAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const [id, action = ''] = rest.replace(/^\/+|\/+$/g, '').split('/');
  if (id === 'recommend') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const sceneID = new URL(request.url).searchParams.get('scene') ?? '';
    const sc = discoverScenes(p.path).find((x) => x.id === sceneID);
    if (!sc) return writeError(404, 'scene_not_found', '镜头不存在');
    let features: string[] = [];
    try {
      features = memory.features(loadScene(sc.directory));
    } catch {
      features = [];
    }
    const rows = audition.readVerdicts(config.load(p.path, null).memory.dir);
    return writeJSON(200, goMap({ scene_id: sceneID, features, verdicts: rows.length, recommendations: audition.recommend(rows, features) }));
  }
  let a: audition.Audition;
  try {
    a = audition.load(p.path, id);
  } catch (err) {
    return writeError(404, 'audition_not_found', (err as Error).message);
  }
  if (action === '') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return writeJSON(200, audition.blindJSON(a));
  }
  if (action === 'activity') {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return writeJSON(200, auditionActivity(p.path, a, !!s.busyHolder(p.path)));
  }
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
  } catch (err) {
    return writeError(400, 'invalid_request', (err as Error).message);
  }
  switch (action) {
    case 'retry': {
      let slot: string;
      try {
        slot = fieldString(body, 'slot');
        audition.retryContestant(p.path, a, slot);
      } catch (err) {
        return writeError(400, 'invalid_retry', (err as Error).message);
      }
      if (s.busyHolder(p.path)) return writeError(409, 'project_busy', s.busyHolder(p.path));
      try {
        if (audition.isRunning(p.path, a)) return writeError(409, 'audition_busy', '本场试镜仍在运行，请等任务结束后重试');
        const t = runWriteTask(s, p, 'scene.audition_retry', `重试 ${a.scene_id} 的选手 ${slot}`, async (signal) => {
          await runStudioOp(s, signal, p, 'scene_audition_retry', { audition: a.id, slot, project_root: p.path });
        });
        return writeJSON(202, goMap({ task_id: t.task_id, scene_id: a.scene_id }));
      } catch (err) {
        return writeTaskError(err);
      }
    }
    case 'vote': {
      if (s.busyHolder(p.path)) return writeError(409, 'project_busy', '请等当前任务结束后再评判');
      let voted: audition.Audition;
      try {
        voted = audition.vote(p.path, a.id, { kind: fieldString(body, 'kind'), winner: fieldString(body, 'winner'), note: fieldString(body, 'note') });
      } catch (err) {
        return writeError(400, 'invalid_verdict', (err as Error).message);
      }
      // 跨项目的评判记录、范例库与人评考试的结论：记不下的不影响这一场的评判，照实告诉界面。
      let after: { exam: audition.ExamOutcome | null; warnings: string[] };
      try {
        after = audition.afterVote(p.path, config.load(p.path, null).memory.dir, voted);
      } catch (err) {
        after = { exam: null, warnings: [(err as Error).message] };
      }
      return writeJSON(200, goMap({ ...audition.blindJSON(audition.load(p.path, voted.id)), exam_outcome: after.exam ?? undefined, warning: after.warnings.join('；') || undefined }));
    }
    case 'adopt': {
      const slot = (() => {
        try {
          return fieldString(body, 'slot');
        } catch {
          return '';
        }
      })();
      if (a.verdict === null) return writeError(409, 'not_judged', '先评判再采用');
      const c = a.contestants.find((x) => x.slot === slot);
      if (!c || c.outcome !== 'succeeded') return writeError(400, 'invalid_slot', `${slot || '（空）'} 没有合格的产物`);
      try {
        const t = runWriteTask(s, p, 'scene.audition_adopt', `采用试镜 ${slot} 到 ${a.scene_id}`, async (signal) => {
          await runStudioOp(s, signal, p, 'scene_audition_adopt', { audition: a.id, slot, project_root: p.path });
        });
        return writeJSON(202, goMap({ task_id: t.task_id, scene_id: a.scene_id }));
      } catch (err) {
        return writeTaskError(err);
      }
    }
  }
  return writeError(404, 'not_found', `没有 ${path.basename(action)} 这个操作`);
}
