import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../envutil';

export const DefaultSceneJobs = 3;
export const MaxSceneJobs = 16;

/**
 * 渲染记忆的项目侧设置。
 *
 * 默认打开：项目随使用积累经验与偏好。没有召回到任何记忆时提示词与输入指纹
 * 都与关闭时逐字相同，所以打开它不会让已有镜头变成 Stale。
 */
export interface MemorySettings {
  /** 为 false 时完全不召回、不写经历（对照组）。 */
  enabled: boolean;
  /** 记忆库目录，ONSET_MEMORY_DIR 可覆盖，默认 ~/.local/share/onset/memory。 */
  dir: string;
  /** 为 0 表示跟随最新快照，否则钉住该快照。 */
  snapshot: number;
  /** 每个镜头召回的记忆总字数上限。 */
  recallBudget: number;
  /**
   * 正式渲染时探索的比例：这么多比例的镜头把召回里排最后的一条经验换成
   * 排在上限外的第一条，给没机会被召回的经验攒样本。0 关闭。
   */
  explore: number;
}

/** Go 的 config.Config。没有 JSON 形式，字段用 camelCase。 */
export interface Config {
  orchestrator: string;
  /** 编排工具用的模型；空是那家工具自己的默认。只在与 orchestrator 同一层（或更高层）写的才算，见 load。 */
  orchestratorModel: string;
  renderer: string;
  /** 渲染工具用的模型，规则同 orchestratorModel。镜头 scene.json 换了渲染工具时不用它（scene/run.ts）。 */
  rendererModel: string;
  /**
   * 三项工具各自的调用选项（推理强度、快速模式、上下文长度……），一行 effort=high,fast=on，规则同模型：
   * 只在写它的那一层、工具也是现在这一家时才算。用 tools.effectiveOptions 按工具挑出认识的项。
   */
  orchestratorOptions: string;
  rendererOptions: string;
  optimizerOptions: string;
  /**
   * 润色与镜头画面描述检查用的工具（promptopt）；空是跟随 orchestrator。用 promptopt.optimizerOf 取实际的工具与模型，
   * 不要直接读这两项。
   */
  optimizer: string;
  /** 优化工具用的模型，规则同 orchestratorModel；optimizer 为空时也为空（跟随编排的模型）。 */
  optimizerModel: string;
  ttsProvider: string;
  /** 已解析的对齐工具，auto 已落成具体取值。 */
  alignProvider: string;
  sceneJobs: number;
  /** 项目 .env 的内容（Go 版 nil map 对应空对象）。 */
  overlay: Record<string, string>;
  /** 渲染记忆的项目侧设置，见 memory 包。 */
  memory: MemorySettings;
  /** 整片风格来源数据的根目录，见 filmstyle.rootDir。 */
  filmStyleRoot: string;
  /** onset 管理的固定版本 HyperFrames CLI 的安装目录，见 hyperframes.requireCLI（onset setup 用 ensureCLI 安装）。 */
  hyperFramesCLI: string;
  /** 内置插件登记的、要显式传给子进程的环境变量（plugin.PluginChildEnv），理由同 hyperFramesCLI。 */
  pluginEnv: Record<string, string>;
  /** 音色库目录（voice 包），所有项目共用；理由同 memory.dir，要显式传给子进程。 */
  voicesDir: string;
  /** 全局设置文件（config/global.ts），理由同 voicesDir，要显式传给子进程。 */
  settingsFile: string;
  /** 客户端里编排工具请求批准时直接允许，不弹卡片（AUTO_APPROVE，studio/permissions.ts）。 */
  autoApprove: boolean;
  /** 用户在 ORCHESTRATOR_ALLOW_COMMANDS 里补充放行的命令前缀，见 orchestratorAccess。 */
  extraCommands: string[];
}

/** 构造一个 Config：没给的字段取 Go 的零值。对应 Go 里的 Config{...} 字面量。 */
export function newConfig(fields: Partial<Omit<Config, 'memory'>> & { memory?: Partial<MemorySettings> } = {}): Config {
  return {
    orchestrator: '',
    orchestratorModel: '',
    renderer: '',
    rendererModel: '',
    orchestratorOptions: '',
    rendererOptions: '',
    optimizerOptions: '',
    optimizer: '',
    optimizerModel: '',
    ttsProvider: '',
    alignProvider: '',
    sceneJobs: 0,
    overlay: {},
    filmStyleRoot: '',
    hyperFramesCLI: '',
    pluginEnv: {},
    voicesDir: '',
    settingsFile: '',
    autoApprove: false,
    extraCommands: [],
    ...fields,
    memory: { enabled: false, dir: '', snapshot: 0, recallBudget: 0, explore: 0, ...fields.memory },
  };
}

/** 每个镜头召回记忆的默认总字数上限。 */
export const DefaultMemoryRecallBudget = 1500;

/** 默认的探索比例；MaxMemoryExplore 是上限。 */
export const DefaultMemoryExplore = 0.1;
export const MaxMemoryExplore = 0.5;

/**
 * 默认记忆库目录：用户级，可跨项目复用。<数据目录>/memory（envutil.dataDir）；
 * 环境里什么都没有时按家目录推。
 */
export function defaultMemoryDir(environ: Record<string, string | undefined>): string {
  return path.join(dataDir(environ) || dataDir({ HOME: os.homedir() }), 'memory');
}

/** strconv.FormatFloat(v, 'f', -1, 64)：最短的可往返十进制，不用指数写法。 */
export function formatFloatShortest(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '+Inf' : '-Inf';
  const negative = value < 0 || Object.is(value, -0);
  const [mantissa, expText] = Math.abs(value).toExponential().split('e');
  const digits = mantissa!.replace('.', '');
  const exp = Number(expText);
  let out: string;
  if (exp >= digits.length - 1) out = digits + '0'.repeat(exp - (digits.length - 1));
  else if (exp >= 0) out = digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  else out = '0.' + '0'.repeat(-exp - 1) + digits;
  return (negative ? '-' : '') + out;
}

/** 渲染工具 renderer 该用的模型：与配置里的渲染工具是同一家时用 rendererModel，否则（镜头 scene.json 换了工具）用那家自己的默认。 */
export function rendererModelFor(config: Config, renderer: string): string {
  return renderer === config.renderer ? config.rendererModel : '';
}

/** 渲染工具 renderer 该用的调用选项，规则同 rendererModelFor。 */
export function rendererOptionsFor(config: Config, renderer: string): string {
  return renderer === config.renderer ? config.rendererOptions : '';
}
