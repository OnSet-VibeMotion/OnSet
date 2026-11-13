// 移植自 internal/config/providers.go。
import { goQuote, isGoSpace } from '../gofmt';
import type { ModelSpec, ToolSpec } from '../toolinstall';
import type { OrchestratorAccess } from '../tools';
import type { Config } from './config';

/**
 * 一个可选的配音服务。合成本身由编排工具按
 * PROMPT-PRODUCTION.md 第三阶段对应小节执行，这里只登记取值与校验所需信息。
 *
 * timestamps 是该服务自带时间戳的粒度，决定第四阶段要不要另做强制对齐：
 * sentence 只能用于粗排，char 可以直接用作短语级时间轴的依据。
 *
 * command 是第三阶段调用的命令名，安全模式下编排工具只被放行这一个 TTS 命令，
 * 见 orchestratorAccess。改提示词里的命令时要同步改这里。
 */
export interface TTSProvider {
  id: string;
  name: string;
  timestamps: string;
  command: string;
  /** am setup 怎么装它（版本钉死）。客户端用户不必自己 npm / pipx / brew。 */
  install: ToolSpec;
  /** 工具第一次运行会去下的模型：am setup（客户端的工具准备页）预先下好，提示词经 config_get 工具取 TTS_MODEL 的本地路径。 */
  model?: ModelSpec;
}

/**
 * Breeze TTS 2 的 MLX 8bit 转换（约 4.6 GB；bf16 版 7.6 GB，4bit 版音质未经验证）。
 * mlx-audio 0.6.1 起支持（models/breeze_tts）。只列加载要用的文件，外加 LICENSE / NOTICE
 * 随模型留在本机；魔搭特有的 configuration.json 与 README 不列。摘要取自魔搭的文件列表，2026-11。
 */
export const BreezeTTS2: ModelSpec = {
  repo: 'mlx-community/Breeze-TTS-2-mlx-8bit',
  files: [
    { path: 'LICENSE', sha256: '2a143ae167cb0253d95bafa694e415570dcce336d712230d205c538523bbd855', size: 18856 },
    { path: 'NOTICE', sha256: '70bc248b98e5bb527f160c86be56d60ef8c63776c43051273643db036ebee40d', size: 146 },
    { path: 'audio_tokenizer/config.json', sha256: 'ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167', size: 2336 },
    { path: 'audio_tokenizer/model.safetensors', sha256: '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258', size: 682293092 },
    { path: 'audio_tokenizer/preprocessor_config.json', sha256: 'fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb', size: 234 },
    { path: 'config.json', sha256: '91cf471c3a9bd00e61046a5e08dce22967f161e75488d21b128026154111be65', size: 12379 },
    { path: 'generation_config.json', sha256: '2ef3f2c0ab8d9ad241059138a795433c5410fd9954efb9625674ecd2a9529434', size: 251 },
    { path: 'model.safetensors', sha256: 'd7a82315bcc59c3057f13bb85100743c7cd40692e38145fb255d6c1f0bf447bc', size: 3885721536 },
    { path: 'model.safetensors.index.json', sha256: '113da60084ed077d67dd99706e5619f4c40056d777225923302cb957b3677026', size: 98863 },
    { path: 'special_tokens_map.json', sha256: '194f265bb588d142a16f27d9576104eb3dab3d7ba9961541d2d6e3d5e77e6470', size: 886 },
    { path: 'tokenizer.json', sha256: 'd3ec9ac3eb2392389b9f5112e85d8b43316494addb587ba7b7a9d61eac23af96', size: 33386945 },
    { path: 'tokenizer_config.json', sha256: '2c084fd6725c2284e8aa6da095a8d036d48fe79665595bfcd50371821b620e44', size: 1157960 },
  ],
};

/**
 * TTS_PROVIDER 的全部合法取值，顺序即帮助文字里的顺序。
 *
 * 收录标准是「有可非交互调用的 CLI，且凭据不必落进项目文件」：
 *   - 豆包 / 火山引擎没有官方 CLI，接入要在 am 里写一个无法离线验证的 HTTP 客户端；
 *   - Azure 的 spx 把密钥写进当前目录下的 ./spx/data，即项目目录；
 *   - IndexTTS2 的许可对商用与模型输出有限制，且只能从源码安装。
 *
 * 这三家暂不收录。
 *
 * breeze（Breeze TTS 2）与 mlx 是同一个 mlx-audio 命令，换了模型：它的权重与生成的音频受
 * BreezeBlue Research and Non-Commercial License 约束，商用要 RESONIA, Inc. 书面授权
 * （推理代码的 Apache 2.0 不覆盖模型与产出）。许可只写在 README 里，界面与提示词不另行提示；缺省值仍是 minimax。
 */
