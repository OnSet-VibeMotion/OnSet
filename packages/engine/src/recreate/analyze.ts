/**
 * 参考视频确定性拆解与同步对比引擎（recreate）：
 * - 全部 ffprobe / ffmpeg 调用经由 mediaprobe.Toolchain；
 * - 通过连续帧 RGB MAD 突变自动识别切点与镜头分段，产出结构化 MotionSpec（motion-spec.md）；
 * - 支持参考视频与复刻成片的同步时间点量化对比，定位最差帧并输出联系表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { formatFixed } from '../gofmt';
import { type FrameStats, isBlank, isDark, type Media, type Toolchain } from '../mediaprobe';

export interface DetectedShot {
  index: number;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  mid_seconds: number;
  mid_stats: FrameStats;
  blank: boolean;
  dark: boolean;
}

export interface ReferenceAnalysis {
  source: string;
  media: Media;
  sample_step_seconds: number;
  cut_threshold: number;
  cuts_seconds: number[];
  shots: DetectedShot[];
}

export interface ComparePoint {
  at_seconds: number;
  mad: number;
  ref_stats: FrameStats;
  cand_stats: FrameStats;
  luma_delta: number;
}

export interface RecreateComparison {
  reference: string;
  candidate: string;
  ref_duration: number;
  cand_duration: number;
  duration_delta: number;
  mean_mad: number;
  max_mad: number;
  points: ComparePoint[];
  worst: ComparePoint[];
  pass: boolean;
  sheet?: string;
}

export interface AnalyzeOptions {
  /** 切点探测步长（秒），默认 0.5s。 */
  stepSeconds?: number;
  /** 判定为硬切的 32x32 RGB MAD 阈值（0–255），默认 36。 */
  cutThreshold?: number;
  /** 最多分析时长上限（秒），防超长视频卡死，默认 180s。 */
  maxDurationSeconds?: number;
}

/**
 * 对参考视频做确定性结构拆解：识别切点、镜头区间与各镜中点画面统计。
 */
export function analyzeReferenceVideo(tc: Toolchain, videoPath: string, opts: AnalyzeOptions = {}): ReferenceAnalysis {
  const abs = path.resolve(videoPath);
  if (!fs.existsSync(abs)) throw new Error(`参考视频不存在：${abs}`);
  const media = tc.probe(abs);
  if (!media.video) throw new Error(`参考文件不包含视频流：${abs}`);

  const total = Math.min(media.video.duration_seconds || media.duration_seconds, opts.maxDurationSeconds ?? 180);
  if (total <= 0) throw new Error(`参考视频时长无效：${abs}`);
  const step = Math.max(0.1, opts.stepSeconds ?? 0.5);
  const threshold = opts.cutThreshold ?? 36;

  const cuts: number[] = [];
  let prevTime = 0;
  for (let t = step; t < total - 0.05; t += step) {
    const mad = tc.frameDifference(abs, prevTime, t);
    if (mad >= threshold) {
      cuts.push(Number(formatFixed(t, 3)));
    }
    prevTime = t;
  }

  const boundaries = [0, ...cuts, Number(formatFixed(total, 3))];
  const shots: DetectedShot[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const duration = Math.max(0.05, Number(formatFixed(end - start, 3)));
    const mid = Math.min(Math.max(0, start + duration / 2), Math.max(0, total - 0.04));
    const stats = tc.frameStats(abs, mid);
    shots.push({
      index: i + 1,
      start_seconds: start,
      end_seconds: end,
      duration_seconds: duration,
      mid_seconds: Number(formatFixed(mid, 3)),
      mid_stats: stats,
      blank: isBlank(stats),
      dark: isDark(stats),
    });
  }

  return {
    source: abs,
    media,
    sample_step_seconds: step,
    cut_threshold: threshold,
    cuts_seconds: cuts,
    shots,
  };
}

/**
 * 同步对比参考视频与复刻成片：按共同时间点采样计算 MAD 与亮度差，定位最差 4 帧。
 */
