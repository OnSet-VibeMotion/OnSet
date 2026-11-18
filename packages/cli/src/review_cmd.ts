/**
 * 本文件收拢整片复查（review）与合成源码扫描（scene_lint）两条操作。移植自 internal/cli/review.go。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as determinism from '@onset/engine/determinism';
import { formatFixed } from '@onset/engine/gofmt';
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as review from '@onset/engine/review';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { sha256File } from '@onset/engine/toolinstall';
import { resolveExisting, safeRelative } from '@onset/engine/validate';
import { currentEnvironment } from './cli';
import { inProject, requireReviewTarget } from './deliverables';
import { type Finding, recordCheckFindings } from './memory_cmd';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';

defineOp({
  name: 'review',
  cli: ['review'],
  summary: '整片复查：音画、帧数、镜头交界与联系表',
  description: `对混音后的成片做整片复查，产出一份机器可读报告和若干张联系表。

镜头级检查（渲染后的产物校验、scene_frames()）只看单个镜头；拼接与混音之后
才出现的问题它们看不到。这一步补的正是这一段：

  音画时长   音轨与视频流各自的时长相差超过 sync_tolerance 即判不合格；
             silent 时改为断言没有音轨（只拼接、未混音的交付）
  总帧数     给了 scenes 时，精确解码统计成片帧数，与各镜头帧数之和比对；
             不一致说明漏拼、重拼或拼接掉帧
  镜头交界   给了 scenes 时，取每个交界两侧各一帧做纯色判定。切黑、切白是
             合法转场，机器分不清有意还是事故，所以只进 hints，不算不通过
  响度       有音轨时解码成片，量积分响度、真峰与响度范围写进报告的 loudness；
             项目里有 frame.md 时与它 audio 块的目标比对。偏离只进 hints，
             不算不通过：平台响度规范各不相同，frame.md 的数是缺省建议
  交界条带   给了 scenes 时，每个交界出一张 seam-NN.png：上一行是切点前 6 帧，
             下一行是切点后 6 帧，用来看转场是否顺、有没有一帧闪烁或跳变

联系表按镜头排版：每行一个镜头，依次是首帧、中间帧、末帧；没给 scenes 时
按 every 秒的间隔取帧，每行 4 格。每张最多 per_sheet 格，超出分页。
格子与镜头、帧号的对应关系写在报告的 sheets 里——图上不叠文字，因为 drawtext
依赖 ffmpeg 编译时带 freetype，各发行版不一致。

联系表不做判断。画面对不对要打开图逐页看：文字是否溢出或压在图形上、相邻
镜头的风格与密度是否一致、交界是否跳变突兀、结尾是否停在合适的画面。

机器检查有不符项或跑不起来时失败。逐帧数据在 report_json（缺省为 <out>/review.json），
工具回复给出结论、联系表与报告路径。

在项目里 video 只能是候选成片 production/audio/candidate.mp4 或 final.mp4（silent 时是
production/silent-master.mp4）：客户端的成片页与制作路线只认这些位置。`,
  examples: [
    '# 成片复查，镜头信息取自 scenes/',
    'review({"video": "production/audio/candidate.mp4", "scenes": "scenes/", "out": "production/review"})',
    '# 脱离项目使用：只查音画时长，按 3 秒间隔出联系表',
    'review({"video": "final.mp4", "fps": 30, "every": 3, "out": "/tmp/review"})',
  ],
  params: {
    video: { type: 'string', description: '要复查的成片', required: true, positional: 0 },
    project_root: { type: 'string', description: '项目根目录，缺省为当前目录；用于从 frame.md 反查帧率' },
    scenes: { type: 'string', description: '镜头根目录；给了才做总帧数与交界检查，联系表按镜头排版' },
    out: { type: 'string', description: '联系表与报告的输出目录，必填' },
    report_json: { type: 'string', description: '报告路径，缺省为 <out>/review.json' },
    validate_report: { type: 'string', description: '另做交付规格、完整解码和首帧校验，保存报告并共用精确帧数' },
    expect_frames: { type: 'integer', description: '交付校验用的冻结总帧数' },
    fps: { type: 'integer', description: '普通复查的帧率覆盖值；交付校验使用 frame.md 的 canvas.fps' },
    silent: { type: 'boolean', description: '断言成片没有音轨，用于只拼接未混音的交付；不做音画比对' },
    sync_tolerance: { type: 'number', description: '音视频流时长允许的差值（秒）', default: review.DefaultSyncTolerance },
    every: { type: 'number', description: '没给 scenes 时联系表的取帧间隔（秒）', default: review.DefaultEvery },
    per_sheet: { type: 'integer', description: '每张联系表的最大格数，超出分页', default: review.DefaultTilesPerSheet },
    thumb_width: { type: 'integer', description: '联系表缩略图宽度（像素）', default: review.DefaultThumbWidth },
  },
  run: async (p, { out, signal }) => {
    const video = str(p.video);
    const rootDir = str(p.project_root) !== '' ? str(p.project_root) : '.';
    const outDir = str(p.out);
    const silent = bool(p.silent);
    if (outDir === '') throw new Error('必须用 out 指定复查产物目录');
    requireReviewTarget(rootDir, video, silent);
    const validationPath = str(p.validate_report);
    const deliveryCanvas = validationPath !== '' ? scene.canvasOf(rootDir, 'frame.md') : undefined;
    let rate = deliveryCanvas?.fps ?? num(p.fps);
    if (rate <= 0) {
      let canvas: scene.Canvas;
      try {
        canvas = scene.canvasOf(rootDir, 'frame.md');
      } catch (err) {
        throw new Error(`无法从 ${rootDir} 的 frame.md 确定帧率：${(err as Error).message}；脱离项目使用时请显式传 fps`);
      }
      rate = canvas.fps;
    }
    const project = inProject(rootDir);
    const sceneDir = str(p.scenes);
    const planned = sceneDir ? schedule.plan(sceneDir, project ? rootDir : undefined) : [];
    const segments = review.reviewSegments(planned, rate);
    const loudness = reviewLoudnessTarget(rootDir, silent);
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    const target = str(p.report_json) || path.join(outDir, 'review.json');
    const reportPath = project ? path.relative(rootDir, path.resolve(video)).split(path.sep).join('/') : video;
    let report: review.Report;
    let videoChanged = false;
    let work = '';
    try {
      let source = video;
      let verifiedMedia: mediaprobe.Media | undefined;
      let spec: review.DeliverySpec | undefined;
      let digest: string | undefined;
      if (deliveryCanvas) {
        safeRelative(rootDir, validationPath);
        const validationFile = resolveExisting(path.resolve(rootDir, validationPath));
        const reviewFile = resolveExisting(path.resolve(target));
        const original = fs.realpathSync(video);
        const targets = [validationFile, reviewFile, original];
        // 两份报告使用可移植的文件名，在 Windows 与 macOS 上也要区分。
        if (new Set(targets.map((file) => file.normalize('NFC').toLowerCase())).size !== targets.length) {
          throw new Error('规格报告、复查报告和成片需要不同路径');
        }
        const frames = num(p.expect_frames) || segments.reduce((sum, segment) => sum + segment.frames, 0);
        if (frames <= 0) throw new Error('交付校验需要冻结总帧数或镜头目录');
        spec = review.deliverySpec(deliveryCanvas, frames, silent);
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-film-review-'));
        source = path.join(work, path.basename(video));
        // 独立副本也隔开原路径上的覆盖和原地写入。支持时由文件系统写时复制。
        fs.copyFileSync(video, source, fs.constants.COPYFILE_FICLONE);
        digest = await sha256File(source);
        signal.throwIfAborted();
        const validation = toolchain.verify(source, {
          spec: {
            widthPx: spec.width_px, heightPx: spec.height_px, fps: spec.fps, frames: spec.frames,
            codec: spec.codec, pixelFormat: spec.pixel_format,
            audio: spec.audio_required ? mediaprobe.AudioPresent : mediaprobe.AudioAbsent,
            sampleRate: spec.sample_rate, channels: spec.channels,
          },
          exactFrames: true, decode: true, checkFrameZero: true,
        });
        const media = { ...validation.media, path: reportPath };
        mediaprobe.writeReportJSON({ ...validation, path: reportPath, media }, validationFile);
        if (!validation.ok) {
          review.writeReportJSON({
            schema_version: review.ReportSchemaVersion, path: reportPath, ok: false, media,
            expected_frames: frames, counted_frames: validation.media.video?.nb_frames ?? 0,
            loudness: null, problems: validation.problems, hints: validation.hints ?? [], cuts: [], sheets: [], seams: [],
          }, target);
          throw new Error(`成片规格校验未通过：${validationPath}\n  - ${validation.problems.join('\n  - ')}`);
        }
        out.write(`规格与完整解码校验：${validationPath}\n`);
        verifiedMedia = validation.media;
      }
      report = review.run(toolchain, {
        video: source,
        fps: rate,
        segments,
        outDir,
        silent,
        loudness,
        verifiedMedia,
        syncTolerance: num(p.sync_tolerance),
        every: num(p.every),
        tilesPerSheet: num(p.per_sheet),
        thumbWidth: num(p.thumb_width),
      });
      report.path = reportPath;
      report.media = { ...report.media, path: reportPath };
      if (digest !== undefined) {
        videoChanged = await sha256File(video).catch(() => '') !== digest;
        if (videoChanged) {
          report.ok = false;
          report.problems.push('影片在复查期间发生变化，请重新复查');
        } else {
          report.video_sha256 = digest;
          report.delivery_spec = spec;
          report.scene_plan_sha256 = review.scenePlanDigest(segments);
        }
      }
    } finally {
      if (work) fs.rmSync(work, { recursive: true, force: true });
    }
    signal.throwIfAborted();
    review.writeReportJSON(report, target);
    for (const sheet of report.sheets ?? []) out.write(`联系表：${sheet.image}（${sheet.tiles?.length ?? 0} 格）\n`);
    if ((report.seams?.length ?? 0) > 0) out.write(`交界条带：${report.seams.length} 张（${report.seams[0].image} 起）\n`);
    for (const hint of report.hints ?? []) out.write(`提示：${hint}\n`);
    out.write(`报告：${target}\n`);
    // 没接上的交接记到交界两侧的镜头上：哪一侧没按约定画，机器分不清。
    const broken = new Map<string, Finding[]>();
    for (const cut of report.cuts ?? []) {
      if (review.handoffBroken(cut)) {
        const problem = `${cut.from} → ${cut.to} 约定了 ${cut.handoff} 交接，但交界两帧差异 ${formatFixed(cut.difference as number, 1)}，没接上`;
        for (const id of [cut.from, cut.to]) broken.set(id, [...(broken.get(id) ?? []), { check: scene.CheckReviewHandoff, problem }]);
      }
    }
    if (!videoChanged) recordCheckFindings(out, rootDir, planned, broken);
    if (!report.ok) throw new Error(`整片复查未通过：${video}\n  - ${(report.problems ?? []).join('\n  - ')}`);
    out.write('机器检查通过；请逐页打开联系表做视觉复查\n');
    return { data: review.reportToJSON(report) };
  },
});

/**
 * reviewLoudnessTarget 从项目根的 frame.md 读成片响度目标。
 * 没有 frame.md（脱离项目使用）时不比对；有但读不出目标时报错，
 * 不静默跳过——那会让人以为响度已经查过了。
 */
