/**
 * 镜头产物视觉抽帧操作：单镜抽帧（scene_frames）与全片批量总览抽帧（scene_frames_batch）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '@onset/engine/fsutil';
import { formatFixed } from '@onset/engine/gofmt';
import { marshalIndent } from '@onset/engine/gojson';
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { currentEnvironment } from './cli';
import { parseRegion, parseStrip, parseTimePoints } from './media_parse';
import { type Finding, recordCheckFindings } from './memory_cmd';
import { bool, num, str, strs } from './ops/common';
import { defineOp, ParamError } from './ops/op';

/** scene_frames 不给 at 时的抽帧点：首、四分位与末帧。 */
const defaultFramePoints = '0,25%,50%,75%,end';

/**
 * scene_frames 写出的 PNG 缺省宽度。看图按像素计 token（Claude 每 28×28 一块）：1920×1080 一张约 2,700，
 * 960×540 约 700。验收看构图、有没有画面、字幕在不在，用不着原尺寸；要看小字与对齐用 crop 取原始像素。
 * 看过的图会一直留在看图一方的上下文里，之后每一步都重读。
 */
const defaultFrameWidth = 960;

/** sheet 联系表每格的宽度与每行格数：五个点拼成 3+2 两行，约 1,440×540，一张图约 1,000 token。 */
const sheetThumbWidth = 480;
const sheetColumns = 3;

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

sheet 为 true 时另把 at 的这些时间点拼成一张联系表（contact-sheet.png，每格宽 ${sheetThumbWidth}、每行
最多 ${sheetColumns} 格）：验收先看这一张，看出问题或要确认细节时再打开单帧、用 crop 看局部。一张网格
花的 token 远少于逐张打开每一帧。

at 抽出的 PNG 缺省缩到宽 ${defaultFrameWidth}（看构图、有没有画面、字幕在不在足够，每张图
花的 token 约为原尺寸的四分之一）；要看细节先用 crop 取那一块，确实要整帧原尺寸时
传 width: 0。空白帧判定按原帧算，不受缩放影响。

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
    width: {
      type: 'integer',
      description: 'at 抽出的 PNG 最大宽度（像素），0 为原尺寸；用了 crop 时不缩放',
      default: defaultFrameWidth,
    },
    sheet: { type: 'boolean', description: '另把 at 的这些时间点拼成一张联系表 contact-sheet.png，验收先看它' },
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
    const points = parseTimePoints(
      str(p.at) !== '' ? str(p.at) : defaultFramePoints,
      media.duration_seconds,
      canvas.fps,
    );
    const width = num(p.width);
    if (!Number.isInteger(width) || width < 0) throw new ParamError('width 要是不小于 0 的整数（0 为原尺寸）');
    const report = toolchain.extractFramesRegion(scene.outputPath(s), points, region, destination, width);
    if (str(p.report_json) !== '') mediaprobe.writeFrameReportJSON(report, str(p.report_json));
    for (const frame of report.frames ?? []) {
      out.write(
        `${formatFixed(frame.at_seconds, 3)} 秒  ${frame.image}  灰度均值 ${formatFixed(frame.stats.mean, 1)}  标准差 ${formatFixed(frame.stats.stddev, 2)}\n`,
      );
    }
    for (const hint of report.hints ?? []) out.write(`提示：${hint}\n`);
    let sheet = '';
    if (bool(p.sheet)) {
      sheet = path.join(destination, 'contact-sheet.png');
      toolchain.contactSheetRegion(
        scene.outputPath(s),
        points,
        region,
        Math.min(points.length, sheetColumns),
        sheetThumbWidth,
        sheet,
      );
      out.write(`联系表：${sheet}（${points.length} 个时间点，从左到右、从上到下；先看这一张，有疑问再开单帧）\n`);
    }
    if (checkBlank && !report.ok) {
      const findings: Finding[] = (report.problems ?? []).map((problem) => ({
        check: scene.CheckFramesBlank,
        problem,
      }));
      recordCheckFindings(out, '.', [s], new Map([[s.id, findings]]));
      throw new Error(`抽帧发现空白帧：${s.output}\n  - ${(report.problems ?? []).join('\n  - ')}`);
    }
    return {
      data: {
        ok: report.ok,
        frames: (report.frames ?? []).map((f) => ({
          at_seconds: f.at_seconds,
          image: f.image,
          mean: f.stats.mean,
          stddev: f.stats.stddev,
        })),
        problems: report.problems ?? [],
        hints: report.hints ?? [],
        ...(sheet !== '' ? { sheet } : {}),
      },
    };
  },
});

