/**
 * scene_cues 执行与核对逻辑：解析分镜计划、计算全局帧区间、核对或写入各镜头 scene.json。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '@onset/engine/filmstyle';
import { formatG, goPathError, goQuote, goRound } from '@onset/engine/gofmt';
import { marshal } from '@onset/engine/gojson';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import * as srt from '@onset/engine/srt';
import type { Out } from './cobra';
import { commitWrites, type PendingWrite, rewriteJSONObject } from './scene_cues_json';

export interface SceneCuesOptions {
  plan: string;
  srt: string;
  phrases: string;
  projectRoot: string;
  scenesRoot: string;
  totalFrames: number;
  fps: number;
  check: boolean;
}

/** 一个镜头重算出的结果。 */
interface SceneCue {
  scene: scene.Scene;
  segment: scene.TimingSegment;
  timing: scene.Timing;
  /** 分镜计划里本镜头的 film_style，写进 scene.json。 */
  film_style: string;
}

function readFileOr(file: string, prefix: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw new Error(prefix + goPathError('open', file, err));
  }
}

export function runSceneCues(opts: SceneCuesOptions, stdout: Out): unknown {
  if (opts.plan === '' || opts.srt === '') throw new Error('plan 与 srt 必填');
  if (opts.totalFrames <= 0) throw new Error('total_frames 必须是正整数');
  if (opts.fps < 0) throw new Error('fps 必须是正整数');
  const planBody = readFileOr(opts.plan, '无法读取分镜计划：');
  const plan = scene.parseTimingPlan(planBody);
  const planSHA = crypto.createHash('sha256').update(planBody).digest('hex');

  const scenes = matchPlanScenes(opts, plan);
  const fps = scenesFPS(scenes, opts.fps);
  const cues = srt.readCues(opts.srt);
  let phraseBody: Buffer | null = null;
  let phrases: scene.PhraseTimeline | null = null;
  if (opts.phrases !== '') {
    phraseBody = readFileOr(opts.phrases, '无法读取短语时间轴：');
    try {
      phrases = scene.parsePhraseTimeline(phraseBody, fps);
    } catch (err) {
      throw new Error(`${opts.phrases}：${(err as Error).message}`);
    }
  }
  verifyPlanFilmStyles(opts.projectRoot, plan);
  const segments = scene.layoutTiming(plan, cues, phrases, fps, opts.totalFrames);
  const { enter, exit } = scene.planHandoffs(plan);
  const look = plan.look ?? scene.zeroLook();
  const planScenes = plan.scenes ?? [];
  const results: SceneCue[] = scenes.map((s, i) => {
    const own = scene.sceneTimelineBlocks(s);
    if (own.length > 0) {
      throw new Error(
        `镜头 ${s.id} 带 ${own.map((b) => b.key).join('、')} 块：${own.map((b) => b.timeline!.label).join('、')}镜头的时长不由 scene_cues() 决定`,
      );
    }
    const timing = scene.newTiming({
      fps,
      start_frame: segments[i].startFrame,
      end_frame_exclusive: segments[i].endFrameExclusive,
      plan: planSHA,
      chapter: planScenes[i].chapter,
      look: { ...look },
      enter: enter[i],
      exit: exit[i],
    });
    if (phrases !== null) timing.phrases = scene.PhraseCopyFile;
    return { scene: s, segment: segments[i], timing, film_style: planScenes[i].film_style };
  });
  if (opts.check) {
    const problems = checkSceneCues(results, phraseBody);
    if (problems.length > 0) {
      throw new Error(
        `镜头时间合同与重算结果不符，请重新运行 scene_cues()（不要手改时长）：\n  - ${problems.join('\n  - ')}`,
      );
    }
    printSceneCues(stdout, results);
    stdout.write(`核对通过：${results.length} 个镜头，合计 ${opts.totalFrames} 帧\n`);
    return cuesData(results, opts.totalFrames, true);
  }
  const writes: PendingWrite[] = [];
  for (const r of results) {
    const sceneFile = path.join(r.scene.directory, 'scene.json');
    const raw = fs.readFileSync(sceneFile, 'utf8');
    const timingJSON = marshal(scene.timingToJSON(r.timing));
    let body: string;
    try {
      body = rewriteJSONObject(raw, [
        { key: 'duration_seconds', value: scene.durationLiteral(scene.segmentFrames(r.segment), fps) },
        { key: 'timing', value: timingJSON },
        r.film_style === ''
          ? { key: 'film_style', value: '', remove: true }
          : { key: 'film_style', value: marshal(r.film_style) },
      ]);
    } catch (err) {
      throw new Error(`${sceneFile}：${(err as Error).message}`);
    }
    if (r.scene.timing && r.scene.timing.plan !== planSHA) {
      const migrated = scene.migrateRecordBeforePlanRewrite(r.scene);
      if (migrated) writes.push({ path: path.join(r.scene.directory, scene.RecordFile), body: Buffer.from(migrated) });
    }
    writes.push({ path: sceneFile, body: Buffer.from(body) });
    if (phraseBody !== null)
      writes.push({ path: path.join(r.scene.directory, scene.PhraseCopyFile), body: phraseBody });
  }
  commitWrites(writes);
  printSceneCues(stdout, results);
  stdout.write(`已写入 ${results.length} 个镜头的时长与 timing 块，合计 ${opts.totalFrames} 帧\n`);
  return cuesData(results, opts.totalFrames, false);
}

