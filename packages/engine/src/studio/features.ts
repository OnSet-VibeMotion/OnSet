/**
 * 镜头相关的接口：镜头列表与详情、镜头渲染 / 抽帧 / 附件 / 产物、渲染全部镜头、合成实时预览。
 * （发布页的接口随「发布」搬进了内置插件 plugins/publishing。）
 */
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import * as ledger from '../ledger';
import * as mediaprobe from '../mediaprobe';
import { newUsage, usageAdd, usageJSON, type Usage } from '../tools';
import { sceneActivity } from './activity';
import { decodeChoice } from './agents';
import { isEnvFile } from './api_ui';
import { DecodeError, decodeJSON, fieldInt, fieldNumber, fieldObject, goMap, goValue, methodNotAllowed, notFound, serveFile, writeError, writeJSON } from './http';
import { discoverScenes, sceneSummaryJSON, type SceneSummary } from './scenes';
import { attachmentJSON, containedPath, newID, validateChoice, type AgentChoice, type Box } from './sessions';
import type { Project, Server } from './studio';
import { addTask, runStudioOpWith, runTask, runWriteTask, updateTask, writeTaskError } from './tasks';

// ---- 镜头列表与详情 ----

/** GET /api/scenes：镜头列表与整个项目的用量合计。 */
export function scenesAPI(s: Server): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const scenes = discoverScenes(p.path);
  // Go 的 nil 切片：没有镜头时写成 null。
  return writeJSON(200, goMap({ scenes: scenes.length > 0 ? scenes.map(sceneSummaryJSON) : null, usage: projectUsageJSON(projectUsage(p.path, scenes)) }));
}

/** ProjectUsage 是整个项目花掉的 token：渲染（各镜头全部尝试）加编排（用量账本）。 */
export interface ProjectUsage {
  renders: Usage;
  attempts: number;
  orchestrator: ledger.Summary;
  total: Usage;
}

function projectUsageJSON(u: ProjectUsage): Record<string, unknown> {
  return { renders: usageJSON(u.renders), attempts: u.attempts, orchestrator: ledger.summaryJSON(u.orchestrator), total: usageJSON(u.total) };
}

export function projectUsage(project: string, scenes: SceneSummary[]): ProjectUsage {
  const out: ProjectUsage = { renders: newUsage(), attempts: 0, orchestrator: ledger.summarize(null), total: newUsage() };
  for (const sc of scenes) {
    if (sc.attempts === 0 || !sc.usage) continue;
    out.attempts += sc.attempts;
    usageAdd(out.renders, sc.usage);
  }
  let entries: ledger.Entry[] | null = null;
  try {
    entries = ledger.read(ledger.projectFile(project));
  } catch {
    entries = null;
  }
  out.orchestrator = ledger.summarize(entries);
  if (out.attempts > 0) usageAdd(out.total, out.renders);
  if (out.orchestrator.calls > 0) usageAdd(out.total, out.orchestrator.total);
  return out;
}

function sceneAPI(p: Project, id: string): Response {
  for (const sc of discoverScenes(p.path)) {
    if (sc.id !== id) continue;
    let data: unknown = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(sc.directory, 'scene.json'), 'utf8')) as unknown;
      // json.Unmarshal 进 map[string]any：不是对象时保持 nil。
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = goValue(parsed);
    } catch {
      data = null;
    }
    return writeJSON(
      200,
      goMap({
        id: sc.id,
        directory: sc.directory,
        duration_seconds: sc.duration_seconds ?? 0,
        output: sc.output ?? '',
        exists: sc.exists,
        stale: sc.stale,
        data,
      }),
    );
  }
  return writeError(404, 'scene_not_found', '镜头不存在');
}

// ---- 渲染 ----

async function decodeRenderChoice(request: Request): Promise<AgentChoice | null> {
  try {
    const choice = decodeChoice(await decodeJSON(request));
    validateChoice(choice);
    return choice;
  } catch {
    return null;
  }
}

