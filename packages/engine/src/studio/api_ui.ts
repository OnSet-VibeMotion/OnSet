/**
 * 新建项目的画幅与风格选项、文件树、原样读文件、卡点状态。移植自 internal/studio/api_ui.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '../assets';
import * as beat from '../beat';
import { compareBytes } from '../gojson';
import * as preset from '../preset';
import { goMap, methodNotAllowed, notFound, serveFile, writeJSON } from './http';
import { containedPath } from './sessions';
import { fileExists } from './scenes';
import type { Server } from './studio';
import { skipDir, walkDir } from './turns';

/**
 * maxTreeEntries 限制 /api/tree 返回的文件数。项目里真正要看的文件远少于这个数，
 * 超过说明扫进了依赖或缓存目录，截断比让网页卡死好。
 */
export const maxTreeEntries = 5000;

/** stylesAPI 列出新建项目可选的画幅与风格，示例图经 /api/styles/{风格}/{画幅}/{骨架}.png 取。 */
export function stylesAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const canvases = preset.all().map((p) => ({ id: p.id, label: p.label, width: p.canvas.widthPx, height: p.canvas.heightPx, orientation: p.canvas.orientation }));
  const styles = preset.allStyles().map((st) => ({ id: st.id, name: st.name, label: st.label }));
  return writeJSON(
    200,
    goMap({
      canvases,
      styles,
      custom: { id: preset.CustomStyle.id, name: preset.CustomStyle.name, label: '由模型按描述自主定风格' },
      archetypes: preset.ArchetypeIDs,
      default_canvas: preset.defaultPreset().id,
    }),
  );
}

export function styleExampleAPI(rest: string): Response {
  const parts = rest.split('/');
  if (parts.length !== 3 || !parts[2].endsWith('.png')) return notFound();
  const [styleID, canvasID] = parts;
  const archetype = parts[2].slice(0, -'.png'.length);
  if (!preset.styleByID(styleID)) return notFound();
  if (!preset.ArchetypeIDs.includes(archetype)) return notFound();
  let body: Buffer;
  try {
    body = assets.style(styleID, canvasID).readFile('assets/style-guide/examples/' + archetype + '.png');
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(body), { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
}

export function isEnvFile(file: string): boolean {
  const base = path.basename(file);
  return base === '.env' || (base.startsWith('.env.') && base !== '.env.example');
}

/** treeAPI 列出项目文件，跳过的目录与快照一致，.env 不列出。 */
export function treeAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const entries: { path: string; size: number; mtime: number }[] = [];
  let truncated = false;
  walkDir(p.path, (file, entry) => {
    if (!entry) return;
    // 用量账本是 Studio 与 am 自己记的账，不是项目内容，文件树里不列。
    if (entry.isDirectory()) return skipDir(p.path, file, entry.name) ? 'skip' : undefined;
    if (!entry.isFile() || isEnvFile(file)) return;
    if (entries.length >= maxTreeEntries) {
      truncated = true;
      return 'stop';
    }
    try {
      const info = fs.lstatSync(file);
      entries.push({ path: path.relative(p.path, file).split(path.sep).join('/'), size: info.size, mtime: Math.floor(info.mtimeMs) });
    } catch {
      // 竞态删除。
    }
  });
  entries.sort((a, b) => compareBytes(a.path, b.path));
  return writeJSON(200, goMap({ files: entries, truncated }));
}

/** rawAPI 原样返回项目里的一个文件（成片、联系表、封面、附件等），支持 Range。 */
export function rawAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let file: string;
  try {
    file = containedPath(p.path, new URL(request.url).searchParams.get('path') ?? '');
  } catch {
    return notFound();
  }
  if (isEnvFile(file)) return notFound();
  try {
    if (fs.statSync(file).isDirectory()) return notFound();
  } catch {
    return notFound();
  }
  return serveFile(request, file, { 'Cache-Control': 'no-cache' });
}

/** beatAPI 返回卡点模式的确认状态，网页据此决定是否显示试听与确认按钮。 */
export function beatAPI(s: Server): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const exists = (rel: string) => fileExists(path.join(p.path, rel));
  return writeJSON(
    200,
    goMap({
      enabled: exists(beat.ConfigFile),
      draft: exists(beat.DraftFile),
      click: exists(beat.ClickFile),
      confirmed: exists(beat.GridFile),
      click_path: beat.ClickFile,
    }),
  );
}
