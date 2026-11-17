/**
 * 全局设置：用户级的一份 settings.conf（<数据目录>/onset/settings.conf，ONSET_SETTINGS_FILE 覆盖），
 * 客户端「设置」页写它。它是所有项目的默认值，取值顺序是
 *
 *   环境变量 > 项目 .env > 项目 onset.conf > 全局设置 > 内置默认
 *
 * 项目里写了的项只对那个项目生效；没写（或写成 KEY= 空值）的跟着全局走，改一次全局，所有这类项目都变。
 * 新项目的 onset.conf 里这几项留空，所以默认跟随全局。
 *
 * 文件格式与 onset.conf 相同（KEY=VALUE、# 注释），由 writeGlobal 整份重写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../envutil';
import { atomicWrite } from '../fsutil';
import { ValidRenderers, ValidTools, validOptionsText } from '../tools';
import { AlignAuto, defaultTTSProvider, validAligner, validTTSProvider } from './providers';

export const SettingsFileEnv = 'ONSET_SETTINGS_FILE';

/** 设置页管的几项：「什么用什么」。 */
export const GlobalKeys = ['ORCHESTRATOR', 'ORCHESTRATOR_MODEL', 'ORCHESTRATOR_OPTIONS', 'RENDERER', 'RENDERER_MODEL', 'RENDERER_OPTIONS', 'OPTIMIZER', 'OPTIMIZER_MODEL', 'OPTIMIZER_OPTIONS', 'TTS_PROVIDER', 'ALIGN_PROVIDER', 'SCENE_JOBS', 'MEMORY', 'AUTO_APPROVE'] as const;
export type GlobalKey = (typeof GlobalKeys)[number];

/**
 * 只属于这台电脑的设置（也写在 settings.conf，不进 config.load、没有「这个项目」一栏）：
 * - NETWORK_PROXY：取插件中心目录、取插件的 git、检查客户端更新走的代理（http://、https://、socks5://）
 * - PLUGIN_CATALOG_URL：插件中心目录地址，空是官方插件中心（flow/market.ts 的 DefaultCatalogURLs）
 * - UPDATE_FEED_URL：客户端更新的地址，空是 GitHub Releases；填了按 electron-updater 的 generic 地址用（镜像）
 * 同名环境变量优先。
 */
export const MachineKeys = ['NETWORK_PROXY', 'PLUGIN_CATALOG_URL', 'UPDATE_FEED_URL'] as const;
export type MachineKey = (typeof MachineKeys)[number];

export function isMachineKey(key: string): key is MachineKey {
  return (MachineKeys as readonly string[]).includes(key);
}

/** 这台电脑的一项设置：环境变量 > settings.conf > 空。read 是读 KEY=VALUE 文件的函数（config.parseConfFile）。 */
export function machineSetting(env: Record<string, string | undefined>, key: MachineKey, read: (file: string) => Record<string, string>): string {
  const fromEnv = env[key]?.trim();
  if (fromEnv) return fromEnv;
  const file = settingsFile(env);
  if (file === '') return '';
  try {
    return read(file)[key]?.trim() ?? '';
  } catch {
    return '';
  }
}

