/**
 * 歌曲讲解的平台配置、初始化、交接、候选生成/导入与选定操作。
 */
import { envMap } from '../../envutil';
import { newToolchain } from '../../mediaprobe';
import { bool, num, str } from '../../opkit';
import type { PluginContext, PluginOpContext, PluginParamSpec } from '../../plugin/types';
import * as song from '../../song';
import { songScaffold } from './cues';

type OpResult = { data?: unknown };
type ParamValues = Record<string, unknown>;
const currentEnvironment = (): Record<string, string> => envMap();

export interface SongOpDef {
  name: string;
  cli: string;
  summary: string;
  help: string;
  examples: string[];
  params?: Record<string, PluginParamSpec>;
  run: (
    p: ParamValues,
    ctx: PluginOpContext,
    signal: AbortSignal,
    root: string,
  ) => void | OpResult | Promise<void> | Promise<OpResult>;
}

export type SongOpRegistrar = (def: SongOpDef) => void;

export function registerSongAuthorOps(ctx: PluginContext, songOp: SongOpRegistrar, songRoot: PluginParamSpec): void {
  ctx.op({
    name: 'song_providers',
    cli: ['song', 'providers'],
    summary: '查看歌曲平台、申请入口和密钥配置步骤',
    description:
      '列出可用歌曲平台；platform 可指定 acestep-local、bailian、elevenlabs、fal、minimax、acestep、mureka、lyria 或 manual 查看开通要求、环境变量和配置示例。只显示密钥是否设置，不读取展示其内容，不请求网络或生成歌曲，无需先初始化项目。',
    examples: [
      'song_providers()',
      'song_providers({"platform": "acestep-local"})',
      'song_providers({"platform": "bailian"})',
    ],
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
      'song_configure({"provider": "acestep-local"})',
      'song_configure({"provider": "acestep-local", "task_type": "cover", "source_audio": "source.mp3", "cover_strength": 0.5})',
      'song_configure({"provider": "bailian", "workspace": "YOUR_WORKSPACE_ID"})',
      'song_configure({"provider": "elevenlabs"})',
      'song_configure({"provider": "fal"})',
      'song_configure({"provider": "mureka"})',
      'song_configure({"provider": "lyria"})',
    ],
    params: {
      provider: {
        type: 'string',
        description: '平台：acestep-local|bailian|elevenlabs|fal|minimax|acestep|mureka|lyria|manual（必填）',
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
      task_type: {
        type: 'string',
        description:
          '可选生成模式（仅 acestep-local）：text2music（默认）| cover（自由改词翻唱）| cover-nofsq（高保真贴合原曲翻唱）',
      },
      source_audio: {
        type: 'string',
        description: '翻唱原曲相对路径（WAV/MP3，仅 cover / cover-nofsq 使用）',
      },
      reference_audio: {
        type: 'string',
        description: '可选音色参考音频相对路径（WAV/MP3，仅 acestep-local 使用）',
      },
      cover_strength: {
        type: 'number',
        description: '翻唱贴合原曲的强度（0..1；留空时 cover 默认 0.5，cover-nofsq 默认 0.35）',
      },
      lm_model: {
        type: 'string',
        description: '可选本机 LM 模型文件名（仅 acestep-local，默认 acestep-5Hz-lm-1.7B-Q8_0.gguf）',
      },
      project_root: songRoot,
    },
    run: (p, { out }) => {
      song.configure(str(p.project_root), str(p.provider), str(p.model), str(p.workspace), str(p.endpoint), {
        ...(p.task_type !== undefined ? { taskType: str(p.task_type) } : {}),
        ...(p.source_audio !== undefined ? { sourceAudio: str(p.source_audio) } : {}),
        ...(p.reference_audio !== undefined ? { referenceAudio: str(p.reference_audio) } : {}),
        ...(p.cover_strength !== undefined ? { coverStrength: num(p.cover_strength) } : {}),
        ...(p.lm_model !== undefined ? { lmModel: str(p.lm_model) } : {}),
      });
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
      out.write(
        '歌曲资产已初始化。运行 song_providers() 查看平台，再用 song_configure({"provider": "PLATFORM"}) 配置（若刚从口播项目切换而来，下一轮对话会自动加载全部歌曲工具）。\n',
      );
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
      out.write(
        `已接收候选 ${c.id}；请核对唱词并由用户确认后运行 song_select({"candidate": "${c.id}"})。尚未选定或对齐。\n`,
      );
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
    run: (p, { out }, signal, root) =>
      song.generate(root, num(p.count), str(p.batch), currentEnvironment(), out, signal),
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
}
