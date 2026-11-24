/**
 * 本文件收拢与媒体产物相关的操作：抽帧（scene_frames）、视频规格校验（validate_video）与拼接（concat）。
 *
 * 这里的操作共用一组辅助函数（时间点与画幅解析），放在一起也更好找。
 */
import path from 'node:path';
import * as concat from '@onset/engine/concat';
import { formatFixed } from '@onset/engine/gofmt';
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as plugin from '@onset/engine/plugin';
import * as review from '@onset/engine/review';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { currentEnvironment } from './cli';
import { requireSilentMaster } from './deliverables';
import './media_frames';
import { canvasFromProject, parseCanvas } from './media_parse';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';

export { parseCanvas, parseRegion, parseStrip, parseTimePoints } from './media_parse';

defineOp({
  name: 'validate_video',
  cli: ['validate', 'video'],
  summary: '校验视频产物规格',
  description: `按机器可判定的规格校验一个视频，用于静音母版和成片验收。

检查项与不给的默认值：
  分辨率        取项目 frame.md 的 canvas；"canvas": "1080x1920" 可覆盖
  帧率          同上取 canvas.fps；fps 可覆盖
  视频编码      默认 h264，codec 可覆盖，"codec": "" 关闭该项检查
  像素格式      默认 yuv420p，pixel_format 同上
  时长/帧数/音轨 默认不检查，由对应参数开启

不符项会一次全部列出，不是报第一条就停——逐条修再重跑一轮代价太高。

三个开关代价明显更高，默认关闭：
  expect_frames    精确统计帧数，完整解码一遍。容器声明的 nb_frames 可能缺失
                   或不准，要断言「总帧数等于冻结时间轴」时必须用它。
  decode           完整解码一遍，发现截断和损坏。仅读流头的检查发现不了：
                   moov 在文件头时，截断一半的文件照样能读出正确规格。
  check_frame_zero 检查第 0 帧是否空白帧，对应 frame.md 的
                   black_or_blank_frame_zero 禁令。抖音类平台拿第 0 帧做封面。

有不符项或检查跑不起来时失败（缺 ffprobe/ffmpeg 时会说明）。
「检查跑不起来」（文件读不了、工具缺失）和「检查跑了但不合格」在 report_json
里是能区分的：前者不产出报告文件，后者产出 ok=false 的完整报告。

判断结果请读结构化结果或 report_json 写出的文件，不要解析中文输出。`,
  examples: [
    '# 静音母版：画幅取自 frame.md，断言无音轨且能完整解码',
    'validate_video({"video": "production/silent-master.mp4", "silent": true, "decode": true})',
    '# 成片：断言总帧数、48kHz 双声道，并检查第 0 帧封面',
    'validate_video({"video": "final.mp4", "expect_frames": 8340, "audio": true, "check_frame_zero": true, "report_json": "production/final-check.json"})',
    '# 脱离项目使用，显式给画幅',
    'validate_video({"video": "clip.mp4", "canvas": "1080x1920", "fps": 30})',
  ],
  params: {
    video: { type: 'string', description: '要校验的视频', required: true, positional: 0 },
    project_root: { type: 'string', description: '项目根目录，缺省为当前目录；用于从 frame.md 反查画幅' },
    canvas: { type: 'string', description: '画幅覆盖值，写成 宽x高（如 1080x1920）；不传则读项目 frame.md' },
    fps: { type: 'integer', description: '帧率覆盖值；不传则读 frame.md 的 canvas.fps' },
    codec: { type: 'string', description: '期望的视频编码；传空串关闭该项检查', default: 'h264' },
    pixel_format: { type: 'string', description: '期望的像素格式；传空串关闭该项检查', default: 'yuv420p' },
    duration: { type: 'number', description: '期望时长（秒），0 表示不检查' },
    duration_tolerance: { type: 'number', description: '时长允许偏差（秒），有限非负数', default: 0.15 },
    expect_frames: { type: 'integer', description: '期望总帧数，0 表示不检查；开启后会完整解码一遍精确统计' },
    silent: { type: 'boolean', description: '断言没有音轨，用于镜头产物和静音母版' },
    audio: { type: 'boolean', description: '断言有音轨，用于混音后的成片；与 silent 互斥' },
    sample_rate: { type: 'integer', description: '配合 audio 断言采样率，0 表示不检查', default: 48000 },
    channels: { type: 'integer', description: '配合 audio 断言声道数，0 表示不检查', default: 2 },
    decode: { type: 'boolean', description: '完整解码一遍确认没有截断或损坏；代价与文件长度成正比' },
    check_frame_zero: { type: 'boolean', description: '检查第 0 帧是否空白帧，交付封面前必查' },
    report_json: { type: 'string', description: '把校验结果写成 JSON 报告到该路径；判断结果应读它而不是解析文字输出' },
  },
  run: (p, { out }) => {
    const video = str(p.video);
    const silent = bool(p.silent);
    const withAudio = bool(p.audio);
    if (silent && withAudio) throw new Error('silent 与 audio 互斥：一个断言没有音轨，一个断言有');
    const rootDir = str(p.project_root) !== '' ? str(p.project_root) : '.';
    const expectFrames = num(p.expect_frames);
    const fps = num(p.fps);
    const spec: mediaprobe.Spec = {
      codec: str(p.codec),
      pixelFormat: str(p.pixel_format),
      durationSeconds: num(p.duration),
      tolerance: num(p.duration_tolerance),
      frames: expectFrames,
    };
    if (str(p.canvas) !== '') {
      const [width, height] = parseCanvas(str(p.canvas));
      spec.widthPx = width;
      spec.heightPx = height;
      spec.fps = fps;
    } else {
      const canvas = canvasFromProject(rootDir);
      spec.widthPx = canvas.widthPx;
      spec.heightPx = canvas.heightPx;
      spec.fps = canvas.fps;
      if (fps > 0) spec.fps = fps;
    }
    if (silent) {
      spec.audio = mediaprobe.AudioAbsent;
    } else if (withAudio) {
      spec.audio = mediaprobe.AudioPresent;
      spec.sampleRate = num(p.sample_rate);
      spec.channels = num(p.channels);
    }
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    const report = toolchain.verify(video, {
      spec,
      exactFrames: expectFrames > 0,
      decode: bool(p.decode),
      checkFrameZero: bool(p.check_frame_zero),
    });
    if (str(p.report_json) !== '') mediaprobe.writeReportJSON(report, str(p.report_json));
    for (const hint of report.hints ?? []) out.write(`提示：${hint}\n`);
    if (!report.ok) throw new Error(`视频规格校验未通过：${video}\n  - ${(report.problems ?? []).join('\n  - ')}`);
    out.write(`视频规格校验通过：${video}\n`);
    return { data: { ok: true, video, media: report.media, hints: report.hints ?? [] } };
  },
});

