/**
 * 记忆面板。
 *
 * 读接口直接读记忆库（只读，不记快照）；面板上的操作都经 onset memory 子命令。
 * 唯一的例外是对话信号（recordUtterance）：每轮结束、每次回退各追加一段经历，
 * 只增不改，不碰项目文件，为它每轮起一个子进程不值得。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { envMap } from '../envutil';
import { sortedKeys } from '../gojson';
import * as memory from '../memory';
import * as scene from '../scene';
import { sceneActivity } from './activity';
import { resolveExamAudio, resolveExamVideo } from './exammedia';
import { goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { memoryStore } from './memory_recall';
import { fileExists } from './scenes';
import type { Server } from './studio';

export { memoryActionAPI, preferenceBrief, recordUtterance } from './memory_actions';
export { memoryApplicationsAPI, memoryExamAudioAPI, memoryRecallAPI } from './memory_recall';

/** 对象与它的 map[string]string 标签表：按键排序写出。 */
function labels(table: Readonly<Record<string, string>>): Record<string, unknown> {
  return sortedKeys({ ...table });
}

/** GET /api/memory：记忆面板的全部数据。 */
export function memoryAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const opened = memoryStore(s);
  if (opened instanceof Response) return opened;
  const { p, cfg, store } = opened;
  try {
    const env = envMap();
    const status = store.status(false, (r) => store.currentModel(r, env, config.rendererModelFor(cfg, r)));
    const all = store.memories().memories;
    const stats = memory.statsToJSON(store.stats());
    const rows = all.map((m) => ({
      ...memory.memoryToJSON(m),
      revised_by: all
        .filter((next) => next.revises === m.name)
        .map((next) => ({ name: next.name, description: next.description, status: next.status })),
      stats: Object.hasOwn(stats, m.name) ? stats[m.name] : null,
      // examinable 为 false 的试用经验只由相邻镜头的交接判定，考不了，要人确认生效。
      examinable: m.kind === memory.KindLesson && memory.examinableLesson(m),
    }));
    const events = store.timeline();
    // 经历事件可能成百上千条，面板只要最近的；整理、考试这些节点事件全留。
    // 记忆库所有项目共用：本项目与其他项目的经历各留最近 50 条，网页默认只显示本项目的。
    const project = memory.projectName(p.path);
    const timeline: unknown[] = [];
    let mine = 0;
    let others = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === memory.EventEpisode) {
        if (events[i].project === project) {
          if (++mine > 50) continue;
        } else if (++others > 50) continue;
      }
      timeline.push(memory.eventToJSON(events[i]));
    }
    const episodes = store.episodes();
    const byID = new Map(episodes.map((e) => [e.id, e]));
    const projects = s.registeredProjects();
    const views = store.exams().map((exam) => {
      const texts = new Map<string, string>();
      const cells = (exam.cells ?? []).map((cell) => {
        const c: Record<string, unknown> = memory.cellToJSON(cell);
        // output 是这一格产物相对项目根的路径，供画面对照读取；不在项目里时不写。
        const video = resolveExamVideo(p.path, cell.workdir, projects);
        if (video) {
          const query = new URLSearchParams({
            question: cell.question,
            renderer: cell.renderer,
            arm: cell.arm,
            repeat: String(cell.repeat),
          });
          const mediaURL = `/api/memory/exams/${encodeURIComponent(exam.id)}`;
          c.preview_video = { url: `${mediaURL}/video?${query}`, source_project: video.source_project };
          let rel: string | undefined;
          try {
            rel = path.relative(p.path, fs.realpathSync(video.file));
          } catch {
            /* 产物尚不存在或已移走。 */
          }
          if (
            rel &&
            !path.isAbsolute(rel) &&
            rel !== '..' &&
            !rel.startsWith('..' + path.sep) &&
            fileExists(path.join(p.path, rel))
          ) {
            c.output = rel.split(path.sep).join('/');
          }
          const q = (exam.questions ?? []).find((q) => q.id === cell.question);
          const source = q?.holdout ? q.input : (byID.get(q?.episode ?? '')?.scene_dir ?? '');
          const audio =
            q && (!q.episode || byID.has(q.episode)) && (!q.holdout || source !== '')
              ? resolveExamAudio(p.path, cell.workdir, source, projects)
              : null;
          if (audio) {
            c.preview_audio = {
              url: `/api/memory/exams/${encodeURIComponent(exam.id)}/audio?${query}`,
              start_seconds: audio.start_seconds,
              duration_seconds: audio.duration_seconds,
              label: '来源项目口播',
              source_project: audio.source_project,
            };
          } else {
            c.audio_unavailable = '此题的来源配音暂时不可用，请检查原项目是否仍在、口播时间是否已改变。';
          }
        }
        // 这一格查出的问题原文与镜头口播取自它的考试经历：格子里只有校验器 ID 与个数。
        const episode = byID.get(cell.episode);
        if (episode) {
          if ((episode.problems ?? []).length > 0) c.problem_texts = episode.problems;
          if (
            (cell.checks ?? []).some((check) => check.startsWith(scene.ReadsCheckPrefix)) &&
            (episode.problems ?? []).some(memory.missingReadEvidence)
          ) {
            c.incomplete = true;
          }
          if (episode.text !== '' && !texts.has(cell.question)) texts.set(cell.question, episode.text);
        }
        return c;
      });
      // Go 的 examView 内嵌 ExamResult、再用自己的 cells 遮住它：cells 排在最后。
      const { cells: _hidden, questions: _questions, ...rest } = memory.examResultToJSON(exam);
      const questions = (exam.questions ?? []).map((q) => ({ ...memory.questionToJSON(q), text: texts.get(q.id) }));
      const incomplete = cells.some((c) => c.incomplete === true);
      const audit = incomplete
        ? {
            verdict: memory.verdictToJSON(
              memory.judge(
                exam.questions ?? [],
                exam.renderers ?? [],
                (exam.cells ?? []).map((c, i) => ({ ...c, incomplete: cells[i].incomplete === true })),
                false,
                exam.trials ?? [],
              ),
            ),
            applied: 'none',
            evaluation_note: '补充审计：检查依据不完整，清单缺失或无效不能作为视频质量改善的依据。原始考试记录保留。',
          }
        : {};
      const acceptance = memory.examAcceptance(store, exam);
      return {
        ...rest,
        ...audit,
        questions,
        cells,
        ...(acceptance ? { human_acceptance: acceptance, original_verdict: exam.verdict } : {}),
      };
    });
    let allRuns: memory.RunSummary[] = [];
    try {
      allRuns = memory.runReport(episodes);
    } catch {
      allRuns = [];
    }
    let runs = allRuns.filter((r) => r.project === project);
    if (runs.length > 12) runs = runs.slice(runs.length - 12);
    // 进化页挑两批来比：记忆库所有项目共用，第一次与第二次常常不在同一个项目里。
    if (allRuns.length > 40) allRuns = allRuns.slice(allRuns.length - 40);
    const snapshots = store.snapshotIDs() ?? [];
    return writeJSON(
      200,
      goMap({
        enabled: cfg.memory.enabled,
        dir: store.dir,
        project,
        pinned: cfg.memory.snapshot,
        budget: cfg.memory.recallBudget,
        renderer: cfg.renderer,
        status: memory.statusReportToJSON(status),
        memories: rows,
        timeline,
        exams: views,
        exam_progress: memory
          .examProgress(store)
          .filter((e) => {
            const rel = path.relative(p.path, e.workspace);
            return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
          })
          .slice(-12)
          .map((e) => ({
            ...memory.examProgressToJSON(e),
            cells: e.cells.map((c) => {
              const q = e.questions.find((q) => q.id === c.question);
              const directory = path.join(e.workspace, e.id, c.question, `${c.renderer}-${c.arm}-${c.repeat}`);
              return {
                ...c,
                result: c.result ? memory.cellToJSON(c.result) : undefined,
                activity:
                  c.status === 'running' && q
                    ? sceneActivity({ id: q.scene_id, directory, exists: false, stale: false, attempts: 0 })
                    : undefined,
              };
            }),
          })),
        snapshots,
        runs: runs.map(memory.runSummaryToJSON),
        runs_all: allRuns.map(memory.runSummaryToJSON),
        pending: pendingProblems(episodes, status.last_consolidated),
        // 面板显示的大白话：校验器、事件类型与镜头特征都不直接露出 ID。
        labels: goMap({
          checks: labels(memory.CheckerLabels),
          events: labels(memory.EventLabels),
          features: labels(memory.featureDescriptions()),
        }),
      }),
    );
  } catch (err) {
    return writeError(500, 'memory_unavailable', (err as Error).message);
  }
}

/**
 * 上次整理之后还没整理的问题，按校验器归组：面板要讲「记下了哪些问题、各出现几次、在哪些镜头」，
 * 而不是一串渲染日志。口径与 status 的 pending_failures 相同（考试不算）；
 * 同一次经历里同一个问题报了几处只算一次。
 */
function pendingProblems(
  episodes: memory.Episode[],
  since: string,
): { check: string; count: number; scenes: { project: string; scene: string }[] }[] {
  const groups = new Map<string, { check: string; count: number; scenes: { project: string; scene: string }[] }>();
  for (const e of episodes) {
    if (e.created_at <= since || e.source === memory.SourceExam || !memory.failure(e)) continue;
    const checks = e.checks?.length ? e.checks : [memory.CheckerHuman];
    for (const check of new Set(checks)) {
      let g = groups.get(check);
      if (!g) groups.set(check, (g = { check, count: 0, scenes: [] }));
      g.count++;
      if (e.scene_id && !g.scenes.some((x) => x.project === e.project && x.scene === e.scene_id)) {
        g.scenes.push({ project: e.project, scene: e.scene_id });
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || (a.check < b.check ? -1 : 1));
}