export const TTSProviders: readonly TTSProvider[] = [
  { id: 'minimax', name: 'MiniMax（mmx CLI）', timestamps: 'sentence', command: 'mmx', install: { kind: 'npm', package: 'mmx-cli', version: '1.0.28', bins: ['mmx'] } },
  { id: 'bailian', name: '阿里云百炼（bl CLI）', timestamps: 'none', command: 'bl', install: { kind: 'npm', package: 'bailian-cli', version: '2.5.1', bins: ['bl'] } },
  {
    id: 'edge',
    name: '微软 Edge 在线语音（edge-tts，免鉴权）',
    timestamps: 'sentence',
    command: 'edge-tts',
    install: { kind: 'uv-tool', package: 'edge-tts', version: '7.3.1', bins: ['edge-tts'] },
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs（官方 CLI）',
    timestamps: 'char',
    command: 'elevenlabs',
    install: { kind: 'npm', package: '@elevenlabs/cli', version: '1.7.0', bins: ['elevenlabs'] },
  },
  { id: 'tencent', name: '腾讯云语音合成（tccli）', timestamps: 'sentence', command: 'tccli', install: { kind: 'uv-tool', package: 'tccli', version: '3.1.187.1', bins: ['tccli'] } },
  {
    id: 'mlx',
    name: '本机 MLX 语音合成（mlx-audio，仅 Apple Silicon）',
    timestamps: 'none',
    command: 'mlx_audio.tts.generate',
    install: mlxAudio(['mlx_audio.tts.generate']),
  },
  {
    id: 'breeze',
    name: 'Breeze TTS 2（mlx-audio，仅 Apple Silicon）',
    timestamps: 'none',
    command: 'mlx_audio.tts.generate',
    install: mlxAudio(['mlx_audio.tts.generate']),
    model: BreezeTTS2,
  },
];

/** mlx-audio：语音合成与 Qwen3 强制对齐是同一个包；依赖里有预发布版本，要放行。 */
function mlxAudio(bins: string[]): ToolSpec {
  return { kind: 'uv-tool', package: 'mlx-audio', version: '0.6.1', bins, prerelease: true, platforms: ['darwin/arm64'] };
}

/**
 * 一个已知文本强制对齐工具：文稿是现成的，把它逐字对到配音上
 * 比识别更准，也不会把专有名词识别错。
 *
 * command 同 TTSProvider.command。funasr 没有命令行入口：am setup 把它装进专用的 Python 环境，
 * 并写一个 funasr-python 调用那份 Python；提示词让编排工具用它跑 Python 脚本。安全模式因此不必放行系统的 python3。
 */
export interface Aligner {
  id: string;
  name: string;
  command: string;
  install: ToolSpec;
  /** 工具第一次运行会去下的模型：am setup（客户端的工具准备页）预先下好，提示词经 config_get 工具取 ALIGN_MODEL 的本地路径。 */
  model?: ModelSpec;
}

