/**
 * 记忆面板的只读查询接口：记忆库打开、历史考试媒体、镜头召回与经验应用预演。
 */
import fs from 'node:fs';
import * as config from '../config';
import { envMap } from '../envutil';
import { compareBytes } from '../gojson';
import * as memory from '../memory';
import * as scene from '../scene';
import * as series from '../series';
import { resolveExamAudio, resolveExamVideo } from './exammedia';
import { goMap, methodNotAllowed, notFound, serveFile, writeError, writeJSON } from './http';
import { discoverScenes } from './scenes';
import type { Project, Server } from './studio';

export function memoryStore(s: Server): { p: Project; cfg: config.Config; store: memory.Store } | Response {
  const p = s.projectOr404();
  if (p instanceof Response) return p;
  let cfg: config.Config;
  try {
    cfg = config.load(p.path, null);
  } catch (err) {
    return writeError(400, 'invalid_config', (err as Error).message);
  }
  let store: memory.Store;
  try {
    store = memory.open(cfg.memory.dir);
  } catch (err) {
    return writeError(500, 'memory_unavailable', (err as Error).message);
  }
  return { p, cfg, store };
}

/** 历史考试的专用媒体入口：只能定位记录中的考场与登记来源，原始文件接口仍限于当前项目。 */
export function memoryExamAudioAPI(s: Server, request: Request, rest: string): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
  const opened = memoryStore(s);
  if (opened instanceof Response) return opened;
  const match = /^([^/]+)\/(audio|video)$/.exec(rest);
  if (!match) return notFound();
  const exam = opened.store.exams().find((e) => e.id === match[1]);
  if (!exam) return notFound();
  const query = new URL(request.url).searchParams;
  const cell = (exam.cells ?? []).find(
    (c) =>
      c.question === query.get('question') &&
      c.renderer === query.get('renderer') &&
      c.arm === query.get('arm') &&
      String(c.repeat) === query.get('repeat'),
  );
  if (!cell) return notFound();
  const question = (exam.questions ?? []).find((q) => q.id === cell.question);
  if (!question) return notFound();
  if (match[2] === 'video') {
    const video = resolveExamVideo(opened.p.path, cell.workdir, s.registeredProjects());
    return video ? serveFile(request, video.file, { 'Cache-Control': 'no-cache' }) : notFound();
  }
  const source = question.holdout
    ? question.input
    : (opened.store.episodes().find((e) => e.id === question.episode)?.scene_dir ?? '');
  if ((question.episode || question.holdout) && source === '') return notFound();
  const audio = resolveExamAudio(opened.p.path, cell.workdir, source, s.registeredProjects());
  if (!audio) return notFound();
  return serveFile(request, audio.file, { 'Cache-Control': 'no-cache' });
}

/** GET /api/memory/recall?scene=…[&renderer=…]：「本镜头想起了什么」。 */
export function memoryRecallAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const opened = memoryStore(s);
  if (opened instanceof Response) return opened;
  const { p, cfg, store } = opened;
  const query = new URL(request.url).searchParams;
  const id = query.get('scene') ?? '';
  for (const summary of discoverScenes(p.path)) {
    if (summary.id !== id) continue;
    let sc: scene.Scene;
    try {
      sc = scene.load(summary.directory);
    } catch (err) {
      return writeError(400, 'invalid_scene', (err as Error).message);
    }
    const renderer = query.get('renderer') || sc.renderer || cfg.renderer;
    let seriesId = '';
    try {
      seriesId = series.readBinding(p.path)?.series_id ?? '';
    } catch {
      seriesId = '';
    }
    let result: memory.RecallResult;
    try {
      result = store.recallScene(sc, {
        snapshot: cfg.memory.snapshot,
        budget: cfg.memory.recallBudget,
        renderer,
        model: store.currentModel(renderer, envMap(), config.rendererModelFor(cfg, renderer)),
        series: seriesId,
      });
    } catch (err) {
      return writeError(400, 'recall_failed', (err as Error).message);
    }
    return writeJSON(
      200,
      goMap({
        recall: memory.recallResultToJSON(result),
        reasons: result.items.map(memory.recallReason),
        section: memory.recallSection(result),
      }),
    );
  }
  return writeError(404, 'scene_not_found', '镜头不存在');
}

