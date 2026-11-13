/**
 * 新建项目的画幅与风格选项、文件树、原样读文件、卡点状态。
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import * as preset from '../preset';
import * as projectinit from '../projectinit';
import { goMap, methodNotAllowed, notFound, serveFile, writeJSON } from './http';
import { containedPath } from './sessions';
import type { Server } from './studio';
import { skipDir, walkDir } from './turns';

/**
 * maxTreeEntries 限制 /api/tree 返回的文件数。项目里真正要看的文件远少于这个数，
 * 超过说明扫进了依赖或缓存目录，截断比让网页卡死好。
 */
export const maxTreeEntries = 5000;

/** stylesAPI 列出新建项目可选的画幅与做法。 */
export function stylesAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const canvases = preset.all().map((p) => ({ id: p.id, label: p.label, width: p.canvas.widthPx, height: p.canvas.heightPx, orientation: p.canvas.orientation }));
  return writeJSON(
    200,
    goMap({
      canvases,
      default_canvas: preset.defaultPreset().id,
      // 新建对话框的做法（讲解形式 + 叙事模式），宿主的与内置插件登记的。
      modes: projectinit.presets(),
    }),
  );
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

