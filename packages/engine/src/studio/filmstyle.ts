/**
 * 整片风格（../filmstyle）在 Studio 里的入口：各风格来源的目录与海报、本项目的
 * 整片风格、装 / 换 / 去掉。移植自 internal/studio/filmstyle.go。
 *
 * 来源数据是前置资源（am setup 准备），这里只读不下载。装与去掉经 am film-style 子命令完成，
 * 占项目写锁，与渲染、拼接同一条路：Studio 自己不写项目文件。这里不点名任何来源，
 * 全部经 filmstyle.sources() 取。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import * as filmstyle from '../filmstyle';
// 全部风格来源经 sources 登记进 filmstyle；新增来源只改 sources 模块。
import '../filmstyle/sources';
import { newToolchain } from '../mediaprobe';
import { DecodeError, decodeJSON, fieldBool, fieldString, goMap, methodNotAllowed, serveFile, writeError, writeJSON } from './http';
import type { Project, Server } from './studio';
import { runStudioCLI, runWriteTask, writeTaskError, type Task } from './tasks';

/** /api/film-styles 里的一个来源。ready 为 false 时来源数据还没由 am setup 准备好（附 problem）。 */
export interface FilmStyleSource {
  id: string;
  name: string;
  gallery?: string;
  categories: string[];
  ready: boolean;
  problem?: string;
}

/** Style 按 Go struct 的字段顺序写出。 */
export function styleJSON(style: filmstyle.Style): Record<string, unknown> {
  return {
    source: style.source,
    slug: style.slug,
    order: style.order,
    cn: style.cn,
    en: style.en,
    category_cn: style.category_cn,
    category_en: style.category_en,
    uses: style.uses,
    summary: style.summary,
    tags: style.tags && style.tags.length > 0 ? style.tags : undefined,
  };
}

/** Manifest 按 Go struct 的字段顺序写出（legacy 是 json:"-"）。 */
function manifestJSON(manifest: filmstyle.Manifest): Record<string, unknown> {
  return {
    source: manifest.source,
    slug: manifest.slug,
    cn: manifest.cn,
    en: manifest.en,
    version: manifest.version,
    digest: manifest.digest,
    installed_at: manifest.installed_at,
  };
}

/** filmStylesAPI 列出各来源的风格目录（随程序下发，不联网）与来源数据是否就绪。 */
export function filmStylesAPI(request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const env = envMap();
  const sources: FilmStyleSource[] = [];
  for (const source of filmstyle.sources()) {
    const item: FilmStyleSource = { id: source.id(), name: source.name(), gallery: source.gallery(), categories: filmstyle.categories(source.id()), ready: true };
    try {
      source.check(env);
    } catch (err) {
      item.ready = false;
      item.problem = (err as Error).message;
    }
    sources.push(item);
  }
  return writeJSON(200, {
    sources: sources.length > 0
      ? sources.map((s) => ({ id: s.id, name: s.name, gallery: s.gallery || undefined, categories: s.categories, ready: s.ready, problem: s.problem || undefined }))
      : null,
    styles: filmstyle.catalog().map(styleJSON),
  });
}

/**
 * filmStylePosterAPI 返回 /api/film-styles/{来源}/{目录名}/poster.jpg：来源数据里有就给，
 * 没有 404，网页显示占位块。
 */
export async function filmStylePosterAPI(request: Request, rest: string): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const parts = rest.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 3 || parts[2] !== 'poster.jpg') return writeError(404, 'not_found', '没有这个资源');
  const { style, ok } = filmstyle.find(parts[0] + '/' + parts[1]);
  if (!ok || !style || style.source !== parts[0] || style.slug !== parts[1]) return writeError(404, 'unknown_film_style', '没有这种风格');
  const source = filmstyle.sourceByID(style.source)!;
  const env = envMap();
  let file: string;
  try {
    file = source.poster(env, style.slug);
  } catch {
    return writeError(404, 'poster_unavailable', '风格海报还没有准备好（am setup）');
  }
  // 原图常是 1920×1080，菜单里一屏几十张会很卡：缩成 480 宽的缩略图，缓存在
  // <风格根目录>/.thumbs/<来源>/ 下，原图比缩略图新时重做。缩不了就退回原图。
  if (new URL(request.url).searchParams.get('size') !== 'full') {
    const cache = path.join(filmstyle.rootDir(env), '.thumbs', style.source, String(posterThumbWidth));
    try {
      file = await posterThumbnail(cache, style.slug, file, env);
    } catch {
      // 退回原图。
    }
  }
  return serveFile(request, file, { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'image/jpeg' });
}

/** posterThumbWidth 是菜单缩略图的宽度。 */
export const posterThumbWidth = 480;

/** 读 JPEG 的 SOF 段取宽高（不解码像素）。不是 JPEG 时抛错。 */
export function jpegSize(file: string): { width: number; height: number } {
  const buf = fs.readFileSync(file);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('invalid JPEG format: missing SOI marker');
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF && i + 9 <= buf.length) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (marker === 0xd9 || marker === 0xda) break;
    i += 2 + length;
  }
  throw new Error('invalid JPEG format: missing SOF marker');
}

