/**
 * 本文件收拢与媒体产物相关的操作：抽帧（scene_frames）、视频规格校验（validate_video）与拼接（concat）。
 *
 * 这里的操作共用一组辅助函数（时间点与画幅解析），放在一起也更好找。
 */
import path from 'node:path';
import * as concat from '@am/engine/concat';
import { formatFixed, goQuote, goRound, goTrimSpace } from '@am/engine/gofmt';
import * as mediaprobe from '@am/engine/mediaprobe';
import * as plugin from '@am/engine/plugin';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import { currentEnvironment } from './cli';
import { type Finding, recordCheckFindings } from './memory_cmd';
import { bool, num, str } from './ops/common';
import { defineOp } from './ops/op';

/** strconv.ParseFloat 的常用子集：十进制、科学计数法、inf / infinity / nan（不区分大小写，可带正负号）。失败返回 null。 */
function parseGoFloat(s: string): number | null {
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return null;
}

/** strconv.Atoi：可带正负号的十进制整数。失败返回 null。 */
function parseGoInt(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const value = Number(s);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * parseTimePoints 解析 --at 的时间点列表，支持秒数、百分比和 end。
 *
 * 百分比和 end 都要先知道时长，所以 duration 必须是实测值而不是 scene.json 的
 * 声明值：产物时长和声明时长不一致正是要靠抽帧去看的情况之一。
 *
 * end 取 duration - 一帧，而不是 duration：后者已经超出最后一帧，
 * ffmpeg 会返回成功但什么都不输出。
 */
export function parseTimePoints(spec: string, duration: number, fps: number): number[] {
  if (fps <= 0) fps = 30;
  let lastFrame = duration - 1.0 / fps;
  if (lastFrame < 0) lastFrame = 0;
  const points: number[] = [];
  for (const raw of spec.split(',')) {
    const item = goTrimSpace(raw);
    if (item === '') continue;
    let value: number;
    if (item.toLowerCase() === 'end') {
      value = lastFrame;
    } else if (item.endsWith('%')) {
      const percent = parseGoFloat(item.slice(0, -1));
      // 与 Go 一致：NaN 不小于 0 也不大于 100，会被放行。
      if (percent === null || percent < 0 || percent > 100) {
        throw new Error(`at 的百分比必须是 0..100，实际收到 ${goQuote(item)}`);
      }
      value = (duration * percent) / 100;
      if (value > lastFrame) value = lastFrame;
    } else {
      const parsed = parseGoFloat(item);
      if (parsed === null || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`at 的时间点必须是非负秒数、百分比或 end，实际收到 ${goQuote(item)}`);
      }
      if (parsed > lastFrame) throw new Error(`at 的时间点 ${item} 秒超出视频时长 ${formatFixed(duration, 3)} 秒`);
      value = parsed;
    }
    points.push(value);
  }
  if (points.length === 0) throw new Error('at 至少要给一个时间点');
  return points;
}

/** parseCanvas 解析 "1080x1440" 形式的画幅覆盖值。 */
export function parseCanvas(value: string): [number, number] {
  const lowered = goTrimSpace(value).toLowerCase();
  const i = lowered.indexOf('x');
  if (i < 0) throw new Error(`canvas 必须写成 宽x高，例如 1080x1440，实际收到 ${goQuote(value)}`);
  const w = parseGoInt(goTrimSpace(lowered.slice(0, i)));
  const h = parseGoInt(goTrimSpace(lowered.slice(i + 1)));
  if (w === null || h === null || w <= 0 || h <= 0) throw new Error(`canvas 的宽高必须是正整数，实际收到 ${goQuote(value)}`);
  return [w, h];
}

/**
 * maxStripFrames 是一张逐帧条带的帧数上限：30fps 下 3 秒。条带是用来看一个
 * 动作或一次转场的，更长的区间应拆成几段，否则缩略图小到看不出差别。
 */
const maxStripFrames = 90;

/** parseRegion 解析 --crop 的 x,y,w,h，并要求区域落在画面内。 */
export function parseRegion(value: string, canvas: scene.Canvas): mediaprobe.Region {
  const parts = value.split(',');
  if (parts.length !== 4) throw new Error(`crop 必须写成 x,y,宽,高（像素），实际收到 ${goQuote(value)}`);
  const numbers = parts.map((part) => {
    const n = parseGoInt(goTrimSpace(part));
    if (n === null || n < 0) throw new Error(`crop 的每一项都必须是非负整数，实际收到 ${goQuote(value)}`);
    return n;
  });
  const r: mediaprobe.Region = { x: numbers[0], y: numbers[1], w: numbers[2], h: numbers[3] };
  if (r.w < 2 || r.h < 2 || r.x + r.w > canvas.widthPx || r.y + r.h > canvas.heightPx) {
    throw new Error(`crop ${value} 超出 ${canvas.widthPx}x${canvas.heightPx} 画面或宽高小于 2`);
  }
  return r;
}

