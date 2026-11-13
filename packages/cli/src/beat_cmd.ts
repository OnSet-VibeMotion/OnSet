/**
 * 无配音卡点模式的命令：导入音乐、分析并确认节拍网格、按小节写镜头 cue。
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
import { currentEnvironment, exactArgs } from './cli';
import { Command, Minute, NoArgs, type Duration, type Out, ref } from './cobra';
import { decodeRawMap, encodeRawMapIndent } from './rawjson';

/** context.WithTimeout：父信号与超时任一触发即取消。setTimeout 只认 2^31-1 毫秒以内，更长的超时等于不设。 */
export function withTimeoutSignal(parent: AbortSignal, timeout: Duration): AbortSignal {
  const ms = timeout / 1e6;
  if (ms > 2 ** 31 - 1) return parent;
  return AbortSignal.any([parent, AbortSignal.timeout(Math.max(1, Math.ceil(ms)))]);
}

export function newBeatCommand(stdout: Out): Command {
  const root = ref('.');
  const timeout = ref<Duration>(0);
  const cmd = new Command({
    use: 'beat',
    short: '无配音卡点：导入音乐、确认节拍网格、按小节切镜头',
    long:
      `卡点模式以项目根的 beat.yaml 启用，与口播、歌曲讲解、多角色对话互斥。

流程：
  am beat init                  写出 beat.yaml
  am beat doctor                检查 beat-this 环境，预先下载模型权重
  am beat import MUSIC          导入音乐（记录摘要与实测时长）
  am beat analyze               分析节拍，写出草稿网格与试听轨 grid-click.wav
  am beat regrid --meter 4 --anchor 1   重拍整体错位或拍号判错时重排重拍
  am beat confirm               试听确认后，把草稿导入为正式网格
  （按小节写 ` +
      beat.PlanFile +
      `）
  am beat cues scenes/          按小节换算整数帧，写入各镜头时长与 beat 块
  am validate beat              校验网格、计划与全部镜头

镜头时长只能用小节数表达：每个切点都是某个重拍的帧号，由同一个公式算出。
产物都在 ` +
      beat.Store +
      ` 下。`,
  });
  cmd.persistentFlags().stringVar(root, 'project-root', '.', '项目根目录');
  cmd.persistentFlags().durationVar(timeout, 'timeout', 30 * Minute, '分析的最长等待时间');
  const withTimeout = (parent: AbortSignal): AbortSignal => {
    if (timeout.value <= 0) throw new Error('--timeout 必须为正');
    return withTimeoutSignal(parent, timeout.value);
  };

  cmd.addCommand(
    new Command({
      use: 'init',
      short: '为项目写出 beat.yaml，不覆盖已有内容',
      args: NoArgs,
      long:
        '在项目根写出 ' +
        beat.ConfigFile +
        '，启用卡点模式。已有内容不同的 beat.yaml 时整体失败、不覆盖。项目里有 song.yaml 或 cast.yaml 时拒绝：卡点与歌曲、多角色对话的时间轴来源互斥。不安装 Python 或模型：节拍分析环境由 am setup --only beat 装在用户级目录，所有卡点项目共用。',
      example: '  am beat init --project-root .',
      runE: () => {
        project.initializeWithFiles(root.value, { [beat.ConfigFile]: Buffer.from(beat.DefaultConfig) });
        beat.loadConfig(root.value);
        stdout.write(`已启用卡点模式。节拍分析环境由 am setup --only beat 准备（所有卡点项目共用，只装一次）\n`);
      },
    }),
  );

  cmd.addCommand(
    new Command({
      use: 'doctor',
      short: '检查 beat-this 环境并预先下载模型权重',
      args: NoArgs,
      long:
        '加载固定版本 beat-this ' +
        beat.AnalyzerVersion +
        ' 的模型，确认分析能跑。beat.yaml 没写 python 时用 am setup --only beat 装好的共享环境（没装好就报错，不在这里装）。' +
        'am setup 已预下载默认的 ' +
        beat.DefaultCheckpoint +
        ' 权重；beat.yaml 换成别的 checkpoint 时，第一次运行本命令会联网下载它。',
      example: '  am setup --only beat\n  am beat doctor',
      runE: async (c) => {
        const signal = withTimeout(c.context());
        await beat.doctor(root.value, currentEnvironment(), stdout, signal);
      },
    }),
  );

  const replace = ref(false);
  const importCmd = new Command({
    use: 'import MUSIC',
    short: '导入音乐，记录摘要与实测时长',
    args: exactArgs(1, 'MUSIC'),
    long: '把音乐复制进 ' + beat.Store + '，完整解码一遍并记录 SHA-256 与时长。已导入另一首时默认拒绝：换歌会让网格与镜头全部失效，确认后加 --replace。授权来源记进素材账本，本命令不判断授权。',
    example: '  am beat import ~/Music/track.mp3\n  am beat import new-cut.wav --replace',
    runE: (_c, args) => {
      const media = newToolchain(currentEnvironment());
      const track = beat.importTrack(root.value, args[0], media, replace.value);
      stdout.write(`已导入 ${track.source}（${formatFixed(track.duration_seconds, 3)} 秒）。下一步：am beat analyze\n`);
    },
  });
  importCmd.flags().boolVar(replace, 'replace', false, '替换已导入的另一首音乐');
  cmd.addCommand(importCmd);

  cmd.addCommand(
    new Command({
      use: 'analyze',
      short: '分析节拍，写出草稿网格与试听轨',
      args: NoArgs,
      long: '用 beat-this 分析普通拍与重拍，写出 ' + beat.DraftFile + ' 与 ' + beat.ClickFile + '。试听轨里每拍一声，重拍更高更响。草稿不会生效：必须听完试听轨，再用 am beat confirm 导入。',
      example: '  am beat analyze',
      runE: async (c) => {
        const signal = withTimeout(c.context());
        const media = newToolchain(currentEnvironment());
        const grid = await beat.analyze(root.value, currentEnvironment(), media, stdout, signal);
        reportDraft(stdout, grid);
      },
    }),
  );

  const meter = ref(0);
  const anchor = ref(0);
  const from = ref('');
  const regrid = new Command({
    use: 'regrid',
    short: '按固定拍号重排重拍，普通拍不变',
    args: NoArgs,
    long: `模型最常见的错误是重拍整体错位（把第 3 拍当成小节开头）或拍号判错，普通拍本身通常是对的。
本命令从第 --anchor 拍（从 0 数）起每 --meter 拍标一个重拍，写回草稿并重新生成试听轨。

  试听时重拍落在第 2 拍上（4/4）   am beat regrid --meter 4 --anchor 1
  模型判成 4 拍、实际是 3 拍        am beat regrid --meter 3 --anchor 0`,
    example: '  am beat regrid --meter 4 --anchor 1',
    runE: async (c) => {
      const draft = readGridFile(root.value, from.value);
      const grid = beat.regrid(draft, meter.value, anchor.value);
      const media = newToolchain(currentEnvironment());
      await beat.writeDraftAndClick(root.value, grid, media, c.context());
      reportDraft(stdout, grid);
    },
  });
  regrid.flags().intVar(meter, 'meter', 4, '每小节拍数');
  regrid.flags().intVar(anchor, 'anchor', 0, '第一个重拍是第几拍（从 0 数）');
  regrid.flags().stringVar(from, 'grid', '', '要重排的网格文件，缺省为 ' + beat.DraftFile);
  cmd.addCommand(regrid);

  const clickFrom = ref('');
  const click = new Command({
    use: 'click',
    short: '按网格文件重新生成试听轨',
    args: NoArgs,
    long: '手改过网格 JSON 后，用它重新生成 ' + beat.ClickFile + ' 再听一遍。',
    example: '  am beat click\n  am beat click --grid my-grid.json',
    runE: async (c) => {
      const grid = readGridFile(root.value, clickFrom.value);
      const media = newToolchain(currentEnvironment());
      await beat.writeClick(root.value, grid, media, c.context());
      stdout.write(`试听轨：${path.join(root.value, beat.ClickFile)}\n`);
    },
  });
  click.flags().stringVar(clickFrom, 'grid', '', '网格文件，缺省为 ' + beat.DraftFile);
  cmd.addCommand(click);

  const confirmFrom = ref('');
  const confirm = new Command({
    use: 'confirm',
    short: '把试听确认过的网格导入为正式网格',
    args: NoArgs,
    long: '只在听完试听轨、确认每个重拍咔嗒都落在小节开头之后执行。正式网格写入 ' + beat.GridFile + '；之后再改网格，所有镜头 cue 失效，需重新 am beat cues 并重渲染。',
    example: '  am beat confirm\n  am beat confirm --grid my-grid.json',
    runE: () => {
      const draft = readGridFile(root.value, confirmFrom.value);
      const grid = beat.confirm(root.value, draft);
      stdout.write(`节拍网格已确认：${beat.summaryString(beat.summarize(grid))}\n`);
      printBars(stdout, grid);
      stdout.write(`下一步：按小节写 ${beat.PlanFile}，再 am beat cues scenes/\n`);
    },
  });
  confirm.flags().stringVar(confirmFrom, 'grid', '', '网格文件，缺省为 ' + beat.DraftFile);
  cmd.addCommand(confirm);

  cmd.addCommand(
    new Command({
      use: 'bars',
      short: '列出正式网格的每个小节',
      args: NoArgs,
      long: '写分镜计划前用它查每个小节的起止时间与拍数。第一个重拍之前的弱起并进第一个镜头，最后一小节延伸到音乐结束。',
      example: '  am beat bars',
      runE: () => {
        const grid = beat.loadGrid(root.value);
        stdout.write(beat.summaryString(beat.summarize(grid)) + '\n');
        printBars(stdout, grid);
      },
    }),
  );

  cmd.addCommand(
    new Command({
      use: 'cues SCENES',
      short: '按小节换算整数帧，写入各镜头时长与 beat 块',
      args: exactArgs(1, 'SCENES'),
      long:
        `读取正式网格与 ` +
        beat.PlanFile +
        `，按镜头目录字典序与计划逐一对应，
把每个镜头的小节换算成整数帧：写入 scene.json 的 duration_seconds 与 beat 块，
以及镜头目录里的 ` +
        beat.CueDataFile +
        `（镜头局部的每一拍：帧号、小节、拍序）。

镜头 id 与顺序必须和计划完全一致；任何一处不合格都不写文件。改过网格或计划后
重跑本命令，已渲染的镜头要 --force 重渲染。`,
      example: '  am beat cues scenes/',
      runE: (_c, args) => {
        const count = applyBeatCues(root.value, args[0]);
        stdout.write(`已写入 ${count} 个镜头的时长与节拍\n`);
      },
    }),
  );
  return cmd;
}

