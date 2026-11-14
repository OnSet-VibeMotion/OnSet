//
// 从固定 commit 的 huashu-art-motion 检出生成 catalog.json：generateCatalog(<检出目录>)。只在开发时运行
// （gen/main.test.ts 在设了 ONSET_HUASHU_SRC 时核对，加 ONSET_UPDATE_GOLDEN=1 时重写）。
//
// 检出的 HEAD 必须等于 PinnedCommit：目录与 commit 不一致的话，列出的风格、字体与 onset setup 实际下载的会对不上。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../../../envutil';
import { atomicWrite } from '../../../fsutil';
import { compareBytes, marshalIndent } from '../../../gojson';
import { repoRoot } from '../../../preset/gen/gen';
import { EngineDir, EngineFiles, FontsDir, PinnedCommit, RecipesDir, type Catalog, type Entry, type Font, type Sheet } from '../huashu';
import { zhTable } from './zh';

/** 默认输出：仓库里 huashu-styles 插件目录下的 catalog.json。 */
export function defaultCatalogPath(): string {
  return path.join(repoRoot(), 'packages', 'engine', 'src', 'plugins', 'huashu-styles', 'catalog.json');
}

/** 总览图的几何：6 列，格子 480×270，横向每 488、纵向每 312 像素一格（上面一行是标题），从 (8, 102) 开始。 */
const sheetGeometry: Omit<Sheet, 'path' | 'sha256'> = { cols: 6, x0: 8, y0: 102, pitch_x: 488, pitch_y: 312, w: 480, h: 270 };

const sheetPath = 'assets/全风格总览.jpg';

/** 随每种风格带上的通用说明：纯代码怎么画、哪些做法被证明有效、换题材时怎么提炼风格。 */
const references = ['references/04-纯代码绘制.md', 'references/07-正面经验.md', 'references/15-跨场景风格提炼.md'];

/**
 * 不随风格带的库：fonts.js 由 onset 按风格重写（build.ts 的 fontsScript）；three.min.js 没有一种接入的风格用到；
 * rig_huashu.js 是花叔本人卡通形象的骨架，上游写明他的形象不随 MIT 授权（README「许可证」）。
 */
const skippedLibs = new Set(['lib/fonts.js', 'lib/three.min.js', 'lib/rig_huashu.js']);

function headOf(src: string): string {
  const git = lookPath('git', process.env.PATH ?? '');
  const result = spawnSync(git, ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`exit status ${result.status}`);
  return result.stdout.trim();
}

/** index.html 里按顺序加载的库脚本（相对 EngineDir），去掉 skippedLibs。 */
export function libScripts(indexHTML: string): string[] {
  const out: string[] = [];
  for (const m of indexHTML.matchAll(/<script src="(lib\/[^"]+\.js)"><\/script>/g)) if (!skippedLibs.has(m[1]!)) out.push(m[1]!);
  if (out.length === 0) throw new Error('index.html 里没有找到 lib/ 下的脚本：上游页面结构已变');
  return out;
}

/** lib/fonts.js 的 FONT_FACES：family → 文件名（FontsDir 下）。 */
export function fontFaces(fontsJS: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of fontsJS.matchAll(/\{family:'([^']+)', url:'lib\/fonts\/([^']+)'/g)) out.set(m[1]!, m[2]!);
  if (out.size === 0) throw new Error('lib/fonts.js 里没有找到 FONT_FACES 条目：上游写法已变');
  return out;
}

/** 上游风格索引（风格配方/INDEX.md）里一种风格的一行。 */
export interface IndexRow {
  layer: string;
  technique: string;
  motifs: string;
  quality: string;
  weakness: string;
}

/** 解析 INDEX.md：「## 材料层…」「## 时代标本…」两节的表格，每行 | id | 风格 | 手法 | 母题 | 转场 | 质量 | 短板 |。 */
export function indexRows(md: string): Map<string, IndexRow> {
  const out = new Map<string, IndexRow>();
  let layer = '';
  for (const line of md.split('\n')) {
    if (line.startsWith('## ')) {
      layer = line.startsWith('## 材料层') ? '材料层' : line.startsWith('## 时代标本') ? '时代标本' : '';
      continue;
    }
    if (layer === '' || !line.startsWith('| ')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 7) continue;
    const id = cells[0]!.replace(/^\[([^\]]+)\]\([^)]*\)$/, '$1');
    if (!/^\d\d_[a-z0-9_]+$/.test(id)) continue;
    out.set(id, { layer, technique: cells[2]!, motifs: cells[3]!, quality: cells[5]!, weakness: cells[6] === '—' ? '' : cells[6]! });
  }
  return out;
}

