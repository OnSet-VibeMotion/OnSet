/**
 * 镜头画面描述检查（promptopt）的接口：
 *
 *   POST   /api/prompt-checks               {scene} 或 {all: true}：检查（后台任务，返回 task_id）
 *   POST   /api/prompt-checks/{镜头}/apply   采用改写稿，写进 prompt.md（写任务）
 *   DELETE /api/prompt-checks/{镜头}         不用了：删掉草稿
 *
 * 检查只写客户端状态目录里的草稿（production/studio/prompt-checks/），不占项目写锁，一轮对话正在跑时也能检查；
 * 采用要改 prompt.md，是写任务，与对话互斥。检查结果随 /api/storyboard 的每个镜头给出（prompt_check）。
 */
import * as promptopt from '../promptopt';
import { DecodeError, decodeJSON, fieldBool, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import type { Server } from './studio';
import { addTask, runStudioOp, runTask, runWriteTask, writeTaskError } from './tasks';

/** 界面上的检查结果：草稿加上「检查之后 prompt.md 又改过」。 */
export type PromptCheckView = promptopt.PromptCheck & { outdated: boolean };

export function promptCheckView(root: string, id: string): PromptCheckView | undefined {
  const check = promptopt.readCheck(root, id);
  if (!check) return undefined;
  return { ...check, outdated: promptopt.checkOutdated(root, check) };
}

export async function promptChecksAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/').filter((x) => x !== '');
  if (parts.length === 0) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    let scene = '';
    let all = false;
    try {
      const body = await decodeJSON(request);
      scene = fieldString(body, 'scene');
      all = fieldBool(body, 'all');
    } catch (err) {
      if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
      throw err;
    }
    if (!all && scene === '') return writeError(400, 'invalid_request', '要给 scene，或者 all: true');
    const t = addTask(s, 'scene.prompt_check', all ? '检查全部画面描述' : `检查 ${scene} 的画面描述`);
    runTask(s, t, async (signal) => {
      await runStudioOp(s, signal, p, 'scene_prompt_check', all ? { all: true } : { scene });
    });
    return writeJSON(202, goMap({ task_id: t.task_id }));
  }
  const id = parts[0]!;
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) return writeError(404, 'not_found', '镜头不存在');
  if (parts.length === 1) {
    if (request.method !== 'DELETE') return methodNotAllowed('DELETE');
    promptopt.removeCheck(p.path, id);
    return writeJSON(200, goMap({ ok: true }));
  }
  if (parts.length === 2 && parts[1] === 'apply') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    const view = promptCheckView(p.path, id);
    if (!view?.prompt) return writeError(404, 'no_rewrite', `${id} 没有可以采用的改写稿`);
    if (view.outdated) return writeError(409, 'outdated', `${id} 的 prompt.md 在检查之后改过了，请重新检查`);
    try {
      const t = runWriteTask(s, p, 'scene.prompt_apply', `采用 ${id} 的画面描述改写稿`, async (signal) => {
        await runStudioOp(s, signal, p, 'scene_prompt_apply', { scene: id });
      });
      return writeJSON(202, goMap({ task_id: t.task_id }));
    } catch (err) {
      return writeTaskError(err);
    }
  }
  return writeError(404, 'not_found', '接口不存在');
}
