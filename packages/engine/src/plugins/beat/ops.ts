/**
 * 卡点的操作：导入音乐、分析并确认节拍网格、按小节写镜头 cue、校验。由卡点插件在 apply 里登记（index.ts），
 * cli 的操作表经 plugin_ops.ts 订阅后照旧 defineOp。
 */
import path from 'node:path';
import * as beat from '../../beat';
import { envMap } from '../../envutil';
import { formatFixed } from '../../gofmt';
import { DefaultAVToleranceFrames, DefaultAVVisualWindowFrames, newToolchain } from '../../mediaprobe';
import { bool, num, positiveDuration, projectRoot, str, timeout, withTimeoutSignal } from '../../opkit';
import type { PluginContext } from '../../plugin/types';
import * as project from '../../project';
import * as schedule from '../../schedule';
import { formatAVBacktestSummary, runBeatAVBacktest } from './backtest';
import { applyBeatCues, beatCoverage } from './cues';

export { beatCoverage } from './cues';

type Out = { write(text: string): void };
type ParamValues = Record<string, unknown>;
const currentEnvironment = (): Record<string, string> => envMap();

/** 命令行里 onset beat 这一层的说明。 */
export const beatGroup = {
  path: ['beat'],
  summary: '无配音卡点：导入音乐、确认节拍网格、按小节切镜头',
  description:
    `卡点模式以项目根的 beat.yaml 启用，与口播、歌曲讲解、多角色对话互斥。

流程：
  beat_init()                          写出 beat.yaml
  beat_doctor()                        检查 beat-this 环境，预先下载模型权重
  beat_import({"music": "<音乐文件>"})  导入音乐（记录摘要与实测时长）
  beat_analyze()                       分析节拍，写出草稿网格与试听轨 grid-click.wav
  beat_regrid({"meter": 4, "anchor": 1})  重拍整体错位或拍号判错时重排重拍
  beat_confirm()                       试听确认后，把草稿导入为正式网格
  （按小节写 ` +
    beat.PlanFile +
    `）
  beat_cues({"scenes": "scenes/"})     按小节换算整数帧，写入各镜头时长与 beat 块
  validate_beat()                      校验网格、计划与全部镜头

镜头时长只能用小节数表达：每个切点都是某个重拍的帧号，由同一个公式算出。
产物都在 ` +
    beat.Store +
    ` 下。`,
};

function readGridFile(root: string, file: string): beat.Grid {
  return beat.readDraft(file === '' ? path.join(root, beat.DraftFile) : file);
}

function reportDraft(out: Out, grid: beat.Grid): void {
  out.write(`草稿网格：${beat.summaryString(beat.summarize(grid))}\n`);
  for (const problem of beat.gridProblems(grid)) out.write(`问题：${problem}\n`);
  out.write(`请试听 ${beat.ClickFile}：每拍一声，重拍更高。重拍错位用 beat_regrid()，确认无误后 beat_confirm()\n`);
}

function printBars(out: Out, grid: beat.Grid): void {
  for (const bar of beat.gridBars(grid)) {
    out.write(
      `  第 ${String(bar.number).padStart(3)} 小节  ${formatFixed(bar.start_seconds, 3).padStart(8)} – ${formatFixed(bar.end_seconds, 3).padStart(8)} 秒  ${bar.beats} 拍\n`,
    );
  }
}

