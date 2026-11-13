/**
 * scene_cues：由字幕或短语锚点推导口播镜头的帧区间，写入各镜头的 duration_seconds 与 timing 块。
 * 移植自 internal/cli/scene_cues.go（commitWrites 与 pendingWrite 移植自 internal/cli/beat.go）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { formatG, goPathError, goQuote, goRound } from '@am/engine/gofmt';
import { marshal } from '@am/engine/gojson';
import * as filmstyle from '@am/engine/filmstyle';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import * as srt from '@am/engine/srt';
import { type Out } from './cobra';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';

defineOp({
  name: 'scene_cues',
  cli: ['scene', 'cues'],
  summary: '由字幕或短语锚点推导镜头帧区间，写入时长与 timing 块',
  description:
    `按分镜计划里每个镜头的起始锚点，把全片切成首尾相接的整数帧区间，
写入 scenes 下每个镜头 scene.json 的 duration_seconds（帧数 ÷ 帧率，保留 6 位小数）
与 timing 块。镜头时长从此由这一步决定，不要手算、不要手改。

分镜计划（plan，JSON）：
  {
    "schema": 1,
    "look": {"background": "#0F1720", "ink": "#F5F1E8", "accent": "#F2B134"},
    "scenes": [
      {"id": "scene-001", "dir": "scenes/scene-001", "chapter": "问题"},
      {"id": "scene-002", "dir": "scenes/scene-002", "chapter": "问题", "first_subtitle": 5},
      {"id": "scene-003", "dir": "scenes/scene-003", "chapter": "机制", "first_phrase": "p-07", "cut": "mid_gap",
       "handoff": {"device": "push_in", "bridge": "画面被琥珀色圆形表面铺满，中心一个 24px 的深色圆点"}}
    ]
  }

  id              必须与镜头目录里 scene.json 的 id 一致
  dir             镜头目录，相对 project_root；顺序必须与 scenes 下镜头目录的
                  字典序一一对应，不得遗漏或多出
  first_subtitle  本镜头第一条字幕在 srt 里的序号（按出现顺序，从 1 开始）
  first_phrase    本镜头第一条短语的 phrase_id，需要 phrases
  cut             切点规则，缺省 next_start：
                    next_start  切在锚点开始处，前面的无文字空白并入前一个镜头
                    prev_end    切在锚点前一条字幕/短语结束处，空白并入本镜头
                    mid_gap     切在空白正中（向下取整）
                  前一条与锚点重叠、没有空白时，三种规则都切在锚点开始处。
  look            可选，全片配色：background、ink、accent 必填，surface、accent_2 可选，
                  一律 #RRGGBB。写了就进每个镜头的提示词与 am-scene.js，镜头不再自主选色
  chapter         可选，镜头所属章节；写了就每个镜头都要写，相邻镜头章节不同即章节交界
  handoff         从上一镜头进入本镜头的交接，章节交界必填、章节内可选：
                    device  手法：` +
      handoffDeviceList() +
      `
                    bridge  交界那一帧两侧共有的画面（物件、位置、大小、状态、底色），
                            不超过 200 字
                    style_shift  交界两侧风格不同时必填（风格相同时不能写），画法怎么换过去：
                            ` +
      styleShiftList() +
      `
                  相邻两个章节交界不得用同一种手法。交接写进两侧镜头的 timing.enter /
                  timing.exit，两个镜头的渲染提示词拿到同一份约定。
  film_style      可选，本镜头的整片风格：不写用项目的默认风格，「来源/目录名」用项目里装的
                  另一种（先 film_style_add()），none 不用整片风格。抄进镜头 scene.json 的
                  film_style；相邻镜头实际用的风格不同即风格交界，必须写 handoff.style_shift

first_subtitle 与 first_phrase 每个镜头恰好填一个；第一个镜头固定从第 0 帧开始，
可以不填。最后一个镜头延伸到 total_frames。锚点必须严格递增，每个镜头至少一帧，
合计正好等于 total_frames。秒换帧统一按「秒 × 帧率四舍五入」。

帧率缺省取镜头视觉规范的画幅（全部镜头必须一致）；给了 fps 时必须与画幅相同。
给了 phrases 时，把短语时间轴原样复制进每个镜头目录（` +
      scene.PhraseCopyFile +
      `），
并写进 timing.phrases，渲染时据此生成局部短语表。

timing 块：{"fps", "start_frame", "end_frame_exclusive", "plan", "phrases",
"chapter", "look", "enter", "exit"}，
帧号是全片全局帧，plan 是分镜计划文件的 SHA-256。scene.json 其余字段与顺序不变。
任何一处不合格都不写文件；内容没变的文件不重写。

check 只重算并核对，不写文件：时长、timing 块或短语副本与重算结果不符
（例如有人手改了 duration_seconds）时逐条列出并失败。
镜头带 song 或 beat 块时拒绝：歌曲、卡点的时长由 song_cues() / beat_cues() 决定。`,
  examples: [
    'scene_cues({"scenes": "scenes/", "plan": "production/scene-plan.json", "srt": "transcription-production.srt", "total_frames": 5400})',
    'scene_cues({"scenes": "scenes/", "plan": "production/scene-plan.json", "srt": "transcription-production.srt", "phrases": "production/phrase-timeline.json", "total_frames": 5400})',
    'scene_cues({"scenes": "scenes/", "check": true, "plan": "production/scene-plan.json", "srt": "transcription-production.srt", "total_frames": 5400})',
  ],
  params: {
    scenes: { type: 'string', description: '镜头目录的上级目录', required: true, positional: 0 },
    plan: { type: 'string', description: '分镜计划 JSON（必填）' },
    srt: { type: 'string', description: '全片字幕 SRT（必填）' },
    phrases: { type: 'string', description: '全片短语时间轴 phrase-timeline.json（可选）' },
    total_frames: { type: 'integer', description: '全片总帧数（必填）' },
    fps: { type: 'integer', description: '帧率，缺省取镜头画幅' },
    project_root: { type: 'string', description: '项目根目录，计划里的 dir 相对它解析', default: '.' },
    check: { type: 'boolean', description: '只核对，不写文件' },
  },
  run: (p, { out }) => {
    const data = runSceneCues(
      {
        plan: str(p.plan),
        srt: str(p.srt),
        phrases: str(p.phrases),
        projectRoot: str(p.project_root),
        scenesRoot: str(p.scenes),
        totalFrames: num(p.total_frames),
        fps: num(p.fps),
        check: bool(p.check),
      },
      out,
    );
    return { data };
  },
});

interface SceneCuesOptions {
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

function runSceneCues(opts: SceneCuesOptions, stdout: Out): unknown {
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
    if (s.song !== null || s.beat !== null) {
      throw new Error(`镜头 ${s.id} 带 song 或 beat 块：歌曲与卡点镜头的时长不由 scene_cues() 决定`);
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
      throw new Error(`镜头时间合同与重算结果不符，请重新运行 scene_cues()（不要手改时长）：\n  - ${problems.join('\n  - ')}`);
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
        r.film_style === '' ? { key: 'film_style', value: '', remove: true } : { key: 'film_style', value: marshal(r.film_style) },
      ]);
    } catch (err) {
      throw new Error(`${sceneFile}：${(err as Error).message}`);
    }
    writes.push({ path: sceneFile, body: Buffer.from(body) });
    if (phraseBody !== null) writes.push({ path: path.join(r.scene.directory, scene.PhraseCopyFile), body: phraseBody });
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
  if (problems.length > 0) throw new Error(`分镜计划与镜头目录不一致（目录按字典序）：\n  - ${problems.join('\n  - ')}`);
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
    else if (!scene.timingEqual(s.timing, r.timing)) problems.push(`${s.id}：timing 块是 ${describeTiming(s.timing)}，应为 ${describeTiming(r.timing)}`);
    if (s.film_style !== r.film_style) problems.push(`${s.id}：film_style 是 ${goQuote(s.film_style)}，分镜计划写的是 ${goQuote(r.film_style)}`);
    if (phraseBody !== null) {
      const copyPath = path.join(s.directory, scene.PhraseCopyFile);
      let have: Buffer | null = null;
      try {
        have = fs.readFileSync(copyPath);
      } catch {
        have = null;
      }
      if (have === null || !have.equals(phraseBody)) problems.push(`${s.id}：${scene.PhraseCopyFile} 与全片短语时间轴不一致`);
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

function styleShiftList(): string {
  return scene.StyleShifts.map((x) => `${x.id}（${x.name}，配 ${x.devices.join('/')}）`).join('、');
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
    if (filmstyle.styleDirOf(projectRoot, value) === '') problems.push(`镜头 ${entry.id} 点名的风格 ${value} 没装进项目：先运行 film_style_add({"style": "${value}"})`);
  }
  if (problems.length > 0) throw new Error(`分镜计划的风格不合格：\n  - ${problems.join('\n  - ')}`);
  scene.verifyStyleBoundaries(plan, (value) => (value === '' ? defaultKey : value === filmstyle.NoFilmStyle ? '' : value));
}

function handoffDeviceList(): string {
  return scene.HandoffDevices.map((d) => d.id).join('、');
}

/** Go fmt 的宽度按字符（rune）计。 */
function padRight(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - [...s].length));
}