function validateMachineSetting(key: MachineKey, value: string): string {
  if (value === '') return '';
  if (/['"\s]/.test(value)) return `${key} 里不能有引号或空白`;
  switch (key) {
    case 'NETWORK_PROXY':
      return /^(https?|socks5h?|socks4):\/\/[^/]+\/?$/.test(value) ? '' : '代理写成 http://主机:端口、https://… 或 socks5://…';
    case 'PLUGIN_CATALOG_URL':
      return /^(https:\/\/|file:\/\/\/)\S+\.json$/.test(value) ? '' : '插件目录地址要是 https://…/index.json（或本机的 file:///…/index.json）';
    case 'UPDATE_FEED_URL':
      return /^https:\/\/\S+$/.test(value) ? '' : '更新地址要是 https:// 开头';
  }
}

/**
 * 内置默认：全局设置也没写时用它。配音按平台选（defaultTTSProvider：Apple Silicon 用本机 Breeze），
 * 其余与以前项目模板里写死的值相同。
 */
export const GlobalDefaults: Record<GlobalKey, string> = {
  ORCHESTRATOR: 'codex',
  // 模型留空是「这家工具自己的默认模型」（它自己的配置或登录账号决定），onset 不另定默认。
  ORCHESTRATOR_MODEL: '',
  // 调用选项（推理强度、快速模式、上下文长度……，tools/options.ts）：effort=high,fast=on；留空用那家工具自己的默认。
  ORCHESTRATOR_OPTIONS: '',
  RENDERER: 'claude',
  RENDERER_MODEL: '',
  RENDERER_OPTIONS: '',
  // 润色输入框里的话、检查镜头画面描述用的工具（promptopt）；留空跟随这一轮的编排工具与模型。
  OPTIMIZER: '',
  OPTIMIZER_MODEL: '',
  OPTIMIZER_OPTIONS: '',
  TTS_PROVIDER: defaultTTSProvider(),
  ALIGN_PROVIDER: AlignAuto,
  SCENE_JOBS: '3',
  MEMORY: 'on',
  // 客户端里编排工具要跑白名单外的命令时：off 每次弹卡片问，on 直接允许（studio/permissions.ts）。
  AUTO_APPROVE: 'off',
};

/**
 * 模型跟着哪一项工具：模型名只对那一家工具有意义（claude 的 opus 交给 codex 就是错的），
 * 所以 config.load 只在「写这个模型的那一层，工具也是现在这一家」时才用它，见 config.ts 的 modelFor。
 */
export const ModelToolKey = {
  ORCHESTRATOR_MODEL: 'ORCHESTRATOR',
  RENDERER_MODEL: 'RENDERER',
  OPTIMIZER_MODEL: 'OPTIMIZER',
  // 调用选项同理：effort=xhigh 对 claude 有意义，交给 codebuddy 就不认。
  ORCHESTRATOR_OPTIONS: 'ORCHESTRATOR',
  RENDERER_OPTIONS: 'RENDERER',
  OPTIMIZER_OPTIONS: 'OPTIMIZER',
} as const;

/** 反过来：工具项对应的模型项与选项项。在同一层换了工具，那一层的这几项要一起清掉（writeGlobal、config_set）。 */
export const ToolCompanionKeys: Readonly<Record<string, readonly GlobalKey[]>> = {
  ORCHESTRATOR: ['ORCHESTRATOR_MODEL', 'ORCHESTRATOR_OPTIONS'],
  RENDERER: ['RENDERER_MODEL', 'RENDERER_OPTIONS'],
  OPTIMIZER: ['OPTIMIZER_MODEL', 'OPTIMIZER_OPTIONS'],
};

/**
 * 模型名的写法：各家的模型 ID 只用字母、数字与 . _ - : / @ # [ ]（claude 的 claude-opus-5-5[1m]、
 * opencode 的 provider/model#variant）。空白与引号一律不收：它要原样拼进命令行与 TOML 覆盖项。
 */
export function validModel(value: string): boolean {
  return value.length <= 200 && /^[A-Za-z0-9._:/@#\[\]+-]+$/.test(value);
}

export function isGlobalKey(key: string): key is GlobalKey {
  return (GlobalKeys as readonly string[]).includes(key);
}

/** 全局设置文件：ONSET_SETTINGS_FILE，否则 <数据目录>/onset/settings.conf。环境里什么都没有时为空。 */
export function settingsFile(env: Record<string, string | undefined>): string {
  if (env[SettingsFileEnv]) return env[SettingsFileEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'settings.conf');
}

/** 一项设置的值合不合法；不合法时返回原因，合法返回空串。空值表示「不设」，总是合法。 */
export function validateSetting(key: string, value: string): string {
  if (isMachineKey(key)) return validateMachineSetting(key, value);
  if (!isGlobalKey(key)) return `不认识的设置项 ${key}（可设：${GlobalKeys.join(' ')}）`;
  if (value === '') return '';
  switch (key) {
    case 'ORCHESTRATOR':
    case 'OPTIMIZER':
      return ValidTools.has(value) ? '' : `${key} 只能是 ${[...ValidTools].join(' ')}`;
    case 'RENDERER':
      return ValidRenderers.has(value) ? '' : `${key} 只能是 ${[...ValidRenderers].join(' ')}`;
    case 'ORCHESTRATOR_MODEL':
    case 'RENDERER_MODEL':
    case 'OPTIMIZER_MODEL':
      return validModel(value) ? '' : `不认识的模型名 ${value}：只能用字母、数字与 . _ - : / @ # [ ] +`;
    case 'ORCHESTRATOR_OPTIONS':
    case 'RENDERER_OPTIONS':
    case 'OPTIMIZER_OPTIONS':
      // 只查写法：哪些键对哪家工具有用由调用时按工具挑（tools.effectiveOptions），设置页按工具给可选项。
      return validOptionsText(value) ? '' : `选项写法不对：${value}（写成 effort=high,fast=on）`;
    case 'TTS_PROVIDER':
      return validTTSProvider(value) ? '' : `不认识的配音工具 ${value}`;
    case 'ALIGN_PROVIDER':
      return value === AlignAuto || validAligner(value) ? '' : `不认识的对齐工具 ${value}`;
    case 'SCENE_JOBS': {
      const n = Number(value);
      return /^[0-9]+$/.test(value) && n >= 1 && n <= 16 ? '' : 'SCENE_JOBS 要是 1 到 16 的整数';
    }
    case 'MEMORY':
    case 'AUTO_APPROVE':
      return value === 'on' || value === 'off' ? '' : `${key} 只能是 on 或 off`;
  }
}

const header = `# 片场全局设置：所有项目的默认值，由客户端的「设置」页写入。
# 项目的 onset.conf 里写了的项只对那个项目生效；没写的跟着这里走。
`;

/** 写全局设置：values 里给的项覆盖，值为空串的项删掉（回到内置默认），没给的项保留。 */
export function writeGlobal(env: Record<string, string | undefined>, values: Record<string, string>, read: (file: string) => Record<string, string>): Record<string, string> {
  const file = settingsFile(env);
  if (file === '') throw new Error('无法确定全局设置文件：环境里没有 HOME');
  for (const [key, value] of Object.entries(values)) {
    const problem = validateSetting(key, value.trim());
    if (problem !== '') throw new Error(problem);
  }
  const current = fs.existsSync(file) ? read(file) : {};
  for (const [key, value] of Object.entries(values)) {
    for (const companion of ToolCompanionKeys[key] ?? []) {
      if (!Object.hasOwn(values, companion) && (current[key] ?? '') !== value.trim()) delete current[companion];
    }
    if (value.trim() === '') delete current[key];
    else current[key] = value.trim();
  }
  const lines = [...GlobalKeys, ...MachineKeys].filter((k) => current[k] !== undefined && current[k] !== '').map((k) => `${k}=${current[k]}`);
  atomicWrite(file, header + lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  return current;
}
