//
// 从固定 commit 的 anidoodle 检出生成 catalog.json：generateCatalog(<检出目录>)。只在开发时运行
// （gen/main.test.ts 在设了 AM_ANIDOODLE_SRC 时核对，加 AM_UPDATE_GOLDEN=1 时重写）。
//
// 检出的 HEAD 必须等于 PinnedCommit：目录与 commit 不一致的话，列出的风格与 am setup 实际下载、
// 转换的模块会对不上。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../../envutil';
import { atomicWrite } from '../../../fsutil';
import { compareBytes, marshalIndent } from '../../../gojson';
import { repoRoot } from '../../../preset/gen/gen';
import { CoreModules, EngineSrc, PinnedCommit, SkillRoot, slugOf, type Catalog, type Entry, type Sheet } from '../anidoodle';
import { compileModule, moduleImports } from '../build';
import { zhTable } from './zh';

/** 默认输出：仓库里 anidoodle-styles 插件目录下的 catalog.json。 */
export function defaultCatalogPath(): string {
  return path.join(repoRoot(), 'packages', 'engine', 'src', 'plugins', 'anidoodle-styles', 'catalog.json');
}

/** 图鉴的几何：8 列，格子 400×444 一格（下面 50 像素是英文标签），画面约 394 见方；四周各让 6 像素。 */
const sheetGeometry: Omit<Sheet, 'path' | 'sha256'> = { cols: 8, pitch_x: 400, pitch_y: 444, inset: 6, size: 388 };

/** 随每种风格带上的通用说明：笔触标准、解剖与真实感、风格不是换色。 */
const references = ['references/styles.md', 'references/craft-bar.md', 'references/anatomy.md', 'references/realism-and-craft.md'];

interface RawStyle {
  id: string;
  name: string;
  family: string;
  medium: string;
  hero: string;
  module: string;
  drawFilm: string;
}

function headOf(src: string): string {
  const git = lookPath('git', process.env.PATH ?? '');
  const result = spawnSync(git, ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`exit status ${result.status}`);
  return result.stdout.trim();
}

/**
 * 从 entries 出发沿相对 import 展开（相对 EngineSrc）。按转换后的 JS 找引用，与浏览器实际加载的一致
 * （类型位置的 import("./x").T 转换后就没了）。引用了包或非脚本文件直接报错：它们没法随风格下发。
 */
export function moduleClosure(engineSrc: string, entries: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    if (seen.has(rel)) continue;
    const file = path.join(engineSrc, rel);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`读取 ${rel}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    seen.add(rel);
    for (const specifier of moduleImports(compileModule(text, rel))) {
      if (!specifier.startsWith('.')) throw new Error(`${rel} 引用了包 ${specifier}：不能随风格下发`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier)).replace(/\.js$/, '.ts');
      if (!fs.existsSync(path.join(engineSrc, target))) throw new Error(`${rel} 引用的 ${specifier} 不是 TypeScript 模块`);
      stack.push(target);
    }
  }
  return [...seen].sort(compareBytes);
}

/** 风格说明：references/styles/<id>.md，没有时找 <drawFilm>.md；都没有为空。 */
function styleDoc(src: string, style: RawStyle): string {
  for (const name of [style.id, style.drawFilm]) {
    const rel = `${SkillRoot}/references/styles/${name}.md`;
    if (fs.existsSync(path.join(src, rel))) return rel;
  }
  return '';
}

/** 生成目录，返回风格数。src 是检出目录，out 留空写到默认位置。 */
export function generateCatalog(src: string, out = defaultCatalogPath()): number {
  if (src === '') throw new Error('必须指定 anidoodle 检出目录');
  let head: string;
  try {
    head = headOf(src);
  } catch (err) {
    throw new Error(`读取 ${src} 的 HEAD：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (head !== PinnedCommit) throw new Error(`${src} 的 HEAD 是 ${head}，与 anidoodle.PinnedCommit ${PinnedCommit} 不符`);
  const catalog = buildCatalog(src);
  atomicWrite(out, marshalIndent(catalog) + '\n', 0o644);
  return catalog.styles.length;
}

/** 按检出内容算出目录（不查 HEAD、不写文件）。 */
export function buildCatalog(src: string): Catalog {
  const raw = JSON.parse(fs.readFileSync(path.join(src, SkillRoot, 'engine', 'styles.gen.json'), 'utf8')) as RawStyle[];
  const engineSrc = path.join(src, EngineSrc);
  const ids = raw.map((s) => s.id);
  const extra = Object.keys(zhTable).filter((id) => !ids.includes(id));
  const missingZh = ids.filter((id) => !(id in zhTable));
  if (missingZh.length > 0 || extra.length > 0) {
    throw new Error(`gen/zh.ts 与上游风格不一致：缺 ${missingZh.join('、') || '无'}；多 ${extra.join('、') || '无'}`);
  }
  const cells = new Set<number>();
  const styles: Entry[] = raw.map((style, i) => {
    const zh = zhTable[style.id]!;
    if (cells.has(zh.cell) || zh.cell < 0 || zh.cell >= raw.length) throw new Error(`gen/zh.ts 里 ${style.id} 的图鉴格子 ${zh.cell} 重复或越界`);
    cells.add(zh.cell);
    const module = style.module.replace(/^engine\/src\//, '');
    const drawFilm = path.posix.join(path.posix.dirname(module), style.drawFilm + '.ts');
    return {
      slug: slugOf(style.id),
      id: style.id,
      num: String(i + 1).padStart(2, '0'),
      en: style.name,
      cn: zh.cn,
      family: style.family,
      category_cn: zh.category_cn,
      medium: style.medium,
      hero: style.hero,
      hero_cn: zh.hero_cn,
      uses: [...zh.uses],
      doc: styleDoc(src, style),
      module,
      draw_film: drawFilm,
      modules: moduleClosure(engineSrc, [...CoreModules, module, drawFilm]),
      cell: zh.cell,
    };
  });
  const sheetPath = `${SkillRoot}/assets/styles.jpg`;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(src, sheetPath))).digest('hex');
  for (const ref of references) {
    if (!fs.existsSync(path.join(src, SkillRoot, ref))) throw new Error(`上游没有 ${ref}`);
  }
  return {
    commit: PinnedCommit,
    sheet: { path: sheetPath, sha256, ...sheetGeometry },
    references: references.map((ref) => `${SkillRoot}/${ref}`),
    styles,
  };
}