function padLeft(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - [...s].length)) + s;
}

function printSceneCues(out: Out, results: readonly SceneCue[]): void {
  out.write(`${padRight('镜头', 20)} ${padLeft('起始帧', 10)} ${padLeft('结束帧', 10)} ${padLeft('帧数', 8)} ${padLeft('秒', 12)}\n`);
  for (const r of results) {
    const frames = scene.segmentFrames(r.segment);
    out.write(
      `${padRight(r.scene.id, 20)} ${padLeft(String(r.segment.startFrame), 10)} ${padLeft(String(r.segment.endFrameExclusive), 10)} ${padLeft(String(frames), 8)} ${padLeft(scene.durationLiteral(frames, r.timing.fps), 12)}\n`,
    );
  }
}

// ---------------------------------------------------------------- 落盘（移植自 beat.go）

export interface PendingWrite {
  path: string;
  body: Buffer;
}

/**
 * commitWrites 分两轮落盘：先把每份新内容写成同目录的临时文件，全部成功后
 * 再逐个改名替换。磁盘满、权限不足这类错误都发生在第一轮，此时一个目标文件
 * 都还没动；第二轮只剩同文件系统内的 rename。rename 本身仍可能中途失败，
 * 那时 am validate beat 会按网格摘要把没换上的镜头报出来。
 *
 * 内容不变的文件不重写：run-all 靠 scene.json 的修改时间判断产物是否过期，
 * 无变化的重跑不能把所有镜头都标成需要重渲染。
 */