/** 结构化结果：每个镜头的全局帧区间。 */
function cuesData(results: readonly SceneCue[], totalFrames: number, checked: boolean): unknown {
  return {
    checked,
    total_frames: totalFrames,
    scenes: results.map((r) => ({
      id: r.scene.id,
      start_frame: r.segment.startFrame,
      end_frame_exclusive: r.segment.endFrameExclusive,
      frames: scene.segmentFrames(r.segment),
      duration_seconds: scene.durationLiteral(scene.segmentFrames(r.segment), r.timing.fps),
    })),
  };
}

/**
 * matchPlanScenes 把计划里的镜头与 SCENES 下的镜头目录逐一对应。
 *
 * 要求一一对应而不只是「计划里的目录都存在」：漏掉的镜头不会被写时长，
 * 合计等于总帧数也就不再意味着全片被覆盖。
 */
function matchPlanScenes(opts: SceneCuesOptions, plan: scene.TimingPlan): scene.Scene[] {
  const scenes = schedule.plan(opts.scenesRoot);
  const entries = plan.scenes ?? [];
  if (scenes.length !== entries.length) {
    throw new Error(`分镜计划有 ${entries.length} 个镜头，${opts.scenesRoot} 下有 ${scenes.length} 个镜头目录`);
  }
  const problems: string[] = [];
  entries.forEach((entry, i) => {
    let dir = entry.dir;
    if (!path.isAbsolute(dir)) dir = path.join(opts.projectRoot, dir);
    const want = canonicalDir(dir);
    if (want === null) {
      problems.push(`第 ${i + 1} 个镜头 ${entry.id} 的目录 ${entry.dir} 不存在`);
      return;
    }
    const have = canonicalDir(scenes[i].directory);
    if (have === null) throw new Error(`${scenes[i].directory} 不是目录`);
    if (want !== have) {
      problems.push(`第 ${i + 1} 个：计划 ${entry.dir}，目录字典序 ${scenes[i].directory}`);
      return;
    }
    if (scenes[i].id !== entry.id) {
      problems.push(`第 ${i + 1} 个：计划 id ${entry.id}，${entry.dir}/scene.json 的 id ${scenes[i].id}`);
    }
  });
  if (problems.length > 0)
    throw new Error(`分镜计划与镜头目录不一致（目录按字典序）：\n  - ${problems.join('\n  - ')}`);
  return scenes;
}

