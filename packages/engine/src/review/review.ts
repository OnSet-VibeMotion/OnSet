// Package review 对成片做整片复查：机器能判的音画时长、总帧数与镜头交界帧
// 直接给结论，其余交给联系表让人或编排工具逐页看。
//
// 镜头级的检查（scene.VerifyOutput、onset scene frames）只看单镜头产物；拼接、
// 混音之后才出现的问题它们一个都看不到：音轨比画面短半秒、某镜在拼接时掉了
// 一帧、交界处闪一帧黑。这些要等成片发布后才被观众发现。
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { formatFixed, goRound } from '../gofmt';
import { marshalIndent } from '../gojson';
import { isBlank, mediaToJSON, type FrameStats, type Media, type ProgramLoudness } from '../mediaprobe';

/** Prober 是复查用到的全部媒体操作；mediaprobe.Toolchain 满足它。 */
export interface Prober {
  probe(file: string): Media;
  countFrames(file: string): number;
  frameStats(file: string, atSeconds: number): FrameStats;
  frameDifference(file: string, a: number, b: number): number;
  contactSheet(file: string, atSeconds: number[], columns: number, thumbWidth: number, dest: string): void;
  measureProgramLoudness(file: string): ProgramLoudness;
}

/** LoudnessTarget 是成片混音的响度目标，来自 frame.md 的 audio 块。 */
export interface LoudnessTarget {
  integratedLUFS: number;
  tolerance: number;
  truePeakMax: number;
}

/**
 * SeamFrames 是交界条带在切点两侧各取的帧数：30fps 下前后各 0.2 秒，正好覆盖
 * 一次转场的收尾与起势。只看切点两侧各一帧，判断不了转场是否顺。
 */
export const SeamFrames = 6;

/**
 * Segment 是成片里按顺序首尾相接的一个镜头。handoff 是从上一镜头进入本镜头
 * 时约定的交接手法，空串（或省略）表示没有约定（硬切）；crossChapter 标记章节交界。
 */
export interface Segment {
  id: string;
  frames: number;
  handoff?: string;
  crossChapter?: boolean;
}

// 交界帧差异的判定阈值（meanAbsoluteDifference，0–255）。
//
// 只对声明了交接的交界判：两侧按约定都画同一帧，前一镜末帧与后一镜首帧应当
// 几乎相同。没有约定的交界是有意的硬切，差异再大也不说明什么。
// 阈值取得宽：交接物件挪了几像素、底纹淡了一点都不该拦，拦下的只该是「两张
// 不同的画面」——误判几次，这道门就没人信了。
/** handoffBreakDifference 及以上判为没接上，进 problems。 */
const handoffBreakDifference = 48.0;
/** handoffLooseDifference 及以上进 hints，让看图的一方确认。 */
const handoffLooseDifference = 20.0;
/** 约定了交接的交界，两帧差异到这个数就算没接顺：拼接时抹平（concat）、修接缝（scene_seams）都按它挑交界。 */
export const HandoffLooseDifference = handoffLooseDifference;

/** Options 控制一次复查。segments 为空时只做与镜头无关的检查，联系表按固定间隔取帧。 */
export interface Options {
  video: string;
  fps: number;
  /** 同一次操作已精确计数的媒体。只供宿主传入，工具参数不能声明校验结论。 */
  verifiedMedia?: Media;
  segments?: Segment[] | null;
  outDir?: string;
  /** silent 断言成片没有音轨（只拼接未混音的交付），不做音画比对。 */
  silent?: boolean;
  /** loudness 省略时只记录实测值，不做比对。 */
  loudness?: LoudnessTarget | null;
  /** syncTolerance 是音视频流时长允许的差值（秒）。 */
  syncTolerance?: number;
  /** every 是没有镜头信息时联系表的取帧间隔（秒）。 */
  every?: number;
  /** tilesPerSheet 是每张联系表的格子数，超出就分页。 */
  tilesPerSheet?: number;
  thumbWidth?: number;
}

/** Tile 是联系表里的一格。position 是 start / middle / end / sample（交界条带里是 before / after）。scene_id 为空时不写出。 */
export interface Tile {
  scene_id: string;
  position: string;
  frame: number;
  at_seconds: number;
}

