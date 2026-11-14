/**
 * 模型互学的接口（@onset/engine/audition 的 learning / learn / exemplars）。学习关系、评判记录、范例库都在记忆库目录，跨项目：
 *
 *   GET    /api/learning                          关系（各带进度曲线、学来的经验、可学的场次与老师的范例数）、提议、评判场数
 *   POST   /api/learning/relations                确认一条：{student, teacher, features, note}
 *   DELETE /api/learning/relations/{编号}          去掉
 *   POST   /api/learning/dismiss                  不要这条提议：{student, teacher, features}
 *   POST   /api/learning/relations/{编号}/learn    向老师学（任务，跑 audition_learn；只写记忆库，不占项目写锁）
 *   POST   /api/learning/relations/{编号}/exam     人评考试：{scene_id}（写任务，跑 scene_audition 的 exam）
 *
 * 确认、去掉、不要在进程里直接写（与评判一样，是人的决定，不碰项目文件）。
 */
import * as audition from '../audition';
import * as config from '../config';
import * as memory from '../memory';
import { DecodeError, decodeJSON, fieldString, fieldStrings, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { discoverScenes } from './scenes';
import type { Server } from './studio';
import { addTask, runStudioOp, runTask, runWriteTask, writeTaskError } from './tasks';

function memDir(s: Server): { dir: string; root: string } | Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  try {
    const cfg = config.load(p.path, null);
    if (!cfg.memory.enabled) return writeError(409, 'memory_disabled', '模型互学要打开记忆（设置里的「记忆」）');
    return { dir: cfg.memory.dir, root: p.path };
  } catch (err) {
    return writeError(400, 'invalid_config', (err as Error).message);
  }
}

function lessonsOf(store: memory.Store, r: audition.Relation): Record<string, unknown>[] {
  const { renderer, model } = audition.splitKey(r.student);
  return store
    .memories()
    .memories.filter(
      (m) =>
        m.kind === memory.KindLesson &&
        (m.learned_from ?? []).includes(r.teacher) &&
        m.applies_when.renderers.includes(renderer) &&
        (model === '' || m.applies_when.models.includes(model)),
    )
    .map((m) => ({ name: m.name, description: m.description, status: m.status, verified_by: m.verified_by, from_auditions: m.from_auditions ?? [], body: m.body }));
}

/** GET /api/learning。 */
export function learningAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const m = memDir(s);
  if (m instanceof Response) return m;
  const rows = audition.readVerdicts(m.dir);
  const learning = audition.loadLearning(m.dir);
  const store = memory.openReadOnly(m.dir);
  const exemplars = audition.listExemplars(m.dir);
  const existing = store.memories().memories;
  const relations = learning.relations.map((r) => ({
    ...r,
    progress: audition.progress(rows, r),
    lessons: lessonsOf(store, r),
    // 还没学过、两边画面都在的对照有几场：为 0 时「向老师学」点了也没东西可学。
    learnable: audition.learnPairs(rows, r, existing).length,
    exemplars: exemplars.filter((e) => e.key === r.teacher).length,
  }));
  return writeJSON(
    200,
    goMap({
      relations,
      proposals: audition.proposals(rows, learning),
      verdicts: rows.length,
      exemplars: exemplars.length,
      thresholds: { matches: audition.ProposalMinMatches, rate: audition.ProposalMinRate },
    }),
  );
}

/** /api/learning/{relations|dismiss}[/{编号}[/learn|/exam]]。 */
export async function learningFeatureAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const m = memDir(s);
  if (m instanceof Response) return m;
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  let body: Record<string, unknown> = {};
  if (request.method === 'POST') {
    try {
      body = await decodeJSON(request);
    } catch (err) {
      return writeError(400, 'invalid_request', (err as Error).message);
    }
  }
  try {
    if (parts[0] === 'dismiss' && parts.length === 1) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      audition.dismissProposal(m.dir, { student: fieldString(body, 'student'), teacher: fieldString(body, 'teacher'), features: fieldStrings(body, 'features') });
      return writeJSON(200, goMap({ ok: true }));
    }
    if (parts[0] !== 'relations') return writeError(404, 'not_found', '没有这个接口');
    if (parts.length === 1) {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      const r = audition.confirmRelation(m.dir, {
        student: fieldString(body, 'student'),
        teacher: fieldString(body, 'teacher'),
        features: fieldStrings(body, 'features'),
        note: fieldString(body, 'note'),
      });
      return writeJSON(200, r);
    }
    const id = parts[1];
    const relation = audition.findRelation(m.dir, id);
    if (parts.length === 2) {
      if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
      audition.removeRelation(m.dir, id);
      return writeJSON(200, goMap({ ok: true }));
    }
    if (request.method !== 'POST') return methodNotAllowed('POST');
    switch (parts[2]) {
      case 'learn': {
        // 只写记忆库（整理者在记忆库的 learn/ 下工作），不碰项目文件：不占项目写锁，渲染时也能学。
        const t = addTask(s, 'audition.learn', `向 ${relation.teacher} 学`);
        runTask(s, t, async (signal) => {
          await runStudioOp(s, signal, p, 'audition_learn', { relation: relation.id });
        });
        return writeJSON(202, goMap({ task_id: t.task_id, relation: relation.id }));
      }
      case 'exam': {
        const sceneID = fieldString(body, 'scene_id');
        const sc = discoverScenes(p.path).find((x) => x.id === sceneID);
        if (!sc) return writeError(404, 'scene_not_found', '镜头不存在');
        const t = runWriteTask(s, p, 'scene.audition', `人评考试 ${sceneID}：${relation.student} 向 ${relation.teacher} 学的经验`, async (signal) => {
          await runStudioOp(s, signal, p, 'scene_audition', { scene: sc.directory, exam: relation.id });
        });
        return writeJSON(202, goMap({ task_id: t.task_id, scene_id: sceneID }));
      }
    }
    return writeError(404, 'not_found', '没有这个操作');
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_request', err.message);
    if ((err as Error).name === 'BusyError') return writeTaskError(err);
    return writeError(400, 'invalid_learning', (err as Error).message);
  }
}
