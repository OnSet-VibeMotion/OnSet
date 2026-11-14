//
// 把下载下来的 anidoodle 变成项目里能直接用的东西（am setup 的最后两步，不联网）：
//
//   1. TypeScript 转成浏览器能直接 import 的 ES 模块。用 am 自己的 Node 运行时的
//      module.stripTypeScriptTypes（transform 模式：上游用了参数属性与 <T> 断言，只剥类型不够），
//      再把相对引用补上 .js。不用 esbuild / tsc：客户端里没有它们，装它们要 npm 与原生二进制。
//   2. 从上游图鉴（一张 8×4 的总图）里裁出每种风格的海报。
//
// 产物放在构建目录（buildDir）：am 自己克隆的检出放在检出里的 .am-build/，用户自己的检出另放在
// am 的数据目录，不往用户的目录里写。全部完成写 BuildMarker（commit 与 CompilerVersion），
// 转换规则变了就递增 CompilerVersion，已下载的检出会重新转换、不必重新下载。
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { lexJS } from '../../determinism/strip';
import { sourceDir } from '../../filmstyle';
import { errorText, exists } from '../../filmstyle/gitlib';
import { cropImages, newToolchain } from '../../mediaprobe';
import { missing } from '../../prereq';
import { EngineSrc, SourceID, catalogFile, type Catalog, type Entry } from './anidoodle';

/** 转换规则的版本：改了 compileModule 或产物的布局就加一。 */
export const CompilerVersion = 1;

/** 构建完成的记录文件。 */
export const BuildMarker = 'am-build.txt';

/** 转好的模块在构建目录里的位置（下面按 EngineSrc 的相对路径放）。 */
export const ModulesDir = 'anidoodle';

/** 海报在构建目录里的位置。 */
export const PostersDir = 'posters';

/** 一份检出（与 library.ts 的 Library 相同的字段）。 */
export interface BuildTarget {
  dir: string;
  commit: string;
  managed: boolean;
}

/** 这份检出的构建目录。 */
export function buildDir(lib: BuildTarget, env: Record<string, string | undefined>): string {
  if (lib.managed) return path.join(lib.dir, '.am-build');
  const key = crypto.createHash('sha256').update(path.resolve(lib.dir)).digest('hex').slice(0, 12);
  return path.join(sourceDir(env, SourceID), 'local-' + key);
}

function markerText(commit: string): string {
  return `${commit} ${CompilerVersion}\n`;
}

/** 构建目录是否完整、与这份检出的 commit 和当前转换规则一致。 */
export function buildComplete(lib: BuildTarget, env: Record<string, string | undefined>): boolean {
  try {
    return fs.readFileSync(path.join(buildDir(lib, env), BuildMarker), 'utf8') === markerText(lib.commit);
  } catch {
    return false;
  }
}

type Strip = (code: string, options: { mode: 'transform' | 'strip'; sourceMap?: boolean }) => string;

function stripper(): Strip {
  // 按名字现取：老版本 Node 没有它，命名导入会在加载时就失败。
  const mod = nodeModule as unknown as { stripTypeScriptTypes?: Strip };
  if (typeof mod.stripTypeScriptTypes !== 'function') {
    throw new Error(`当前运行时（Node ${process.versions.node}）没有 module.stripTypeScriptTypes，转换不了 anidoodle 的 TypeScript：需要 Node 22.13 或更新`);
  }
  return mod.stripTypeScriptTypes;
}

/**
 * 一个 TypeScript 模块转成浏览器 ES 模块：去掉类型（transform 模式），去掉没当作值用到的引入，相对引用补成 .js。
 * name 只用于报错。转换时 Node 会发一条 ExperimentalWarning，这里吞掉：它会混进 am setup 的进度行。
 */