/** Sheet 是一张联系表，tiles 按图中从左到右、从上到下的顺序排列。 */
export interface Sheet {
  image: string;
  columns: number;
  tiles: Tile[];
}

/** Cut 是两个镜头的交界：before 是前一镜的末帧，after 是后一镜的首帧。 */
export interface Cut {
  from: string;
  to: string;
  frame: number;
  before: FrameStats;
  after: FrameStats;
  /** handoff 与 difference 只在该交界声明了交接时出现（handoff 为空串、difference 为 null 时不写出）。 */
  handoff: string;
  difference: number | null;
}

/** Report 是复查的机器可读结果。ok 只由 problems 决定。零值字段按 Go 的 omitempty 不写出，见 reportToJSON。 */
export interface Report {
  schema_version: number;
  path: string;
  ok: boolean;
  media: Media;
  expected_frames: number;
  counted_frames: number;
  /** loudness 是解码成片后实测的响度；没有音轨时为 null。 */
  loudness: ProgramLoudness | null;
  problems: string[];
  hints: string[];
  cuts: Cut[];
  sheets: Sheet[];
  /** seams 是每个镜头交界的逐帧条带，切点在第 SeamFrames+1 格。 */
  seams: Sheet[];
}

/** ReportSchemaVersion 是 Report 的结构版本。 */
export const ReportSchemaVersion = 1;

function frameStatsJSON(f: FrameStats): unknown {
  return { at_seconds: f.at_seconds, mean: f.mean, stddev: f.stddev };
}

function sheetJSON(s: Sheet): unknown {
  return {
    image: s.image,
    columns: s.columns,
    tiles: s.tiles.map((t) => ({ scene_id: t.scene_id || undefined, position: t.position, frame: t.frame, at_seconds: t.at_seconds })),
  };
}

/** 按 Go 的字段顺序与 omitempty 构造 review.json 的 JSON 值。 */
export function reportToJSON(r: Report): unknown {
  return {
    schema_version: r.schema_version,
    path: r.path,
    ok: r.ok,
    media: mediaToJSON(r.media),
    expected_frames: r.expected_frames || undefined,
    counted_frames: r.counted_frames || undefined,
    loudness: r.loudness ? { integrated_lufs: r.loudness.integrated_lufs, true_peak_dbtp: r.loudness.true_peak_dbtp, range_lu: r.loudness.range_lu } : undefined,
    problems: r.problems,
    hints: r.hints.length > 0 ? r.hints : undefined,
    cuts:
      r.cuts.length > 0
        ? r.cuts.map((c) => ({
            from: c.from,
            to: c.to,
            frame: c.frame,
            before: frameStatsJSON(c.before),
            after: frameStatsJSON(c.after),
            handoff: c.handoff || undefined,
            difference: c.difference ?? undefined,
          }))
        : undefined,
    sheets: r.sheets.map(sheetJSON),
    seams: r.seams.length > 0 ? r.seams.map(sheetJSON) : undefined,
  };
}

/** WriteJSON 原子写出报告。 */
export function writeReportJSON(r: Report, target: string): void {
  atomicWrite(target, Buffer.from(marshalIndent(reportToJSON(r)) + '\n', 'utf8'), 0o644);
}

// 缺省值。DefaultTilesPerSheet 取 3 的倍数，按镜头排版时一行正好是一个镜头的首、中、末。
export const DefaultSyncTolerance = 0.1;
export const DefaultEvery = 5.0;
export const DefaultTilesPerSheet = 18;
export const DefaultThumbWidth = 360;
const segmentColumns = 3;
const sampleColumns = 4;

interface Resolved {
  video: string;
  fps: number;
  segments: Segment[];
  outDir: string;
  silent: boolean;
  loudness: LoudnessTarget | null;
  syncTolerance: number;
  every: number;
  tilesPerSheet: number;
  thumbWidth: number;
}

function withDefaults(o: Options): Resolved {
  const positive = (v: number | undefined, fallback: number): number => (v !== undefined && v > 0 ? v : fallback);
  return {
    video: o.video,
    fps: o.fps,
    segments: o.segments ?? [],
    outDir: o.outDir ?? '',
    silent: o.silent ?? false,
    loudness: o.loudness ?? null,
    syncTolerance: positive(o.syncTolerance, DefaultSyncTolerance),
    every: positive(o.every, DefaultEvery),
    tilesPerSheet: positive(o.tilesPerSheet, DefaultTilesPerSheet),
    thumbWidth: positive(o.thumbWidth, DefaultThumbWidth),
  };
}

