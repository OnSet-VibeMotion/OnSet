/**
 * 无配音卡点模式的操作：导入音乐、分析并确认节拍网格、按小节写镜头 cue。
 * 移植自 internal/cli/beat.go。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '@am/engine/beat';
import { formatFixed, goPathError, goQuote } from '@am/engine/gofmt';
import { marshal } from '@am/engine/gojson';
import { newToolchain } from '@am/engine/mediaprobe';
import * as project from '@am/engine/project';
import * as scene from '@am/engine/scene';
import type { Scene } from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import { currentEnvironment } from './cli';
import { type Out } from './cobra';
import { defineGroup } from './ops/cli';
import { bool, num, positiveDuration, projectRoot, str, timeout } from './ops/common';
import { defineOp, type ParamValues } from './ops/op';
import { decodeRawMap, encodeRawMapIndent } from '@am/engine/rawjson';

export { withTimeoutSignal } from './ops/common';
import { withTimeoutSignal } from './ops/common';

defineGroup({
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
});

const analysisTimeout = timeout('30m', '分析');

/** 分析超时与调用方的取消信号合在一起。 */
function analysisSignal(params: ParamValues, parent: AbortSignal): AbortSignal {
  return withTimeoutSignal(parent, positiveDuration(params.timeout, 'timeout'));
}

/** 草稿网格的结构化摘要：拍数、小节、拍号与问题。 */
function draftData(grid: beat.Grid): unknown {
  return { summary: beat.summarize(grid), problems: beat.gridProblems(grid), click: beat.ClickFile };
}

