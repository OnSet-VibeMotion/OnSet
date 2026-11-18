/** 发布页的后端接口（原在 studio/features.ts）。 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { walkDir } from '../../fsutil';
import type { ApiHost } from '../../plugin/types';
import { goMap, goValue, writeJSON } from '../../studio/http';
import { decodeConfig } from '../../validate/imageconfig';
import { platformName } from './cover_images';
import { readPublish } from './publish';

/** GET /api/publish：publish.md 解析出的字段与 covers/ 下的封面（不回传 Markdown 原文）。 */
export function publishAPI(s: ApiHost): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const file = path.join(p.path, 'publish.md');
  const available = fs.existsSync(file);
  // 不回传 Markdown 原文：发布页只按解析出的字段排版。
  const result: Record<string, unknown> = { available, path: 'publish.md' };
  const covers: unknown[] = [];
  // 结构化的发布信息供页面排版；解析失败时页面给出原因。
  if (available) {
    try {
      const data = readPublish(file);
      result.data = data === null ? null : goValue(data);
      const platform = data !== null && typeof data.platform === 'string' ? data.platform : '';
      result.platform_name = platformName(platform);
      // 平台标题、平台话题里写到的平台，给页面显示中文名（没写这两项时不出这个字段）。
      const copy = data !== null && typeof data.copy === 'object' && data.copy !== null ? (data.copy as Record<string, unknown>) : {};
      const named = new Set<string>();
      for (const field of ['platform_titles', 'platform_hashtags']) {
        const block = copy[field];
        if (block && typeof block === 'object' && !Array.isArray(block)) for (const k of Object.keys(block)) named.add(k);
      }
      if (named.size > 0) result.platform_names = goValue(Object.fromEntries([...named].sort().map((k) => [k, platformName(k)])));
    } catch (err) {
      result.parse_error = (err as Error).message;
    }
  }
  walkDir(path.join(p.path, 'covers'), (full, entry) => {
    if (!entry || entry.isDirectory()) return;
    let info: fs.Stats;
    try {
      info = fs.lstatSync(full);
    } catch {
      return;
    }
    const cover: Record<string, unknown> = { path: path.relative(p.path, full).split(path.sep).join('/'), size: info.size };
    let body: Buffer | null = null;
    try {
      body = fs.readFileSync(full);
    } catch {
      body = null;
    }
    if (body) {
      cover.sha256 = crypto.createHash('sha256').update(body).digest('hex');
      try {
        // Go 版用 image.Decode（只注册了 PNG 与 JPEG）；这里读文件头里的宽高。
        const config = decodeConfig(full);
        cover.width = config.width;
        cover.height = config.height;
      } catch {
        cover.error = '无法读取图片尺寸';
      }
    }
    covers.push(goMap(cover));
  });
  result.covers = covers;
  return writeJSON(200, goMap(result));
}