export function commitWrites(writes: readonly PendingWrite[]): void {
  const ready: { temp: string; path: string }[] = [];
  const cleanup = () => {
    for (const s of ready) fs.rmSync(s.temp, { force: true });
  };
  for (const w of writes) {
    try {
      if (fs.readFileSync(w.path).equals(w.body)) continue;
    } catch {
      // 不存在就写。
    }
    // os.CreateTemp(dir, "."+base+".*")：随机后缀。
    const temp = path.join(path.dirname(w.path), `.${path.basename(w.path)}.${crypto.randomInt(0, 2 ** 32)}`);
    try {
      fs.writeFileSync(temp, w.body, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(temp, 0o644);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      cleanup();
      throw err;
    }
    ready.push({ temp, path: w.path });
  }
  for (let i = 0; i < ready.length; i++) {
    const s = ready[i];
    try {
      fs.renameSync(s.temp, s.path);
    } catch (err) {
      for (const rest of ready.slice(i)) fs.rmSync(rest.temp, { force: true });
      throw new Error(`写入 ${s.path} 失败，部分镜头可能仍是旧网格，请重跑 beat_cues()：${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------- 保序改写 JSON 对象

export interface JSONField {
  key: string;
  /** 原样的 JSON 文本（Go 的 json.RawMessage）。 */
  value: string;
  /** 为 true 时删掉这个字段（没有就什么也不做）。 */
  remove?: boolean;
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

function skipSpace(src: string, i: number): number {
  while (i < src.length && isSpace(src[i])) i++;
  return i;
}

/** 从 i 开始扫一个 JSON 字符串（含引号），返回结束后的位置。 */
function scanString(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === '\\') j++;
    j++;
  }
  if (j >= src.length) throw new Error('unexpected end of JSON input');
  return j + 1;
}

/** 从 i 开始扫一个 JSON 值，返回结束后的位置；值本身用 JSON.parse 校验。 */
function scanValue(src: string, i: number): number {
  const c = src[i];
  let j = i;
  if (c === '"') j = scanString(src, i);
  else if (c === '{' || c === '[') {
    let depth = 0;
    while (j < src.length) {
      const ch = src[j];
      if (ch === '"') {
        j = scanString(src, j);
        continue;
      }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    if (depth !== 0) throw new Error('unexpected end of JSON input');
  } else {
    while (j < src.length && !isSpace(src[j]) && src[j] !== ',' && src[j] !== '}' && src[j] !== ']') j++;
  }
  JSON.parse(src.slice(i, j));
  return j;
}

/** json.Indent(dst, src, prefix, indent)：只改空白，字符串与数字原样保留。 */
function indentJSON(src: string, prefix: string, indent: string): string {
  let out = '';
  let needIndent = false;
  let depth = 0;
  const newline = () => {
    out += '\n' + prefix + indent.repeat(depth);
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (isSpace(c)) continue;
    if (needIndent && c !== '}' && c !== ']') {
      needIndent = false;
      depth++;
      newline();
    }
    if (c === '"') {
      const end = scanString(src, i);
      out += src.slice(i, end);
      i = end - 1;
      continue;
    }
    switch (c) {
      case '{':
      case '[':
        needIndent = true;
        out += c;
        break;
      case ',':
        out += c;
        newline();
        break;
      case ':':
        out += ': ';
        break;
      case '}':
      case ']':
        if (needIndent) {
          needIndent = false;
          out += c;
        } else {
          depth--;
          newline();
          out += c;
        }
        break;
      default:
        out += c;
    }
  }
  return out;
}

/**
 * rewriteJSONObject 改写一个 JSON 对象里的若干字段：已有字段原地替换，
 * 新字段追加在末尾，其余字段的顺序与取值原样保留，整体按两格缩进重排。
 *
 * 不走 map[string]json.RawMessage：那样会把字段按字母序重排，每次运行都让
 * 手写的 scene.json 面目全非，diff 里看不出真正改了什么。
 */
export function rewriteJSONObject(raw: string, updates: readonly JSONField[]): string {
  let i = skipSpace(raw, 0);
  if (raw[i] !== '{') throw new Error('不是 JSON 对象');
  i++;
  const fields: JSONField[] = [];
  const seen = new Set<string>();
  for (;;) {
    i = skipSpace(raw, i);
    if (i >= raw.length) throw new Error('不是合法 JSON：unexpected EOF');
    if (raw[i] === '}') break;
    if (fields.length > 0) {
      if (raw[i] !== ',') throw new Error('不是合法 JSON 对象');
      i = skipSpace(raw, i + 1);
    }
    if (raw[i] !== '"') throw new Error('不是合法 JSON 对象');
    let key: string;
    let end: number;
    try {
      end = scanString(raw, i);
      key = JSON.parse(raw.slice(i, end)) as string;
    } catch (err) {
      throw new Error(`不是合法 JSON：${(err as Error).message}`);
    }
    i = skipSpace(raw, end);
    if (raw[i] !== ':') throw new Error('不是合法 JSON 对象');
    i = skipSpace(raw, i + 1);
    let valueEnd: number;
    try {
      valueEnd = scanValue(raw, i);
    } catch (err) {
      throw new Error(`字段 ${key} 不是合法 JSON：${(err as Error).message}`);
    }
    if (seen.has(key)) throw new Error(`字段 ${key} 重复`);
    seen.add(key);
    fields.push({ key, value: raw.slice(i, valueEnd) });
    i = valueEnd;
  }
  for (const u of updates) {
    if (u.remove) {
      const at = fields.findIndex((f) => f.key === u.key);
      if (at >= 0) fields.splice(at, 1);
      continue;
    }
    let replaced = false;
    for (const f of fields) {
      if (f.key === u.key) {
        f.value = u.value;
        replaced = true;
      }
    }
    if (!replaced) fields.push({ ...u });
  }
  let out = '{\n';
  fields.forEach((f, idx) => {
    out += '  ' + marshal(f.key) + ': ' + indentJSON(f.value, '  ', '  ');
    if (idx < fields.length - 1) out += ',';
    out += '\n';
  });
  return out + '}\n';
}