export function compileModule(ts: string, name: string): string {
  const strip = stripper();
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === 'ExperimentalWarning' && /stripTypeScriptTypes|Type Stripping/i.test(text)) return;
    (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  let js: string;
  try {
    js = strip(ts, { mode: 'transform', sourceMap: false });
  } catch (err) {
    throw new Error(`转换 ${name}：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  } finally {
    process.emitWarning = emit;
  }
  return rewriteSpecifiers(elideUnusedImports(js));
}

const namedImport = /\bimport\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*(["'])([^"'\n]+)\3[ \t]*;?/g;

/** 名字在 code 里有没有当作值出现：成员访问（a.P）与对象字面量的键（{ P: … }）不算，展开（...P）算。 */
function usedAsValue(code: string, name: string): boolean {
  const pattern = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  for (const m of code.matchAll(pattern)) {
    const before = code.slice(0, m.index).trimEnd();
    if (before.endsWith('.') && !before.endsWith('...')) continue;
    const after = code.slice(m.index! + m[0].length).trimStart();
    if (after.startsWith(':') && !after.startsWith('::') && (before.endsWith('{') || before.endsWith(','))) continue;
    return true;
  }
  return false;
}

/**
 * 去掉没有当作值用到的具名引入，整条都用不上就整条去掉——与 tsc、esbuild 对 TypeScript 的处理相同。
 * 上游有 import { P, rng } from "./core" 这种把类型与值写在一起、类型不带 type 的写法；只去类型的话
 * 浏览器会报「./core.js 没有导出 P」，整个模块加载失败（实测）。
 */
export function elideUnusedImports(js: string): string {
  const { codeOnly } = lexJS(js);
  const found = [...js.matchAll(namedImport)].filter((m) => codeOnly.startsWith('import', m.index));
  const rest = codeOnly.split('');
  for (const m of found) for (let i = m.index; i < m.index + m[0].length; i++) if (rest[i] !== '\n') rest[i] = ' ';
  const code = rest.join('');
  let out = js;
  for (const m of [...found].reverse()) {
    const def = m[1] && usedAsValue(code, m[1]) ? m[1] : '';
    const kept = m[2]!
      .split(',')
      .map((spec) => spec.trim())
      .filter((spec) => spec !== '' && usedAsValue(code, spec.split(/\s+as\s+/).pop()!));
    let replacement = '';
    if (def !== '' || kept.length > 0) {
      const named = kept.length > 0 ? `{ ${kept.join(', ')} }` : '';
      replacement = `import ${[def, named].filter((x) => x !== '').join(', ')} from ${m[3]}${m[4]}${m[3]};`;
    }
    out = out.slice(0, m.index) + replacement + out.slice(m.index + m[0].length);
  }
  return out;
}

const importPattern = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;

/** 相对引用补成 .js（写了 .ts 的换成 .js；带别的扩展名的不动，生成器会把它们挡下）。 */
export function rewriteSpecifiers(js: string): string {
  return js.replace(importPattern, (match, lead: string, quote: string, spec: string) => {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return match;
    let out = spec;
    if (out.endsWith('.ts')) out = out.slice(0, -3) + '.js';
    else if (!/\.[A-Za-z0-9]+$/.test(path.posix.basename(out))) out += '.js';
    return lead + quote + out + quote;
  });
}

/** 一段 JS 里的 import / export … from / import() 引用。 */
export function moduleImports(js: string): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(importPattern)) out.push(m[3]!);
  return out;
}

/** 全部风格要用到的模块（相对 EngineSrc），去重排序。 */
export function allModules(catalog: Catalog = catalogFile()): string[] {
  return [...new Set(catalog.styles.flatMap((s) => s.modules))].sort();
}

/** 转好的模块路径（相对构建目录下的 ModulesDir）。 */
export function compiledName(rel: string): string {
  return rel.replace(/\.ts$/, '.js');
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

/**
 * 转换全部模块并裁出海报，写完成记录。先写进 <构建目录>.partial 再整体换位，别处看到的构建目录总是完整的。
 * 缺 ffmpeg 时抛 prereq.MissingError（它是必需的前置资源，安装页先装它）。
 */
export async function build(lib: BuildTarget, opts: BuildOptions, signal?: AbortSignal): Promise<string> {
  const catalog = opts.catalog ?? catalogFile();
  const target = buildDir(lib, opts.env);
  if (buildComplete(lib, opts.env)) return target;
  const partial = target + '.partial';
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  opts.stage?.('把 TypeScript 转成浏览器模块');
  const engine = path.join(lib.dir, EngineSrc);
  for (const rel of allModules(catalog)) {
    const from = path.join(engine, rel);
    if (!exists(from)) throw new Error(`anidoodle 检出里缺少 ${path.posix.join(EngineSrc, rel)}`);
    const out = path.join(partial, ModulesDir, compiledName(rel));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, compileModule(fs.readFileSync(from, 'utf8'), rel), { mode: 0o644 });
  }
  opts.stage?.('从图鉴里裁出风格海报');
  const sheet = path.join(lib.dir, catalog.sheet.path);
  let digest: string;
  try {
    digest = crypto.createHash('sha256').update(fs.readFileSync(sheet)).digest('hex');
  } catch (err) {
    throw new Error(`读取图鉴 ${sheet}：${errorText(err)}`, { cause: err });
  }
  if (digest !== catalog.sheet.sha256) throw new Error(`图鉴 ${sheet} 与固定版本不符（sha256 ${digest}），拒绝裁切`);
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
    catalog.styles.map((s) => ({
      x: (s.cell % g.cols) * g.pitch_x + g.inset,
      y: Math.floor(s.cell / g.cols) * g.pitch_y + g.inset,
      w: g.size,
      h: g.size,
    })),
    catalog.styles.map((s) => posterFile(partial, s)),
    signal,
  );
  fs.writeFileSync(path.join(partial, BuildMarker), markerText(lib.commit), { mode: 0o644 });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(partial, target);
  return target;
}
