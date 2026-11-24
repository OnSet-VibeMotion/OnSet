/**
 * 整片开工、轮次详情/回退、确定性命令与只读文件接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { goClean, goTrimSpace } from '../gofmt';
import * as plugin from '../plugin';
import * as project from '../project';
import { decodeChoice, withDefaults } from './agents';
import { decodeAttachments, writeStartError } from './api_sessions_events';
import { isEnvFile } from './api_ui';
import {
  DecodeError,
  decodeJSON,
  fieldArray,
  fieldString,
  goMap,
  methodNotAllowed,
  writeError,
  writeJSON,
} from './http';
import { discoverScenes, fileExists } from './scenes';
import {
  type Attachment,
  BusyError,
  containedPath,
  createSession,
  emit,
  focusStageFor,
  kindNotice,
  NotExistError,
  revert,
  type Session,
  startTurn,
  validateChoice,
} from './sessions';
import type { Server } from './studio';
import { runStudioOp, runWriteTask, writeTaskError } from './tasks';
import { ConflictError, isContentState, loadTurn, readBlob, turnJSON } from './turns';

/** maxFileBytes 是 /api/files 返回正文的上限。 */
const maxFileBytes = 2 << 20;

export async function productionStartAPI(s: Server, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let message: string;
  let promptOverride: string;
  let attachments: Attachment[] | null;
  let choice;
  try {
    const body = await decodeJSON(request);
    message = fieldString(body, 'message');
    promptOverride = fieldString(body, 'prompt');
    // attachments 是首页一起交上来的文章、素材（已经上传到 production/studio/uploads/）。
    attachments = decodeAttachments(fieldArray(body, 'attachments'));
    choice = decodeChoice(body);
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  try {
    validateChoice(choice);
  } catch (err) {
    return writeError(400, 'invalid_agent', (err as Error).message);
  }
  let override = '';
  if (promptOverride !== '') {
    try {
      override = containedPath(p.path, promptOverride);
    } catch (err) {
      return writeError(400, 'invalid_prompt', (err as Error).message);
    }
  }
  let prompt: Buffer;
  let promptPath: string;
  let promptLabel: string;
  let warnings: string[];
  try {
    // 客户端整片开工首轮按当前进度聚焦展开（仅公共约定 + 当前阶段 + 阶段索引），避免首轮一次性灌入 100KB+ 全部阶段。
    const focus = override === '' ? focusStageFor(p.path) : undefined;
    ({ prompt, path: promptPath, label: promptLabel, warnings } = project.runPrompt(p.path, override, focus));
  } catch (err) {
    return writeError(400, 'prompt_missing', (err as Error).message);
  }
  let cfg: config.Config;
  try {
    cfg = config.load(p.path, null);
  } catch (err) {
    return writeError(400, 'invalid_config', (err as Error).message);
  }
  const holder = s.busyHolder(p.path);
  if (holder !== '') return writeError(409, 'project_busy', new BusyError(holder).message);
  const rel = promptPath === '' ? promptLabel : path.relative(p.path, promptPath).split(path.sep).join('/');
  let sess: Session;
  try {
    sess = createSession(s, p.path, 'production', '整片制作（' + rel + '）', withDefaults(choice, cfg));
  } catch (err) {
    return writeError(500, 'session_failed', (err as Error).message);
  }
  try {
    // 读不出来、但这个项目用不到的插件：照常开工，在对话里说一声。
    for (const text of warnings) emit(sess, '', { kind: kindNotice, text });
    const turn = startTurn(s, p, sess, {
      message: goTrimSpace(message),
      prompt: prompt.toString('utf8'),
      attachments,
    });
    return writeJSON(202, goMap({ session_id: sess.meta.session_id, turn_id: turn.turn_id, prompt: rel, warnings }));
  } catch (err) {
    return writeStartError(err);
  }
}

/** turnAPI 处理 /api/turns/{id}、/api/turns/{id}/file?path=、/api/turns/{id}/revert。 */
export function turnAPI(s: Server, request: Request, rest: string): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  let turn;
  try {
    turn = loadTurn(p.path, parts[0]);
  } catch {
    return writeError(404, 'turn_not_found', '这一轮不存在');
  }
  const action = parts.length > 1 ? parts[1] : '';
  switch (action) {
    case '':
      turn.before = null;
      turn.after = null;
      return writeJSON(200, turnJSON(turn));
    case 'file': {
      const rel = new URL(request.url).searchParams.get('path') ?? '';
      let change;
      for (const c of turn.changes ?? []) if (c.path === rel) change = c;
      if (!change) return writeError(404, 'file_not_changed', '这一轮没有改动这个文件');
      let before: Buffer | null;
      let after: Buffer | null;
      try {
        before = readBlob(p.path, turn.before?.[rel]);
        after = readBlob(p.path, turn.after?.[rel]);
      } catch (err) {
        return writeError(500, 'blob_missing', (err as Error).message);
      }
      return writeJSON(
        200,
        goMap({
          path: rel,
          change: change.change,
          text: change.revertable || isContentState(turn.before?.[rel]) || isContentState(turn.after?.[rel]),
          before: (before ?? Buffer.alloc(0)).toString('utf8'),
          after: (after ?? Buffer.alloc(0)).toString('utf8'),
        }),
      );
    }
    case 'revert': {
      if (request.method !== 'POST') return methodNotAllowed('POST');
      try {
        const { turn: reverted, skipped } = revert(s, p, turn.turn_id);
        return writeJSON(200, goMap({ turn_id: reverted.turn_id, status: reverted.status, skipped }));
      } catch (err) {
        if (err instanceof ConflictError) {
          return writeJSON(409, goMap({ code: 'revert_conflict', message: err.message, paths: err.paths }));
        }
        if (err instanceof BusyError) return writeError(409, 'project_busy', err.message);
        return writeError(409, 'revert_rejected', (err as Error).message);
      }
    }
    default:
      return writeError(404, 'not_found', '接口不存在');
  }
}