/** 解析符号链接后的绝对目录；不存在或不是目录时为 null。 */
function canonicalDir(dir: string): string | null {
  try {
    const resolved = fs.realpathSync(path.resolve(dir));
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/** 取全部镜头的画幅帧率，必须一致；flag 非 0 时还必须与之相同。 */
function scenesFPS(scenes: readonly scene.Scene[], flag: number): number {
  let fps = flag;
  for (const s of scenes) {
    let canvas: scene.Canvas;
    try {
      canvas = scene.sceneCanvas(s);
    } catch (err) {
      throw new Error(`镜头 ${s.id}：${(err as Error).message}`);
    }
    if (fps === 0) fps = canvas.fps;
    if (canvas.fps !== fps) {
      if (flag !== 0) throw new Error(`fps ${flag} 与镜头 ${s.id} 的画幅 ${canvas.fps}fps 不符`);
      throw new Error(`镜头帧率不一致：镜头 ${s.id} 是 ${canvas.fps}fps，前面的镜头是 ${fps}fps`);
    }
  }
  return fps;
}

/** 逐个镜头比对重算结果，返回全部不符项。 */
function checkSceneCues(results: readonly SceneCue[], phraseBody: Buffer | null): string[] {
  const problems: string[] = [];
  for (const r of results) {
    const s = r.scene;
    const frames = scene.segmentFrames(r.segment);
    const got = goRound(s.duration_seconds * r.timing.fps);
    if (got !== frames) {
      problems.push(
        `${s.id}：duration_seconds ${formatG(s.duration_seconds)} 秒是 ${got} 帧，应为 ${frames} 帧（${scene.durationLiteral(frames, r.timing.fps)} 秒）`,
      );
    } else {
      try {
        scene.verifyFrameAlignment(s);
      } catch (err) {
        problems.push(`${s.id}：${(err as Error).message}`);
      }
    }
    if (s.timing === null) problems.push(`${s.id}：缺少 timing 块`);
    else if (!scene.timingEqual(s.timing, r.timing))
      problems.push(`${s.id}：timing 块是 ${describeTiming(s.timing)}，应为 ${describeTiming(r.timing)}`);
    if (s.film_style !== r.film_style)
      problems.push(`${s.id}：film_style 是 ${goQuote(s.film_style)}，分镜计划写的是 ${goQuote(r.film_style)}`);
    if (phraseBody !== null) {
      const copyPath = path.join(s.directory, scene.PhraseCopyFile);
      let have: Buffer | null = null;
      try {
        have = fs.readFileSync(copyPath);
      } catch {
        have = null;
      }
      if (have === null || !have.equals(phraseBody))
        problems.push(`${s.id}：${scene.PhraseCopyFile} 与全片短语时间轴不一致`);
    }
  }
  return problems;
}

function describeTiming(t: scene.Timing): string {
  let plan = t.plan;
  if (Buffer.byteLength(plan) > 12) plan = Buffer.from(plan).subarray(0, 12).toString();
  let text = `${t.fps}fps [${t.start_frame}, ${t.end_frame_exclusive}) plan=${plan} phrases=${goQuote(t.phrases)}`;
  if (t.chapter !== '' || !scene.lookIsZero(t.look) || !scene.handoffIsZero(t.enter) || !scene.handoffIsZero(t.exit)) {
    text += ` chapter=${goQuote(t.chapter)} look=${!scene.lookIsZero(t.look)} enter=${describeHandoff(t.enter)} exit=${describeHandoff(t.exit)}`;
  }
  return text;
}

function describeHandoff(h: scene.Handoff): string {
  if (scene.handoffIsZero(h)) return '-';
  return h.peer + '/' + h.device + (h.style_shift !== '' ? '/' + h.style_shift : '');
}

/**
 * 分镜计划里的风格：点名的风格要已经装进项目，相邻镜头实际用的风格不同就要写 style_shift。
 * 实际用的风格要按项目当前的默认风格算，所以放在这里而不是 parseTimingPlan。
 */
function verifyPlanFilmStyles(projectRoot: string, plan: scene.TimingPlan): void {
  const { manifest, ok } = filmstyle.installed(projectRoot);
  const defaultKey = ok ? filmstyle.manifestKey(manifest) : '';
  const problems: string[] = [];
  for (const entry of plan.scenes ?? []) {
    const value = entry.film_style;
    if (value === '' || value === filmstyle.NoFilmStyle) continue;
    if (filmstyle.styleDirOf(projectRoot, value) === '')
      problems.push(`镜头 ${entry.id} 点名的风格 ${value} 没装进项目：先运行 film_style_add({"style": "${value}"})`);
  }
  if (problems.length > 0) throw new Error(`分镜计划的风格不合格：\n  - ${problems.join('\n  - ')}`);
  scene.verifyStyleBoundaries(plan, (value) =>
    value === '' ? defaultKey : value === filmstyle.NoFilmStyle ? '' : value,
  );
}

/** Go fmt 的宽度按字符（rune）计。 */
function padRight(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - [...s].length));
}

function padLeft(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - [...s].length)) + s;
}

function printSceneCues(out: Out, results: readonly SceneCue[]): void {
  out.write(
    `${padRight('镜头', 20)} ${padLeft('起始帧', 10)} ${padLeft('结束帧', 10)} ${padLeft('帧数', 8)} ${padLeft('秒', 12)}\n`,
  );
  for (const r of results) {
    const frames = scene.segmentFrames(r.segment);
    out.write(
      `${padRight(r.scene.id, 20)} ${padLeft(String(r.segment.startFrame), 10)} ${padLeft(String(r.segment.endFrameExclusive), 10)} ${padLeft(String(frames), 8)} ${padLeft(scene.durationLiteral(frames, r.timing.fps), 12)}\n`,
    );
  }
}
