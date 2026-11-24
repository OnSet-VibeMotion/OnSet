/**
 * 项目状态、素材列表与成片审查接口：/api/state、/api/assets、/api/review、/api/review/run。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReviewWorkDirEnv } from '../review';
import { contained } from '../scene';
import { decodeJSON, fieldString, goMap, goValue, methodNotAllowed, writeError, writeJSON } from './http';
import {
  filmVideos,
  latestReviewReport,
  readReviewReport,
  reviewApprovalDigest,
  silentMaster,
  studioReviewInputs,
} from './reviewreport';
import { fileExists } from './scenes';
import type { Server } from './studio';
import { findProjectVideo, inspectProject, walkFiles } from './studio_inspect';
import { runStudioOp, runWriteTask, writeTaskError } from './tasks';

export function stateAPI(s: Server): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  return writeJSON(200, inspectProject(p));
}

export function assetsAPI(s: Server): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const assets: { path: string; size: number }[] = [];
  for (const root of ['assets', 'cast'])
    walkFiles(path.join(p.path, root), (file, info) => {
      assets.push({ path: path.relative(p.path, file).split(path.sep).join('/'), size: info.size });
    });
  return writeJSON(200, goMap({ assets }));
}

export function reviewAPI(s: Server, request: Request): Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  const video = new URL(request.url).searchParams.get('video') || undefined;
  if (video && !filmVideos.has(video) && video !== silentMaster) {
    return writeError(400, 'invalid_video', '请选择项目的成片、配音合成版或无声母版');
  }
  const report =
    latestReviewReport(p.path, video) ??
    readReviewReport(p.path, path.join(p.path, 'production', 'review', 'review.json'));
  if (!report) return writeJSON(200, goMap({ available: false, issues: [] }));
  const target = report.video;
  const knownTarget = target && (filmVideos.has(target) || target === silentMaster) ? target : null;
  return writeJSON(
    200,
    goMap({
      available: true,
      path: knownTarget,
      unbound: report.video === null,
      can_approve: (!video || video === knownTarget) && reviewApprovalDigest(p.path, report) !== '',
      report: report.data ? goValue(report.data) : goMap({ raw: report.body }),
      report_dir: path.relative(p.path, path.dirname(report.file)).split(path.sep).join('/'),
    }),
  );
}

export async function reviewRunAPI(s: Server, request: Request): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let selected: string;
  try {
    selected = fieldString(await decodeJSON(request), 'video');
  } catch {
    return writeError(400, 'invalid_request', '视频路径无效');
  }
  const silent = selected === silentMaster;
  if (selected && !silent && !filmVideos.has(selected)) {
    return writeError(400, 'invalid_video', '请选择项目的成片、配音合成版或无声母版');
  }
  if (selected && !fileExists(path.join(p.path, selected))) {
    return writeError(404, 'video_missing', '找不到选中的视频');
  }
  try {
    const t = runWriteTask(s, p, 'project.review', '运行成片审查', async (signal) => {
      const folder =
        selected === 'final.mp4'
          ? 'review-final'
          : selected === 'production/final.mp4'
            ? 'review-production-final'
            : silent
              ? 'review-silent'
              : 'review';
      const dir = contained(p.path, path.join('production', folder), 'out');
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      const video = selected ? path.join(p.path, selected) : findProjectVideo(p.path);
      if (video === '') throw new Error('找不到可审查的成片，请先生成 candidate.mp4 或 final.mp4');
      contained(p.path, path.relative(p.path, video), 'video');
      const { scenes, spec } = studioReviewInputs(p.path, silent);
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-studio-review-'));
      try {
        await runStudioOp(
          s,
          signal,
          p,
          'review',
          {
            video,
            out: dir,
            silent,
            validate_report: path.join('production', folder, 'validate.json').split(path.sep).join('/'),
            expect_frames: spec.frames,
            ...(scenes ? { scenes } : {}),
          },
          { env: { [ReviewWorkDirEnv]: work } },
        );
      } finally {
        // 取消时执行进程可能被强制终止，等进程树退出后由宿主回收副本。
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
      }
    });
    return writeJSON(202, goMap({ task_id: t.task_id }));
  } catch (err) {
    return writeTaskError(err);
  }
}