/** Run 执行复查。抛错只表示「检查没跑成」，「跑了但不合格」是 report.ok === false。 */
export function run(p: Prober, options: Options): Report {
  const opts = withDefaults(options);
  if (opts.fps <= 0) throw new Error(`复查需要有效的帧率，收到 ${opts.fps}`);
  for (const segment of opts.segments) {
    if (segment.frames <= 0) throw new Error(`镜头 ${segment.id} 的帧数必须为正，收到 ${segment.frames}`);
  }
  const verified = options.verifiedMedia;
  const priorCount = verified?.path === opts.video ? verified.video?.nb_frames : undefined;
  const media = priorCount && priorCount > 0 ? verified! : p.probe(opts.video);
  const report: Report = {
    schema_version: ReportSchemaVersion,
    path: opts.video,
    ok: false,
    media,
    expected_frames: 0,
    counted_frames: 0,
    loudness: null,
    problems: [],
    hints: [],
    cuts: [],
    sheets: [],
    seams: [],
  };
  if (media.video === null) {
    report.problems.push('成片没有视频流');
    return report;
  }
  if (opts.silent) {
    if (media.audio !== null) report.problems.push('按静音成片复查，但文件里有音轨');
  } else {
    checkSync(report, media, opts.syncTolerance);
    if (media.audio !== null) checkLoudness(p, report, opts);
  }
  // 帧数总要实测：联系表的取帧上限只能信解码出的帧数。容器时长取的是最长
  // 的那条流，音轨比画面长时按它取帧会越过末帧，ffmpeg 返回成功却什么都不写。
  report.counted_frames = priorCount && priorCount > 0 ? priorCount : p.countFrames(opts.video);
  if (opts.segments.length > 0) {
    checkFrames(report, opts);
    checkCuts(p, report, opts);
  }
  writeSheets(p, report, opts);
  writeSeams(p, report, opts);
  report.ok = report.problems.length === 0;
  return report;
}

/** aacFrameSamples 是一个 AAC 帧的采样数。 */
const aacFrameSamples = 1024;

/** checkSync 比较音视频流各自的时长。容器时长取的是较长的那条流，看不出差异。 */
function checkSync(report: Report, media: Media, tolerance: number): void {
  if (media.audio === null) {
    report.problems.push('成片没有音轨');
    return;
  }
  const video = media.video!.duration_seconds;
  const audio = media.audio.duration_seconds;
  if (video <= 0 || audio <= 0) {
    report.hints.push('容器没有声明音视频流各自的时长，未做音画时长比对');
    return;
  }
  const diff = Math.abs(video - audio);
  if (diff > tolerance) {
    report.problems.push(
      `音画时长不一致：视频 ${formatFixed(video, 3)} 秒，音频 ${formatFixed(audio, 3)} 秒，相差 ${formatFixed(diff, 3)} 秒（容差 ${formatFixed(tolerance, 3)}）`,
    );
    return;
  }
  // 容差之内仍超过一个 AAC 帧，说明音轨不是按节目总帧数精确导出的。
  // AAC 编码的起始延迟只会造成几十个采样的偏差（HYPIT 实测 −16 与 −32），
  // 一个 AAC 帧是 1024 个采样，超过它就不是编码器能解释的。只进 hints：
  // 不同 ffmpeg 与编码器组合的偏差没有逐一实测，直接判失败会误伤。
  let rate = media.audio.sample_rate;
  if (rate <= 0) rate = 48000;
  const frame = aacFrameSamples / rate;
  if (diff > frame) {
    report.hints.push(
      `音画时长相差 ${formatFixed(diff * rate, 0)} 个采样（${formatFixed(diff, 3)} 秒），超过一个 AAC 帧（${aacFrameSamples} 个采样）：音轨可能没有按节目总帧数精确导出，检查混音输出的采样数`,
    );
  }
}

