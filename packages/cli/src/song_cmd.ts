/**
 * 单人歌曲讲解的命令：生成或导入候选、试听选择、歌词对齐、镜头歌曲 cue 与合成。
 * 移植自 internal/cli/song.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '@am/engine/assets';
import { atomicWrite } from '@am/engine/fsutil';
import { goPathError } from '@am/engine/gofmt';
import { marshal, marshalIndent } from '@am/engine/gojson';
import { newToolchain } from '@am/engine/mediaprobe';
import * as project from '@am/engine/project';
import * as scene from '@am/engine/scene';
import type { Scene } from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import * as song from '@am/engine/song';
import { withTimeoutSignal } from './beat_cmd';
import { currentEnvironment } from './cli';
import { Command, ExactArgs, MaximumNArgs, Minute, NoArgs, type Duration, type Out, ref } from './cobra';
import { decodeRawMap, encodeRawMapIndent } from './rawjson';

export function songScaffold(root: string): void {
  if (fs.existsSync(path.join(root, 'cast.yaml'))) throw new Error('首版不支持 song + cast');
  const extra: Record<string, Uint8Array> = { 'song.yaml': Buffer.from(song.DefaultConfig) };
  const shared = assets.shared();
  const files = shared.walkFiles();
  for (const prefix of ['PROMPT-SONG.md', '.agents/skills/song-explainer']) {
    const matched = files.filter((file) => file === prefix || file.startsWith(prefix + '/'));
    if (matched.length === 0) throw new Error(`open ${prefix}: file does not exist`);
    for (const file of matched) extra[file] = shared.readFile(file);
  }
  project.initializeWithFiles(root, extra);
}

const songHelp: Record<string, string> = {
  handoff:
    '读取已创作的歌词及 song.yaml 曲风，输出可复制文本，并保存不可变快照及 production/song/web-handoff.json 等待记录。不调用 API，不需要 API Key、Python 或媒体工具。正常退出后必须暂停等待用户提供音频，不能将命令成功当成歌曲生成成功；同一会话或再次 am run 可继续。',
  'receive AUDIO':
    '根据当前网页交接记录导入用户提供的本机音频，使用交接时的歌词快照，更新接收状态；不自动选择、对齐或渲染。同一音频重跑复用候选，不同音频创建新候选。必须先询问网页是否改词；改词时请用 song import AUDIO --lyrics FINAL_LYRICS 显式导入核对后的最终歌词。',
  init: '在当前项目补充 song.yaml、PROMPT-SONG.md 和 song-explainer 技能；已有文件内容不同则整体失败，不改用户提示词，不安装 Python 或模型。cast.yaml 存在时拒绝。',
  doctor:
    '检查 song.yaml 选定服务、ffprobe/ffmpeg 和独立 Python 环境的 Xingyu 0.6.1。librosa 0.11.0 缺失只警告。MiniMax 检查 CLI 能力，不调用收费服务；ACE-Step 仅请求 /health；百炼、ElevenLabs、fal、Mureka、Lyria 仅检查密钥是否存在，不验证远端权限或产生费用。',
  generate:
    'manual 模式仅输出网页交接材料并暂停等待文件；其他平台默认两首，串行执行，完成后必须停下来给用户试听，不代选。相同配置、歌词与 batch 复用已有候选；ACE-Step 已保存任务 ID 可续轮询；无 ID 的不明提交拒绝重发。明确需要新候选时换 --batch。运行 am song providers 查看平台密钥配置。MiniMax 使用 mmx；其他平台从环境读取密钥。Mureka、fal 和 ACE-Step 已知任务可续轮询；百炼、ElevenLabs 与 Lyria 同步请求中断不自动重发。',
  'import AUDIO': '复制音频和核对过的歌词为新的不可变候选，实测时长并完整解码。歌词中的结构标签不作为字幕。导入不意味着选定，必须另行 select。',
  'select CANDIDATE': '仅在用户试听确定后执行。选定记录保存候选、歌词和音频摘要；变化会使旧时间轴和镜头失效。本命令不对齐或渲染。',
  prepare:
    '默认调用独立 Python 环境中的 Xingyu 0.6.1，再用 librosa 0.11.0 提取真实节拍；模型由用户独立安装。保留原始报告、行映射和问题清单。失败时修正 timeline-draft.json，通过 --timeline 导入；确认歌词、术语和句首误差后加 --reviewed 才能分镜渲染。估算字词不参与逐字同步。',
  'cues SCENES':
    '按镜头目录字典序累计整数帧时长，将全局歌词及节拍裁切为局部秒数。总长度必须为 ceil(实际歌曲秒数 × fps)，含前奏与尾奏。更新 scene.json 的 song 块和 song-cues.json；校验失败不写文件，成功后旧镜头需 --force 重渲染。',
  'mux SILENT-MASTER': '检查静音母版总帧数与歌曲时间轴一致，复制视频并加入完整歌曲。只允许末尾不足一帧的静音补齐，不变速、不叠 BGM、不做侧链。输出为 MP4 并执行完整解码与规格检查。',
};

const songExamples: Record<string, string> = {
  handoff: 'handoff',
  'receive AUDIO': 'receive /path/to/downloaded-song.mp3',
  init: 'init --project-root .',
  doctor: 'doctor',
  generate: 'generate --count 2 --batch first',
  'import AUDIO': 'import song.mp3 --lyrics lyrics.txt',
  'select CANDIDATE': 'select first-candidate',
  prepare: 'prepare\n  am song prepare --timeline production/song/timeline.json --reviewed',
  'cues SCENES': 'cues scenes/',
  'mux SILENT-MASTER': 'mux production/silent-master.mp4 --out final.mp4',
};

/** Go 的 %v 打印 []string：[a b c]。 */
function formatList(list: readonly string[]): string {
  return '[' + list.join(' ') + ']';
}