/** 登记卡点的全部操作。 */
export function beatOps(ctx: PluginContext): void {
  const analysisTimeout = timeout('30m', '分析');

  /** 分析超时与调用方的取消信号合在一起。 */
  function analysisSignal(params: ParamValues, parent: AbortSignal): AbortSignal {
    return withTimeoutSignal(parent, positiveDuration(params.timeout, 'timeout'));
  }

  /** 草稿网格的结构化摘要：拍数、小节、拍号与问题。 */
  function draftData(grid: beat.Grid): unknown {
    return { summary: beat.summarize(grid), problems: beat.gridProblems(grid), click: beat.ClickFile };
  }

  ctx.op({
    name: 'beat_init',
    cli: ['beat', 'init'],
    summary: '为项目写出 beat.yaml，不覆盖已有内容',
    description:
      '在项目根写出 ' +
      beat.ConfigFile +
      '，启用卡点模式。已有内容不同的 beat.yaml 时整体失败、不覆盖。项目里有 song.yaml 或 cast.yaml 时拒绝：卡点与歌曲、多角色对话的时间轴来源互斥。不安装 Python 或模型：节拍分析环境在客户端工具准备页的「音乐卡点」里安装，装在用户级目录，所有卡点项目共用。',
    examples: ['beat_init()'],
    params: { project_root: projectRoot },
    run: (p, { out }) => {
      const root = str(p.project_root);
      project.initializeWithFiles(root, { [beat.ConfigFile]: Buffer.from(beat.DefaultConfig) });
      beat.loadConfig(root);
      out.write(`已启用卡点模式。节拍分析环境在客户端工具准备页的「音乐卡点」里安装（所有卡点项目共用，只装一次）\n`);
    },
  });

  ctx.op({
    name: 'beat_doctor',
    cli: ['beat', 'doctor'],
    summary: '检查 beat-this 环境并预先下载模型权重',
    description:
      '加载固定版本 beat-this ' +
      beat.AnalyzerVersion +
      ' 的模型，确认分析能跑。beat.yaml 没写 python 时用客户端工具准备页（「音乐卡点」）装好的共享环境（没装好就报错，不在这里装）。' +
      '安装时已预下载默认的 ' +
      beat.DefaultCheckpoint +
      ' 权重；beat.yaml 换成别的 checkpoint 时，第一次运行会联网下载它。',
    examples: ['beat_doctor()'],
    params: { project_root: projectRoot, timeout: analysisTimeout },
    run: async (p, { out, signal }) => {
      await beat.doctor(str(p.project_root), currentEnvironment(), out, analysisSignal(p, signal));
    },
  });

  ctx.op({
    name: 'beat_import',
    cli: ['beat', 'import'],
    summary: '导入音乐，记录摘要与实测时长',
    description:
      '把音乐复制进 ' +
      beat.Store +
      '，完整解码一遍并记录 SHA-256 与时长。已导入另一首时默认拒绝：换歌会让网格与镜头全部失效，确认后加 "replace": true。授权来源记进素材账本，这里不判断授权。',
    examples: ['beat_import({"music": "~/Music/track.mp3"})', 'beat_import({"music": "new-cut.wav", "replace": true})'],
    params: {
      music: { type: 'string', description: '音乐文件', required: true, positional: 0 },
      replace: { type: 'boolean', description: '替换已导入的另一首音乐' },
      project_root: projectRoot,
    },
    run: (p, { out }) => {
      const media = newToolchain(currentEnvironment());
      const track = beat.importTrack(str(p.project_root), str(p.music), media, bool(p.replace));
      out.write(`已导入 ${track.source}（${formatFixed(track.duration_seconds, 3)} 秒）。下一步：beat_analyze()\n`);
      return { data: { source: track.source, duration_seconds: track.duration_seconds } };
    },
  });

  ctx.op({
    name: 'beat_analyze',
    cli: ['beat', 'analyze'],
    summary: '分析节拍，写出草稿网格与试听轨',
    description:
      '用 beat-this 分析普通拍与重拍，写出 ' +
      beat.DraftFile +
      ' 与 ' +
      beat.ClickFile +
      '。试听轨里每拍一声，重拍更高更响。草稿不会生效：必须让用户听完试听轨，再用 beat_confirm() 导入。',
    examples: ['beat_analyze()'],
    params: { project_root: projectRoot, timeout: analysisTimeout },
    run: async (p, { out, signal }) => {
      const root = str(p.project_root);
      const media = newToolchain(currentEnvironment());
      const grid = await beat.analyze(root, currentEnvironment(), media, out, analysisSignal(p, signal));
      reportDraft(out, grid);
      return { data: draftData(grid) };
    },
  });

  const gridParam = { type: 'string', description: '网格文件，缺省为 ' + beat.DraftFile, flag: 'grid' } as const;

  ctx.op({
    name: 'beat_regrid',
    cli: ['beat', 'regrid'],
    summary: '按固定拍号重排重拍，普通拍不变',
    description: `模型最常见的错误是重拍整体错位（把第 3 拍当成小节开头）或拍号判错，普通拍本身通常是对的。
  从第 anchor 拍（从 0 数）起每 meter 拍标一个重拍，写回草稿并重新生成试听轨。

    试听时重拍落在第 2 拍上（4/4）   beat_regrid({"meter": 4, "anchor": 1})
    模型判成 4 拍、实际是 3 拍        beat_regrid({"meter": 3, "anchor": 0})`,
    examples: ['beat_regrid({"meter": 4, "anchor": 1})'],
    params: {
      meter: { type: 'integer', description: '每小节拍数', default: 4 },
      anchor: { type: 'integer', description: '第一个重拍是第几拍（从 0 数）', default: 0 },
      grid: { ...gridParam, description: '要重排的网格文件，缺省为 ' + beat.DraftFile },
      project_root: projectRoot,
    },
    run: async (p, { out, signal }) => {
      const root = str(p.project_root);
      const grid = beat.regrid(readGridFile(root, str(p.grid)), num(p.meter), num(p.anchor));
      await beat.writeDraftAndClick(root, grid, newToolchain(currentEnvironment()), signal);
      reportDraft(out, grid);
      return { data: draftData(grid) };
    },
  });

  ctx.op({
    name: 'beat_click',
    cli: ['beat', 'click'],
    summary: '按网格文件重新生成试听轨',
    description: '手改过网格 JSON 后，用它重新生成 ' + beat.ClickFile + ' 再听一遍。',
    examples: ['beat_click()', 'beat_click({"grid": "my-grid.json"})'],
    params: { grid: gridParam, project_root: projectRoot },
    run: async (p, { out, signal }) => {
      const root = str(p.project_root);
      await beat.writeClick(root, readGridFile(root, str(p.grid)), newToolchain(currentEnvironment()), signal);
      out.write(`试听轨：${path.join(root, beat.ClickFile)}\n`);
      return { data: { click: path.join(root, beat.ClickFile) } };
    },
  });

  ctx.op({
    name: 'beat_confirm',
    cli: ['beat', 'confirm'],
    // 确认网格要用户本人听过：插件页面不能替他点。
    noPageCall: true,
    summary: '把试听确认过的网格导入为正式网格',
    description:
      '只在用户听完试听轨、确认每个重拍咔嗒都落在小节开头之后执行。正式网格写入 ' +
      beat.GridFile +
      '；之后再改网格，所有镜头 cue 失效，需重新 beat_cues() 并重渲染。',
    examples: ['beat_confirm()', 'beat_confirm({"grid": "my-grid.json"})'],
    params: { grid: gridParam, project_root: projectRoot },
    run: (p, { out }) => {
      const root = str(p.project_root);
      const grid = beat.confirm(root, readGridFile(root, str(p.grid)));
      out.write(`节拍网格已确认：${beat.summaryString(beat.summarize(grid))}\n`);
      printBars(out, grid);
      out.write(`下一步：按小节写 ${beat.PlanFile}，再 beat_cues({"scenes": "scenes/"})\n`);
      return { data: { summary: beat.summarize(grid), bars: beat.gridBars(grid) } };
    },
  });

  ctx.op({
    name: 'beat_bars',
    cli: ['beat', 'bars'],
    summary: '列出正式网格的每个小节',
    description:
      '写分镜计划前用它查每个小节的起止时间与拍数。第一个重拍之前的弱起并进第一个镜头，最后一小节延伸到音乐结束。',
    examples: ['beat_bars()'],
    params: { project_root: projectRoot },
    run: (p, { out }) => {
      const grid = beat.loadGrid(str(p.project_root));
      out.write(beat.summaryString(beat.summarize(grid)) + '\n');
      printBars(out, grid);
      return { data: { summary: beat.summarize(grid), bars: beat.gridBars(grid) } };
    },
  });

  ctx.op({
    name: 'beat_cues',
    cli: ['beat', 'cues'],
    summary: '按小节换算整数帧，写入各镜头时长与 beat 块',
    description:
      `读取正式网格与 ` +
      beat.PlanFile +
      `，按镜头目录字典序与计划逐一对应，
  把每个镜头的小节换算成整数帧：写入 scene.json 的 duration_seconds 与 beat 块，
  以及镜头目录里的 ` +
      beat.CueDataFile +
      `（镜头局部的每一拍：帧号、小节、拍序）。

  镜头 id 与顺序必须和计划完全一致；任何一处不合格都不写文件。改过网格或计划后
  重跑，确认要返修的镜头由 scene_run_all() 的 only_scenes 与 force 一起指定。`,
    examples: ['beat_cues({"scenes": "scenes/"})'],
    params: {
      scenes: { type: 'string', description: '镜头目录的上级目录', required: true, positional: 0 },
      project_root: projectRoot,
    },
    run: (p, { out }) => {
      const result = applyBeatCues(str(p.project_root), str(p.scenes));
      const anchorMsg = result.anchors ? `，同步写入 ${result.anchors.anchors.length} 个命名锚点` : '';
      out.write(`已写入 ${result.scenes} 个镜头的时长与节拍${anchorMsg}\n`);
      return {
        data: {
          scenes: result.scenes,
          ...(result.anchors ? { anchors: result.anchors.anchors.length, sfx_cues: result.anchors.sfx_cues } : {}),
        },
      };
    },
  });

  ctx.op({
    name: 'beat_av_backtest',
    cli: ['beat', 'av-backtest'],
    summary: '对成片执行逐锚点音画回测并输出 av-backtest.json',
    description:
      '逐锚点对源音乐瞬态与成片混音音轨做局部归一化互相关定位，解码成片 ROI 画面在计划帧 ±6 帧内计算相邻帧变化峰或亮度峰，评估画面-音乐与音效-音乐真实帧误差（默认容差 ±2 帧，可配置 0–3 帧）。当存在 ≥ 3 个可靠音乐匹配且偏移散布 < 15ms 时自动估算 measured_output_offset_seconds，报告落盘 av-backtest.json。',
    examples: [
      'beat_av_backtest()',
      'beat_av_backtest({"video": "production/audio/candidate.mp4", "tolerance_frames": 2, "out": "production/review/av-backtest.json"})',
    ],
    params: {
      video: {
        type: 'string',
        description: '要回测的成片视频路径，缺省为 production/audio/candidate.mp4',
        positional: 0,
      },
      source_music: { type: 'string', description: '源音乐文件路径，缺省从 track.json 读取' },
      anchors: { type: 'string', description: '锚点表 JSON 路径，缺省为 ' + beat.AnchorsFile },
      sfx_stem: { type: 'string', description: '可选独立 SFX 分轨（缺省存在 production/audio/sfx.wav 时自动使用）' },
      cue_sheet: { type: 'string', description: '可选 cue-sheet.json 路径（用于按 cue_id 匹配音效素材）' },
      out: { type: 'string', description: 'av-backtest.json 输出路径或目录，缺省写到视频同目录' },
      fps: { type: 'number', description: '帧率覆盖值；缺省从 frame.md 或视频流探测' },
      tolerance_frames: {
        type: 'integer',
        description: '音画误差容差（帧，0–3）',
        default: DefaultAVToleranceFrames,
      },
      window_frames: {
        type: 'integer',
        description: '画面峰值搜索窗口（±帧）',
        default: DefaultAVVisualWindowFrames,
      },
      strict: { type: 'boolean', description: 'verdict 非 pass 时以非零状态失败', default: false },
      project_root: projectRoot,
    },
    run: async (p, { out, signal }) => {
      const { report, reportPath } = await runBeatAVBacktest({
        root: str(p.project_root),
        video: str(p.video) || undefined,
        sourceMusic: str(p.source_music) || undefined,
        anchors: str(p.anchors) || undefined,
        sfxStem: str(p.sfx_stem) || undefined,
        cueSheet: str(p.cue_sheet) || undefined,
        out: str(p.out) || undefined,
        fps: num(p.fps) > 0 ? num(p.fps) : undefined,
        toleranceFrames: p.tolerance_frames !== undefined ? num(p.tolerance_frames) : DefaultAVToleranceFrames,
        windowFrames: p.window_frames !== undefined ? num(p.window_frames) : DefaultAVVisualWindowFrames,
        env: currentEnvironment(),
        signal,
      });
      out.write(formatAVBacktestSummary(report, reportPath));
      if (bool(p.strict) && report.verdict !== 'pass') {
        throw new Error(`成片音画回测未通过（verdict=${report.verdict}），详情见 ${reportPath}`);
      }
      return { data: { ...report, report_path: reportPath } };
    },
  });

  ctx.op({
    name: 'validate_beat',
    cli: ['validate', 'beat'],
    summary: '校验节拍网格、分镜计划与全部卡点镜头',
    description:
      '检查正式网格已人工确认且属于当前音乐；分镜计划的小节合计等于网格小节数；镜头目录与计划逐一对应；每个镜头的 beat 块、时长与局部节拍文件都与网格一致，切点全部落在重拍上。不通过时报错。',
    examples: ['validate_beat()'],
    params: {
      project_root: projectRoot,
      scenes: { type: 'string', description: '镜头目录，缺省为项目 scenes/' },
    },
    run: (p, { out }) => {
      const root = str(p.project_root);
      const dir = str(p.scenes) !== '' ? str(p.scenes) : path.join(root, 'scenes');
      const scenes = schedule.plan(dir);
      beatCoverage(root, scenes);
      out.write(`卡点校验通过：${scenes.length} 个镜头，切点全部落在重拍上\n`);
      return { data: { ok: true, scenes: scenes.length } };
    },
  });
}
