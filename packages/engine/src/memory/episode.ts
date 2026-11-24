import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { goQuote } from '../gofmt';
import { compareBytes } from '../gojson';
import { freeze as freezeResources } from '../renderassets';
import { type Attempt, blockExtraInputDirs, FrameFile, frameSource, inputFiles, type Scene } from '../scene';
import {
  type Episode,
  episodeToJSON,
  type Feedback,
  newEpisode,
  OutcomeFeedback,
  parseEpisode,
  passed,
  SourceConversation,
  SourceExam,
  SourceFeedback,
} from './episode_schema';
import { EventEpisode } from './events';
import { features as sceneFeatures } from './features';
import { compactStamp, monthStamp, rfc3339Nano } from './gostr';
import { copyFile, readJSON, walkDir, writeJSON } from './io';
import type { Exploration } from './recall';
import type { Store } from './store';
import { rendererModel, uniqueSorted } from './util';

export {
  type Episode,
  episodeToJSON,
  type Feedback,
  failure,
  feedbackToJSON,
  firstTry,
  newEpisode,
  newFeedback,
  OutcomeFeedback,
  parseEpisode,
  passed,
  SourceCheck,
  SourceConversation,
  SourceExam,
  SourceFeedback,
  SourceRender,
} from './episode_schema';

function newEpisodeID(now: Date): string {
  return 'ep-' + compactStamp(now) + '-' + crypto.randomBytes(3).toString('hex');
}

/** Go 的 filepath.Dir。 */
function goFileDir(p: string): string {
  return path.dirname(p === '' ? '.' : p);
}

function goFileBase(p: string): string {
  if (p === '') return '.';
  const base = path.basename(p);
  return base === '' ? '/' : base;
}

/** dir 所在项目的名字（项目根目录名：向上找含 onset.conf 的目录），不在项目里时为空。 */
export function projectName(dir: string): string {
  return projectOf(dir);
}

export function projectOf(dir: string): string {
  let current = dir;
  for (;;) {
    try {
      fs.statSync(path.join(current, 'onset.conf'));
      return goFileBase(current);
    } catch {
      // 继续向上找。
    }
    const parent = goFileDir(current);
    if (parent === current) return '';
    current = parent;
  }
}

/** 一次渲染尝试从哪来。 */
export interface AttemptSource {
  /** SourceRender 或 SourceExam。 */
  source: string;
  /** 批次编号，见 Episode.run。 */
  run?: string;
  /** 考试编号，只对 SourceExam 有值。 */
  exam?: string;
  /** 这次召回的探索，见 RecallResult.explored。 */
  explored?: Exploration | null;
}

function featuresOrNull(sc: Scene): string[] | null {
  try {
    return sceneFeatures(sc);
  } catch {
    return null;
  }
}

/** 把一次渲染尝试写成经历，冻结镜头输入，并写进时间线。 */
export function recordAttempt(s: Store, sc: Scene, attempt: Attempt, from: AttemptSource): Episode {
  const episode = newEpisode({
    source: from.source,
    scene_id: sc.id,
    text: sc.text,
    renderer: attempt.renderer,
    model: attempt.model,
    fingerprint: attempt.fingerprint,
    outcome: attempt.outcome,
    retry: attempt.retry,
    seconds: attempt.seconds,
    usage: attempt.usage,
    error: attempt.error,
    problems: attempt.problems,
    checks: attempt.checks,
    features: featuresOrNull(sc),
    exam: from.exam ?? '',
    run: from.run ?? '',
  });
  if (sc.memory !== null) {
    episode.recalled = sc.memory.names && sc.memory.names.length > 0 ? [...sc.memory.names] : null;
    episode.snapshot = sc.memory.snapshot;
    episode.explored = from.explored ?? null;
  }
  s.observeModel(attempt.renderer, attempt.model);
  return saveEpisode(s, sc, episode);
}

/** 把一条人工反馈写成经历。 */
export function recordFeedback(s: Store, sc: Scene, feedback: Feedback): Episode {
  if (feedback.verdict !== 'up' && feedback.verdict !== 'down') {
    throw new Error(`反馈只能是 up 或 down，收到 ${goQuote(feedback.verdict)}`);
  }
  return saveEpisode(
    s,
    sc,
    newEpisode({
      source: SourceFeedback,
      scene_id: sc.id,
      text: sc.text,
      renderer: sc.renderer,
      outcome: OutcomeFeedback,
      features: featuresOrNull(sc),
      feedback: { ...feedback },
    }),
  );
}

