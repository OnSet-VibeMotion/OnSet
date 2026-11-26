// Package review 对成片做整片复查：机器能判的音画时长、总帧数与镜头交界帧
// 直接给结论，其余交给联系表让人或编排工具逐页看。
//
// 镜头级的检查（scene.VerifyOutput、onset scene frames）只看单镜头产物；拼接、
// 混音之后才出现的问题它们一个都看不到：音轨比画面短半秒、某镜在拼接时掉了
// 一帧、交界处闪一帧黑。这些要等成片发布后才被观众发现。
import path from 'node:path';
import { formatFixed } from '../gofmt';
import { isBlank, type Media, readFrameQCForVideo } from '../mediaprobe';
import { writeSeams, writeSheets } from './sheets';
import {
  type Cut,
  frameTime,
  handoffBreakDifference,
  handoffLooseDifference,
  type Options,
  type Prober,
  type Report,
  ReportSchemaVersion,
  type Resolved,
  withDefaults,
} from './types';

export {
  type Cut,
  DefaultEvery,
  DefaultSyncTolerance,
  DefaultThumbWidth,
  DefaultTilesPerSheet,
  HandoffLooseDifference,
  handoffBroken,
  type LoudnessTarget,
  type Options,
  type Prober,
  type Report,
  ReportSchemaVersion,
  reportToJSON,
  SeamFrames,
  type Segment,
  type Sheet,
  type Tile,
  writeReportJSON,
} from './types';

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
  const qcPath = options.frameQCPath || (opts.outDir ? path.join(opts.outDir, 'frame-qc.json') : '');
  if (qcPath) {
    const qc = readFrameQCForVideo(qcPath, opts.video);
    if (qc.stale) {
      report.hints.push(
        `帧检报告 ${path.basename(qcPath)} 与当前视频 SHA-256 不一致，已忽略旧摘要，请重新运行 media_frame_qc 扫描`,
      );
    } else if (qc.summary) {
      report.frame_qc = qc.summary;
      if (qc.summary.verdict === 'warn' || qc.summary.verdict === 'fail') {
        report.hints.push(
          `全流帧检 verdict=${qc.summary.verdict}（fail ${qc.summary.fail_count} / warn ${qc.summary.warn_count} / info ${qc.summary.info_count}），详情见 ${path.basename(qcPath)}`,
        );
      }
    }
  }
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
    report.problems.push(
      `成片总帧数 ${counted} 与镜头帧数之和 ${expected} 不符（相差 ${counted - expected} 帧）：检查是否漏拼、重拼镜头或拼接掉帧`,
    );
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
    const cut: Cut = {
      from: opts.segments[i].id,
      to: next.id,
      frame: cursor,
      before,
      after,
      handoff,
      difference: null,
    };
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