defineOp({
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

defineOp({
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

defineOp({
  name: 'beat_import',
  cli: ['beat', 'import'],
  summary: '导入音乐，记录摘要与实测时长',
  description: '把音乐复制进 ' + beat.Store + '，完整解码一遍并记录 SHA-256 与时长。已导入另一首时默认拒绝：换歌会让网格与镜头全部失效，确认后加 "replace": true。授权来源记进素材账本，这里不判断授权。',
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

defineOp({
  name: 'beat_analyze',
  cli: ['beat', 'analyze'],
  summary: '分析节拍，写出草稿网格与试听轨',
  description: '用 beat-this 分析普通拍与重拍，写出 ' + beat.DraftFile + ' 与 ' + beat.ClickFile + '。试听轨里每拍一声，重拍更高更响。草稿不会生效：必须让用户听完试听轨，再用 beat_confirm() 导入。',
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

defineOp({
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

defineOp({
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

defineOp({
  name: 'beat_confirm',
  cli: ['beat', 'confirm'],
  summary: '把试听确认过的网格导入为正式网格',
  description: '只在用户听完试听轨、确认每个重拍咔嗒都落在小节开头之后执行。正式网格写入 ' + beat.GridFile + '；之后再改网格，所有镜头 cue 失效，需重新 beat_cues() 并重渲染。',
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

defineOp({
  name: 'beat_bars',
  cli: ['beat', 'bars'],
  summary: '列出正式网格的每个小节',
  description: '写分镜计划前用它查每个小节的起止时间与拍数。第一个重拍之前的弱起并进第一个镜头，最后一小节延伸到音乐结束。',
  examples: ['beat_bars()'],
  params: { project_root: projectRoot },
  run: (p, { out }) => {
    const grid = beat.loadGrid(str(p.project_root));
    out.write(beat.summaryString(beat.summarize(grid)) + '\n');
    printBars(out, grid);
    return { data: { summary: beat.summarize(grid), bars: beat.gridBars(grid) } };
  },
});

defineOp({
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
重跑，已渲染的镜头要 "force": true 重渲染。`,
  examples: ['beat_cues({"scenes": "scenes/"})'],
  params: {
    scenes: { type: 'string', description: '镜头目录的上级目录', required: true, positional: 0 },
    project_root: projectRoot,
  },
  run: (p, { out }) => {
    const count = applyBeatCues(str(p.project_root), str(p.scenes));
    out.write(`已写入 ${count} 个镜头的时长与节拍\n`);
    return { data: { scenes: count } };
  },
});

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
    out.write(`  第 ${String(bar.number).padStart(3)} 小节  ${formatFixed(bar.start_seconds, 3).padStart(8)} – ${formatFixed(bar.end_seconds, 3).padStart(8)} 秒  ${bar.beats} 拍\n`);
  }
}

/** beatLayout 对齐分镜计划与镜头目录，返回每个镜头的帧区间。 */
function beatLayout(root: string, scenes: readonly Scene[]): { grid: beat.Grid; segments: beat.Segment[]; fps: number } {
  const grid = beat.loadGrid(root);
  const plan = beat.loadPlan(root);
  const canvas = scene.canvasOf(root, 'frame.md');
  const segments = beat.layout(grid, plan, canvas.fps);
  if (segments.length !== scenes.length) throw new Error(`${beat.PlanFile} 有 ${segments.length} 个镜头，镜头目录有 ${scenes.length} 个`);
  const mismatched: string[] = [];
  scenes.forEach((s, i) => {
    if (s.id !== segments[i].id) mismatched.push(`第 ${i + 1} 个：计划 ${segments[i].id}，目录 ${s.id}`);
    const others = scene.sceneBlocks().filter((b) => b.key !== 'beat' && scene.blockValue(s, b.key) !== null);
    if (others.length > 0) throw new Error(`卡点镜头 ${s.id} 不能带 ${others.map((b) => b.key).join('、')} 块`);
  });
  if (mismatched.length > 0) throw new Error(`镜头顺序与 ${beat.PlanFile} 不一致（目录按字典序）：${mismatched.join('；')}`);
  return { grid, segments, fps: canvas.fps };
}

interface PendingWrite {
  path: string;
  body: Buffer;
}

function applyBeatCues(root: string, scenesRoot: string): number {
  const scenes = schedule.plan(scenesRoot);
  const { grid, segments, fps } = beatLayout(root, scenes);
  const absRoot = path.resolve(root);
  const gridSHA = beat.gridSHA(root);
  const writes: PendingWrite[] = [];
  scenes.forEach((s, i) => {
    // 镜头目录向上找到的项目根必须就是本次的 --project-root，否则写出的
    // 引用在渲染时会指向另一个项目的网格。
    let found = '';
    let failed = false;
    try {
      found = beat.findRoot(s.directory);
    } catch {
      failed = true;
    }
    if (failed || found !== absRoot) {
      throw new Error(`镜头 ${s.id} 不在项目 ${absRoot} 之内（向上找到的 ${beat.ConfigFile} 根是 ${goQuote(found)}）`);
    }
    const gridRef = beat.gridRef(s.directory, absRoot);
    const segment = segments[i];
    const { body: data, sha256: dataSHA } = beat.encodeLocal(beat.sliceGrid(grid, segment, fps));
    const cue: beat.Cue = {
      scene: s.id,
      first_bar: segment.firstBar,
      bars: segment.bars,
      fps,
      grid: gridRef,
      sha256: gridSHA,
      start_frame: segment.startFrame,
      frames: segment.frames,
      data: beat.CueDataFile,
      data_sha256: dataSHA,
    };
    const sceneFile = path.join(s.directory, 'scene.json');
    let raw: string;
    try {
      raw = fs.readFileSync(sceneFile, 'utf8');
    } catch (err) {
      throw new Error(goPathError('open', sceneFile, err), { cause: err });
    }
    let fields: Map<string, string>;
    try {
      fields = decodeRawMap(raw);
    } catch (err) {
      throw new Error(`${sceneFile} 不是合法 JSON：${(err as Error).message}`, { cause: err });
    }
    fields.set('beat', marshal(beat.cueToJSON(cue)));
    fields.set('duration_seconds', marshal(segment.frames / fps));
    const body = encodeRawMapIndent(fields);
    writes.push({ path: path.join(s.directory, beat.CueDataFile), body: data }, { path: sceneFile, body: Buffer.from(body + '\n') });
  });
  commitWrites(writes);
  return scenes.length;
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
function commitWrites(writes: readonly PendingWrite[]): void {
  const ready: { temp: string; path: string }[] = [];
  const cleanup = () => {
    for (const s of ready) fs.rmSync(s.temp, { force: true });
  };
  for (const w of writes) {
    try {
      if (fs.readFileSync(w.path).equals(w.body)) continue;
    } catch {
      // 不存在：照常写。
    }
    const temp = path.join(path.dirname(w.path), '.' + path.basename(w.path) + '.' + crypto.randomInt(1e9));
    try {
      fs.writeFileSync(temp, w.body, { flag: 'wx', mode: 0o600 });
      fs.chmodSync(temp, 0o644);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      cleanup();
      throw new Error(goPathError('open', temp, err), { cause: err });
    }
    ready.push({ temp, path: w.path });
  }
  for (let i = 0; i < ready.length; i++) {
    try {
      fs.renameSync(ready[i].temp, ready[i].path);
    } catch (err) {
      for (const rest of ready.slice(i)) fs.rmSync(rest.temp, { force: true });
      throw new Error(`写入 ${ready[i].path} 失败，部分镜头可能仍是旧网格，请重跑 beat_cues()：${(err as Error).message}`, { cause: err });
    }
  }
}

/** beatCoverage 校验全部镜头都带着与网格、计划一致的 beat 块，且首尾相接覆盖整首音乐。 */
export function beatCoverage(root: string, scenes: readonly Scene[]): void {
  const { segments } = beatLayout(root, scenes);
  const problems: string[] = [];
  scenes.forEach((s, i) => {
    const segment = segments[i];
    if (s.beat === null) {
      problems.push(`${s.id} 缺少 beat 块`);
      return;
    }
    if (s.beat.start_frame !== segment.startFrame || s.beat.frames !== segment.frames) {
      problems.push(`${s.id} 的帧区间与计划不符：beat 块 ${s.beat.start_frame}+${s.beat.frames}，计划 ${segment.startFrame}+${segment.frames}`);
      return;
    }
    try {
      scene.verifyBeatInputs(s);
    } catch (err) {
      problems.push(`${s.id}：${(err as Error).message}`);
    }
  });
  if (problems.length > 0) throw new Error(`卡点镜头校验未通过，改过网格或计划后请重新 beat_cues()：\n  - ${problems.join('\n  - ')}`);
}

defineOp({
  name: 'validate_beat',
  cli: ['validate', 'beat'],
  summary: '校验节拍网格、分镜计划与全部卡点镜头',
  description: '检查正式网格已人工确认且属于当前音乐；分镜计划的小节合计等于网格小节数；镜头目录与计划逐一对应；每个镜头的 beat 块、时长与局部节拍文件都与网格一致，切点全部落在重拍上。不通过时报错。',
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
