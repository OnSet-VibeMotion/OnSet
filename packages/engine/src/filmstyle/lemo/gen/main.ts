//
// 从固定 commit 的 lemo-opuscar 检出生成 catalog.json：generateCatalog(<检出目录>)。
//
// 检出的 HEAD 必须等于 PinnedCommit：目录清单与 commit 不一致的话，
// am film-style list 列出的风格与 am film-style use 实际装到的会对不上。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../../envutil';
import { atomicWrite } from '../../../fsutil';
import { compareBytes, marshalIndent } from '../../../gojson';
import { goExt, goQuote } from '../../../gofmt';
import { repoRoot } from '../../../preset/gen/gen';
import { PinnedCommit, type Entry } from '../lemo';
import { sortedEntries } from '../library';

/** 默认输出：仓库里 lemo 目录下的 catalog.json（Go 版是 internal/filmstyle/lemo/catalog.json）。只在开发时运行。 */
export function defaultCatalogPath(): string {
  return path.join(repoRoot(), 'packages', 'engine', 'src', 'filmstyle', 'lemo', 'catalog.json');
}

/** 取字段：encoding/json 先找同名键，再不区分大小写地找。 */
function field(raw: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(raw, name)) return raw[name];
  const key = Object.keys(raw).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : raw[key];
}

function str(raw: Record<string, unknown>, name: string): string {
  const value = field(raw, name);
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`json: cannot unmarshal ${typeof value} into Go struct field rawStyle.${name} of type string`);
  return value;
}

/**
 * 生成 catalog.json，返回写出的风格数。src 是 lemo-opuscar 检出目录，out 留空写到默认位置。
 * 对应 `go run ./internal/filmstyle/lemo/gen -src <检出> [-out <文件>]`。
 */
export function generateCatalog(src: string, out = defaultCatalogPath(), env: Record<string, string> = processEnv()): number {
  if (src === '') throw new Error('必须用 -src 指定 lemo-opuscar 检出目录');
  let head: string;
  try {
    const git = lookPath('git', env.PATH ?? '');
    const result = spawnSync(git, ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`exit status ${result.status}`);
    head = result.stdout.trim();
  } catch (err) {
    throw new Error(`读取 ${src} 的 HEAD：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (head !== PinnedCommit) throw new Error(`${src} 的 HEAD 是 ${head}，与 lemo.PinnedCommit ${PinnedCommit} 不符`);
  // filepath.Glob(styles/*/style.json)：按名字排序，Glob 的 * 不匹配以外的点开头名字照样匹配。
  const stylesDir = path.join(src, 'styles');
  const matches: string[] = [];
  let dirs: fs.Dirent[] = [];
  try {
    dirs = sortedEntries(stylesDir);
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const file = path.join(stylesDir, dir.name, 'style.json');
    try {
      fs.lstatSync(file);
      matches.push(file);
    } catch {
      // 没有 style.json。
    }
  }
  const catalog: Entry[] = [];
  for (const file of matches) {
    const slug = path.basename(path.dirname(file));
    if (slug.startsWith('_')) continue; // _template 是上游加新风格用的样板
    let decoded: Omit<Entry, 'three_js'>;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const raw = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      const rawUses = field(raw, 'uses');
      const rawDur = field(raw, 'dur');
      decoded = {
        slug: str(raw, 'slug'),
        num: str(raw, 'num'),
        en: str(raw, 'en'),
        cn: str(raw, 'cn'),
        category_en: str(raw, 'category_en'),
        category_cn: str(raw, 'category_cn'),
        film: str(raw, 'film'),
        line: str(raw, 'line'),
        line_cn: str(raw, 'line_cn'),
        uses: Array.isArray(rawUses) ? rawUses.map(String) : null,
        demo_seconds: typeof rawDur === 'number' ? rawDur : 0,
      };
    } catch (err) {
      throw new Error(`${file}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (decoded.slug !== slug) throw new Error(`${file} 的 slug 是 ${goQuote(decoded.slug)}，与目录名不符`);
    try {
      fs.statSync(path.join(src, 'styles', slug, 'STYLE.md'));
    } catch {
      throw new Error(`风格 ${slug} 缺少 STYLE.md`);
    }
    catalog.push({ ...decoded, three_js: usesThree(path.join(src, 'styles', slug, 'demo')) });
  }
  catalog.sort((a, b) => (a.num !== b.num ? compareBytes(a.num, b.num) : compareBytes(a.slug, b.slug)));
  atomicWrite(out, marshalIndent(catalog) + '\n', 0o644);
  process.stdout.write(`写出 ${out}：${catalog.length} 种风格\n`);
  return catalog.length;
}

function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  return out;
}

/**
 * demo 是否通过 importmap 引用 three.js。用到的风格安装时要把
 * three 一起带进技能目录，渲染器才能把它拷进镜头目录。
 */
export function usesThree(demo: string): boolean {
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = sortedEntries(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(file)) return true;
        continue;
      }
      if (goExt(entry.name) !== '.html') continue;
      try {
        if (fs.readFileSync(file, 'utf8').includes('node_modules/three')) return true;
      } catch {
        // 读不了就跳过。
      }
    }
    return false;
  };
  return walk(demo);
}