/** parseStrip 把 --strip a:b 换算成区间内的全部帧时间点。 */
export function parseStrip(spec: string, duration: number, fps: number): number[] {
  const i = spec.indexOf(':');
  if (i < 0) throw new Error(`strip 必须写成 开始:结束（秒），实际收到 ${goQuote(spec)}`);
  let bounds: number[];
  try {
    bounds = parseTimePoints(spec.slice(0, i) + ',' + spec.slice(i + 1), duration, fps);
  } catch (err) {
    throw new Error(`strip：${(err as Error).message}`);
  }
  const first = Math.trunc(goRound(bounds[0] * fps));
  const last = Math.trunc(goRound(bounds[1] * fps));
  if (last < first) throw new Error(`strip 的结束早于开始：${goQuote(spec)}`);
  const count = last - first + 1;
  if (count > maxStripFrames) throw new Error(`strip 覆盖 ${count} 帧，超过上限 ${maxStripFrames} 帧；请拆成几段`);
  const points: number[] = [];
  for (let frame = first; frame <= last; frame++) points.push(frame / fps);
  return points;
}

/** scene_frames 不给 at 时的抽帧点：首、四分位与末帧。 */
const defaultFramePoints = '0,25%,50%,75%,end';

defineOp({
  name: 'scene_frames',
  cli: ['scene', 'frames'],
  summary: '从镜头产物抽帧供视觉检查',
  description: `把这一镜的产物按若干时间点抽成 PNG，用于视觉验收。

这一步不判断画面对不对——那只有能看图的一方说得清。它的职责是把「渲染完的
mp4」变成「可以逐张打开看的 PNG」，并把机器能判的情况标出来。

渲染成功不等于画面正确：文字压在图形上看不清、中文字体静默回退成方框、
动画在第 30 帧就停住、转场只做了一半——这些全都能顺利跑完渲染。
抽帧是把这类问题从「成片时才发现」提前到「单镜头渲完就发现」的唯一手段。

at 接受三种写法，可混用（缺省 ${defaultFramePoints}）：
  秒数     0、1.5、2.833
  百分比   25%、50%——按实测时长换算，不是 scene.json 的声明时长
  end      最后一帧。取时长减一帧，直接用时长会超出末帧，
           ffmpeg 会返回成功却什么都不输出

check_blank 对每一帧做纯色判定，命中即失败。判定阈值刻意保守，只拦几乎
完全均匀的画面：深色背景配浅色标题是常见设计，误判它比漏判一个真空白帧更糟。
偏暗但有内容的帧只进报告的 hints，不算失败。

strip 写成 开始:结束，把区间内的每一帧拼成一张条带图（strip-<开始>-<结束>.png），
用来看动作与转场：有没有预备和跟随、是否匀速、几个元素是否同一帧齐动、
入场是否一帧蹦出。单张最多 90 帧，与 at 互斥。

crop 写成 x,y,宽,高，只保留画面上这块区域的原始像素，用来在全分辨率下看小字
是否清楚、线条是否对齐；对 at 的 PNG 与 strip 的条带都生效。

产物默认写到 <镜头目录>/visual-qc/，与制作提示词的 production/visual-qc/
是同一用途。逐帧统计量在结构化结果与 report_json 里，判断结果请读它。`,
  examples: [
    '# 默认在首、四分位和末帧各抽一张',
    'scene_frames({"scene": "scenes/scene-001"})',
    '# 只看第 0 帧封面，并拦下空白帧',
    'scene_frames({"scene": "scenes/scene-001", "at": "0", "check_blank": true})',
    '# 逐帧看 1.2 到 1.6 秒的入场动作',
    'scene_frames({"scene": "scenes/scene-001", "strip": "1.2:1.6"})',
    '# 全分辨率看底部说明文字',
    'scene_frames({"scene": "scenes/scene-001", "at": "50%", "crop": "88,1180,904,160"})',
    '# 检查转场区间，写到项目统一的视觉验收目录',
    'scene_frames({"scene": "scenes/scene-001", "at": "0,0.5,1.2,end", "out": "production/visual-qc/scene-001", "report_json": "production/visual-qc/scene-001.json"})',
  ],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    at: { type: 'string', description: `抽帧时间点，逗号分隔；支持秒数、百分比与 end，缺省 ${defaultFramePoints}` },
    out: { type: 'string', description: 'PNG 输出目录，缺省为 <镜头目录>/visual-qc' },
    check_blank: { type: 'boolean', description: '发现空白帧时失败；不传则只抽帧和记录' },
    report_json: { type: 'string', description: '把逐帧统计写成 JSON 报告到该路径' },
    strip: { type: 'string', description: '开始:结束（秒，可用百分比与 end），把区间内每一帧拼成一张条带图' },
    crop: { type: 'string', description: 'x,y,宽,高（像素），只保留该区域的原始像素' },
    cols: { type: 'integer', description: '条带每行的帧数', default: 6 },
    thumb_width: { type: 'integer', description: '条带里每帧的宽度（像素）', default: 320 },
  },
  run: (p, { out }) => {
    const s = scene.load(str(p.scene));
    const canvas = scene.sceneCanvas(s);
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    // 时间点按实测时长换算：产物时长与声明时长不一致，
    // 正是要靠抽帧去看的情况之一。
    const media = toolchain.probe(scene.outputPath(s));
    let region: mediaprobe.Region | null = null;
    if (str(p.crop) !== '') region = parseRegion(str(p.crop), canvas);
    const destination = str(p.out) !== '' ? str(p.out) : path.join(s.directory, 'visual-qc');
    const strip = str(p.strip);
    const checkBlank = bool(p.check_blank);
    if (strip !== '') {
      if (str(p.at) !== '' || checkBlank) throw new Error('strip 与 at、check_blank 互斥');
      const points = parseStrip(strip, media.duration_seconds, canvas.fps);
      const name = 'strip-' + strip.replaceAll(':', '-').replaceAll('.', '_') + '.png';
      const image = path.join(destination, name);
      const columns = num(p.cols);
      toolchain.contactSheetRegion(scene.outputPath(s), points, region, columns, num(p.thumb_width), image);
      out.write(`逐帧条带：${image}（${points.length} 帧，${columns} 列，从左到右、从上到下）\n`);
      return { data: { strip: image, frames: points.length, columns } };
    }
    const points = parseTimePoints(str(p.at) !== '' ? str(p.at) : defaultFramePoints, media.duration_seconds, canvas.fps);
    const report = toolchain.extractFramesRegion(scene.outputPath(s), points, region, destination);
    if (str(p.report_json) !== '') mediaprobe.writeFrameReportJSON(report, str(p.report_json));
    for (const frame of report.frames ?? []) {
      out.write(`${formatFixed(frame.at_seconds, 3)} 秒  ${frame.image}  灰度均值 ${formatFixed(frame.stats.mean, 1)}  标准差 ${formatFixed(frame.stats.stddev, 2)}\n`);
    }
    for (const hint of report.hints ?? []) out.write(`提示：${hint}\n`);
    if (checkBlank && !report.ok) {
      const findings: Finding[] = (report.problems ?? []).map((problem) => ({ check: scene.CheckFramesBlank, problem }));
      recordCheckFindings(out, '.', [s], new Map([[s.id, findings]]));
      throw new Error(`抽帧发现空白帧：${s.output}\n  - ${(report.problems ?? []).join('\n  - ')}`);
    }
    return {
      data: {
        ok: report.ok,
        frames: (report.frames ?? []).map((f) => ({ at_seconds: f.at_seconds, image: f.image, mean: f.stats.mean, stddev: f.stats.stddev })),
        problems: report.problems ?? [],
        hints: report.hints ?? [],
      },
    };
  },
});

