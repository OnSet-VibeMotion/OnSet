/**
 * 单人歌曲讲解的操作：生成或导入候选、试听选择、歌词对齐、镜头歌曲 cue 与合成。由歌曲讲解插件在 apply 里登记
 * （songOps），cli 的操作表经 plugin_ops.ts 照旧 defineOp。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '../../assets';
import { envMap } from '../../envutil';
import { atomicWrite } from '../../fsutil';
import { flowRecord, recordFlow } from '../../flow/lock';
import { goPathError } from '../../gofmt';
import { marshal, marshalIndent } from '../../gojson';
import { newToolchain } from '../../mediaprobe';
import { bool, num, positiveDuration, projectRoot, str, timeout, withTimeoutSignal } from '../../opkit';
import type { PluginContext, PluginOpContext, PluginParamSpec } from '../../plugin/types';
import * as project from '../../project';
import { decodeRawMap, encodeRawMapIndent } from '../../rawjson';
import * as scene from '../../scene';
import type { Scene } from '../../scene';
import * as schedule from '../../schedule';
import * as song from '../../song';
import { verifySongInputs } from './block';

type Out = { write(text: string): void };
type OpResult = { data?: unknown };
type ParamValues = Record<string, unknown>;
const currentEnvironment = (): Record<string, string> => envMap();

export function songScaffold(root: string): void {
  if (fs.existsSync(path.join(root, 'cast.yaml'))) throw new Error('首版不支持 song + cast');
  const extra: Record<string, Uint8Array> = {
    'song.yaml': Buffer.from(song.DefaultConfig),
  };
  const shared = assets.shared();
  const files = shared.walkFiles();
  for (const prefix of ['.agents/skills/song-explainer']) {
    const matched = files.filter((file) => file === prefix || file.startsWith(prefix + '/'));
    if (matched.length === 0) throw new Error(`open ${prefix}: file does not exist`);
    for (const file of matched) extra[file] = shared.readFile(file);
  }
  project.initializeWithFiles(root, extra);
  // 项目用哪个流程只看锁文件的记录：补了歌曲资产就把记录换成歌曲讲解（画幅不变），制作提示词随之按歌曲讲解组合。
  const rec = flowRecord(root);
  if (rec && rec.id !== 'song') recordFlow(root, { id: 'song', canvas: rec.canvas });
}

/** Go 的 %v 打印 []string：[a b c]。 */
function formatList(list: readonly string[]): string {
  return '[' + list.join(' ') + ']';
}

