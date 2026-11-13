/**
 * 全局设置：用户级的一份 settings.conf（<数据目录>/am/settings.conf，AM_SETTINGS_FILE 覆盖），
 * 客户端「设置」页写它。它是所有项目的默认值，取值顺序是
 *
 *   环境变量 > 项目 .env > 项目 article-to-motion.conf > 全局设置 > 内置默认
 *
 * 项目里写了的项只对那个项目生效；没写（或写成 KEY= 空值）的跟着全局走，改一次全局，所有这类项目都变。
 * 新项目的 article-to-motion.conf 里这几项留空，所以默认跟随全局。
 *
 * 文件格式与 article-to-motion.conf 相同（KEY=VALUE、# 注释），由 writeGlobal 整份重写。
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../envutil';
import { atomicWrite } from '../fsutil';
import { ValidTools } from '../tools';
import { AlignAuto, defaultTTSProvider, validAligner, validTTSProvider } from './providers';

export const SettingsFileEnv = 'AM_SETTINGS_FILE';

/** 设置页管的几项：「什么用什么」。 */
export const GlobalKeys = ['ORCHESTRATOR', 'RENDERER', 'TTS_PROVIDER', 'ALIGN_PROVIDER', 'SCENE_JOBS', 'MEMORY', 'AUTO_APPROVE'] as const;
export type GlobalKey = (typeof GlobalKeys)[number];

/**
 * 内置默认：全局设置也没写时用它。配音按平台选（defaultTTSProvider：Apple Silicon 用本机 Breeze），
 * 其余与以前项目模板里写死的值相同。
 */
export const GlobalDefaults: Record<GlobalKey, string> = {
  ORCHESTRATOR: 'codex',
  RENDERER: 'claude',
  TTS_PROVIDER: defaultTTSProvider(),
  ALIGN_PROVIDER: AlignAuto,
  SCENE_JOBS: '3',
  MEMORY: 'on',
  // 客户端里编排工具要跑白名单外的命令时：off 每次弹卡片问，on 直接允许（studio/permissions.ts）。
  AUTO_APPROVE: 'off',
};

export function isGlobalKey(key: string): key is GlobalKey {
  return (GlobalKeys as readonly string[]).includes(key);
}

/** 全局设置文件：AM_SETTINGS_FILE，否则 <数据目录>/am/settings.conf。环境里什么都没有时为空。 */
export function settingsFile(env: Record<string, string | undefined>): string {
  if (env[SettingsFileEnv]) return env[SettingsFileEnv]!;
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'settings.conf');
}

/** 一项设置的值合不合法；不合法时返回原因，合法返回空串。空值表示「不设」，总是合法。 */
export function validateSetting(key: string, value: string): string {
  if (!isGlobalKey(key)) return `不认识的设置项 ${key}（可设：${GlobalKeys.join(' ')}）`;
  if (value === '') return '';
  switch (key) {
    case 'ORCHESTRATOR':
    case 'RENDERER':
      return ValidTools.has(value) ? '' : `${key} 只能是 ${[...ValidTools].join(' ')}`;
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

const header = `# ArticleToMotion 全局设置：所有项目的默认值，由客户端的「设置」页写入。
# 项目的 article-to-motion.conf 里写了的项只对那个项目生效；没写的跟着这里走。
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
    if (value.trim() === '') delete current[key];
    else current[key] = value.trim();
  }
  const lines = GlobalKeys.filter((k) => current[k] !== undefined && current[k] !== '').map((k) => `${k}=${current[k]}`);
  atomicWrite(file, header + lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  return current;
}
