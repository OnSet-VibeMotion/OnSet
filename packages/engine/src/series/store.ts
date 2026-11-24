import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { goTrimSpace } from '../gofmt';
import { marshalIndent } from '../gojson';
import {
  BriefFile,
  ConfigFile,
  type CreateSeriesInput,
  DefaultNamingPattern,
  type SeriesConfig,
  type SeriesDefaults,
  slugifySeriesId,
  type UpdateSeriesPatch,
  validateSeriesId,
} from './types';

function nowISO(): string {
  return new Date().toISOString();
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = goTrimSpace(value);
  return trimmed === '' ? undefined : trimmed;
}

function normalizeDefaults(raw: unknown): SeriesDefaults {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const d = raw as Record<string, unknown>;
  const out: SeriesDefaults = {};
  const set = (k: keyof Omit<SeriesDefaults, 'extra_film_styles'>) => {
    const v = cleanOptionalString(d[k]);
    if (v !== undefined) out[k] = v;
  };
  set('canvas');
  set('delivery');
  set('narration');
  set('film_style');
  set('tts_voice');
  set('brand_kit_id');
  set('orchestrator');
  set('renderer');
  if (Array.isArray(d.extra_film_styles)) {
    const extras = [...new Set(d.extra_film_styles.map(cleanOptionalString).filter((x): x is string => !!x))];
    if (extras.length > 0) out.extra_film_styles = extras;
  }
  return out;
}

function parseSeriesConfig(raw: unknown, expectedId: string): SeriesConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('专栏配置格式无效');
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) throw new Error(`不支持的专栏配置版本：${String(r.schema)}`);
  const id = validateSeriesId(typeof r.id === 'string' && r.id !== '' ? r.id : expectedId);
  const name = cleanOptionalString(r.name);
  if (!name) throw new Error('专栏名称不能为空');
  const nextEp =
    typeof r.next_episode === 'number' && Number.isInteger(r.next_episode) && r.next_episode >= 1 ? r.next_episode : 1;
  const now = nowISO();
  return {
    schema: 1,
    id,
    name,
    description: cleanOptionalString(r.description),
    accent: cleanOptionalString(r.accent),
    parent_dir: cleanOptionalString(r.parent_dir),
    naming_pattern: cleanOptionalString(r.naming_pattern),
    next_episode: nextEp,
    defaults: normalizeDefaults(r.defaults),
    created_at: cleanOptionalString(r.created_at) ?? now,
    updated_at: cleanOptionalString(r.updated_at) ?? now,
  };
}

/** 某个专栏在库里的目录路径。 */
export function seriesDir(rootDir: string, id: string): string {
  return path.join(rootDir, validateSeriesId(id));
}

function resolveRealOrAbs(dir: string): string {
  const abs = path.resolve(dir);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** 校验目标目录不与专栏库根目录重叠（防止删除专栏时误删任何项目文件夹）。 */
export function assertOutsideSeriesRoot(seriesRoot: string, candidateDir: string, label: string): void {
  if (!seriesRoot || !candidateDir) return;
  const rootReal = resolveRealOrAbs(seriesRoot);
  const targetReal = resolveRealOrAbs(candidateDir);
  const relToRoot = path.relative(rootReal, targetReal);
  const relToTarget = path.relative(targetReal, rootReal);
  const insideRoot = relToRoot === '' || (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot));
  const containsRoot = relToTarget === '' || (!relToTarget.startsWith('..') && !path.isAbsolute(relToTarget));
  if (insideRoot || containsRoot) {
    throw new Error(`${label}不能位于或包含专栏库目录：${candidateDir}`);
  }
}

/** 校验默认保存父目录不位于专栏库内部（允许父目录位于用户主目录等祖先目录；最终项目目录仍由 bindProject 做严格重叠检查）。 */
function assertNotInsideSeriesRoot(seriesRoot: string, candidateDir: string, label: string): void {
  if (!seriesRoot || !candidateDir) return;
  const rootReal = resolveRealOrAbs(seriesRoot);
  const targetReal = resolveRealOrAbs(candidateDir);
  const relToRoot = path.relative(rootReal, targetReal);
  const insideRoot = relToRoot === '' || (!relToRoot.startsWith('..') && !path.isAbsolute(relToRoot));
  if (insideRoot) {
    throw new Error(`${label}不能位于专栏库目录内部：${candidateDir}`);
  }
}

function containsNestedProject(dir: string): boolean {
  const markers = new Set(['onset.conf', 'onset.flow.json', 'onset.series.json']);
  const walk = (cur: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isFile() && markers.has(entry.name)) return true;
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'assets') {
        if (walk(path.join(cur, entry.name))) return true;
      }
    }
    return false;
  };
  return walk(dir);
}

function writeConfig(rootDir: string, cfg: SeriesConfig): void {
  const dir = seriesDir(rootDir, cfg.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  atomicWrite(path.join(dir, ConfigFile), marshalIndent(cfg) + '\n', 0o644);
}

/** 读取单个专栏配置；不存在时返回 null。 */
export function getSeries(rootDir: string, id: string): SeriesConfig | null {
  if (!rootDir) return null;
  let valid: string;
  try {
    valid = validateSeriesId(id);
  } catch {
    return null;
  }
  const file = path.join(rootDir, valid, ConfigFile);
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return parseSeriesConfig(JSON.parse(body), valid);
}

/** 列出专栏库里全部专栏，按更新时间倒序。损坏的单个目录跳过以免拖垮首页。 */
export function listSeries(rootDir: string): SeriesConfig[] {
  if (!rootDir) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const list: SeriesConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      const cfg = getSeries(rootDir, entry.name);
      if (cfg) list.push(cfg);
    } catch {
      // 跳过损坏目录，避免影响其他专栏。
    }
  }
  list.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  return list;
}