/** MLX 强制对齐用的模型（Hugging Face 与魔搭上同名；摘要取自魔搭的文件列表，2026-11）。 */
export const QwenForcedAligner: ModelSpec = {
  repo: 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit',
  files: [
    { path: 'chat_template.json', sha256: '75a8cfca24f00de72d796fbfed6858fc9614ef3dabd8696684cc3bc03a9c58ff', size: 1161 },
    { path: 'config.json', sha256: '8dc126e1a4ac001acb02f3a9ca6277c8a20a25485fde293bc99eeab3aedc604d', size: 6940 },
    { path: 'generation_config.json', sha256: '948d089b23bca1d214e768d59c4438365665f52ec6d33678f4062206b3fbbb8c', size: 115 },
    { path: 'merges.txt', sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', size: 1671853 },
    { path: 'model.safetensors', sha256: 'be19ef8ac4326d032e7673342930b14c2df30bd68c1632493b0f563e30829f91', size: 1271924386 },
    { path: 'model.safetensors.index.json', sha256: '766eb50873855eeb4d95ab92def358cfd173bfc8c7aabd8635ababa1edf6db79', size: 79108 },
    { path: 'preprocessor_config.json', sha256: '45e120a4eda2c20c5d7f2ea9354e63536bf35e27aa573fb7cdf78017b378770d', size: 330 },
    { path: 'tokenizer_config.json', sha256: '3ab80063f8511deb9566e6ad438d17b7a6277fcffd52d92854112f19d36bd81c', size: 12666 },
    { path: 'vocab.json', sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910', size: 2776833 },
  ],
};

/** ALIGN_PROVIDER 的具体取值；另有 auto 按平台选择。 */
export const Aligners: readonly Aligner[] = [
  {
    id: 'mlx',
    name: 'Qwen3-ForcedAligner（mlx-audio，Apple Silicon 本机）',
    command: 'mlx_audio.stt.generate',
    install: mlxAudio(['mlx_audio.stt.generate']),
    model: QwenForcedAligner,
  },
  {
    id: 'funasr',
    name: 'FunASR 时间戳预测（CPU，macOS 与 Linux）',
    command: 'funasr-python',
    install: { kind: 'uv-venv', name: 'funasr', packages: ['funasr==1.4.16', 'torch', 'torchaudio'], bin: 'funasr-python' },
  },
];

/** 让 am 按运行平台选择对齐工具。 */
export const AlignAuto = 'auto';

/**
 * 把 auto 落成具体工具：Apple Silicon 用 MLX，其余用 FunASR。
 * goos / goarch 用 Go 的写法（darwin、arm64）；Node 的 process.platform 与之相同，
 * process.arch 的 arm64 也相同（x64 对应 amd64，这里只看 arm64）。
 */
export function resolveAligner(value: string, goos: string, goarch: string): string {
  if (value !== AlignAuto) return value;
  if (goos === 'darwin' && goarch === 'arm64') return 'mlx';
  return 'funasr';
}

/**
 * 内置的默认配音：Apple Silicon 上用本机的 Breeze TTS 2（离线、不花钱，能从音色库克隆同一个声音），
 * 其余平台 Breeze 跑不了（只有 MLX 版），用 MiniMax。goos / goarch 的写法同 resolveAligner。
 * 只是没人设过时的缺省：全局设置或项目里写了就用写的。
 */
export function defaultTTSProvider(goos: string = process.platform, goarch: string = process.arch): string {
  return goos === 'darwin' && goarch === 'arm64' ? 'breeze' : 'minimax';
}

export function validTTSProvider(id: string): boolean {
  return TTSProviders.some((provider) => provider.id === id);
}

export function validAligner(id: string): boolean {
  return Aligners.some((aligner) => aligner.id === id);
}

/** 空格分隔的全部取值，用于错误信息与帮助文字。 */
export function ttsProviderIDs(): string {
  return TTSProviders.map((provider) => provider.id).join(' ');
}

/** 空格分隔的全部取值（含 auto）。 */
export function alignerIDs(): string {
  return [AlignAuto, ...Aligners.map((aligner) => aligner.id)].join(' ');
}

/** 按当前进程的平台解析 auto；测试用 resolveAligner 覆盖其他平台。 */
export function hostAligner(value: string): string {
  return resolveAligner(value, process.platform, process.arch);
}

/**
 * 任何配置下编排工具都要用到的命令（安全模式下按前缀放行）。
 *
 * 早先只放行 am、ffmpeg、ffprobe、ls、mkdir，编排工具连 cat、head、echo、shasum 都被拦，
 * 一轮对话里大半工具调用是「需要批准」，而 -p 模式下没人批准（实测）。这里补上只读查看、
 * 校验哈希、只读 git 与下载（制作提示词要求从 Google Fonts 下载字体）。之后又放了
 * python3 / python / node：编排工具常要写小脚本处理数据，拦掉只会逼用户改用 --unsafe
 * （用户反馈）。代价是脚本能做任何事，包括读 .env——这里防的是误操作与越界命令，
 * 不是对抗性的编排工具。仍然不放：shell 本身（sh、bash，等于任意命令行）、删除与改权限
 * （rm、chmod、chown）、安装（brew、pip、npm）、提权（sudo）。用户要补别的命令写进
 * ORCHESTRATOR_ALLOW_COMMANDS。
 * claude 的 acceptEdits 自己会放行工作区内的 touch、mkdir、rm、mv、cp 这类文件命令；
 * .env 的读取由 Read 禁令拦着，cat .env 照样会被拒（实测）。
 *
 * 2026-11 再放宽一轮（用户反馈「安全方向的限制还可以放宽」）：文本处理（sed、awk、tr……）、
 * 压缩解压、macOS 自带的看图与放音命令，都是编排工具整理素材时顺手要用、又碰不到项目外的。
 * 仍然不放 xargs、env、sh 这类「能代为执行任意命令」的。白名单外的命令，编排工具是 claude 且在
 * 客户端里时会弹卡片问用户（studio/permissions.ts），其余工具照旧直接拒绝。
 */
export const orchestratorBaseCommands: readonly string[] = [
  // am 不在这里：编排工具只经 am 的工具服务（MCP）调用它，见 tools.amToolsServer。
  'ffmpeg', 'ffprobe',
  // 查看文件与目录（只读）
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'sort', 'uniq', 'cut', 'diff', 'cmp',
  'stat', 'file', 'du', 'pwd', 'basename', 'dirname', 'realpath', 'jq', 'tree', 'which', 'date',
  // 输出与切换目录
  'echo', 'printf', 'cd',
  // 文件操作（工作区内）
  'mkdir', 'cp', 'mv', 'touch',
  // 校验哈希（成片与发布配置要记 SHA-256）
  'shasum', 'sha256sum', 'md5',
  // 只读 git
  'git status', 'git diff', 'git log', 'git show',
  // 下载字体、授权素材
  'curl',
  // 跑小脚本处理数据（解析对齐结果、批量改 JSON、算时长……），编排工具经常要用
  'python3', 'python', 'node',
  // 文本处理
  'sed', 'awk', 'tr', 'tee', 'column', 'paste', 'nl', 'fold', 'iconv', 'base64', 'xxd', 'od', 'comm', 'join', 'rev',
  // 压缩解压（下载的字体包、素材包）
  'tar', 'unzip', 'zip', 'gzip', 'gunzip',
  // 链接、等待与条件判断
  'ln', 'sleep', 'test', 'true', 'false',
  // macOS 自带的看图、读元数据、放音（检查封面尺寸、试听配音）
  'sips', 'mdls', 'afplay', 'open',
];

/** strings.Fields：按 unicode.IsSpace 认的空白切开，丢掉空段。 */
function goFields(value: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of value) {
    if (isGoSpace(ch.codePointAt(0)!)) {
      if (current !== '') out.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

const shellControl = new Set([';', '&', '|', '`', '$', '<', '>', '(', ')', '\\', '"', "'", '*', '\n']);

/**
 * 解析 ORCHESTRATOR_ALLOW_COMMANDS：逗号分隔的命令前缀，例如
 * "uv run, pnpm, magick"。前缀按原样放行（claude 写成 Bash(<前缀>:*)），不能带 shell
 * 控制符：带了的话一条「前缀」就能拼出任意命令。
 */
export function parseAllowCommands(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const item = goFields(raw).join(' ');
    if (item === '') continue;
    if ([...item].some((c) => shellControl.has(c))) {
      throw new Error(
        `ORCHESTRATOR_ALLOW_COMMANDS 里的 ${goQuote(item)} 带了 shell 控制符；只写命令前缀，例如 "uv run"、"pnpm"，多个用逗号分隔`,
      );
    }
    out.push(item);
  }
  return out;
}

/**
 * 安全模式下编排工具要放行的命令：基础命令、当前 TTS 与对齐
 * 工具各自的那一个命令，加上调用方补充的（固定版本的 hyperframes）。安装命令
 * （brew、pip、uv、npm）不在其中：安全模式下要用户自己装好。
 * 对应 Go 的 Config.OrchestratorAccess。
 */
export function orchestratorAccess(config: Config, ...extra: string[]): OrchestratorAccess {
  const commands = [...orchestratorBaseCommands];
  for (const provider of TTSProviders) {
    if (provider.id === config.ttsProvider && provider.command !== '') commands.push(provider.command);
  }
  for (const aligner of Aligners) {
    if (aligner.id === config.alignProvider && aligner.command !== '') commands.push(aligner.command);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const command of [...commands, ...config.extraCommands, ...extra]) {
    if (command !== '' && !seen.has(command)) {
      seen.add(command);
      out.push(command);
    }
  }
  const access: OrchestratorAccess = { commands: out };
  const writable: string[] = [];
  if (config.memory.enabled && config.memory.dir !== '') writable.push(config.memory.dir);
  // 音色库同理：voice_save 写的是用户级目录，codex 的 workspace-write 沙箱默认只放行工作目录。
  if (config.voicesDir !== '') writable.push(config.voicesDir);
  if (writable.length > 0) access.writableDirs = writable;
  // 风格来源的数据不放进可写范围：它是前置资源，只由用户在终端里跑的 am setup 下载，
  // 编排工具调用的 am film-style use 只读它、写项目。
  return access;
}