/**
 * checkLoudness 量成片的积分响度与真峰，与 frame.md 的目标比对。
 *
 * 结论只进 hints：平台各有自己的响度规范，frame.md 的数是缺省建议而不是交付
 * 硬门槛；而且响度偏了要回混音那一步改，重跑复查得到的仍是同一个数。
 * 真峰超标例外地值得点名「先查码率」：AAC 编解码会把采样之间的峰值抬上去，
 * 混音导出的 WAV 达标不代表成片达标。
 */
function checkLoudness(p: Prober, report: Report, opts: Resolved): void {
  const measured = p.measureProgramLoudness(opts.video);
  report.loudness = measured;
  const target = opts.loudness;
  if (target === null) return;
  const diff = measured.integrated_lufs - target.integratedLUFS;
  if (Math.abs(diff) > target.tolerance) {
    report.hints.push(
      `成片积分响度 ${formatFixed(measured.integrated_lufs, 1)} LUFS，偏离目标 ${formatFixed(target.integratedLUFS, 1)} LUFS 超过 ±${formatFixed(target.tolerance, 1)}：回混音阶段调整，不要在成片上再叠一次规范化`,
    );
  }
  if (measured.true_peak_dbtp > target.truePeakMax) {
    report.hints.push(
      `成片真峰 ${formatFixed(measured.true_peak_dbtp, 1)} dBTP，高于上限 ${formatFixed(target.truePeakMax, 1)} dBTP：先确认 AAC 码率不低于 384k（低码率会把采样间峰值抬高），再在混音里压限`,
    );
  }
}

/**
 * checkFrames 把精确解码出的总帧数与各镜头帧数之和比对。
 * 不一致说明拼接时有镜头漏拼、重拼或掉帧，而容器声明的 nb_frames 不可信。
 */
function checkFrames(report: Report, opts: Resolved): void {
  let expected = 0;
  for (const segment of opts.segments) expected += segment.frames;
  const counted = report.counted_frames;
  report.expected_frames = expected;
  if (counted !== expected) {
    report.problems.push(`成片总帧数 ${counted} 与镜头帧数之和 ${expected} 不符（相差 ${counted - expected} 帧）：检查是否漏拼、重拼镜头或拼接掉帧`);
  }
}

/**
 * checkCuts 取每个交界两侧各一帧做纯色判定。
 *
 * 结论只进 hints：切黑、切白是合法的转场手法，机器分不清有意还是事故。
 * 联系表会把这两帧放在相邻格子里，交给看图的一方判断。
 */
function checkCuts(p: Prober, report: Report, opts: Resolved): void {
  let cursor = 0;
  for (let i = 0; i + 1 < opts.segments.length; i++) {
    cursor += opts.segments[i].frames;
    // 成片比镜头合计短时（帧数检查已报问题），越过末尾的交界没有帧可取。
    if (cursor >= report.counted_frames) {
      report.hints.push(`成片只有 ${report.counted_frames} 帧，第 ${cursor} 帧起的镜头交界与联系表格子已跳过`);
      break;
    }
    const before = p.frameStats(opts.video, frameTime(cursor - 1, opts.fps));
    const after = p.frameStats(opts.video, frameTime(cursor, opts.fps));
    const next = opts.segments[i + 1];
    const handoff = next.handoff ?? '';
    const cut: Cut = { from: opts.segments[i].id, to: next.id, frame: cursor, before, after, handoff, difference: null };
    if (handoff !== '') {
      cut.difference = p.frameDifference(opts.video, frameTime(cursor - 1, opts.fps), frameTime(cursor, opts.fps));
      checkHandoff(report, cut, next.crossChapter ?? false);
    }
    report.cuts.push(cut);
    if (isBlank(before) || isBlank(after)) {
      report.hints.push(`${cut.from} → ${cut.to} 交界（第 ${cut.frame} 帧）有纯色帧，确认是有意的转场而不是拼接事故`);
    }
  }
}

/** HandoffBroken 报告这个交界是否约定了交接却没接上（与 problems 里的判定一致）。 */
export function handoffBroken(cut: Pick<Cut, 'handoff' | 'difference'>): boolean {
  return (cut.handoff ?? '') !== '' && cut.difference !== null && cut.difference !== undefined && cut.difference >= handoffBreakDifference;
}

