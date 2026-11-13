// 移植自 internal/config/config.go。
//
// 配置的解析顺序：环境变量 > 项目 .env > article-to-motion.conf > 缺省值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, envMap, WindowsBaseEnvKeys } from '../envutil';
import { RootEnv, childEnvKeys, rootDir } from '../filmstyle';
import { formatG, goPathError, goTrimSpace } from '../gofmt';
import { BrowserEnv, CLIDirEnv, HyperFramesBrowserEnv, PinnedVersion, cliDir } from '../hyperframes';
import { childEnvKeys as toolpathEnvKeys } from '../toolpath';
import { EnvDirEnv as BeatEnvDirEnv, envDir as beatEnvDir } from '../beat/env';
import { DirEnv as VoicesDirEnv, defaultDir as defaultVoicesDir } from '../voice/dir';
import { GlobalDefaults, GlobalKeys, ModelToolKey, SettingsFileEnv, isGlobalKey, settingsFile, validModel, type GlobalKey } from './global';
import { ValidRenderers, ValidTools } from '../tools';
import { AlignAuto, alignerIDs, hostAligner, parseAllowCommands, ttsProviderIDs, validAligner, validTTSProvider } from './providers';

export const DefaultSceneJobs = 3;
export const MaxSceneJobs = 16;

/**
 * (?i)(API_KEY|TOKEN|SECRET|PASSWORD)$。RE2 的 (?i) 让 s 还匹配 ſ（U+017F）、k 还匹配 K（U+212A），
 * JS 的 i 标志不会，所以逐字母展开成字符类。码点用 fromCodePoint 拼，避免源码里出现这两个字符。
 */
const secretKey = (() => {
  const longS = String.fromCodePoint(0x17f);
  const kelvin = String.fromCodePoint(0x212a);
  const ci = (word: string) =>
    [...word]
      .map((c) => {
        const lower = c.toLowerCase();
        if (lower < 'a' || lower > 'z') return c;
        let cls = lower + lower.toUpperCase();
        if (lower === 's') cls += longS;
        if (lower === 'k') cls += kelvin;
        return '[' + cls + ']';
      })
      .join('');
  return new RegExp('(' + ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD'].map(ci).join('|') + ')$');
})();

/**
 * 渲染记忆的项目侧设置。
 *
 * 默认打开：项目随使用积累经验与偏好。没有召回到任何记忆时提示词与输入指纹
 * 都与关闭时逐字相同，所以打开它不会让已有镜头变成 Stale。
 */