export function compareReferenceAndCandidate(
  tc: Toolchain,
  referencePath: string,
  candidatePath: string,
  opts: { points?: number[]; madPassThreshold?: number; sheetOut?: string } = {},
): RecreateComparison {
  const refAbs = path.resolve(referencePath);
  const candAbs = path.resolve(candidatePath);
  const refMedia = tc.probe(refAbs);
  const candMedia = tc.probe(candAbs);
  if (!refMedia.video || !candMedia.video) throw new Error('对比双方必须都包含有效视频流');

  const refDur = refMedia.video.duration_seconds || refMedia.duration_seconds;
  const candDur = candMedia.video.duration_seconds || candMedia.duration_seconds;
  const sharedDur = Math.min(refDur, candDur);
  const maxSafe = Math.max(0, sharedDur - 0.04);

  let times = opts.points?.filter((t) => Number.isFinite(t) && t >= 0 && t <= maxSafe) ?? [];
  if (times.length === 0) {
    const count = Math.min(12, Math.max(4, Math.ceil(sharedDur / 2)));
    times = [];
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (maxSafe * i) / (count - 1);
      times.push(Number(formatFixed(t, 3)));
    }
  }

  const points: ComparePoint[] = [];
  for (const t of times) {
    const mad = tc.frameDifferenceBetween(refAbs, t, candAbs, t);
    const refStats = tc.frameStats(refAbs, t);
    const candStats = tc.frameStats(candAbs, t);
    points.push({
      at_seconds: t,
      mad: Number(formatFixed(mad, 2)),
      ref_stats: refStats,
      cand_stats: candStats,
      luma_delta: Number(formatFixed(Math.abs(refStats.mean - candStats.mean), 2)),
    });
  }

  const meanMad = points.length > 0 ? points.reduce((s, p) => s + p.mad, 0) / points.length : 0;
  const maxMad = points.length > 0 ? Math.max(...points.map((p) => p.mad)) : 0;
  const worst = [...points].sort((a, b) => b.mad - a.mad).slice(0, 4);
  const threshold = opts.madPassThreshold ?? 42;
  const durationDelta = Number(formatFixed(Math.abs(refDur - candDur), 3));

  let sheet: string | undefined;
  if (opts.sheetOut && worst.length > 0) {
    tc.contactSheet(
      candAbs,
      worst.map((w) => w.at_seconds),
      Math.min(4, worst.length),
      360,
      opts.sheetOut,
    );
    sheet = opts.sheetOut;
  }

  return {
    reference: refAbs,
    candidate: candAbs,
    ref_duration: Number(formatFixed(refDur, 3)),
    cand_duration: Number(formatFixed(candDur, 3)),
    duration_delta: durationDelta,
    mean_mad: Number(formatFixed(meanMad, 2)),
    max_mad: Number(formatFixed(maxMad, 2)),
    points,
    worst,
    pass: meanMad <= threshold && durationDelta <= 0.25,
    sheet,
  };
}

/**
 * 按 Motion.md 分层结构生成可读、可执行的参考拆解规范（production/motion-spec.md）。
 * 严格区分「机器实测事实」与「待填写的替换决策」，供后续分镜与并发渲染消费。
 */
export function renderMotionSpecMarkdown(analysis: ReferenceAnalysis, title?: string): string {
  const v = analysis.media.video!;
  const fps = v.fps_den > 0 ? formatFixed(v.fps_num / v.fps_den, 2) : '未知';
  const lines = [
    `# ${title?.trim() || path.basename(analysis.source)} — 参考拆解契约（Motion Spec）`,
    '',
    '## 1. 参考来源与实测规格（观察事实）',
    `- 参考文件：\`${analysis.source}\``,
    `- 画幅与帧率：${v.width_px}×${v.height_px} @ ${fps} fps`,
    `- 实测时长：${formatFixed(analysis.media.duration_seconds, 2)} 秒（${analysis.media.audio ? '含音轨' : '无音轨'}）`,
    `- 探测切点数：${analysis.cuts_seconds.length} 处（切点：${analysis.cuts_seconds.length ? analysis.cuts_seconds.map((c) => `${c}s`).join(', ') : '单镜无硬切'}）`,
    '',
    '## 2. 保持项（复刻结构不变量）',
    '- 保持下表各镜头的时长比例、切点节奏与画面视觉密度。',
    '- 保持开场钩子、主信息揭示顺序与结尾停留阅读时间。',
    '- 原生 HTML/SVG/CSS/GSAP 承载全部排版、图表、卡片、字幕与图形转场，不将可编辑文字烤进像素。',
    '',
    '## 3. 可替换项（本次主题与品牌）',
    '- 品牌身份与视觉：挂载用户品牌包（`production/brand-kit.json`）或按项目要求替换配色与字体。',
    '- 文案与证据：替换为本项目真实文稿、产品界面、数据与配音；长文案拆句排布，不靠无限缩字。',
    '',
    '## 4. 镜头时间表（机器实测）',
    '| 镜头 | 起始 (s) | 结束 (s) | 时长 (s) | 中点亮度 | 备注 |',
    '|---|---|---|---|---|---|',
  ];
  for (const s of analysis.shots) {
    const note = s.blank ? '疑似纯色/转场空白' : s.dark ? '暗调构图' : '正常画面';
    lines.push(
      `| shot-${String(s.index).padStart(2, '0')} | ${formatFixed(s.start_seconds, 2)} | ${formatFixed(s.end_seconds, 2)} | ${formatFixed(s.duration_seconds, 2)} | ${formatFixed(s.mid_stats.mean, 1)} | ${note} |`,
    );
  }
  lines.push(
    '',
    '## 5. 复刻验收标准',
    '- 在每个镜头中点及切点前后做同步抽帧核对，确认视觉密度、对比度与阅读停留不弱于参考。',
    '- 技术对比（MAD / 时长差）通过不等于视觉验收完成，最终以人眼审片为准。',
    '',
  );
  return lines.join('\n');
}

/** 将拆解规范原子写入项目的 production/motion-spec.md。 */
export function writeMotionSpec(projectRoot: string, analysis: ReferenceAnalysis, title?: string): string {
  const dest = path.join(projectRoot, 'production', 'motion-spec.md');
  atomicWrite(dest, renderMotionSpecMarkdown(analysis, title), 0o644);
  return dest;
}
