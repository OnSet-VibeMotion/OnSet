//
// 配置的解析顺序：环境变量 > 项目 .env > onset.conf > 缺省值。
import fs from 'node:fs';
import path from 'node:path';
import { envMap } from '../envutil';
import { RootEnv, rootDir } from '../filmstyle';
import { formatG, goPathError, goTrimSpace } from '../gofmt';
import { CLIDirEnv, cliDir, PinnedVersion } from '../hyperframes';
import { pluginChildEnvs } from '../plugin/registry';
import { defaultDir as defaultSeriesDir, DirEnv as SeriesDirEnv } from '../series/dir';
import { ValidRenderers, ValidTools, validOptionsText } from '../tools';
import { defaultDir as defaultVoicesDir, DirEnv as VoicesDirEnv } from '../voice/dir';
import {
  GlobalDefaults,
  type GlobalKey,
  GlobalKeys,
  isGlobalKey,
  ModelToolKey,
  settingsFile,
  validModel,
} from './global';
import {
  AlignAuto,
  alignerIDs,
  hostAligner,
  parseAllowCommands,
  ttsProviderIDs,
  validAligner,
  validTTSProvider,
} from './providers';
import {
  type Config,
  DefaultMemoryExplore,
  DefaultMemoryRecallBudget,
  DefaultSceneJobs,
  defaultMemoryDir,
  formatFloatShortest,
  MaxMemoryExplore,
  MaxSceneJobs,
  newConfig,
} from './types';

export { childEnvironment } from './childenv';
export {
  type Config,
  DefaultMemoryExplore,
  DefaultMemoryRecallBudget,
  DefaultSceneJobs,
  defaultMemoryDir,
  formatFloatShortest,
  MaxMemoryExplore,
  MaxSceneJobs,
  type MemorySettings,
  newConfig,
  rendererModelFor,
  rendererOptionsFor,
} from './types';

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

/** 读 KEY=VALUE 格式的配置文件（onset.conf、.env、全局设置）；不存在时为空。 */
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
    conf = parseConfFile(path.join(root, 'onset.conf'));
  } catch (err) {
    throw new Error(`读取 onset.conf: ${(err as Error).message}`, { cause: err });
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
    orchestratorOptions: modelFor('ORCHESTRATOR_OPTIONS'),
    rendererOptions: modelFor('RENDERER_OPTIONS'),
    optimizer: resolve('OPTIMIZER', ''),
    // 没设优化工具时它跟随编排工具与编排模型（与选项），给它单写的没有对象。
    optimizerModel: resolve('OPTIMIZER', '') === '' ? '' : modelFor('OPTIMIZER_MODEL'),
    optimizerOptions: resolve('OPTIMIZER', '') === '' ? '' : modelFor('OPTIMIZER_OPTIONS'),
    ttsProvider: resolve('TTS_PROVIDER', ''),
    overlay: dotenv,
  });
  cfg.settingsFile = globalFile;
  const autoApprove = resolve('AUTO_APPROVE', 'off').toLowerCase();
  if (autoApprove !== 'on' && autoApprove !== 'off') {
    throw new Error(`无效的 AUTO_APPROVE: ${autoApprove}（可选：on off）`);
  }
  cfg.autoApprove = autoApprove === 'on';
  if (!ValidTools.has(cfg.orchestrator)) {
    throw new Error(`无效的 ORCHESTRATOR: ${cfg.orchestrator}（可选：${[...ValidTools].join(' ')}）`);
  }
  if (cfg.optimizer !== '' && !ValidTools.has(cfg.optimizer)) {
    throw new Error(`无效的 OPTIMIZER: ${cfg.optimizer}（可选：留空跟随编排，或 ${[...ValidTools].join(' ')}）`);
  }
  if (!ValidRenderers.has(cfg.renderer)) {
    throw new Error(`无效的 RENDERER: ${cfg.renderer}（可选：${[...ValidRenderers].join(' ')}）`);
  }
  for (const [key, value] of [
    ['ORCHESTRATOR_MODEL', cfg.orchestratorModel],
    ['RENDERER_MODEL', cfg.rendererModel],
    ['OPTIMIZER_MODEL', cfg.optimizerModel],
  ] as const) {
    if (value !== '' && !validModel(value)) {
      throw new Error(`无效的 ${key}: ${value}（模型名只能用字母、数字与 . _ - : / @ # [ ] +）`);
    }
  }
  for (const [key, value] of [
    ['ORCHESTRATOR_OPTIONS', cfg.orchestratorOptions],
    ['RENDERER_OPTIONS', cfg.rendererOptions],
    ['OPTIMIZER_OPTIONS', cfg.optimizerOptions],
  ] as const) {
    if (!validOptionsText(value)) throw new Error(`无效的 ${key}: ${value}（写成 effort=high,fast=on）`);
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
  if (jobs === undefined || jobs < 1 || jobs > MaxSceneJobs) {
    throw new Error(`SCENE_JOBS 必须在 1..${MaxSceneJobs} 之间`);
  }
  cfg.sceneJobs = jobs;
  const memory = resolve('MEMORY', 'on').toLowerCase();
  if (memory === 'on') cfg.memory.enabled = true;
  else if (memory !== 'off') throw new Error(`无效的 MEMORY: ${memory}（可选：on off）`);
  cfg.extraCommands = parseAllowCommands(resolve('ORCHESTRATOR_ALLOW_COMMANDS', ''));
  cfg.memory.dir = resolve('ONSET_MEMORY_DIR', defaultMemoryDir(env));
  cfg.filmStyleRoot = resolve(RootEnv, rootDir(env));
  cfg.hyperFramesCLI = resolve(CLIDirEnv, cliDir(env, PinnedVersion));
  // 内置插件的目录类变量（例如卡点的节拍分析环境）同理：编排工具调用的操作要找到 onset setup 装好的那一套。
  cfg.pluginEnv = {};
  for (const { value: spec } of pluginChildEnvs()) {
    const v = resolve(spec.key, spec.value(env));
    if (v !== '') cfg.pluginEnv[spec.key] = v;
  }
  cfg.voicesDir = resolve(VoicesDirEnv, defaultVoicesDir(env));
  cfg.seriesDir = resolve(SeriesDirEnv, defaultSeriesDir(env));
  const snapshotText = resolve('MEMORY_SNAPSHOT', '');
  if (snapshotText !== '') {
    const snapshot = goAtoi(snapshotText);
    if (snapshot === undefined || snapshot < 1) {
      throw new Error('MEMORY_SNAPSHOT 必须是正整数快照号，留空表示跟随最新快照');
    }
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
  const conf = root === '' ? {} : parseConfFile(path.join(root, 'onset.conf'));
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