/** 只读地预演召回：停用经验仅放进本次候选池，不改状态、快照或统计。 */
export function memoryApplicationsAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const opened = memoryStore(s);
  if (opened instanceof Response) return opened;
  const { p, cfg, store } = opened;
  const name = new URL(request.url).searchParams.get('name') ?? '';
  const m = store.find(name);
  if (!m || m.kind !== memory.KindLesson) return writeError(404, 'memory_not_found', '经验不存在');
  const summaries = discoverScenes(p.path);
  const sourceDirs = new Set<string>();
  for (const episode of store.episodes()) {
    if (!m.from_episodes.includes(episode.id) || episode.scene_dir === '') continue;
    try {
      // 历史路径可能经 /var 或项目别名写入；只在比较时解析，不改经历。
      sourceDirs.add(fs.realpathSync(episode.scene_dir));
    } catch {
      // 来源项目已搬走或删除时，仍然可以预演这条经验的召回。
    }
  }
  const matches: Record<string, unknown>[] = [];
  let unreadable = 0;
  const env = envMap();
  for (const summary of summaries) {
    try {
      const sc = scene.load(summary.directory);
      const renderer = sc.renderer || cfg.renderer;
      const model = store.currentModel(renderer, env, config.rendererModelFor(cfg, renderer));
      const result = store.recallScene(sc, {
        snapshot: cfg.memory.snapshot,
        budget: cfg.memory.recallBudget,
        renderer,
        model,
        extra: m.status === memory.StatusActive ? [] : [m],
      });
      const selected = result.items.find((item) => item.name === name);
      const item = selected ?? result.omitted.find((item) => item.name === name);
      if (!item) continue;
      let readingContext: { compound_cues: number[]; hint: string } | undefined;
      if (m.checked_by?.includes('reads.order')) {
        try {
          const data = scene.buildSceneData(sc);
          const compact = (text: string) => text.replace(/[\t\n\r ]/g, '');
          const cues = data.cues
            .filter(
              (cue) =>
                data.phrases.filter(
                  (phrase) =>
                    compact(phrase.text) !== '' &&
                    phrase.start_frame < cue.end_frame_exclusive &&
                    phrase.end_frame_exclusive > cue.start_frame &&
                    compact(cue.text).includes(compact(phrase.text)),
                ).length > 1,
            )
            .map((cue) => cue.index);
          readingContext = {
            compound_cues: cues,
            hint:
              cues.length > 0
                ? `有 ${cues.length} 条字幕同时包含多个短语，优先核对是否较晚重复出现前序文字；这不代表已经出错。`
                : '仅匹配召回条件，未发现一条字幕包含多个短语；还需结合画面判断是否适用。',
          };
        } catch {
          readingContext = { compound_cues: [], hint: '暂时读不了字幕结构，仍需结合画面判断是否适用。' };
        }
      }
      matches.push({
        scene_id: sc.id,
        text: sc.text,
        renderer,
        model,
        selected: !!selected,
        score: item.score,
        source_scene: sourceDirs.has(fs.realpathSync(sc.directory)),
        features: item.matched_features,
        keywords: item.matched_keywords,
        global: item.global,
        omit_reason: item.omit_reason,
        reading_context: readingContext,
      });
    } catch {
      unreadable++;
    }
  }
  const hasCompound = (row: Record<string, unknown>) =>
    Number(((row.reading_context as { compound_cues: number[] } | undefined)?.compound_cues.length ?? 0) > 0);
  matches.sort(
    (a, b) =>
      Number(b.selected) - Number(a.selected) ||
      hasCompound(b) - hasCompound(a) ||
      Number(b.score) - Number(a.score) ||
      compareBytes(String(a.scene_id), String(b.scene_id)),
  );
  return writeJSON(
    200,
    goMap({ name, status: m.status, enabled: cfg.memory.enabled, scanned: summaries.length, unreadable, matches }),
  );
}