/** checkHandoff 按交界帧差异判定声明过交接的交界是否真的接上了。 */
function checkHandoff(report: Report, cut: Cut, crossChapter: boolean): void {
  const scope = crossChapter ? '章节交界' : '交界';
  const difference = cut.difference!;
  if (difference >= handoffBreakDifference) {
    report.problems.push(
      `${cut.from} → ${cut.to} ${scope}（第 ${cut.frame} 帧）约定了 ${cut.handoff} 交接，但前一镜末帧与后一镜首帧差异 ${formatFixed(difference, 1)}，是两张不同的画面：对照两侧 timing.exit / timing.enter 的交界帧重渲染没接上的一侧`,
    );
  } else if (difference >= handoffLooseDifference) {
    report.hints.push(
      `${cut.from} → ${cut.to} ${scope}（第 ${cut.frame} 帧）约定了 ${cut.handoff} 交接，交界两帧差异 ${formatFixed(difference, 1)}，看对应的 seam 条带确认物件、位置和底色接上了`,
    );
  }
}

function frameTime(frame: number, fps: number): number {
  return frame / fps;
}

/** planTiles 按镜头取首、中、末帧；没有镜头信息时按固定间隔取帧并补上末帧。 */
function planTiles(opts: Resolved, counted: number): [Tile[], number] {
  const tiles: Tile[] = [];
  if (opts.segments.length > 0) {
    let cursor = 0;
    for (const segment of opts.segments) {
      const spots: [string, number][] = [
        ['start', cursor],
        ['middle', cursor + Math.trunc(segment.frames / 2)],
        ['end', cursor + segment.frames - 1],
      ];
      for (const [position, frame] of spots) tiles.push({ scene_id: segment.id, position, frame, at_seconds: frameTime(frame, opts.fps) });
      cursor += segment.frames;
    }
    return [tiles, segmentColumns];
  }
  const lastFrame = counted - 1;
  const step = Math.max(1, Math.trunc(goRound(opts.every * opts.fps)));
  for (let frame = 0; frame < lastFrame; frame += step) tiles.push({ scene_id: '', position: 'sample', frame, at_seconds: frameTime(frame, opts.fps) });
  if (lastFrame >= 0) tiles.push({ scene_id: '', position: 'end', frame: lastFrame, at_seconds: frameTime(lastFrame, opts.fps) });
  return [tiles, sampleColumns];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** writeSheets 分页生成联系表。 */
function writeSheets(p: Prober, report: Report, opts: Resolved): void {
  const [planned, columns] = planTiles(opts, report.counted_frames);
  const tiles = planned.filter((tile) => tile.frame < report.counted_frames);
  const perSheet = Math.max(columns, Math.trunc(opts.tilesPerSheet / columns) * columns);
  for (let start = 0, page = 1; start < tiles.length; start += perSheet, page++) {
    const chunk = tiles.slice(start, Math.min(start + perSheet, tiles.length));
    const image = path.join(opts.outDir, `sheet-${pad2(page)}.png`);
    p.contactSheet(
      opts.video,
      chunk.map((tile) => tile.at_seconds),
      columns,
      opts.thumbWidth,
      image,
    );
    report.sheets.push({ image, columns, tiles: chunk });
  }
}

/** writeSeams 为每个落在成片范围内的交界出一张逐帧条带。 */
function writeSeams(p: Prober, report: Report, opts: Resolved): void {
  report.cuts.forEach((cut, i) => {
    const tiles: Tile[] = [];
    for (let frame = Math.max(0, cut.frame - SeamFrames); frame < Math.min(report.counted_frames, cut.frame + SeamFrames); frame++) {
      const after = frame >= cut.frame;
      tiles.push({ scene_id: after ? cut.to : cut.from, position: after ? 'after' : 'before', frame, at_seconds: frameTime(frame, opts.fps) });
    }
    const image = path.join(opts.outDir, `seam-${pad2(i + 1)}.png`);
    p.contactSheet(
      opts.video,
      tiles.map((tile) => tile.at_seconds),
      SeamFrames,
      opts.thumbWidth,
      image,
    );
    report.seams.push({ image, columns: SeamFrames, tiles });
  });
}