/**
 * posterThumbnail 返回海报缩略图路径，没有就生成。
 *
 * Go 版用标准库解码 JPEG 后按面积平均缩小（box filter）再编码；TS 没有图像库，改经 mediaprobe 的
 * 工具链调 ffmpeg 的 area 缩放（同为面积平均），像素不逐字节相同，尺寸相同（高按 Go 的整数除法取）。
 * 缺 ffmpeg 时抛错，调用方退回原图——与 Go 版「缩不了就退回原图」同一条路。
 */
export async function posterThumbnail(dir: string, slug: string, source: string, env: Record<string, string> = envMap()): Promise<string> {
  const target = path.join(dir, slug + '.jpg');
  try {
    const thumb = fs.statSync(target);
    const original = fs.statSync(source);
    if (original.mtimeMs <= thumb.mtimeMs) return target;
  } catch {
    // 没有缩略图或原图：往下重做。
  }
  const { width: sourceWidth, height: sourceHeight } = jpegSize(source);
  if (sourceWidth <= posterThumbWidth) return source;
  const width = posterThumbWidth;
  const height = Math.max(1, Math.floor((sourceHeight * width) / sourceWidth));
  const toolchain = newToolchain(env);
  const ffmpeg = toolchain.ffmpegPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = path.join(dir, `.am-tmp-${crypto.randomBytes(6).toString('hex')}.jpg`);
  try {
    const ran = await toolchain.runAsync(ffmpeg, ['-v', 'error', '-y', '-i', source, '-vf', `scale=${width}:${height}:flags=area`, '-q:v', '4', tmp], {
      captureStderr: true,
    });
    if (ran.error) throw new Error(`缩略图失败：${ran.error}：${ran.stderr.toString('utf8').trim()}`);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return target;
}

/** 本项目的整片风格。style_file 是 STYLE.md 在项目里的相对路径，网页经 /api/files 读。 */
interface ProjectFilmStyle {
  installed: boolean;
  manifest?: filmstyle.Manifest;
  style?: filmstyle.Style;
  style_file?: string;
}

/** projectFilmStyleAPI：GET 查看本项目的整片风格；POST {"style","replace"} 装或换；DELETE 去掉。 */
export async function projectFilmStyleAPI(s: Server, request: Request): Promise<Response> {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  switch (request.method) {
    case 'GET': {
      let found: { manifest: filmstyle.Manifest; ok: boolean };
      try {
        found = filmstyle.installed(p.path);
      } catch (err) {
        return writeError(500, 'film_style_unreadable', (err as Error).message);
      }
      const resp: ProjectFilmStyle = { installed: found.ok };
      if (found.ok) {
        resp.manifest = found.manifest;
        const rel = path.relative(p.path, filmstyle.installedDir(p.path));
        resp.style_file = path.join(rel, filmstyle.StyleFile).split(path.sep).join('/');
        const match = filmstyle.find(filmstyle.manifestKey(found.manifest));
        if (match.ok && match.style) resp.style = match.style;
      }
      return writeJSON(200, {
        installed: resp.installed,
        manifest: resp.manifest ? manifestJSON(resp.manifest) : undefined,
        style: resp.style ? styleJSON(resp.style) : undefined,
        style_file: resp.style_file || undefined,
      });
    }
    case 'POST': {
      let style = '';
      let replace = false;
      let remove = false;
      try {
        const body = await decodeJSON(request);
        style = fieldString(body, 'style');
        replace = fieldBool(body, 'replace');
        // remove 为 true 时等同 DELETE：网页的按钮动作统一走 POST。
        remove = fieldBool(body, 'remove');
      } catch (err) {
        if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
        throw err;
      }
      if (remove) return removeFilmStyle(s, p);
      let found: filmstyle.Style;
      try {
        found = filmstyle.lookup(style);
      } catch (err) {
        return writeError(400, 'unknown_film_style', (err as Error).message);
      }
      try {
        const t = startFilmStyleTask(s, p, found, replace);
        return writeJSON(202, goMap({ task_id: t.task_id }));
      } catch (err) {
        return writeTaskError(err);
      }
    }
    case 'DELETE':
      return removeFilmStyle(s, p);
    default:
      return methodNotAllowed('GET, POST, DELETE');
  }
}

/** startFilmStyleTask 起一个 am film-style use 写任务。 */
export function startFilmStyleTask(s: Server, p: Project, style: filmstyle.Style, replace: boolean): Task {
  const args = ['film-style', 'use', filmstyle.styleKey(style), '--project-root', p.path];
  if (replace) args.push('--replace');
  return runWriteTask(s, p, 'film-style.use', '整片风格：' + style.cn, async (signal) => {
    await runStudioCLI(s, signal, p, ...args);
  });
}

function removeFilmStyle(s: Server, p: Project): Response {
  try {
    const t = runWriteTask(s, p, 'film-style.remove', '去掉整片风格', async (signal) => {
      await runStudioCLI(s, signal, p, 'film-style', 'remove', '--project-root', p.path);
    });
    return writeJSON(202, goMap({ task_id: t.task_id }));
  } catch (err) {
    return writeTaskError(err);
  }
}