/** 场景源码里用到的字体 family（按引号里的名字认：ctx.font 写成 '38px "Kalam-700"' 或 font: 'Kalam-700'）。 */
export function sceneFonts(source: string, faces: Map<string, string>): string[] {
  return [...faces.keys()].filter((family) => source.includes(`"${family}"`) || source.includes(`'${family}'`));
}

/** 生成目录，返回风格数。src 是检出目录，out 留空写到默认位置。 */
export function generateCatalog(src: string, out = defaultCatalogPath()): number {
  if (src === '') throw new Error('必须指定 huashu-art-motion 检出目录');
  let head: string;
  try {
    head = headOf(src);
  } catch (err) {
    throw new Error(`读取 ${src} 的 HEAD：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (head !== PinnedCommit) throw new Error(`${src} 的 HEAD 是 ${head}，与 huashu.PinnedCommit ${PinnedCommit} 不符`);
  const catalog = buildCatalog(src);
  atomicWrite(out, marshalIndent(catalog) + '\n', 0o644);
  return catalog.styles.length;
}

function read(src: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(src, rel), 'utf8');
  } catch (err) {
    throw new Error(`读取 ${rel}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/** 按检出内容算出目录（不查 HEAD、不写文件）。 */
export function buildCatalog(src: string): Catalog {
  const engine = (rel: string) => `${EngineDir}/${rel}`;
  const libs = libScripts(read(src, engine('index.html')));
  for (const rel of [...libs, ...EngineFiles]) if (!fs.existsSync(path.join(src, engine(rel)))) throw new Error(`上游没有 ${engine(rel)}`);
  const faces = fontFaces(read(src, engine('lib/fonts.js')));
  const index = indexRows(read(src, `${RecipesDir}/INDEX.md`));
  const cells = new Set<number>();
  const slugs = new Set<string>();
  const ordered = Object.entries(zhTable).sort((a, b) => a[1].cell - b[1].cell);
  const styles: Entry[] = ordered.map(([id, zh], i) => {
    if (cells.has(zh.cell) || zh.cell < 0 || zh.cell >= 36) throw new Error(`gen/zh.ts 里 ${id} 的总览图格子 ${zh.cell} 重复或越界`);
    cells.add(zh.cell);
    if (slugs.has(zh.slug) || !/^[a-z0-9][a-z0-9-]*$/.test(zh.slug)) throw new Error(`gen/zh.ts 里 ${id} 的目录名 ${zh.slug} 重复或不合规`);
    slugs.add(zh.slug);
    const scene = engine(`scenes/${id}.js`);
    const card = `${RecipesDir}/${id}.md`;
    const source = read(src, scene);
    read(src, card);
    if (!source.includes(`SCENES['${id}']`)) throw new Error(`${scene} 没有注册 SCENES['${id}']`);
    const row = index.get(id);
    if (!row) throw new Error(`${RecipesDir}/INDEX.md 里没有 ${id} 这一行`);
    const families = new Set([...sceneFonts(source, faces), zh.cjk]);
    const fonts: Font[] = [...families].sort(compareBytes).map((family) => {
      const file = faces.get(family);
      if (!file) throw new Error(`${id} 要用的字体 ${family} 不在 lib/fonts.js 里`);
      if (!fs.existsSync(path.join(src, engine(`${FontsDir}/${file}`)))) throw new Error(`上游没有字体文件 ${engine(`${FontsDir}/${file}`)}`);
      return { family, file };
    });
    return {
      slug: zh.slug,
      id,
      num: String(i + 1).padStart(2, '0'),
      en: zh.en,
      cn: zh.cn,
      category_cn: zh.category_cn,
      category_en: zh.category_en,
      uses: [...zh.uses],
      layer: row.layer,
      quality: row.quality,
      weakness: row.weakness,
      technique: row.technique,
      motifs: row.motifs,
      scene,
      card,
      fonts,
      cjk: zh.cjk,
      cell: zh.cell,
    };
  });
  for (const ref of references) read(src, ref);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(src, sheetPath))).digest('hex');
  return {
    commit: PinnedCommit,
    sheet: { path: sheetPath, sha256, ...sheetGeometry },
    libs,
    references,
    styles,
  };
}