/** POST /api/render/all：按镜头编号逐个渲染全部镜头。 */
export async function renderAllAPI(s: Server, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const scenes = discoverScenes(p.path);
  if (scenes.length === 0) return writeError(400, 'no_scenes', '项目中没有可渲染的镜头');
  const choice = await decodeRenderChoice(request);
  if (!choice) return writeError(400, 'invalid_agent', '渲染工具无效');
  try {
    const t = runWriteTask(s, p, 'scenes.render', `渲染全部 ${scenes.length} 个镜头`, async (signal, t) => {
      for (const [index, sc] of scenes.entries()) {
        if (signal.aborted) throw new Error('context canceled');
        updateTask(s, t.task_id, 'running', `正在渲染 ${sc.id}（${index + 1}/${scenes.length}）`, index / scenes.length, null);
        try {
          await runStudioOpWith(s, signal, p, { tool: '', renderer: choice.renderer, rendererModel: choice.rendererModel, rendererOptions: choice.rendererOptions }, 'scene_run', { scene: sc.directory });
        } catch (err) {
          throw new Error(`${sc.id}：${(err as Error).message}`, { cause: err });
        }
      }
    });
    return writeJSON(202, goMap({ task_id: t.task_id, scene_count: scenes.length }));
  } catch (err) {
    return writeTaskError(err);
  }
}

/** /api/scenes/{id}[/{action}[/…]]：镜头详情、渲染过程、渲染、附件、产物与抽帧。 */
export async function sceneFeatureAPI(s: Server, request: Request, rest: string): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length < 2) return sceneAPI(p, parts[0]);
  const [id, action] = parts;
  for (const sc of discoverScenes(p.path)) {
    if (sc.id !== id) continue;
    switch (action) {
      case 'render': {
        if (request.method !== 'POST') return methodNotAllowed('POST');
        const choice = await decodeRenderChoice(request);
        if (!choice) return writeError(400, 'invalid_agent', '渲染工具无效');
        const sceneDir = sc.directory;
        try {
          const t = runWriteTask(s, p, 'scene.render', '渲染 ' + id, async (signal) => {
            await runStudioOpWith(s, signal, p, { tool: '', renderer: choice.renderer, rendererModel: choice.rendererModel, rendererOptions: choice.rendererOptions }, 'scene_run', { scene: sceneDir });
          });
          return writeJSON(202, goMap({ task_id: t.task_id, scene_id: id }));
        } catch (err) {
          return writeTaskError(err);
        }
      }
      case 'activity':
        return writeJSON(200, sceneActivity(sc));
      case 'attachment':
        if (request.method !== 'POST') return methodNotAllowed('POST');
        return sceneAttachment(request, p, sc);
      case 'asset': {
        const asset = path.join(sc.directory, sc.output ?? '');
        const rel = path.relative(sc.directory, asset);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
          return writeError(403, 'asset_outside_scene', '镜头产物不得逃出镜头目录');
        }
        return serveFile(request, asset);
      }
      case 'frames': {
        if (parts.length > 2) {
          const frameName = path.basename(parts[2]);
          if (frameName !== parts[2] || !frameName.endsWith('.jpg')) return writeError(400, 'invalid_frame', '无效的帧路径');
          return serveFile(request, path.join(sc.directory, '.studio-frames', frameName));
        }
        if (request.method === 'POST') {
          const t = addTask(s, 'scene.capture_frames', '抽取 ' + id + ' 关键帧');
          runTask(s, t, async (signal) => captureSceneFrames(signal, sc));
          return writeJSON(202, goMap({ task_id: t.task_id, scene_id: id }));
        }
        const frames: string[] = [];
        try {
          const entries = fs.readdirSync(path.join(sc.directory, '.studio-frames'), { withFileTypes: true });
          entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          for (const entry of entries) if (!entry.isDirectory() && entry.name.endsWith('.jpg')) frames.push('.studio-frames/' + entry.name);
        } catch {
          // 还没抽过帧。
        }
        return writeJSON(200, goMap({ scene_id: id, frames }));
      }
    }
  }
  return writeError(404, 'scene_not_found', '镜头不存在');
}