export function songCoverage(root: string, scenes: readonly Scene[], t: song.Timeline, requireCues: boolean): void {
  const canvas = scene.canvasOf(root, 'frame.md');
  if (!t.reviewed) throw new Error('歌曲时间轴尚未人工复核；使用 song_prepare({"timeline": "<文件>", "reviewed": true})');
  const target = song.frames(t, canvas.fps) / canvas.fps;
  const p = schedule.coverageProblems(scenes, target, 1e-6);
  if (p.length > 0) throw new Error(`歌曲需从零覆盖前奏至尾奏：${formatList(p)}`);
  let cursor = 0;
  for (const s of scenes) {
    if (s.cast !== null) throw new Error('首版不支持 song + cast');
    scene.verifyFrameAlignment(s);
    if (requireCues) {
      if (s.song === null || s.song.fps !== canvas.fps || Math.abs(s.song.start_seconds - cursor) > 1e-6) {
        throw new Error(`镜头 ${s.id} 歌曲起点不一致，请运行 song_cues()`);
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
    const cue: song.Cue = {
      fps: canvas.fps,
      timeline: rel,
      sha256: sha,
      start_seconds: cursor,
      data: 'song-cues.json',
      data_sha256: dataSHA,
    };
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

export function songOps(ctx: PluginContext): void {
  ctx.opGroup({
    path: ['song'],
    summary: '单人歌曲讲解：生成、试听选择、歌词对齐与镜头节拍',
    description:
      '歌曲讲解以 song.yaml 启用，与默认口播独立。先生成或导入候选，用户试听 song_select() 后 song_prepare()；核对时间轴再 song_cues()、validate_song() 和渲染。song_providers() 查看平台与 API Key 申请入口，song_configure() 选择平台。首版不支持 cast。所有产物保存在 production/song，密钥仅来自进程环境。',
  });

  const songRoot = { ...projectRoot, description: '歌曲项目根目录' };
  const songTimeout = timeout('30m', '生成/对齐（ACE-Step/fal/Mureka 可续跑）');

  /** 带超时的歌曲操作：project_root 与 timeout 两个参数，超时与调用方的取消合在一起。 */
  function songOp(def: {
    name: string;
    cli: string;
    summary: string;
    help: string;
    examples: string[];
    params?: Record<string, PluginParamSpec>;
    run: (p: ParamValues, ctx: PluginOpContext, signal: AbortSignal, root: string) => void | OpResult | Promise<void | OpResult>;
  }): void {
    ctx.op({
      name: def.name,
      cli: ['song', def.cli],
      summary: def.summary,
      description: def.summary + '。\n\n' + def.help,
      examples: def.examples,
      params: {
        ...(def.params ?? {}),
        project_root: songRoot,
        timeout: songTimeout,
      },
      run: (p, ctx) => def.run(p, ctx, withTimeoutSignal(ctx.signal, positiveDuration(p.timeout, 'timeout')), str(p.project_root)),
    });
  }

  ctx.op({
    name: 'song_providers',
    cli: ['song', 'providers'],
    summary: '查看歌曲平台、申请入口和密钥配置步骤',
    description:
      '列出可用歌曲平台；platform 可指定 bailian、elevenlabs、fal、minimax、acestep、mureka、lyria 或 manual 查看开通要求、环境变量和配置示例。只显示密钥是否设置，不读取展示其内容，不请求网络或生成歌曲，无需先初始化项目。',
    examples: ['song_providers()', 'song_providers({"platform": "bailian"})'],
    params: {
      platform: {
        type: 'string',
        description: '只看这一个平台',
        positional: 0,
      },
    },
    run: (p, { out }) => {
      song.platformGuide(out, str(p.platform), currentEnvironment());
    },
  });

  ctx.op({
    name: 'song_configure',
    cli: ['song', 'configure'],
    summary: '选择歌曲平台并引导配置 API Key',
    description:
      '修改现有 song.yaml 的平台、模型及服务地址，保留歌词、曲风和其他设置；先运行 song_init()。切换平台清理旧 endpoint/workspace，默认采用新平台模型。密钥仅通过进程环境读取，这里不收集、不保存密钥，不登录或调用收费 API。未设置密钥仍可保存平台设置，随后按输出步骤配置。',
    examples: [
      'song_configure({"provider": "bailian", "workspace": "YOUR_WORKSPACE_ID"})',
      'song_configure({"provider": "elevenlabs"})',
      'song_configure({"provider": "fal"})',
      'song_configure({"provider": "mureka"})',
      'song_configure({"provider": "lyria"})',
    ],
    params: {
      provider: {
        type: 'string',
        description: '平台：bailian|elevenlabs|fal|minimax|acestep|mureka|lyria|manual（必填）',
      },
      model: { type: 'string', description: '留空使用所选平台默认模型' },
      workspace: {
        type: 'string',
        description: '百炼北京地域业务空间 ID（非密钥）',
      },
      endpoint: {
        type: 'string',
        description: '仅自建 ACE-Step 的 HTTP(S) 服务地址（不含密钥）',
      },
      project_root: songRoot,
    },
    run: (p, { out }) => {
      song.configure(str(p.project_root), str(p.provider), str(p.model), str(p.workspace), str(p.endpoint));
      out.write('已更新 song.yaml；原有候选保留，生成前请完成以下接入步骤。\n');
      song.platformGuide(out, str(p.provider), currentEnvironment());
    },
  });

  songOp({
    name: 'song_init',
    cli: 'init',
    summary: '为已有项目补充歌曲资产，不覆盖已有内容',
    help: '在当前项目补充 song.yaml 和 song-explainer 技能，并把项目的流程记录换成歌曲讲解（制作提示词随之按歌曲讲解组合）；已有文件内容不同则整体失败，不安装 Python 或模型。cast.yaml 存在时拒绝。',
    examples: ['song_init()'],
    run: (_p, { out }, _signal, root) => {
      songScaffold(root);
      out.write('歌曲资产已初始化。运行 song_providers() 查看平台，再用 song_configure({"provider": "PLATFORM"}) 配置。\n');
    },
  });

  songOp({
    name: 'song_handoff',
    cli: 'handoff',
    summary: '输出网页生成用的歌词和风格，记录等待用户音频',
    help: '读取已创作的歌词及 song.yaml 曲风，输出可复制文本，并保存不可变快照及 production/song/web-handoff.json 等待记录。不调用 API，不需要 API Key、Python 或媒体工具。正常结束后必须暂停等待用户提供音频，不能将操作成功当成歌曲生成成功；同一会话或新的一轮对话都可以接着做。',
    examples: ['song_handoff()'],
    params: {
      refresh: {
        type: 'boolean',
        description: '明确用新版歌词/曲风替换待接收材料；用户需重新在网页生成',
      },
    },
    run: (p, { out }, _signal, root) => {
      song.handoffWithRefresh(root, bool(p.refresh), out);
    },
  });

  songOp({
    name: 'song_receive',
    cli: 'receive',
    summary: '接收网页生成音频，绑定交接时的歌词快照',
    help: '根据当前网页交接记录导入用户提供的本机音频，使用交接时的歌词快照，更新接收状态；不自动选择、对齐或渲染。同一音频重跑复用候选，不同音频创建新候选。必须先询问网页是否改词；改词时请用 song_import({"audio": "<音频>", "lyrics": "<最终歌词>"}) 显式导入核对后的最终歌词。',
    examples: ['song_receive({"audio": "/path/to/downloaded-song.mp3"})'],
    params: {
      audio: {
        type: 'string',
        description: '用户提供的音频文件',
        required: true,
        positional: 0,
      },
    },
    run: (p, { out }, _signal, root) => {
      const c = song.receive(root, str(p.audio), newToolchain(currentEnvironment()));
      out.write(`已接收候选 ${c.id}；请核对唱词并由用户确认后运行 song_select({"candidate": "${c.id}"})。尚未选定或对齐。\n`);
      return { data: { candidate: c.id } };
    },
  });

  songOp({
    name: 'song_doctor',
    cli: 'doctor',
    summary: '检查服务、对齐环境与媒体工具',
    help: '检查 song.yaml 选定服务、ffprobe/ffmpeg 和独立 Python 环境的 Xingyu 0.6.1。librosa 0.11.0 缺失只警告。MiniMax 检查 CLI 能力，不调用收费服务；ACE-Step 仅请求 /health；百炼、ElevenLabs、fal、Mureka、Lyria 仅检查密钥是否存在，不验证远端权限或产生费用。',
    examples: ['song_doctor()'],
    run: (_p, { out }, signal, root) => song.doctor(root, currentEnvironment(), out, signal),
  });

  songOp({
    name: 'song_generate',
    cli: 'generate',
    summary: '串行生成候选并停止，等待用户试听选择',
    help: 'manual 模式仅输出网页交接材料并暂停等待文件；其他平台默认两首，串行执行，完成后必须停下来给用户试听，不代选。相同配置、歌词与 batch 复用已有候选；ACE-Step 已保存任务 ID 可续轮询；无 ID 的不明提交拒绝重发。明确需要新候选时换 batch。song_providers() 查看平台密钥配置。MiniMax 使用 mmx；其他平台从环境读取密钥。Mureka、fal 和 ACE-Step 已知任务可续轮询；百炼、ElevenLabs 与 Lyria 同步请求中断不自动重发。',
    examples: ['song_generate({"count": 2, "batch": "first"})'],
    params: {
      count: {
        type: 'integer',
        description: '候选数 1..8；相同请求复用候选',
        default: 2,
      },
      batch: {
        type: 'string',
        description: '显式使用新批次标识才会重新生成',
        default: 'default',
      },
    },
    run: (p, { out }, signal, root) => song.generate(root, num(p.count), str(p.batch), currentEnvironment(), out, signal),
  });

  songOp({
    name: 'song_import',
    cli: 'import',
    summary: '复制外部音频和歌词为候选',
    help: '复制音频和核对过的歌词为新的不可变候选，实测时长并完整解码。歌词中的结构标签不作为字幕。导入不意味着选定，必须另行 song_select()。',
    examples: ['song_import({"audio": "song.mp3", "lyrics": "lyrics.txt"})'],
    params: {
      audio: {
        type: 'string',
        description: '音频文件',
        required: true,
        positional: 0,
      },
      lyrics: { type: 'string', description: '经核对的歌词文件' },
    },
    run: (p, { out }, _signal, root) => {
      if (str(p.lyrics) === '') throw new Error('必须提供 lyrics');
      const c = song.importSong(root, str(p.audio), str(p.lyrics), newToolchain(currentEnvironment()));
      out.write(`已导入候选： ${c.id}\n`);
      return { data: { candidate: c.id } };
    },
  });

  songOp({
    name: 'song_select',
    cli: 'select',
    summary: '记录用户试听选定的歌曲及摘要',
    help: '仅在用户试听确定后执行。选定记录保存候选、歌词和音频摘要；变化会使旧时间轴和镜头失效。这里不对齐或渲染。',
    examples: ['song_select({"candidate": "first-candidate"})'],
    params: {
      candidate: {
        type: 'string',
        description: '候选编号',
        required: true,
        positional: 0,
      },
    },
    run: (p, { out }, _signal, root) => {
      song.select(root, str(p.candidate));
      out.write(`已选定： ${str(p.candidate)}\n`);
    },
  });

  songOp({
    name: 'song_prepare',
    cli: 'prepare',
    summary: '对齐歌词、分析节拍，或导入修正时间轴',
    help: '默认调用独立 Python 环境中的 Xingyu 0.6.1，再用 librosa 0.11.0 提取真实节拍；模型由用户独立安装。保留原始报告、行映射和问题清单。失败时修正 timeline-draft.json，通过 timeline 导入；确认歌词、术语和句首误差后加 "reviewed": true 才能分镜渲染。估算字词不参与逐字同步。',
    examples: ['song_prepare()', 'song_prepare({"timeline": "production/song/timeline.json", "reviewed": true})'],
    params: {
      timeline: {
        type: 'string',
        description: '导入人工修正的统一时间轴 JSON',
      },
      reviewed: {
        type: 'boolean',
        description: '确认导入的时间轴已核对歌词、术语和句首时间',
      },
    },
    run: async (p, { out }, signal, root) => {
      const canvas = scene.canvasOf(root, 'frame.md');
      await song.prepare(root, str(p.timeline), bool(p.reviewed), currentEnvironment(), out, signal);
      song.exportPhrases(root, canvas.fps);
    },
  });

  songOp({
    name: 'song_cues',
    cli: 'cues',
    summary: '计算镜头局部歌词和节拍，绑定全局摘要',
    help: '按镜头目录字典序累计整数帧时长，将全局歌词及节拍裁切为局部秒数。总长度必须为 ceil(实际歌曲秒数 × fps)，含前奏与尾奏。更新 scene.json 的 song 块和 song-cues.json；校验失败不写文件，成功后旧镜头需 "force": true 重渲染。',
    examples: ['song_cues({"scenes": "scenes/"})'],
    params: {
      scenes: {
        type: 'string',
        description: '镜头目录的上级目录',
        required: true,
        positional: 0,
      },
    },
    run: (p, { out }, _signal, root) => {
      applySongCues(root, str(p.scenes), out);
    },
  });

  songOp({
    name: 'song_mux',
    cli: 'mux',
    summary: '将完整歌曲与整数帧静音母版合成',
    help: '检查静音母版总帧数与歌曲时间轴一致，复制视频并加入完整歌曲。只允许末尾不足一帧的静音补齐，不变速、不叠 BGM、不做侧链。输出为 MP4 并执行完整解码与规格检查。',
    examples: ['song_mux({"master": "production/silent-master.mp4", "out": "final.mp4"})'],
    params: {
      master: {
        type: 'string',
        description: '静音母版',
        required: true,
        positional: 0,
      },
      out: { type: 'string', description: '成片输出路径（MP4）' },
    },
    run: async (p, _ctx, signal, root) => {
      const master = str(p.master);
      const output = str(p.out);
      if (output === '') throw new Error('必须提供 out');
      const t = song.loadTimeline(root);
      if (!t.reviewed) throw new Error('时间轴尚未人工复核');
      const c = song.selected(root);
      let dir = '';
      try {
        dir = song.candidateDir(root, c.id);
      } catch {
        // Go 版忽略这里的错误。
      }
      const canvas = scene.canvasOf(root, 'frame.md');
      const m = newToolchain(currentEnvironment());
      const report = m.verify(master, {
        spec: { widthPx: canvas.widthPx, heightPx: canvas.heightPx },
      });
      if (!report.ok) throw new Error(`静音母版画幅不符：${formatList(report.problems ?? [])}`);
      const scenes = schedule.plan(path.join(root, 'scenes'));
      songCoverage(root, scenes, t, true);
      songOutputsCurrent(scenes, master);
      await m.muxSong(master, path.join(dir, c.audio), output, t.duration_seconds, canvas.fps, signal);
      return { data: { out: output } };
    },
  });

  ctx.op({
    name: 'validate_song',
    cli: ['validate', 'song'],
    summary: '校验歌曲选择、歌词、时间轴和镜头覆盖',
    verb: '校验歌曲时间轴',
    description:
      '检查已选歌曲和歌词摘要、已人工复核的统一时间轴，以及所有镜头从零至尾奏的整数帧覆盖。检查每镜头局部歌词和全局摘要；发现过期依赖时必须重跑 song_cues() 并重渲染。不通过时报错。',
    examples: ['validate_song()'],
    params: {
      project_root: projectRoot,
      scenes: { type: 'string', description: '镜头目录，默认项目 scenes/' },
    },
    run: (p, { out }) => {
      const root = str(p.project_root);
      const t = song.loadTimeline(root);
      if (!t.reviewed) throw new Error('时间轴尚未人工复核');
      const dir = str(p.scenes) !== '' ? str(p.scenes) : path.join(root, 'scenes');
      const scenes = schedule.plan(dir);
      songCoverage(root, scenes, t, true);
      out.write('歌曲与镜头时间轴校验通过\n');
      return { data: { ok: true, scenes: scenes.length } };
    },
  });
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
    verifySongInputs(s);
    const output = statNs(scene.outputPath(s));
    for (const name of ['scene.json', 'prompt.md', s.song.data]) {
      const file = path.join(s.directory, name);
      if (name === 'prompt.md' && !fs.existsSync(file)) continue;
      if (statNs(file) > output) throw new Error(`歌曲镜头 ${s.id} 已过期，需要 "force": true 重渲染`);
    }
    if (masterTime !== null && output > masterTime) throw new Error(`静音母版早于镜头 ${s.id}，需要重新 concat()`);
  }
}