/**
 * studioCommands 是可以从网页直接触发的确定性步骤。它们不经过编排工具，
 * 参数只有镜头 id，不接受任意命令行。内置插件登记的命令（ctx.command，例如卡点的 beat.regrid 收拍号与起始拍）
 * 由插件从请求体算出操作参数；登记的校验器另有 `<id>.check`（例如发布的 publish.check）。
 */
export const studioCommands: Readonly<Record<string, string>> = {
  'scene.validate': '校验镜头',
  'scene.qc_batch': '批量抽帧质检',
  'project.concat': '拼接无声母版',
  'project.post_render': '修接缝、拼接与复查',
};

export async function commandAPI(s: Server, request: Request, rest: string): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const name = rest.replace(/^\/+|\/+$/g, '');
  const validator = plugin.pluginValidators().find((v) => `${v.value.id}.check` === name)?.value;
  const command = plugin.pluginCommands().find((c) => c.value.id === name)?.value;
  if (!Object.hasOwn(studioCommands, name) && !validator && !command) {
    return writeError(404, 'unknown_command', '不支持的命令：' + name);
  }
  let label = validator ? validator.label : command ? command.label : studioCommands[name];
  let sceneID: string;
  let body: Record<string, unknown>;
  try {
    body = await decodeJSON(request);
    sceneID = fieldString(body, 'scene_id');
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  let op: { name: string; params: Record<string, unknown> } | null = null;
  let pipeline: Array<{ name: string; params: Record<string, unknown> }> | null = null;
  switch (name) {
    case 'scene.validate':
      for (const sc of discoverScenes(p.path))
        if (sc.id === sceneID) op = { name: 'scene_lint', params: { scene: sc.directory } };
      if (!op) return writeError(404, 'scene_not_found', '镜头不存在');
      label += ' ' + sceneID;
      break;
    case 'scene.qc_batch':
      op = {
        name: 'scene_frames_batch',
        params: { scenes: path.join(p.path, 'scenes'), out: path.join(p.path, 'production', 'visual-qc', 'batch') },
      };
      break;
    case 'project.concat':
      op = {
        name: 'concat',
        params: { scenes: path.join(p.path, 'scenes'), out: path.join(p.path, 'production', 'silent-master.mp4') },
      };
      break;
    case 'project.post_render':
      pipeline = [
        { name: 'scene_seams', params: { scenes: path.join(p.path, 'scenes') } },
        {
          name: 'concat',
          params: { scenes: path.join(p.path, 'scenes'), out: path.join(p.path, 'production', 'silent-master.mp4') },
        },
        {
          name: 'review',
          params: {
            video: path.join(p.path, 'production', 'silent-master.mp4'),
            scenes: path.join(p.path, 'scenes'),
            out: path.join(p.path, 'production', 'review-silent'),
            silent: true,
          },
        },
      ];
      break;
  }
  if (command) {
    // 内置插件登记的命令：插件从请求体算出操作参数，请求不合格时照它说的回 400。
    const r = command.params(body, p.path);
    if ('error' in r) return writeError(400, r.error.code, r.error.message);
    op = { name: command.op, params: r.params };
    if (r.label) label += r.label;
  }
  if (validator) {
    // 内置插件登记的校验器：校验项目里的一个文件。
    const file = path.join(p.path, validator.file);
    if (!fileExists(file)) return writeError(400, `${validator.id}_missing`, `找不到 ${validator.file}`);
    op = { name: validator.op, params: { file, project_root: p.path } };
  }
  const steps = pipeline ?? [op!];
  try {
    const t = runWriteTask(s, p, name, label, async (signal) => {
      if (name === 'project.concat' || name === 'project.post_render' || name === 'scene.qc_batch') {
        fs.mkdirSync(path.join(p.path, 'production'), { recursive: true, mode: 0o755 });
      }
      for (const step of steps) await runStudioOp(s, signal, p, step.name, step.params);
    });
    return writeJSON(202, goMap({ task_id: t.task_id, command: name }));
  } catch (err) {
    return writeTaskError(err);
  }
}

/** filesAPI 只读返回项目里的一个文件。超过上限或含 NUL 的按二进制处理，不返回正文。 */
export function filesAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const rel = new URL(request.url).searchParams.get('path') ?? '';
  let file: string;
  try {
    file = containedPath(p.path, rel);
  } catch (err) {
    if (err instanceof NotExistError) return writeError(404, 'file_not_found', '文件不存在');
    return writeError(400, 'invalid_path', (err as Error).message);
  }
  if (isEnvFile(file)) return writeError(403, 'secret_file', 'Studio 不读取 .env');
  let info: fs.Stats;
  try {
    info = fs.statSync(file);
  } catch {
    return writeError(404, 'file_not_found', '文件不存在');
  }
  if (info.isDirectory()) return writeError(404, 'file_not_found', '文件不存在');
  const result: Record<string, unknown> = { path: goClean(rel), size: info.size, binary: true, content: '' };
  if (info.size <= maxFileBytes) {
    try {
      const body = fs.readFileSync(file);
      if (!body.subarray(0, 8192).includes(0)) {
        result.binary = false;
        result.content = body.toString('utf8');
      }
    } catch {
      // 读不了就按二进制。
    }
  }
  return writeJSON(200, goMap(result));
}