export function newSongCmd(out: Out): Command {
  const root = ref('.');
  const timeout = ref<Duration>(0);
  const cmd = new Command({ use: 'song', short: '单人歌曲讲解：生成、试听选择、歌词对齐与镜头节拍' });
  cmd.long =
    '歌曲讲解以 song.yaml 启用，与默认口播独立。先生成或导入候选，用户试听 select 后 prepare；核对时间轴再 cues、validate song 和渲染。运行 am song providers 查看平台与 API Key 申请入口，am song configure 选择平台。首版不支持 cast。所有产物保存在 production/song，密钥仅来自进程环境。';
  cmd.persistentFlags().stringVar(root, 'project-root', '.', '歌曲项目根目录');
  cmd.persistentFlags().durationVar(timeout, 'timeout', 30 * Minute, '生成/对齐的最长等待时间；ACE-Step/fal/Mureka 可续跑');
  const add = (use: string, short: string, n: number, fn: (signal: AbortSignal, args: string[]) => void | Promise<void>): Command => {
    const sub = new Command({
      use,
      short,
      args: ExactArgs(n),
      runE: async (c, a) => {
        if (timeout.value <= 0) throw new Error('--timeout 必须为正');
        await fn(withTimeoutSignal(c.context(), timeout.value), a);
      },
    });
    sub.long = short + '。\n\n' + songHelp[use];
    sub.example = '  am song ' + songExamples[use];
    cmd.addCommand(sub);
    return sub;
  };
  const providers = new Command({
    use: 'providers [PLATFORM]',
    short: '查看歌曲平台、申请入口和密钥配置步骤',
    long: '列出可用歌曲平台；可指定 bailian、elevenlabs、fal、minimax、acestep、mureka、lyria 或 manual 查看开通要求、环境变量和配置示例。只显示密钥是否设置，不读取展示其内容，不请求网络或生成歌曲，无需先初始化项目。',
    example: '  am song providers\n  am song providers bailian',
    args: MaximumNArgs(1),
    runE: (_c, args) => {
      song.platformGuide(out, args.length > 0 ? args[0] : '', currentEnvironment());
    },
  });
  cmd.addCommand(providers);
  const provider = ref('');
  const model = ref('');
  const workspace = ref('');
  const endpoint = ref('');
  const configure = new Command({
    use: 'configure',
    short: '选择歌曲平台并引导配置 API Key',
    long: '修改现有 song.yaml 的平台、模型及服务地址，保留歌词、曲风和其他设置；先运行 song init。切换平台清理旧 endpoint/workspace，默认采用新平台模型。密钥仅通过进程环境读取，本命令不收集、不保存密钥，不登录或调用收费 API。未设置密钥仍可保存平台设置，随后按输出步骤配置。',
    example:
      '  am song configure --provider bailian --workspace YOUR_WORKSPACE_ID\n  am song configure --provider elevenlabs\n  am song configure --provider fal\n  am song configure --provider mureka\n  am song configure --provider lyria',
    args: NoArgs,
    runE: () => {
      song.configure(root.value, provider.value, model.value, workspace.value, endpoint.value);
      out.write('已更新 song.yaml；原有候选保留，生成前请完成以下接入步骤。\n');
      song.platformGuide(out, provider.value, currentEnvironment());
    },
  });
  configure.flags().stringVar(provider, 'provider', '', '平台：bailian|elevenlabs|fal|minimax|acestep|mureka|lyria|manual（必填）');
  configure.flags().stringVar(model, 'model', '', '留空使用所选平台默认模型');
  configure.flags().stringVar(workspace, 'workspace', '', '百炼北京地域业务空间 ID（非密钥）');
  configure.flags().stringVar(endpoint, 'endpoint', '', '仅自建 ACE-Step 的 HTTP(S) 服务地址（不含密钥）');
  cmd.addCommand(configure);
  add('init', '为已有项目补充歌曲资产，不覆盖已有内容', 0, () => {
    songScaffold(root.value);
    out.write('歌曲资产已初始化。运行 am song providers 查看平台，再用 am song configure --provider PLATFORM 配置。\n');
  });
  const refreshHandoff = ref(false);
  const handoff = add('handoff', '输出网页生成用的歌词和风格，记录等待用户音频', 0, () => song.handoffWithRefresh(root.value, refreshHandoff.value, out));
  handoff.flags().boolVar(refreshHandoff, 'refresh', false, '明确用新版歌词/曲风替换待接收材料；用户需重新在网页生成');
  add('receive AUDIO', '接收网页生成音频，绑定交接时的歌词快照', 1, (_s, a) => {
    const m = newToolchain(currentEnvironment());
    const c = song.receive(root.value, a[0], m);
    out.write(`已接收候选 ${c.id}；请核对唱词并由用户确认后运行 am song select ${c.id}。尚未选定或对齐。\n`);
  });
  add('doctor', '检查服务、对齐环境与媒体工具', 0, (signal) => song.doctor(root.value, currentEnvironment(), out, signal));
  const count = ref(0);
  const batch = ref('');
  const gen = add('generate', '串行生成候选并停止，等待用户试听选择', 0, (signal) => song.generate(root.value, count.value, batch.value, currentEnvironment(), out, signal));
  gen.flags().intVar(count, 'count', 2, '候选数 1..8；相同请求复用候选');
  gen.flags().stringVar(batch, 'batch', 'default', '显式使用新批次标识才会重新生成');
  const lyrics = ref('');
  const imp = add('import AUDIO', '复制外部音频和歌词为候选', 1, (_s, a) => {
    if (lyrics.value === '') throw new Error('必须提供 --lyrics');
    const m = newToolchain(currentEnvironment());
    const c = song.importSong(root.value, a[0], lyrics.value, m);
    out.write(`已导入候选： ${c.id}\n`);
  });
  imp.flags().stringVar(lyrics, 'lyrics', '', '经核对的歌词文件');
  add('select CANDIDATE', '记录用户试听选定的歌曲及摘要', 1, (_s, a) => {
    song.select(root.value, a[0]);
    out.write(`已选定： ${a[0]}\n`);
  });
  const manual = ref('');
  const reviewed = ref(false);
  const prep = add('prepare', '对齐歌词、分析节拍，或导入修正时间轴', 0, async (signal) => {
    const canvas = scene.canvasOf(root.value, 'frame.md');
    await song.prepare(root.value, manual.value, reviewed.value, currentEnvironment(), out, signal);
    song.exportPhrases(root.value, canvas.fps);
  });
  prep.flags().stringVar(manual, 'timeline', '', '导入人工修正的统一时间轴 JSON');
  prep.flags().boolVar(reviewed, 'reviewed', false, '确认导入的时间轴已核对歌词、术语和句首时间');
  add('cues SCENES', '计算镜头局部歌词和节拍，绑定全局摘要', 1, (_s, a) => applySongCues(root.value, a[0], out));
  const output = ref('');
  const mux = add('mux SILENT-MASTER', '将完整歌曲与整数帧静音母版合成', 1, async (signal, a) => {
    if (output.value === '') throw new Error('必须提供 --out');
    const t = song.loadTimeline(root.value);
    if (!t.reviewed) throw new Error('时间轴尚未人工复核');
    const c = song.selected(root.value);
    let dir = '';
    try {
      dir = song.candidateDir(root.value, c.id);
    } catch {
      // Go 版忽略这里的错误。
    }
    const canvas = scene.canvasOf(root.value, 'frame.md');
    const m = newToolchain(currentEnvironment());
    const report = m.verify(a[0], { spec: { widthPx: canvas.widthPx, heightPx: canvas.heightPx } });
    if (!report.ok) throw new Error(`静音母版画幅不符：${formatList(report.problems ?? [])}`);
    const scenes = schedule.plan(path.join(root.value, 'scenes'));
    songCoverage(root.value, scenes, t, true);
    songOutputsCurrent(scenes, a[0]);
    await m.muxSong(a[0], path.join(dir, c.audio), output.value, t.duration_seconds, canvas.fps, signal);
  });
  mux.flags().stringVar(output, 'out', '', '成片输出路径（MP4）');
  return cmd;
}