function canvasFromProject(rootDir: string): scene.Canvas {
  try {
    return scene.canvasOf(rootDir, 'frame.md');
  } catch (err) {
    throw new Error(`无法从 ${rootDir} 的 frame.md 确定画幅：${(err as Error).message}；` + '脱离项目使用时请显式传 canvas（宽x高）与 fps');
  }
}

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

拼完会自证：断言母版时长等于各片段时长之和、无音轨、画幅与帧率符合目标。`,
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
  },
  run: async (p, { out, signal }) => {
    const outPath = str(p.out);
    if (outPath === '') throw new Error('必须用 out 指定母版输出路径');
    const rootDir = str(p.project_root) !== '' ? str(p.project_root) : '.';
    const fps = num(p.fps);
    const target: concat.Target = { widthPx: 0, heightPx: 0, fps: 0, codec: concat.DefaultCodec, pixelFormat: concat.DefaultPixelFormat };
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
    out.write(`片段 ${inputs.length} 个，合计 ${formatFixed(plan.totalSeconds, 3)} 秒；需要规范化 ${plan.normalize?.length ?? 0} 个\n`);
    for (const item of plan.normalize ?? []) out.write(`  规范化：${item.id}\n`);
    if ((plan.blocking?.length ?? 0) > 0) throw new Error(`拼接前必须先修复以下问题：\n  - ${plan.blocking.join('\n  - ')}`);
    const normalize = (plan.normalize ?? []).map((item) => item.id);
    if (bool(p.dry_run)) {
      out.write('dry-run：未写入任何文件\n');
      return { data: { dry_run: true, scenes: inputs.length, total_seconds: plan.totalSeconds, normalize } };
    }

    const runner = concat.newRunner(currentEnvironment(), toolchain);
    const needsNormalize = new Set(normalize);
    const destinations = str(p.normalized_dir) !== '' ? str(p.normalized_dir) : path.join(path.dirname(outPath), 'normalized');
    const paths: string[] = [];
    for (const input of inputs) {
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
      throw new Error(`母版已写出但不符合预期，不要直接用于后续阶段：${outPath}\n  - ${(report.problems ?? []).join('\n  - ')}`);
    }
    out.write(`静音母版已生成：${outPath}（${formatFixed(report.media.duration_seconds, 3)} 秒）\n`);
    return { data: { out: outPath, scenes: inputs.length, duration_seconds: report.media.duration_seconds, normalize } };
  },
});