/** 读取专栏的 brief.md（专栏级视觉与口播规范），没有时返回空串。 */
export function readBrief(rootDir: string, id: string): string {
  const file = path.join(seriesDir(rootDir, id), BriefFile);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/** 写入专栏的 brief.md；传入纯空白时移除文件。 */
export function writeBrief(rootDir: string, id: string, content: string): void {
  const dir = seriesDir(rootDir, id);
  if (!fs.existsSync(path.join(dir, ConfigFile))) throw new Error(`找不到专栏：${id}`);
  const file = path.join(dir, BriefFile);
  if (goTrimSpace(content) === '') {
    fs.rmSync(file, { force: true });
    return;
  }
  atomicWrite(file, content.endsWith('\n') ? content : content + '\n', 0o644);
}

function uniqueSlug(rootDir: string, base: string): string {
  let candidate = base;
  for (let i = 2; i <= 100; i++) {
    if (!fs.existsSync(path.join(rootDir, candidate))) return candidate;
    const suffix = `-${i}`;
    candidate = `${base.slice(0, 40 - suffix.length)}${suffix}`;
  }
  throw new Error('同类专栏名太多，请手动指定一个专栏标识');
}

/** 新建一个专栏。未指定 id 时按名称自动生成唯一 slug。 */
export function createSeries(rootDir: string, input: CreateSeriesInput): SeriesConfig {
  if (!rootDir) throw new Error('专栏库目录未配置');
  const name = cleanOptionalString(input.name);
  if (!name) throw new Error('请填写专栏名称');
  const id =
    input.id !== undefined && goTrimSpace(input.id) !== ''
      ? validateSeriesId(input.id)
      : uniqueSlug(rootDir, slugifySeriesId(name));
  const target = path.join(rootDir, id);
  if (fs.existsSync(path.join(target, ConfigFile))) throw new Error(`专栏「${id}」已存在`);
  const parentDir = cleanOptionalString(input.parent_dir);
  if (parentDir) assertNotInsideSeriesRoot(rootDir, parentDir, '专栏默认保存目录');
  const nextEp =
    typeof input.next_episode === 'number' && Number.isInteger(input.next_episode) && input.next_episode >= 1
      ? input.next_episode
      : 1;
  const now = nowISO();
  const cfg: SeriesConfig = {
    schema: 1,
    id,
    name,
    description: cleanOptionalString(input.description),
    accent: cleanOptionalString(input.accent),
    parent_dir: cleanOptionalString(input.parent_dir),
    naming_pattern: cleanOptionalString(input.naming_pattern) ?? DefaultNamingPattern,
    next_episode: nextEp,
    defaults: normalizeDefaults(input.defaults),
    created_at: now,
    updated_at: now,
  };
  writeConfig(rootDir, cfg);
  if (input.brief !== undefined && goTrimSpace(input.brief) !== '') writeBrief(rootDir, id, input.brief);
  return cfg;
}

/** 更新已有专栏配置。 */
export function updateSeries(rootDir: string, id: string, patch: UpdateSeriesPatch): SeriesConfig {
  const existing = getSeries(rootDir, id);
  if (!existing) throw new Error(`找不到专栏：${id}`);
  const nextName = patch.name !== undefined ? cleanOptionalString(patch.name) : existing.name;
  if (!nextName) throw new Error('专栏名称不能为空');
  let nextEpisode = existing.next_episode;
  if (patch.next_episode !== undefined) {
    if (!Number.isInteger(patch.next_episode) || patch.next_episode < 1) {
      throw new Error('下一期期号必须是正整数');
    }
    nextEpisode = patch.next_episode;
  }
  const nextParentDir = patch.parent_dir !== undefined ? cleanOptionalString(patch.parent_dir) : existing.parent_dir;
  if (nextParentDir) assertNotInsideSeriesRoot(rootDir, nextParentDir, '专栏默认保存目录');
  const updated: SeriesConfig = {
    ...existing,
    name: nextName,
    description: patch.description !== undefined ? cleanOptionalString(patch.description) : existing.description,
    accent: patch.accent !== undefined ? cleanOptionalString(patch.accent) : existing.accent,
    parent_dir: nextParentDir,
    naming_pattern:
      patch.naming_pattern !== undefined ? cleanOptionalString(patch.naming_pattern) : existing.naming_pattern,
    next_episode: nextEpisode,
    defaults: patch.defaults !== undefined ? normalizeDefaults(patch.defaults) : existing.defaults,
    updated_at: nowISO(),
  };
  writeConfig(rootDir, updated);
  if (patch.brief !== undefined) writeBrief(rootDir, existing.id, patch.brief);
  return updated;
}

/** 新建或归入一期后，若期号不小于当前 next_episode 则推进下一期编号。 */
export function advanceNextEpisode(rootDir: string, id: string, episode: number): SeriesConfig | null {
  if (!Number.isInteger(episode) || episode < 1) return null;
  const existing = getSeries(rootDir, id);
  if (!existing) return null;
  if (episode < existing.next_episode) return existing;
  return updateSeries(rootDir, id, { next_episode: episode + 1 });
}

/** 删除专栏目录本身；绝不删除任何已绑定的视频项目目录。 */
export function deleteSeries(rootDir: string, id: string): void {
  const valid = validateSeriesId(id);
  const dir = path.join(rootDir, valid);
  if (!fs.existsSync(path.join(dir, ConfigFile))) throw new Error(`找不到专栏：${valid}`);
  if (containsNestedProject(dir)) {
    throw new Error(`专栏目录内检测到视频项目文件，为防误删已中止删除：${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