export function songCoverage(root: string, scenes: readonly Scene[], t: song.Timeline, requireCues: boolean): void {
  const canvas = scene.canvasOf(root, 'frame.md');
  if (!t.reviewed) throw new Error('歌曲时间轴尚未人工复核；使用 prepare --timeline FILE --reviewed');
  const target = song.frames(t, canvas.fps) / canvas.fps;
  const p = schedule.coverageProblems(scenes, target, 1e-6);
  if (p.length > 0) throw new Error(`歌曲需从零覆盖前奏至尾奏：${formatList(p)}`);
  let cursor = 0;
  for (const s of scenes) {
    if (s.cast !== null) throw new Error('首版不支持 song + cast');
    scene.verifyFrameAlignment(s);
    if (requireCues) {
      if (s.song === null || s.song.fps !== canvas.fps || Math.abs(s.song.start_seconds - cursor) > 1e-6) {
        throw new Error(`镜头 ${s.id} 歌曲起点不一致，请运行 am song cues`);
      }
      const targetPath = path.resolve(path.join(root, song.Store, 'timeline.json'));
      const cuePath = path.resolve(path.join(s.directory, s.song.timeline));
      if (targetPath !== cuePath) throw new Error(`镜头 ${s.id} 引用了其他项目歌曲`);
      song.verifyCue(s.directory, s.song, s.duration_seconds);
    }
    cursor += s.duration_seconds;
  }
}