/** 在镜头产物的开头、中间、结尾各抽一帧，存进镜头目录的 .studio-frames/。 */
async function captureSceneFrames(signal: AbortSignal, sc: SceneSummary): Promise<void> {
  if (!sc.exists) throw new Error('镜头产物不存在');
  const dir = path.join(sc.directory, '.studio-frames');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const toolchain = mediaprobe.newToolchain(envMap());
  const duration = sc.duration_seconds ?? 0;
  const seconds = [0, duration / 2, Math.max(duration - 0.05, 0)];
  for (const [i, second] of seconds.entries()) {
    if (signal.aborted) throw new Error('context canceled');
    const out = path.join(dir, `frame-${String(i + 1).padStart(2, '0')}.jpg`);
    try {
      toolchain.extractFrame(path.join(sc.directory, sc.output ?? ''), second, out);
    } catch (err) {
      throw new Error('抽帧失败：' + (err as Error).message, { cause: err });
    }
  }
}

/** sceneAttachment 在镜头产物的某一秒抽一帧存成附件，供下一条消息引用。 */
async function sceneAttachment(request: Request, p: Project, sc: SceneSummary): Promise<Response> {
  let seconds: number;
  let region: Box | undefined;
  try {
    const body = await decodeJSON(request);
    seconds = fieldNumber(body, 'seconds');
    const raw = fieldObject(body, 'region');
    region = raw ? { x: fieldInt(raw, 'x'), y: fieldInt(raw, 'y'), w: fieldInt(raw, 'w'), h: fieldInt(raw, 'h') } : undefined;
  } catch (err) {
    if (!(err instanceof DecodeError)) throw err;
    return writeError(400, 'invalid_request', '需要非负的 seconds');
  }
  if (seconds < 0) return writeError(400, 'invalid_request', '需要非负的 seconds');
  if (!sc.exists) return writeError(400, 'scene_not_rendered', '镜头还没有产物');
  let toolchain: mediaprobe.Toolchain;
  try {
    toolchain = mediaprobe.newToolchain(envMap());
  } catch (err) {
    return writeError(500, 'ffprobe_missing', (err as Error).message);
  }
  const name = `${sc.id}-${newID('a')}.png`;
  const rel = ['production', 'studio', 'attachments', name].join('/');
  try {
    toolchain.extractFrame(path.join(sc.directory, sc.output ?? ''), seconds, path.join(p.path, ...rel.split('/')));
  } catch (err) {
    return writeError(500, 'extract_failed', (err as Error).message);
  }
  return writeJSON(201, attachmentJSON({ scene_id: sc.id, path: rel, seconds: seconds || undefined, region }));
}

// ---- 合成实时预览 ----

/** previewAPI 静态服务镜头目录，供网页用 iframe 打开合成实时预览。rest 是 /preview/scenes/ 之后的部分。 */
export function previewAPI(s: Server, request: Request, rest: string): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const cut = rest.indexOf('/');
  const id = cut < 0 ? rest : rest.slice(0, cut);
  let file = cut < 0 ? '' : rest.slice(cut + 1);
  for (const sc of discoverScenes(p.path)) {
    if (sc.id !== id) continue;
    if (file === '') file = 'index.html';
    const sceneRel = path.relative(p.path, sc.directory);
    let full: string;
    try {
      full = containedPath(p.path, path.join(sceneRel, file));
    } catch {
      return notFound();
    }
    if (!full.startsWith(sc.directory + path.sep) || isEnvFile(full)) return notFound();
    return serveFile(request, full);
  }
  return notFound();
}
