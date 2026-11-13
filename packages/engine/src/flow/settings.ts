/**
 * 第三方站的设置：清单里声明（ManifestSetting），值存在用户级的 <站目录>/<id>/config/ 下，所有项目共用。
 * 普通设置在 settings.json；密钥（type: secret）单独放 secrets.json，权限 0600，只交给插件自己的子进程，
 * 接口与插件页面只知道「填没填」。不进项目文件：密钥不能跟着项目被归档、被编排工具读到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { stationsDir, type Manifest, type ManifestSetting } from './external';

type Env = Record<string, string | undefined>;
export type SettingValue = string | number | boolean;

function configDir(env: Env, id: string): string {
  return path.join(stationsDir(env), id, 'config');
}

function readJSON(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 按声明的类型收下一个值；不合法就报错。空串表示清空（回到缺省值）。 */
export function coerceSetting(s: ManifestSetting, value: unknown): SettingValue | undefined {
  if (value === '' || value === null || value === undefined) return undefined;
  switch (s.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      break;
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(n)) return n;
      break;
    }
    case 'select':
      if (typeof value === 'string' && s.options.includes(value)) return value;
      throw new Error(`${s.label} 只能选 ${s.options.join(' / ')}`);
    default:
      if (typeof value === 'string') return value;
  }
  throw new Error(`${s.label} 的值不对`);
}

/** 全部设置的值（含密钥），缺省值补齐：交给插件自己的子进程。 */
export function stationSettings(env: Env, m: Manifest): Record<string, SettingValue> {
  const plain = readJSON(path.join(configDir(env, m.id), 'settings.json'));
  const secrets = readJSON(path.join(configDir(env, m.id), 'secrets.json'));
  const out: Record<string, SettingValue> = {};
  for (const s of m.settings) {
    const raw = s.type === 'secret' ? secrets[s.key] : plain[s.key];
    let v: SettingValue | undefined;
    try {
      v = coerceSetting(s, raw);
    } catch {
      v = undefined;
    }
    if (v === undefined) v = s.default;
    if (v !== undefined) out[s.key] = v;
  }
  return out;
}

/** 给界面与插件页面看的设置：密钥只给「填没填」。 */
export function publicSettings(env: Env, m: Manifest): { values: Record<string, SettingValue>; secrets_set: Record<string, boolean> } {
  const all = stationSettings(env, m);
  const values: Record<string, SettingValue> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const s of m.settings) {
    if (s.type === 'secret') secretsSet[s.key] = typeof all[s.key] === 'string' && all[s.key] !== '';
    else if (all[s.key] !== undefined) values[s.key] = all[s.key];
  }
  return { values, secrets_set: secretsSet };
}

/** 改一项设置（空值清掉）。 */
export function writeStationSetting(env: Env, m: Manifest, key: string, value: unknown): void {
  const s = m.settings.find((x) => x.key === key);
  if (!s) throw new Error(`插件 ${m.name} 没有设置 ${key}`);
  const v = coerceSetting(s, value);
  const dir = configDir(env, m.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, s.type === 'secret' ? 'secrets.json' : 'settings.json');
  const current = readJSON(file);
  if (v === undefined) delete current[key];
  else current[key] = v;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(current).sort()) sorted[k] = current[k];
  atomicWrite(file, marshalIndent(sorted) + '\n', s.type === 'secret' ? 0o600 : 0o644);
  if (s.type === 'secret') fs.chmodSync(file, 0o600);
}
