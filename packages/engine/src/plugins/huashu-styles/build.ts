//
// 把下载下来的 huashu-art-motion 变成项目里能直接用的东西（onset setup 的最后一步，不联网）：
//
//   1. engine.js 去掉预览播放器（patchEngine）：那段只在浏览器里手动预览时用，读 performance.now()，
//      HyperFrames 的 lint 直接拦下。
//   2. 每种风格一份 fonts.js（fontsScript）：只列这种风格带上的字体，路径改成镜头目录里的 huashu/lib/fonts/。
//      引擎启动时加载 FONT_FACES 里的每一个字体，列了没带的文件会启动失败；全带上的话每个镜头多 15 MB。
//   3. 从上游全风格总览图里裁出每种风格的海报。
//
// 产物放在构建目录（buildDir）：onset 自己克隆的检出放在检出里的 .onset-build/，用户自己的检出另放在 onset 的数据目录，
// 不往用户的目录里写。全部完成写 BuildMarker（commit 与 BuildVersion），改了这里的规则就递增 BuildVersion，
// 已下载的检出会重新构建、不必重新下载。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sourceDir } from '../../filmstyle';
import { errorText, exists } from '../../filmstyle/gitlib';
import { cropImages, newToolchain } from '../../mediaprobe';
import { missing } from '../../prereq';
import { EngineDir, SourceID, catalogFile, type Catalog, type Entry, type Font } from './huashu';

/** 构建规则的版本：改了 patchEngine、fontsScript 或产物的布局就加一。 */
export const BuildVersion = 1;

/** 构建完成的记录文件。 */
export const BuildMarker = 'onset-build.txt';

/** 去掉预览播放器的 engine.js 在构建目录里的位置。 */
export const EngineOut = 'engine.js';

/** 每种风格的 fonts.js（fonts/<slug>.js）与海报（posters/<slug>.jpg）。 */
export const FontsOutDir = 'fonts';
export const PostersDir = 'posters';

/** 镜头目录里引擎所在的目录名：字体路径按它写。 */
export const RuntimeDir = 'huashu';

/** 一份检出（与 library.ts 的 Library 相同的字段）。 */
export interface BuildTarget {
  dir: string;
  commit: string;
  managed: boolean;
}

/** 这份检出的构建目录。 */
export function buildDir(lib: BuildTarget, env: Record<string, string | undefined>): string {
  if (lib.managed) return path.join(lib.dir, '.onset-build');
  const key = crypto.createHash('sha256').update(path.resolve(lib.dir)).digest('hex').slice(0, 12);
  return path.join(sourceDir(env, SourceID), 'local-' + key);
}

function markerText(commit: string): string {
  return `${commit} ${BuildVersion}\n`;
}

/** 构建目录是否完整、与这份检出的 commit 和当前构建规则一致。 */
export function buildComplete(lib: BuildTarget, env: Record<string, string | undefined>): boolean {
  try {
    return fs.readFileSync(path.join(buildDir(lib, env), BuildMarker), 'utf8') === markerText(lib.commit);
  } catch {
    return false;
  }
}

const previewStart = '// ---------- 预览 UI ----------';
const previewEnd = 'boot().catch(';

function once(text: string, marker: string): number {
  const at = text.indexOf(marker);
  if (at < 0 || text.indexOf(marker, at + 1) >= 0) throw new Error(`engine.js 里「${marker}」应当恰好出现一次：上游写法已变，要同步改 build.ts 的 patchEngine`);
  return at;
}

/**
 * 去掉 engine.js 的预览播放器：从「预览 UI」那行注释到 boot() 之前（拖动条、播放按钮与读 performance.now() 的播放循环）。
 * 引擎在镜头里只由 hf-seek 驱动（接头 onset-huashu.js），用不上它。
 */
export function patchEngine(js: string): string {
  const start = once(js, previewStart);
  const end = once(js, previewEnd);
  if (end < start) throw new Error('engine.js 的预览播放器不在 boot() 之前：上游写法已变，要同步改 build.ts 的 patchEngine');
  const out = js.slice(0, start) + '// ---------- 预览 UI：片场去掉了（镜头里只由 hf-seek 驱动，见 onset-huashu.js） ----------\n' + js.slice(end);
  if (/performance\.now|requestAnimationFrame|Math\.random|Date\.now/.test(out)) throw new Error('去掉预览播放器后的 engine.js 里仍有读时钟或不带种子的随机数：上游写法已变');
  return out;
}