defineOp({
  name: 'concat',
  cli: ['concat'],
  summary: '把镜头产物按顺序拼成静音母版',
  description: `按镜头目录名的字典序，把 scenes 下所有镜头的产物拼成一条静音母版。

规格一致时全程 -c copy，不重新编码。只有编码或像素格式与目标不同的片段会先
生成规范化副本（原始文件保留），再一起拼接。

刻意不提供重定时能力。分辨率或帧率与母版不符时直接失败并要求回镜头工程重渲染，
而不是缩放或改帧率：把 720p 拉伸到 1080 是画质损失而不是格式统一，改帧率会动到
时间轴。制作提示词第八阶段写的是同一条规则——「禁止通过 setpts 或改变帧率让镜头
追赶配音；源时间轴有误时必须回到镜头工程重渲染」。提示词里的禁令可以被忽略，
不存在的能力不能，所以这里根本没有对应的参数。

带音轨的镜头产物同样直接失败：静音母版按契约就该无音轨，混音在后面的阶段做。

目标画幅默认从项目 frame.md 反查，canvas 可脱离项目使用。
dry_run 只打印分析结果，不写任何文件，用于拼接前确认。

拼完会自证：断言母版时长等于各片段时长之和、无音轨、画幅与帧率符合目标。

在项目里 out 只能是 production/silent-master.mp4：客户端的制作路线与成片页按这个位置找。

约定了交接的交界（后一镜 timing.enter 有手法），拼接前先量前一镜末帧与后一镜首帧；差异大到算没接顺时，
在交界两边各约 0.25 秒里叠上对方的那一帧再淡掉，成一次很短的溶解，总帧数不变。这是兜底，
更好的做法是先用 scene_seams() 让后一镜按真实末帧重做开头。不要抹平就传 "smooth_seams": false。`,
  examples: [
    '# 拼成静音母版',
    'concat({"scenes": "scenes/", "out": "production/silent-master.mp4"})',
    '# 先看看有没有规格不一致的镜头，不写文件',
    'concat({"scenes": "scenes/", "out": "production/silent-master.mp4", "dry_run": true})',
    '# 脱离项目使用，显式给画幅',
    'concat({"scenes": "scenes/", "out": "master.mp4", "canvas": "1080x1920", "fps": 30})',
  ],
  params: {
    scenes: { type: 'string', description: '镜头目录的上级目录', required: true, positional: 0 },
    out: { type: 'string', description: '母版输出路径，必填' },
    project_root: { type: 'string', description: '项目根目录，缺省为当前目录；用于从 frame.md 反查画幅' },
    canvas: { type: 'string', description: '画幅覆盖值，写成 宽x高；不传则读项目 frame.md' },
    fps: { type: 'integer', description: '帧率覆盖值；不传则读 frame.md 的 canvas.fps' },
    normalized_dir: { type: 'string', description: '规范化副本目录，缺省为 <out 所在目录>/normalized' },
    dry_run: { type: 'boolean', description: '只分析并打印结果，不写任何文件' },
    smooth_seams: { type: 'boolean', description: '抹平没接上的约定交接（缺省打开）', default: true },
  },
  run: async (p, { out, signal }) => {
    const outPath = str(p.out);
    if (outPath === '') throw new Error('必须用 out 指定母版输出路径');
    const rootDir = str(p.project_root) !== '' ? str(p.project_root) : '.';
    requireSilentMaster(rootDir, outPath);
    const fps = num(p.fps);
    const target: concat.Target = {
      widthPx: 0,
      heightPx: 0,
      fps: 0,
      codec: concat.DefaultCodec,
      pixelFormat: concat.DefaultPixelFormat,
    };
    if (str(p.canvas) !== '') {
      const [width, height] = parseCanvas(str(p.canvas));
      target.widthPx = width;
      target.heightPx = height;
      target.fps = fps;
    } else {
      const canvas = canvasFromProject(rootDir);
      target.widthPx = canvas.widthPx;
      target.heightPx = canvas.heightPx;
      target.fps = canvas.fps;
      if (fps > 0) target.fps = fps;
    }
    const scenes = schedule.plan(str(p.scenes));
    for (const check of plugin.pluginRenderChecks()) check.value.beforeConcat?.(rootDir, scenes);
    const inputs: concat.Input[] = scenes.map((s) => ({ id: s.id, path: scene.outputPath(s) }));
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    const plan = concat.analyze(toolchain, inputs, target);
    out.write(
      `片段 ${inputs.length} 个，合计 ${formatFixed(plan.totalSeconds, 3)} 秒；需要规范化 ${plan.normalize?.length ?? 0} 个\n`,
    );
    for (const item of plan.normalize ?? []) out.write(`  规范化：${item.id}\n`);
    if ((plan.blocking?.length ?? 0) > 0)
      throw new Error(`拼接前必须先修复以下问题：\n  - ${plan.blocking.join('\n  - ')}`);
    const normalize = (plan.normalize ?? []).map((item) => item.id);
    // 约定了交接却没接顺的交界：前一镜末帧与后一镜首帧差异到 review 判「要看一眼」的程度就抹平。
    const seams: { from: string; to: string; difference: number }[] = [];
    const frameCounts = new Map<string, number>();
    const framesOf = (input: concat.Input) => {
      if (!frameCounts.has(input.id)) frameCounts.set(input.id, toolchain.countFrames(input.path));
      return frameCounts.get(input.id)!;
    };
    if (p.smooth_seams !== false) {
      for (let i = 1; i < scenes.length; i++) {
        if ((scenes[i].timing?.enter?.device ?? '') === '') continue;
        const a = inputs[i - 1];
        const b = inputs[i];
        const difference = toolchain.frameDifferenceBetween(a.path, (framesOf(a) - 1) / target.fps, b.path, 0);
        if (difference >= review.HandoffLooseDifference) seams.push({ from: a.id, to: b.id, difference });
      }
    }
    for (const seam of seams)
      out.write(`  抹平交界：${seam.from} → ${seam.to}（末帧与首帧差异 ${formatFixed(seam.difference, 1)}）\n`);
    if (bool(p.dry_run)) {
      out.write('dry-run：未写入任何文件\n');
      return {
        data: { dry_run: true, scenes: inputs.length, total_seconds: plan.totalSeconds, normalize, smoothed: seams },
      };
    }

    const runner = concat.newRunner(currentEnvironment(), toolchain);
    const needsNormalize = new Set(normalize);
    const destinations =
      str(p.normalized_dir) !== '' ? str(p.normalized_dir) : path.join(path.dirname(outPath), 'normalized');
    // 每个镜头片头、片尾各要叠哪一帧：交界 A → B 给 A 的片尾叠 B 的首帧、给 B 的片头叠 A 的末帧。
    const blends = new Map<string, { head?: concat.SeamBlend; tail?: concat.SeamBlend }>();
    const blendFrames = Math.max(1, Math.round(concat.SeamBlendSeconds * target.fps));
    for (const seam of seams) {
      const a = inputs.find((x) => x.id === seam.from)!;
      const b = inputs.find((x) => x.id === seam.to)!;
      const aLast = path.join(destinations, 'seams', `${seam.from}-last.png`);
      const bFirst = path.join(destinations, 'seams', `${seam.to}-first.png`);
      toolchain.extractFrame(a.path, (framesOf(a) - 1) / target.fps, aLast);
      toolchain.extractFrame(b.path, 0, bFirst);
      blends.set(seam.from, { ...blends.get(seam.from), tail: { plate: bFirst, frames: blendFrames } });
      blends.set(seam.to, { ...blends.get(seam.to), head: { plate: aLast, frames: blendFrames } });
    }
    const paths: string[] = [];
    for (const input of inputs) {
      const blend = blends.get(input.id);
      if (blend) {
        // 抹平时按 target 重新编码，规范化顺带完成。
        const dest = path.join(destinations, input.id + '.mp4');
        await runner.smoothSeams(input.path, dest, target, { ...blend, totalFrames: framesOf(input) }, signal);
        paths.push(dest);
        continue;
      }
      if (!needsNormalize.has(input.id)) {
        paths.push(input.path);
        continue;
      }
      const dest = path.join(destinations, input.id + '.mp4');
      await runner.normalize(input.path, dest, target, signal);
      paths.push(dest);
    }
    await runner.concat(paths, outPath, signal);
    // 自证：拼完的母版必须对得上各片段时长之和，且仍然无音轨。
    const report = toolchain.verify(outPath, {
      spec: {
        widthPx: target.widthPx,
        heightPx: target.heightPx,
        fps: target.fps,
        durationSeconds: plan.totalSeconds,
        tolerance: 0.1,
        audio: mediaprobe.AudioAbsent,
      },
    });
    if (!report.ok) {
      throw new Error(
        `母版已写出但不符合预期，不要直接用于后续阶段：${outPath}\n  - ${(report.problems ?? []).join('\n  - ')}`,
      );
    }
    out.write(`静音母版已生成：${outPath}（${formatFixed(report.media.duration_seconds, 3)} 秒）\n`);
    return {
      data: {
        out: outPath,
        scenes: inputs.length,
        duration_seconds: report.media.duration_seconds,
        normalize,
        smoothed: seams,
      },
    };
  },
});