/** 写出 MarshalIndent 加换行的原文；内容不变时不碰文件（与 song.WriteJSON 相同）。 */
function writeText(file: string, text: string): void {
  const b = Buffer.from(text);
  try {
    if (fs.readFileSync(file).equals(b)) return;
  } catch {
    // 不存在或读不了：照常写。
  }
  atomicWrite(file, b, 0o644);
}

export function applySongCues(root: string, scenesRoot: string, out: Out): void {
  const t = song.loadTimeline(root);
  const scenes = schedule.plan(scenesRoot);
  songCoverage(root, scenes, t, false);
  const timeline = path.resolve(path.join(root, song.Store, 'timeline.json'));
  const sha = song.hashFile(timeline);
  const canvas = scene.canvasOf(root, 'frame.md');
  const updates: { path: string; body: string }[] = [];
  let cursor = 0;
  for (const s of scenes) {
    const dir = path.resolve(s.directory);
    const rel = path.relative(dir, timeline);
    const data = song.slice(t, cursor, s.duration_seconds);
    const encoded = marshalIndent(song.timelineToJSON(data)) + '\n';
    // Compute the exact file digest before mutating any scene.
    const dataSHA = song.bytesHash(encoded);
    const cue: song.Cue = { fps: canvas.fps, timeline: rel, sha256: sha, start_seconds: cursor, data: 'song-cues.json', data_sha256: dataSHA };
    const sceneFile = song.localPath(dir, 'scene.json');
    const cueFile = song.localPath(dir, cue.data);
    let raw: string;
    try {
      raw = fs.readFileSync(sceneFile, 'utf8');
    } catch (err) {
      throw new Error(goPathError('open', sceneFile, err), { cause: err });
    }
    const fields = decodeRawMap(raw);
    fields.set('song', marshal(song.cueToJSON(cue)));
    updates.push({ path: cueFile, body: encoded }, { path: sceneFile, body: encodeRawMapIndent(fields) + '\n' });
    cursor += s.duration_seconds;
  }
  for (const u of updates) writeText(u.path, u.body);
  out.write(`已更新 ${scenes.length} 个镜头的歌曲依赖\n`);
}

