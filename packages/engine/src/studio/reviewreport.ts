/**
 * 整片复查的报告不一定在 production/review/：制作提示词要求每次修订用独立目录，编排常写到 production/review-v3/ 这类目录
 * （2026-11 片场宣传视频：复查明明做完了，路线还按 11 月 14 日的旧报告判「上游改过，要重做」，复查页也显示旧报告）。
 * 这里找 production/ 下一层目录里最新的、复查的是成片候选或成片的 review.json；复查静音母版的（production/review-silent/）不算。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ReviewReport {
  file: string;
  mtime: number;
}

/** 复查的是这几个文件才算整片复查。 */
export const filmVideos = new Set(['production/audio/candidate.mp4', 'final.mp4', 'production/final.mp4']);

function reviewedVideo(root: string, file: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof raw.path !== 'string' || raw.path === '') return null;
    const abs = path.isAbsolute(raw.path) ? raw.path : path.join(root, raw.path);
    return path.relative(root, abs).split(path.sep).join('/');
  } catch {
    return null;
  }
}

export function latestReviewReport(root: string): ReviewReport | null {
  const production = path.join(root, 'production');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(production, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: ReviewReport | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'studio') continue;
    const file = path.join(production, entry.name, 'review.json');
    let mtime: number;
    try {
      const info = fs.statSync(file);
      if (!info.isFile()) continue;
      mtime = info.mtimeMs;
    } catch {
      continue;
    }
    const video = reviewedVideo(root, file);
    // 老报告没写 path：只认缺省目录里的那份。
    const counts = video === null ? entry.name === 'review' : filmVideos.has(video);
    if (counts && (!best || mtime > best.mtime)) best = { file, mtime };
  }
  return best;
}