export function saveEpisode(s: Store, sc: Scene, episode: Episode): Episode {
  const now = s.clock();
  episode = { ...episode };
  episode.schema = 1;
  episode.id = newEpisodeID(now);
  episode.created_at = rfc3339Nano(now);
  episode.scene_dir = sc.directory;
  episode.project = projectOf(sc.directory);
  if (episode.features === null) episode.features = [];
  const dir = path.join(s.dir, 'episodes', monthStamp(now), episode.id);
  fs.mkdirSync(dir, { recursive: true });
  // 对话信号不属于某个镜头，没有输入可冻结。
  if (sc.id !== '') {
    try {
      freezeInput(sc, path.join(dir, 'input'));
      episode.input = 'input';
    } catch {
      // 冻结失败时这段经历不能用来考试，但照样记下。
    }
  }
  writeJSON(path.join(dir, 'episode.json'), episodeToJSON(episode));
  episode.dir = dir;
  s.log({
    time: '',
    type: EventEpisode,
    summary: episodeSummary(episode),
    project: episode.project,
    detail: {
      episode: episode.id,
      scene: episode.scene_id,
      renderer: episode.renderer,
      model: episode.model,
      outcome: episode.outcome,
      checks: episode.checks,
      recalled: episode.recalled,
      source: episode.source,
      exam: episode.exam,
    },
  });
  return episode;
}

function episodeSummary(e: Episode): string {
  const prefix = e.source === SourceExam ? '考试 ' + e.exam + '：' : '';
  return prefix + episodeOutcome(e);
}

function episodeOutcome(e: Episode): string {
  if (e.source === SourceConversation) {
    if (e.feedback !== null && e.feedback.verdict === 'down') return '用户回退了一轮对话：' + e.text;
    return '用户说：' + e.text;
  }
  if (e.source === SourceFeedback) {
    const verdict = e.feedback!.verdict === 'down' ? '👎' : '👍';
    return `镜头 ${e.scene_id} 收到人工反馈 ${verdict} ${e.feedback!.note}`;
  }
  if (passed(e))
    return `镜头 ${e.scene_id}（${rendererModel(e.renderer, e.model)}）通过校验，召回 ${e.recalled?.length ?? 0} 条记忆`;
  if ((e.checks?.length ?? 0) > 0) {
    return `镜头 ${e.scene_id}（${rendererModel(e.renderer, e.model)}）校验失败：${(uniqueSorted(e.checks) ?? []).join('、')}`;
  }
  return `镜头 ${e.scene_id}（${e.renderer}）${e.outcome}`;
}

/**
 * 把镜头声明过的输入原样拷进 target，供考试重放。
 * 清单与输入指纹同源（scene.inputFiles），另加镜头扩展块要带的目录（例如角色包），
 * 以及镜头当时就近读到的 frame.md：画幅只从 frame.md 取，重放要按当时的画幅。
 */
export function freezeInput(sc: Scene, target: string): void {
  freezeResources(sc.directory, target);
  for (const rel of inputFiles(sc)) copyFile(path.join(sc.directory, rel), path.join(target, rel));
  const frame = frameSource(sc);
  if (frame) copyFile(path.join(frame.directory, frame.file), path.join(target, FrameFile));
  for (const rel of blockExtraInputDirs(sc)) {
    const root = path.join(sc.directory, rel);
    walkDir(root, (file, entry, _isDir, err) => {
      if (err) throw err;
      if (entry === null || !entry.isFile()) return;
      copyFile(file, path.join(target, path.relative(sc.directory, file)));
    });
  }
}

/** 读出全部经历，按时间升序。 */
export function episodes(s: Store): Episode[] {
  const out: Episode[] = [];
  const root = path.join(s.dir, 'episodes');
  walkDir(root, (file, entry, isDir, err) => {
    if (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'skip';
      throw err;
    }
    if (isDir && entry !== null && entry.name === 'input') return 'skip';
    if (isDir || entry === null || entry.name !== 'episode.json') return;
    let raw: unknown;
    try {
      raw = readJSON(file);
    } catch {
      return;
    }
    const episode = parseEpisode(raw);
    if (episode === null || episode.id === '') return;
    episode.dir = path.dirname(file);
    out.push(episode);
  });
  out.sort(
    (a, b) => compareBytes(episodeTimeKey(a.created_at), episodeTimeKey(b.created_at)) || compareBytes(a.id, b.id),
  );
  return out;
}

/** RFC3339Nano 的 UTC 时间补齐小数后才可按字节排序；保留旧 Go 记录的纳秒精度，不改磁盘内容。 */
function episodeTimeKey(time: string): string {
  return time.replace(
    /(?:\.(\d+))?Z$/,
    (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(9, '0')}Z`,
  );
}

/** 按编号找经历。 */
export function episodeByID(s: Store, id: string): Episode {
  const found = episodes(s).find((e) => e.id === id);
  if (!found) throw new Error(`经历 ${id} 不存在`);
  return found;
}