export function newValidateSongCommand(out: Out): Command {
  const root = ref('.');
  const scenesRoot = ref('');
  const cmd = new Command({
    use: 'song',
    short: '校验歌曲选择、歌词、时间轴和镜头覆盖',
    args: NoArgs,
    runE: () => {
      const t = song.loadTimeline(root.value);
      if (!t.reviewed) throw new Error('时间轴尚未人工复核');
      const dir = scenesRoot.value !== '' ? scenesRoot.value : path.join(root.value, 'scenes');
      const scenes = schedule.plan(dir);
      songCoverage(root.value, scenes, t, true);
      out.write('歌曲与镜头时间轴校验通过\n');
    },
  });
  cmd.long =
    '检查已选歌曲和歌词摘要、已人工复核的统一时间轴，以及所有镜头从零至尾奏的整数帧覆盖。检查每镜头局部歌词和全局摘要；发现过期依赖时必须重跑 song cues 并重渲染。失败退出 1。';
  cmd.example = '  am validate song --project-root .';
  cmd.flags().stringVar(root, 'project-root', '.', '项目根目录');
  cmd.flags().stringVar(scenesRoot, 'scenes', '', '镜头目录，默认项目 scenes/');
  return cmd;
}

function statNs(file: string): bigint {
  try {
    return fs.statSync(file, { bigint: true }).mtimeNs;
  } catch (err) {
    throw new Error(goPathError('stat', file, err), { cause: err });
  }
}

/**
 * Reject stale song renders even if callers bypass run-all and go straight to
 * concat/mux. The existing renderer's file timestamps define artifact freshness.
 */
export function songOutputsCurrent(scenes: readonly Scene[], master: string): void {
  const masterTime = master !== '' ? statNs(master) : null;
  for (const s of scenes) {
    if (s.song === null) continue;
    scene.verifySongInputs(s);
    const output = statNs(scene.outputPath(s));
    for (const name of ['scene.json', 'prompt.md', s.song.data]) {
      const file = path.join(s.directory, name);
      if (name === 'prompt.md' && !fs.existsSync(file)) continue;
      if (statNs(file) > output) throw new Error(`歌曲镜头 ${s.id} 已过期，需要 --force 重渲染`);
    }
    if (masterTime !== null && output > masterTime) throw new Error(`静音母版早于镜头 ${s.id}，需要重新 concat`);
  }
}
