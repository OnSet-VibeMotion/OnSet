/**
 * 整片复查的报告不一定在 production/review/：制作提示词要求每次修订用独立目录，编排常写到 production/review-v3/ 这类目录
 * （2026-11 片场宣传视频：复查明明做完了，路线还按 11 月 14 日的旧报告判「上游改过，要重做」，复查页也显示旧报告）。
 * 这里找 production/ 下一层目录里最新的、复查的是成片候选或成片的 review.json；复查静音母版的（production/review-silent/）不算。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canvasOf, contained } from '../scene';
import { compareBytes } from '../gojson';
import { deliverySpec, reviewSegments, scenePlanDigest } from '../review';
import { plan } from '../schedule';

export interface ReviewReport {
  file: string;
  mtime: number;
  body: string;
  data: Record<string, unknown> | null;
  video: string | null;
}

export const candidateFilm = 'production/audio/candidate.mp4';
export const silentMaster = 'production/silent-master.mp4';
/** 复查的是这几个文件才算整片复查。 */
export const filmVideos = new Set([candidateFilm, 'final.mp4', 'production/final.mp4']);

function reviewVideoPath(root: string, value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  return path.relative(root, path.resolve(root, value)).split(path.sep).join('/');
}

export function readReviewReport(root: string, file: string): ReviewReport | null {
  try {
    const resolved = contained(root, path.relative(root, file), 'review.json');
    const info = fs.statSync(resolved);
    if (!info.isFile()) return null;
    const body = fs.readFileSync(resolved, 'utf8');
    let data: Record<string, unknown> | null = null;
    try {
      const value: unknown = JSON.parse(body);
      if (value && typeof value === 'object' && !Array.isArray(value)) data = value as Record<string, unknown>;
    } catch {
      // 缺省目录下的旧报告仍可查看原文。
    }
    return { file, mtime: info.mtimeMs, body, data, video: reviewVideoPath(root, data?.path) };
  } catch {
    return null;
  }
}

export function latestReviewReport(root: string, video?: string, { exact = false } = {}): ReviewReport | null {
  const production = path.join(root, 'production');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(contained(root, 'production', 'production'), { withFileTypes: true });
  } catch {
    return null;
  }
  let best: ReviewReport | null = null;
  let matching: ReviewReport | null = null;
  for (const entry of entries.sort((a, b) => compareBytes(a.name, b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'studio') continue;
    const found = readReviewReport(root, path.join(production, entry.name, 'review.json'));
    if (!found) continue;
    if (found.video === video && (!matching || found.mtime > matching.mtime)) matching = found;
    // 老报告没写 path：只认缺省目录里的那份。
    const counts = found.video === null ? entry.name === 'review' : filmVideos.has(found.video);
    if (counts && (!best || found.mtime > best.mtime)) best = found;
  }
  return matching ?? (video && exact ? null : best);
}

export function studioReviewInputs(root: string, silent: boolean) {
  contained(root, 'frame.md', 'frame.md');
  const canvas = canvasOf(root, 'frame.md');
  const scenes = contained(root, 'scenes', 'scenes');
  const planned = fs.existsSync(scenes) ? plan(scenes, root) : [];
  if (planned.length) {
    // 镜头计划已冻结时以它为准，避免沿用上次混音遗留的时长。
    const segments = reviewSegments(planned, canvas.fps);
    const frames = segments.reduce((sum, segment) => sum + segment.frames, 0);
    return { scenes, spec: deliverySpec(canvas, frames, silent), planDigest: scenePlanDigest(segments) };
  }
  const timing = contained(root, path.join('production', 'timing-report.json'), 'timing-report.json');
  try {
    const { total_frames: frames, fps } = JSON.parse(fs.readFileSync(timing, 'utf8')) ?? {};
    if (Number.isSafeInteger(frames) && frames > 0 && (fps === undefined || fps === canvas.fps)) {
      return { scenes: undefined, spec: deliverySpec(canvas, frames, silent), planDigest: undefined };
    }
  } catch (err) {
    if (!(err instanceof SyntaxError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  throw new Error('没有可用的冻结镜头计划，请重新生成时长报告后再复查');
}

export function reviewApprovalDigest(root: string, report: ReviewReport | null): string {
  const sha = report?.data?.video_sha256;
  if (!report?.video || !filmVideos.has(report.video) || report.data?.ok !== true ||
      typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return '';
  const saved = report.data.delivery_spec;
  if (!saved || typeof saved !== 'object') return '';
  const matchesCurrentPlan = () => {
    try {
      const { spec, planDigest } = studioReviewInputs(root, false);
      return report.data?.scene_plan_sha256 === planDigest &&
        Object.entries(spec).every(([field, value]) => (saved as Record<string, unknown>)[field] === value);
    } catch {
      return false;
    }
  };
  return matchesCurrentPlan() && projectVideoDigest(root, report.video) === sha && matchesCurrentPlan() ? sha : '';
}

export function canApproveLatestReview(root: string, video: string, digest: string): boolean {
  if (!filmVideos.has(video) || !digest) return false;
  let selected = latestReviewReport(root, video, { exact: true });
  // 允许重读一次刚写完的报告。连续有写入时请重新操作。
  for (let attempt = 0; selected && attempt < 2; attempt++) {
    if (reviewApprovalDigest(root, selected) !== digest) return false;
    const latest = latestReviewReport(root, video, { exact: true });
    if (latest?.file === selected.file && latest.body === selected.body) return true;
    selected = latest;
  }
  return false;
}

/** 候选成片动辄上百 MB，路线每次刷新都要看。缓存须区分原地改写和原子替换。 */
const digestCache = new Map<string, { info: fs.BigIntStats; sha: string }>();

function sameFileState(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

export function projectVideoDigest(root: string, video: string): string {
  try {
    const file = contained(root, video, 'video');
    const info = fs.statSync(file, { bigint: true });
    if (!info.isFile()) return '';
    const hit = digestCache.get(file);
    if (hit && sameFileState(hit.info, info)) return hit.sha;
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) hash.update(buf.subarray(0, n));
      if (!sameFileState(info, fs.fstatSync(fd, { bigint: true })) ||
          !sameFileState(info, fs.statSync(file, { bigint: true }))) return '';
    } finally {
      fs.closeSync(fd);
    }
    const sha = hash.digest('hex');
    digestCache.set(file, { info, sha });
    return sha;
  } catch {
    return '';
  }
}
