/**
 * Studio 项目登记文件的读写与路径解析。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { goPathError } from '../gofmt';
import { marshalIndent } from '../gojson';
import { type Project, projectJSON, type Registry } from './studio_inspect';

/** os.UserConfigDir()。 */
function userConfigDir(): string {
  const home = process.env.HOME || os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

export function defaultConfigPath(): string {
  if (process.env.ONSET_STUDIO_CONFIG) return process.env.ONSET_STUDIO_CONFIG;
  try {
    return path.join(userConfigDir(), 'onset', 'studio', 'projects.json');
  } catch {
    return path.join(os.tmpdir(), 'onset-studio-projects.json');
  }
}

export function loadRegistryFile(configPath: string): Registry {
  const registry: Registry = { schema: 1, projects: null };
  let body: string;
  try {
    body = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return registry;
    throw new Error('读取 Studio 项目登记失败：' + goPathError('open', configPath, err), { cause: err });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (err) {
    throw new Error('项目登记损坏（Studio）：' + (err as Error).message, { cause: err });
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (typeof r.schema === 'number') registry.schema = r.schema;
    if (Array.isArray(r.projects)) {
      registry.projects = r.projects.map((item) => {
        const p = (item ?? {}) as Record<string, unknown>;
        const str = (key: string) => (typeof p[key] === 'string' ? (p[key] as string) : '');
        return {
          id: str('id'),
          path: str('path'),
          name: str('name'),
          last_opened_at: str('last_opened_at') || undefined,
        };
      });
    }
    if (typeof r.last_parent === 'string' && r.last_parent !== '') registry.last_parent = r.last_parent;
    if (typeof r.skin === 'string' && r.skin !== '') registry.skin = r.skin;
  }
  if (registry.schema === 0) registry.schema = 1;
  return registry;
}

export function saveRegistryFile(configPath: string, registry: Registry): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const body =
    marshalIndent({
      schema: registry.schema,
      projects: registry.projects ? registry.projects.map(projectJSON) : null,
      last_parent: registry.last_parent || undefined,
      skin: registry.skin || undefined,
    }) + '\n';
  const tmp = path.join(dir, `.projects-${crypto.randomBytes(5).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, configPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 「在 Finder 中显示」要选中的路径。`projectID` 为空时用当前项目；`target` 是项目内的相对路径或绝对路径，
 * 空表示项目文件夹本身。解析后（含符号链接）必须在项目里，`.env` 不显示；文件还不存在（镜头还没渲染）时
 * 退到最近一层存在的上级目录。返回 `{ path, folder }`：`folder` 为 true 时直接打开它，否则在 Finder 里选中它。
 */
export function revealProjectPath(
  registry: Registry,
  currentProject: () => Project,
  projectID: string,
  target: string,
): { path: string; folder: boolean } {
  const p = projectID === '' ? currentProject() : (registry.projects ?? []).find((x) => x.id === projectID);
  if (!p) throw new Error('项目没有登记');
  const root = fs.realpathSync(p.path);
  if (target === '') return { path: root, folder: true };
  let full = path.resolve(root, target);
  const rel = path.relative(root, full);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('路径不在项目里');
  if (path.basename(full) === '.env') full = path.dirname(full);
  while (!fs.existsSync(full) && full !== root) full = path.dirname(full);
  const real = fs.realpathSync(full);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('路径不在项目里');
  return { path: real, folder: real === root };
}