function readGridFile(root: string, file: string): beat.Grid {
  return beat.readDraft(file === '' ? path.join(root, beat.DraftFile) : file);
}

function reportDraft(out: Out, grid: beat.Grid): void {
  out.write(`草稿网格：${beat.summaryString(beat.summarize(grid))}\n`);
  for (const problem of beat.gridProblems(grid)) out.write(`问题：${problem}\n`);
  out.write(`请试听 ${beat.ClickFile}：每拍一声，重拍更高。重拍错位用 am beat regrid，确认无误后 am beat confirm\n`);
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
    if (s.song !== null || s.cast !== null) throw new Error(`卡点镜头 ${s.id} 不能带 song 或 cast 块`);
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
      throw new Error(`写入 ${ready[i].path} 失败，部分镜头可能仍是旧网格，请重跑 am beat cues：${(err as Error).message}`, { cause: err });
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
  if (problems.length > 0) throw new Error(`卡点镜头校验未通过，改过网格或计划后请重新 am beat cues：\n  - ${problems.join('\n  - ')}`);
}

export function newValidateBeatCommand(stdout: Out): Command {
  const root = ref('.');
  const scenesRoot = ref('');
  const cmd = new Command({
    use: 'beat',
    short: '校验节拍网格、分镜计划与全部卡点镜头',
    args: NoArgs,
    long: '检查正式网格已人工确认且属于当前音乐；分镜计划的小节合计等于网格小节数；镜头目录与计划逐一对应；每个镜头的 beat 块、时长与局部节拍文件都与网格一致，切点全部落在重拍上。失败退出 1。',
    example: '  am validate beat --project-root .',
    runE: () => {
      const dir = scenesRoot.value !== '' ? scenesRoot.value : path.join(root.value, 'scenes');
      const scenes = schedule.plan(dir);
      beatCoverage(root.value, scenes);
      stdout.write(`卡点校验通过：${scenes.length} 个镜头，切点全部落在重拍上\n`);
    },
  });
  cmd.flags().stringVar(root, 'project-root', '.', '项目根目录');
  cmd.flags().stringVar(scenesRoot, 'scenes', '', '镜头目录，缺省为项目 scenes/');
  return cmd;
}