const batchDefaultPoints = '0,50%,end';

defineOp({
  name: 'scene_frames_batch',
  cli: ['scene', 'frames-batch'],
  summary: '批量抽取全片镜头并拼成多镜总览联系表（大幅减少验收看图次数）',
  description: `一次扫描 scenes/ 下的全部已渲染镜头（或 only_scenes 指定的子集），为每个镜头抽取代表帧并可选执行空白帧检测，
再按每张联系表 scenes_per_sheet 个镜头（每行一镜，从左到右按时间点排列）拼成总览联系表。

整片 20 个镜头只需 1 次工具调用与 4 张总览图，不必逐镜调用 20 次 scene_frames() 并把 20 张单镜联系表全部塞进上下文。
发现某镜异常或需看第 0 帧封面细节时，再对该镜单独调用 scene_frames() 或 crop。`,
  examples: [
    'scene_frames_batch({"scenes": "scenes/"})',
    'scene_frames_batch({"scenes": "scenes/", "out": "production/visual-qc/batch", "check_blank": true})',
    'scene_frames_batch({"scenes": "scenes/", "only_scenes": ["scene-001", "scene-004"]})',
  ],
  params: {
    scenes: { type: 'string', description: '镜头目录的上级目录', default: 'scenes' },
    only_scenes: { type: 'strings', description: '只抽这些镜头 ID；留空为全片' },
    at: {
      type: 'string',
      description: `每个镜头抽取的时间点（逗号分隔，缺省 ${batchDefaultPoints}）`,
      default: batchDefaultPoints,
    },
    out: { type: 'string', description: '总览联系表与报告输出目录', default: 'production/visual-qc/batch' },
    check_blank: { type: 'boolean', description: '检查空白帧并在发现空白帧时报错' },
    scenes_per_sheet: { type: 'integer', description: '每张总览联系表最多包含的镜头行数（1..10）', default: 5 },
    thumb_width: { type: 'integer', description: '每格缩略图宽度（像素）', default: 360 },
    report_json: { type: 'string', description: '报告路径，缺省为 <out>/batch-qc.json' },
  },
  run: async (p, { out, signal }) => {
    const scenesDir = str(p.scenes) || 'scenes';
    const planned = schedule.plan(scenesDir);
    const only = strs(p.only_scenes);
    const selected = only.length > 0 ? planned.filter((s) => only.includes(s.id)) : planned;
    if (only.length > 0 && selected.length !== new Set(only).size) {
      throw new ParamError('only_scenes 中包含不存在的镜头 ID');
    }
    const perSheet = num(p.scenes_per_sheet);
    if (!Number.isInteger(perSheet) || perSheet < 1 || perSheet > 10) {
      throw new ParamError('scenes_per_sheet 必须是 1..10 的整数');
    }
    const thumbWidth = num(p.thumb_width);
    if (!Number.isInteger(thumbWidth) || thumbWidth < 64) {
      throw new ParamError('thumb_width 必须是至少 64 的整数');
    }
    const atSpec = str(p.at) || batchDefaultPoints;
    const outDir = str(p.out) || 'production/visual-qc/batch';
    const reportPath = str(p.report_json) || path.join(outDir, 'batch-qc.json');
    const checkBlank = bool(p.check_blank);
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    fs.mkdirSync(outDir, { recursive: true });
    const work = fs.mkdtempSync(path.join(outDir, '.batch-'));
    try {
      const perScene: Array<{
        scene_id: string;
        ok: boolean;
        missing?: boolean;
        problems: string[];
        hints: string[];
        files: string[];
      }> = [];
      const blankFindings = new Map<string, Finding[]>();
      const blankProblems: string[] = [];
      for (const s of selected) {
        signal.throwIfAborted();
        const mp4 = scene.outputPath(s);
        if (!fs.existsSync(mp4)) {
          perScene.push({
            scene_id: s.id,
            ok: false,
            missing: true,
            problems: [`缺少渲染产物：${s.output}`],
            hints: [],
            files: [],
          });
          continue;
        }
        const canvas = scene.sceneCanvas(s);
        const media = toolchain.probe(mp4);
        const points = parseTimePoints(atSpec, media.duration_seconds, canvas.fps);
        const sceneWork = path.join(work, s.id);
        const report = toolchain.extractFramesRegion(mp4, points, null, sceneWork, thumbWidth);
        const problems = report.problems ?? [];
        const hints = [...(report.hints ?? [])];
        if (checkBlank && !report.ok) {
          blankFindings.set(
            s.id,
            problems.map((problem) => ({ check: scene.CheckFramesBlank, problem })),
          );
          for (const problem of problems) blankProblems.push(`${s.id}: ${problem}`);
        } else if (!checkBlank && !report.ok) {
          for (const problem of problems) hints.push(problem);
        }
        perScene.push({
          scene_id: s.id,
          ok: checkBlank ? report.ok : true,
          problems: checkBlank ? problems : [],
          hints,
          files: (report.frames ?? []).map((f) => f.image),
        });
      }
      const rendered = perScene.filter((row) => row.files.length > 0);
      const cols = rendered[0]?.files.length ?? 0;
      const sheets: Array<{ image: string; scenes: string[]; columns: number }> = [];
      if (rendered.length > 0 && cols > 0) {
        for (let i = 0; i < rendered.length; i += perSheet) {
          signal.throwIfAborted();
          const group = rendered.slice(i, i + perSheet);
          const image = path.join(outDir, `overview-${String(sheets.length + 1).padStart(2, '0')}.png`);
          const files = group.flatMap((row) => row.files);
          await mediaprobe.contactSheetImages(toolchain, files, image, signal, cols, thumbWidth);
          sheets.push({ image, scenes: group.map((row) => row.scene_id), columns: cols });
        }
      }
      const manifest = {
        scenes_dir: scenesDir,
        at: atSpec,
        ok: perScene.every((row) => row.ok),
        total_scenes: perScene.length,
        sheets,
        scenes: perScene.map(({ files: _files, ...rest }) => rest),
      };
      atomicWrite(reportPath, marshalIndent(manifest) + '\n', 0o644);
      out.write(
        `批量视觉抽帧完成：共 ${perScene.length} 个镜头，生成 ${sheets.length} 张总览联系表（每行一镜，时间点 ${atSpec}）\n`,
      );
      for (const sheet of sheets) out.write(`总览联系表：${sheet.image}（${sheet.scenes.join(', ')}）\n`);
      const flagged = perScene.filter((row) => !row.ok || row.hints.length > 0);
      for (const row of flagged) {
        if (row.problems.length > 0) out.write(`异常 ${row.scene_id}：${row.problems.join('；')}\n`);
        for (const hint of row.hints) out.write(`提示 ${row.scene_id}：${hint}\n`);
      }
      out.write(`报告：${reportPath}\n`);
      if (checkBlank && blankProblems.length > 0) {
        recordCheckFindings(out, '.', selected, blankFindings);
        throw new Error(`批量抽帧发现空白帧：\n  - ${blankProblems.join('\n  - ')}`);
      }
      if (!manifest.ok) {
        const failed = perScene
          .filter((row) => !row.ok)
          .map((row) => `${row.scene_id}（${row.problems.join('；') || '未通过'}）`);
        throw new Error(`批量抽帧存在异常镜头：${failed.join('、')}；详见报告：${reportPath}`);
      }
      return {
        data: {
          ok: manifest.ok,
          total_scenes: perScene.length,
          sheets: sheets.map((s) => ({ image: s.image, scenes: s.scenes })),
          scenes: manifest.scenes,
          report: reportPath,
        },
      };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
});