export interface MemorySettings {
  /** 为 false 时完全不召回、不写经历（对照组）。 */
  enabled: boolean;
  /** 记忆库目录，AM_MEMORY_DIR 可覆盖，默认 ~/.local/share/am/memory。 */
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
  /** am 管理的固定版本 HyperFrames CLI 的安装目录，见 hyperframes.requireCLI（am setup 用 ensureCLI 安装）。 */
  hyperFramesCLI: string;
  /** 节拍分析环境目录（beat/env.ts），理由同 hyperFramesCLI。 */
  beatEnv: string;
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
    ttsProvider: '',
    alignProvider: '',
    sceneJobs: 0,
    overlay: {},
    filmStyleRoot: '',
    hyperFramesCLI: '',
    beatEnv: '',
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

/** 读 KEY=VALUE 格式的配置文件（article-to-motion.conf、.env、全局设置）；不存在时为空。 */
export function parseConfFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw new Error(goPathError('open', file, err), { cause: err });
  }
  // bufio.Scanner 按 \n 分行，去掉行尾的 \r；最后一行没有换行也算一行。
  const lines = body.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    let line = goTrimSpace(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length);
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = goTrimSpace(line.slice(0, eq));
    let value = goTrimSpace(line.slice(eq + 1));
    if (value.length >= 2 && ((value[0] === "'" && value.endsWith("'")) || (value[0] === '"' && value.endsWith('"')))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** strconv.Atoi：可带符号的十进制整数，超出 int64 报错；失败返回 undefined。 */
function goAtoi(value: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined;
  const big = BigInt(value);
  if (big > 9223372036854775807n || big < -9223372036854775808n) return undefined;
  return Number(big);
}

/**
 * strconv.ParseFloat(s, 64) 的十进制写法与 inf / infinity / nan（不区分大小写）。
 * 十六进制浮点（0x1p-3）与带下划线的写法不支持：配置里不会出现。失败返回 undefined。
 */
function goParseFloat(value: string): number | undefined {
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(value);
  if (special) {
    if (special[2]!.toLowerCase() === 'nan') return special[1] === '' ? NaN : undefined;
    return special[1] === '-' ? -Infinity : Infinity;
  }
  if (!/^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(value)) return undefined;
  const n = Number(value);
  // 超出 float64 范围时 Go 报 ErrRange。
  return Number.isFinite(n) ? n : undefined;
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

/** 读取项目配置。environ 不给（或为 null）时用当前进程环境。 */
export function load(root: string, environ?: Record<string, string> | null): Config {
  const env = environ ?? envMap();
  let dotenv: Record<string, string>;
  try {
    dotenv = parseConfFile(path.join(root, '.env'));
  } catch (err) {
    throw new Error(`读取 .env: ${(err as Error).message}`, { cause: err });
  }
  for (const key of Object.keys(dotenv)) {
    if (secretKey.test(key)) throw new Error(`.env 不得保存密钥 ${key}，请使用对应工具的登录命令`);
  }
  let conf: Record<string, string>;
  try {
    conf = parseConfFile(path.join(root, 'article-to-motion.conf'));
  } catch (err) {
    throw new Error(`读取 article-to-motion.conf: ${(err as Error).message}`, { cause: err });
  }
  const globalFile = settingsFile(env);
  let global: Record<string, string> = {};
  if (globalFile !== '') {
    try {
      global = parseConfFile(globalFile);
    } catch (err) {
      throw new Error(`读取全局设置 ${globalFile}: ${(err as Error).message}`, { cause: err });
    }
  }
  // 全局设置只管设置页的那几项（GlobalKeys）；其余键照旧只看环境变量、.env 与项目配置。
  const layers = (key: string) => [env, dotenv, conf, isGlobalKey(key) ? global : {}];
  // 从第 from 层往下找第一个写了的值；都没写时取内置默认。
  const resolveFrom = (key: string, fallback: string, from: number): string => {
    for (const source of layers(key).slice(from)) {
      const value = source[key];
      if (value) return value;
    }
    return isGlobalKey(key) ? GlobalDefaults[key] : fallback;
  };
  const resolve = (key: string, fallback: string): string => resolveFrom(key, fallback, 0);
  // 模型只对写它时的那家工具有意义：在模型所在的那一层往下看工具，是现在这一家才用。
  // 例如全局设了 claude + opus、项目改成 codex，opus 不能交给 codex；客户端给会话换了渲染工具、
  // 没选模型时（子进程环境里 RENDERER 变了而 RENDERER_MODEL 没写），项目里给旧工具写的模型同样作废。
  const modelFor = (modelKey: keyof typeof ModelToolKey): string => {
    const toolKey = ModelToolKey[modelKey];
    const at = layers(modelKey).findIndex((source) => !!source[modelKey]);
    if (at < 0) return '';
    return resolveFrom(toolKey, '', at) === resolve(toolKey, '') ? layers(modelKey)[at]![modelKey]! : '';
  };
  const cfg = newConfig({
    orchestrator: resolve('ORCHESTRATOR', ''),
    orchestratorModel: modelFor('ORCHESTRATOR_MODEL'),
    renderer: resolve('RENDERER', ''),
    rendererModel: modelFor('RENDERER_MODEL'),
    ttsProvider: resolve('TTS_PROVIDER', ''),
    overlay: dotenv,
  });
  cfg.settingsFile = globalFile;
  const autoApprove = resolve('AUTO_APPROVE', 'off').toLowerCase();
  if (autoApprove !== 'on' && autoApprove !== 'off') throw new Error(`无效的 AUTO_APPROVE: ${autoApprove}（可选：on off）`);
  cfg.autoApprove = autoApprove === 'on';
  if (!ValidTools.has(cfg.orchestrator)) {
    throw new Error(`无效的 ORCHESTRATOR: ${cfg.orchestrator}（可选：codex claude qoder codebuddy opencode director）`);
  }
  if (!ValidRenderers.has(cfg.renderer)) {
    throw new Error(`无效的 RENDERER: ${cfg.renderer}（可选：codex claude qoder codebuddy opencode）`);
  }
  for (const [key, value] of [['ORCHESTRATOR_MODEL', cfg.orchestratorModel], ['RENDERER_MODEL', cfg.rendererModel]] as const) {
    if (value !== '' && !validModel(value)) throw new Error(`无效的 ${key}: ${value}（模型名只能用字母、数字与 . _ - : / @ # [ ] +）`);
  }
  if (!validTTSProvider(cfg.ttsProvider)) {
    throw new Error(`无效的 TTS_PROVIDER: ${cfg.ttsProvider}（可选：${ttsProviderIDs()}）`);
  }
  const align = resolve('ALIGN_PROVIDER', AlignAuto);
  if (align !== AlignAuto && !validAligner(align)) {
    throw new Error(`无效的 ALIGN_PROVIDER: ${align}（可选：${alignerIDs()}）`);
  }
  cfg.alignProvider = hostAligner(align);
  const jobs = goAtoi(resolve('SCENE_JOBS', String(DefaultSceneJobs)));
  if (jobs === undefined || jobs < 1 || jobs > MaxSceneJobs) throw new Error(`SCENE_JOBS 必须在 1..${MaxSceneJobs} 之间`);
  cfg.sceneJobs = jobs;
  const memory = resolve('MEMORY', 'on').toLowerCase();
  if (memory === 'on') cfg.memory.enabled = true;
  else if (memory !== 'off') throw new Error(`无效的 MEMORY: ${memory}（可选：on off）`);
  cfg.extraCommands = parseAllowCommands(resolve('ORCHESTRATOR_ALLOW_COMMANDS', ''));
  cfg.memory.dir = resolve('AM_MEMORY_DIR', defaultMemoryDir(env));
  cfg.filmStyleRoot = resolve(RootEnv, rootDir(env));
  cfg.hyperFramesCLI = resolve(CLIDirEnv, cliDir(env, PinnedVersion));
  cfg.beatEnv = resolve(BeatEnvDirEnv, beatEnvDir(env));
  cfg.voicesDir = resolve(VoicesDirEnv, defaultVoicesDir(env));
  const snapshotText = resolve('MEMORY_SNAPSHOT', '');
  if (snapshotText !== '') {
    const snapshot = goAtoi(snapshotText);
    if (snapshot === undefined || snapshot < 1) throw new Error('MEMORY_SNAPSHOT 必须是正整数快照号，留空表示跟随最新快照');
    cfg.memory.snapshot = snapshot;
  }
  const budget = goAtoi(resolve('MEMORY_RECALL_BUDGET', String(DefaultMemoryRecallBudget)));
  if (budget === undefined || budget < 0) throw new Error('MEMORY_RECALL_BUDGET 必须是非负整数');
  cfg.memory.recallBudget = budget;
  const explore = goParseFloat(resolve('MEMORY_EXPLORE', formatFloatShortest(DefaultMemoryExplore)));
  // 与 Go 一样：NaN 不小于 0 也不大于上限，照样放行。
  if (explore === undefined || explore < 0 || explore > MaxMemoryExplore) {
    throw new Error(`MEMORY_EXPLORE 必须是 0 到 ${formatG(MaxMemoryExplore)} 之间的小数（0 关闭探索）`);
  }
  cfg.memory.explore = explore;
  return cfg;
}

/**
 * 子进程（编排工具、渲染器）的环境。对应 Go 的 Config.ChildEnvironment。
 * base 不给（或为 null）时用当前进程环境；unsafe 为 false 时只透传白名单与 passthrough 里的变量。
 */
export function childEnvironment(
  config: Config,
  base?: Record<string, string> | null,
  unsafe = false,
  passthrough: string[] = [],
): Record<string, string> {
  const source = base ?? envMap();
  const out: Record<string, string> = {};
  if (unsafe) {
    Object.assign(out, source);
  } else {
    // USER / LOGNAME / SHELL 不是凭据，但工具链要靠它们确定身份：
    // macOS 上 claude CLI 缺 USER 就读不到 Keychain 里的登录态，
    // 报的却是「Not logged in」，与权限隔离毫无关联，极难排查。
    //
    // CODEX_HOME 同理不是凭据，而是 Codex 的数据目录：用户改过它时，缺了这个
    // 变量 Codex 回到 ~/.codex 找登录态，报未登录；内置生图的产物也落到
    // 那里，自定义风格的定风格阶段拿不到氛围参照图。
    const allowed = [
      'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL',
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_HOME',
      // Windows 的系统变量（缺了 SystemRoot 等子进程直接出错，见 envutil.WindowsBaseEnvKeys）；别的系统上没有它们。
      ...WindowsBaseEnvKeys,
      ...passthrough,
    ];
    for (const key of allowed) {
      if (Object.hasOwn(source, key)) out[key] = source[key]!;
    }
  }
  Object.assign(out, config.overlay);
  out.ORCHESTRATOR = config.orchestrator;
  out.RENDERER = config.renderer;
  // 模型与工具一起写进去（空就删掉 .env 里带进来的旧值）：子进程按 load 的规则，环境里只有工具、
  // 没有模型时不会捡起项目配置里给别的工具写的模型。编排工具调用的 am scene run 因此用会话选的渲染模型。
  for (const [key, value] of [['ORCHESTRATOR_MODEL', config.orchestratorModel], ['RENDERER_MODEL', config.rendererModel]] as const) {
    if (value !== '') out[key] = value;
    else delete out[key];
  }
  out.TTS_PROVIDER = config.ttsProvider;
  if (config.alignProvider !== '') out.ALIGN_PROVIDER = config.alignProvider;
  // 记忆设置与 ORCHESTRATOR 一样显式写进去：编排工具调用的 am memory remember、
  // am scene run 必须用同一个记忆库。安全模式的白名单里没有 AM_MEMORY_DIR，
  // 不写的话子进程回落到默认目录——既不是这一个库，也不在 codex 沙箱放行的范围里
  // （实测：偏好写入被拒，报「没有写入权限」）。
  if (config.memory.dir !== '') {
    out.AM_MEMORY_DIR = config.memory.dir;
    out.MEMORY = config.memory.enabled ? 'on' : 'off';
    out.MEMORY_RECALL_BUDGET = String(config.memory.recallBudget);
    out.MEMORY_EXPLORE = formatFloatShortest(config.memory.explore);
    if (config.memory.snapshot > 0) out.MEMORY_SNAPSHOT = String(config.memory.snapshot);
  }
  // 风格来源的数据目录同理显式写进去：默认根目录由 XDG_DATA_HOME 推出，而它不在白名单里，
  // 编排工具调用的 am film-style 会算出另一个目录，找不到 am setup 准备好的数据。
  // 各来源自己的覆盖变量（filmstyle.childEnvKeys）设了才传。
  if (config.filmStyleRoot !== '') out[RootEnv] = config.filmStyleRoot;
  for (const key of childEnvKeys()) {
    if (key === RootEnv) continue;
    if (source[key]) out[key] = source[key]!;
    if (config.overlay[key]) out[key] = config.overlay[key]!;
  }
  // CLI 目录同理：子进程里的 am hyperframes 要找到同一份已装好的 CLI，否则会按 HOME
  // 另算一个目录，在渲染途中重新 npm install。
  if (config.hyperFramesCLI !== '') out[CLIDirEnv] = config.hyperFramesCLI;
  // 节拍分析环境同理：编排工具调用的 am beat analyze 要找到 am setup 装好的那一套，找不到就会想自己去建。
  if (config.beatEnv !== '') out[BeatEnvDirEnv] = config.beatEnv;
  // 音色库同理：编排工具调用的 voice_save、voice_get 与客户端的音色页要是同一个库，
  // 默认目录由 XDG_DATA_HOME 推出而它不在白名单里。
  if (config.voicesDir !== '') out[VoicesDirEnv] = config.voicesDir;
  // 全局设置同理：子进程（编排工具调用的 am、渲染）按同一份全局设置解析项目配置。
  if (config.settingsFile !== '') out[SettingsFileEnv] = config.settingsFile;
  // 客户端自带的浏览器与用户显式指定的浏览器同理：子进程里的 am hyperframes 照样用它们，不去下载 headless-shell。
  for (const key of [BrowserEnv, HyperFramesBrowserEnv]) if (source[key]) out[key] = source[key]!;
  // 客户端自带的 npm、工具目录与 am setup 的工具目录同理：子进程里的 am 要找到同一套，而白名单里没有它们。
  for (const key of toolpathEnvKeys) if (source[key]) out[key] = source[key]!;
  if (unsafe) out.AM_UNSAFE = '1';
  return out;
}

/** 设置页上的一项：它现在的值、值从哪来、全局与这个项目各自写的是什么。 */
export interface SettingRow {
  key: GlobalKey;
  effective: string;
  /** env：环境变量；dotenv：项目 .env；project：项目配置；global：全局设置；default：内置默认。 */
  source: 'env' | 'dotenv' | 'project' | 'global' | 'default';
  global: string;
  /** 项目配置里写的值；没写（跟随全局）为空。没有项目时为空。 */
  project: string;
}

/** 列出设置页那几项的来历。root 为空时只看全局。 */
export function describeSettings(root: string, environ?: Record<string, string> | null): SettingRow[] {
  const env = environ ?? envMap();
  const file = settingsFile(env);
  const global = file === '' ? {} : parseConfFile(file);
  const dotenv = root === '' ? {} : parseConfFile(path.join(root, '.env'));
  const conf = root === '' ? {} : parseConfFile(path.join(root, 'article-to-motion.conf'));
  return GlobalKeys.map((key) => {
    const layers: [SettingRow['source'], string | undefined][] = [
      ['env', env[key]],
      ['dotenv', dotenv[key]],
      ['project', conf[key]],
      ['global', global[key]],
    ];
    const hit = layers.find(([, v]) => v);
    return {
      key,
      effective: hit ? hit[1]! : GlobalDefaults[key],
      source: hit ? hit[0] : 'default',
      global: global[key] ?? '',
      project: conf[key] ?? '',
    };
  });
}
