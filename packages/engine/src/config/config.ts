// 移植自 internal/config/config.go。
//
// 配置的解析顺序：环境变量 > 项目 .env > article-to-motion.conf > 缺省值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envMap } from '../envutil';
import { RootEnv, childEnvKeys, rootDir } from '../filmstyle';
import { formatG, goPathError, goTrimSpace } from '../gofmt';
import { BrowserEnv, CLIDirEnv, HyperFramesBrowserEnv, PinnedVersion, cliDir } from '../hyperframes';
import { childEnvKeys as toolpathEnvKeys } from '../toolpath';
import { EnvDirEnv as BeatEnvDirEnv, envDir as beatEnvDir } from '../beat/env';
import { ValidTools } from '../tools';
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
  renderer: string;
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
  /** 用户在 ORCHESTRATOR_ALLOW_COMMANDS 里补充放行的命令前缀，见 orchestratorAccess。 */
  extraCommands: string[];
}

/** 构造一个 Config：没给的字段取 Go 的零值。对应 Go 里的 Config{...} 字面量。 */
export function newConfig(fields: Partial<Omit<Config, 'memory'>> & { memory?: Partial<MemorySettings> } = {}): Config {
  return {
    orchestrator: '',
    renderer: '',
    ttsProvider: '',
    alignProvider: '',
    sceneJobs: 0,
    overlay: {},
    filmStyleRoot: '',
    hyperFramesCLI: '',
    beatEnv: '',
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
 * 默认记忆库目录：用户级，可跨项目复用。
 * XDG_DATA_HOME 有值时用它，否则落在 HOME 下的 .local/share。
 */
export function defaultMemoryDir(environ: Record<string, string | undefined>): string {
  const dir = environ.XDG_DATA_HOME;
  if (dir) return path.join(dir, 'am', 'memory');
  let home = environ.HOME ?? '';
  if (home === '') home = os.homedir();
  return path.join(home, '.local', 'share', 'am', 'memory');
}

function parseFile(file: string): Record<string, string> {
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

/** 读取项目配置。environ 不给（或为 null）时用当前进程环境。 */
export function load(root: string, environ?: Record<string, string> | null): Config {
  const env = environ ?? envMap();
  let dotenv: Record<string, string>;
  try {
    dotenv = parseFile(path.join(root, '.env'));
  } catch (err) {
    throw new Error(`读取 .env: ${(err as Error).message}`, { cause: err });
  }
  for (const key of Object.keys(dotenv)) {
    if (secretKey.test(key)) throw new Error(`.env 不得保存密钥 ${key}，请使用对应工具的登录命令`);
  }
  let conf: Record<string, string>;
  try {
    conf = parseFile(path.join(root, 'article-to-motion.conf'));
  } catch (err) {
    throw new Error(`读取 article-to-motion.conf: ${(err as Error).message}`, { cause: err });
  }
  const resolve = (key: string, fallback: string): string => {
    for (const source of [env, dotenv, conf]) {
      const value = source[key];
      if (value) return value;
    }
    return fallback;
  };
  const cfg = newConfig({
    orchestrator: resolve('ORCHESTRATOR', ''),
    renderer: resolve('RENDERER', ''),
    ttsProvider: resolve('TTS_PROVIDER', 'minimax'),
    overlay: dotenv,
  });
  if (!ValidTools.has(cfg.orchestrator)) {
    throw new Error(`无效的 ORCHESTRATOR: ${cfg.orchestrator}（可选：codex claude qoder codebuddy opencode）`);
  }
  if (!ValidTools.has(cfg.renderer)) {
    throw new Error(`无效的 RENDERER: ${cfg.renderer}（可选：codex claude qoder codebuddy opencode）`);
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
      ...passthrough,
    ];
    for (const key of allowed) {
      if (Object.hasOwn(source, key)) out[key] = source[key]!;
    }
  }
  Object.assign(out, config.overlay);
  out.ORCHESTRATOR = config.orchestrator;
  out.RENDERER = config.renderer;
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
  // 客户端自带的浏览器与用户显式指定的浏览器同理：子进程里的 am hyperframes 照样用它们，不去下载 headless-shell。
  for (const key of [BrowserEnv, HyperFramesBrowserEnv]) if (source[key]) out[key] = source[key]!;
  // 客户端自带的 npm、工具目录与 am setup 的工具目录同理：子进程里的 am 要找到同一套，而白名单里没有它们。
  for (const key of toolpathEnvKeys) if (source[key]) out[key] = source[key]!;
  if (unsafe) out.AM_UNSAFE = '1';
  return out;
}