export function reviewLoudnessTarget(rootDir: string, silent: boolean): review.LoudnessTarget | null {
  if (silent) return null;
  try {
    fs.statSync(path.join(rootDir, 'frame.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
  }
  let targets: scene.AudioTargets;
  try {
    targets = scene.audioTargetsOf(rootDir, 'frame.md');
  } catch (err) {
    throw new Error(`无法从 ${rootDir} 的 frame.md 读出响度目标：${(err as Error).message}`);
  }
  return { integratedLUFS: targets.integratedLUFS, tolerance: targets.tolerance, truePeakMax: targets.truePeakMax };
}

defineOp({
  name: 'scene_lint',
  cli: ['scene', 'lint'],
  ...(process.platform==='win32'?{scopes:['orchestrator','renderer'] as Array<'orchestrator'|'renderer'>}:{}),
  summary: '扫描镜头合成源码的确定性问题',
  description:
    `静态扫描镜头目录里渲染实际加载的合成源码，找出让渲染结果不可复现的写法。

这与渲染后的产物校验跑的是同一套规则：scene_run() / scene_run_all() 在渲染器退出后
会自动执行，命中即判本镜头失败且不重试。单独提供这一步，是为了在改完
合成代码后、重新渲染前先确认一遍。

扫描范围：从 index.html（没有时取顶层 .html，仍没有时向下两层找 index.html）
出发，沿 src、href、data-composition-src、import 与 CSS url() 的本地引用展开。
没被引用的草稿文件不参与判定。第三方库（vendor/、lib/、node_modules/ 等目录下，
带 .min / .bundle / .umd 后缀，或以许可证横幅开头的 JS）只记进报告的 skipped，
不做判定：库内部的 Math.random、requestAnimationFrame 不在渲染路径上。

规则：
  clock            Date.now()、performance.now()、无参 new Date()
  random           Math.random()
  raf              requestAnimationFrame
  interval         setInterval
  infinite-repeat  repeat: -1
  network          远程 fetch、XMLHttpRequest、WebSocket、EventSource
  remote-font      在线字体（Google Fonts）
  unpinned-cdn     jsdelivr / unpkg / esm.sh / cdnjs 上没有完整版本号的库
  remote-asset     其他远程资源

注释、字符串与正则字面量里提到这些 API 不算违规。渲染路径确实不经过的交互代码可在同一行注释写
` +
    determinism.AllowMarker +
    `: 理由
豁免，豁免项仍写进报告的 allowed。`,
  examples: ['scene_lint({"scene": "scenes/scene-003"})', 'scene_lint({"scene": "scenes/scene-003", "report_json": "scenes/scene-003/lint.json"})'],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    report_json: { type: 'string', description: '把扫描结果写成 JSON 报告到该路径' },
  },
  run: (p, { out }) => {
    const dir = str(p.scene);
    const report = determinism.scan(dir);
    if (str(p.report_json) !== '') determinism.writeJSON(report, str(p.report_json));
    for (const hint of report.hints ?? []) out.write(`提示：${hint}\n`);
    for (const skipped of report.skipped ?? []) out.write(`按第三方库跳过：${skipped}\n`);
    for (const allowed of report.allowed ?? []) out.write(`已豁免：${determinism.findingString(allowed)}\n`);
    if (!report.ok) throw new Error(`合成源码存在确定性问题：${dir}\n  - ${determinism.problems(report).join('\n  - ')}`);
    out.write(`合成源码扫描通过：${report.files?.length ?? 0} 个文件\n`);
    return {
      data: {
        ok: report.ok,
        files: report.files ?? [],
        allowed: (report.allowed ?? []).map((f) => determinism.findingString(f)),
        skipped: report.skipped ?? [],
        hints: report.hints ?? [],
      },
    };
  },
});