/** fonts.js 里一个 FONT_FACES 条目（一整行）。 */
const faceLine = /^\s*\{family:'([^']+)', url:'lib\/fonts\/([^']+)'(.*)\},?\s*$/;

/**
 * 只列 fonts 这几种字体的 fonts.js，路径改成镜头目录里的 huashu/lib/fonts/。条目的其余写法（desc）照抄上游。
 * 上游 fonts.js 里找不到某个字体，或文件名与目录不符，直接报错。
 */
export function fontsScript(upstream: string, fonts: Font[]): string {
  const lines = new Map<string, string>();
  for (const line of upstream.split('\n')) {
    const m = faceLine.exec(line);
    if (!m) continue;
    lines.set(m[1]!, `  {family:'${m[1]}', url:'${RuntimeDir}/lib/fonts/${m[2]}'${m[3]}},`);
    const want = fonts.find((f) => f.family === m[1]);
    if (want && want.file !== m[2]) throw new Error(`fonts.js 里 ${m[1]} 的文件是 ${m[2]}，目录里写的是 ${want.file}：重跑生成器`);
  }
  const kept = fonts.map((f) => {
    const line = lines.get(f.family);
    if (!line) throw new Error(`fonts.js 里没有字体 ${f.family}：上游写法已变，要重跑生成器`);
    return line;
  });
  return [
    '// 这种风格带上的字体（片场按风格从上游 lib/fonts.js 挑出，路径相对镜头目录）。',
    '// 每个字体文件注册成独立 family（文件名去扩展名），用法：ctx.font = \'96px "Cinzel-700"\'。没列在这里的上游字体没有带。',
    'window.FONT_FACES = [',
    ...kept,
    '];',
    '',
  ].join('\n');
}

/** 一种风格的 fonts.js 在构建目录里的文件。 */
export function fontsFile(build: string, entry: Pick<Entry, 'slug'>): string {
  return path.join(build, FontsOutDir, entry.slug + '.js');
}

/** 海报在构建目录里的文件。 */
export function posterFile(build: string, entry: Pick<Entry, 'slug'>): string {
  return path.join(build, PostersDir, entry.slug + '.jpg');
}

/** 一次构建。 */
export interface BuildOptions {
  env: Record<string, string>;
  catalog?: Catalog;
  /** 每完成一步汇报。 */
  stage?: (what: string) => void;
}

function readUpstream(lib: BuildTarget, rel: string): string {
  const file = path.join(lib.dir, EngineDir, rel);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读取 huashu 检出里的 ${EngineDir}/${rel}：${errorText(err)}`, { cause: err });
  }
}

/**
 * 改写引擎、生成每种风格的 fonts.js、裁出海报，写完成记录。先写进 <构建目录>.partial 再整体换位，
 * 别处看到的构建目录总是完整的。缺 ffmpeg 时抛 prereq.MissingError（它是必需的前置资源，安装页先装它）。
 */
export async function build(lib: BuildTarget, opts: BuildOptions, signal?: AbortSignal): Promise<string> {
  const catalog = opts.catalog ?? catalogFile();
  const target = buildDir(lib, opts.env);
  if (buildComplete(lib, opts.env)) return target;
  const partial = target + '.partial';
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(path.join(partial, FontsOutDir), { recursive: true });
  opts.stage?.('改写引擎与字体表');
  fs.writeFileSync(path.join(partial, EngineOut), patchEngine(readUpstream(lib, 'engine.js')), { mode: 0o644 });
  const upstreamFonts = readUpstream(lib, 'lib/fonts.js');
  for (const entry of catalog.styles) fs.writeFileSync(fontsFile(partial, entry), fontsScript(upstreamFonts, entry.fonts), { mode: 0o644 });
  opts.stage?.('从总览图里裁出风格海报');
  const sheet = path.join(lib.dir, catalog.sheet.path);
  let digest: string;
  try {
    digest = crypto.createHash('sha256').update(fs.readFileSync(sheet)).digest('hex');
  } catch (err) {
    throw new Error(`读取总览图 ${sheet}：${errorText(err)}`, { cause: err });
  }
  if (digest !== catalog.sheet.sha256) throw new Error(`总览图 ${sheet} 与固定版本不符（sha256 ${digest}），拒绝裁切`);
  const toolchain = newToolchain(opts.env);
  try {
    toolchain.ffmpegPath();
  } catch {
    throw missing('剪辑工具 ffmpeg', '裁风格海报要用它，先在工具准备页装「剪辑」');
  }
  const g = catalog.sheet;
  await cropImages(
    toolchain,
    sheet,
    catalog.styles.map((s) => ({ x: g.x0 + (s.cell % g.cols) * g.pitch_x, y: g.y0 + Math.floor(s.cell / g.cols) * g.pitch_y, w: g.w, h: g.h })),
    catalog.styles.map((s) => posterFile(partial, s)),
    signal,
  );
  for (const s of catalog.styles) if (!exists(posterFile(partial, s))) throw new Error(`没有裁出 ${s.slug} 的海报`);
  fs.writeFileSync(path.join(partial, BuildMarker), markerText(lib.commit), { mode: 0o644 });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(partial, target);
  return target;
}
