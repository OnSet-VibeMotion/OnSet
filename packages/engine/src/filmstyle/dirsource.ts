/**
 * 目录式风格库：一个目录里每种风格一个子目录（目录名就是风格的 slug），子目录里至少有 STYLE.md，
 * 可选 style.json（名字、分类、顺序、一句话说明、标记）、SKILL.md、poster.jpg / poster.png 与其他参考素材。
 *
 * 第三方插件清单的 film_styles 就是这种风格库（已装的插件对所有项目可见，见 flow/styles.ts）；内置插件也可以拿它登记
 * 一个随插件下发的风格库（ctx.filmStyleSource(new DirectorySource(...))）。风格库在本机目录里，不联网、没有前置资源。
 * 装进项目时整个子目录拷进去，缺 SKILL.md 时补一份通用的。
 *
 * onlyReferenced（清单 film_styles.only_referenced）时只带实际用到的：风格目录与风格库根目录下的 assets/ 只拷
 * 风格的脚本与页面里出现过名字的文件（referencedAssets），node_modules/three/ 只拷脚本 import 到的模块
 * （threeClosure）；风格目录里其余文件照拷。不开时只拷风格子目录，库根的 assets/、node_modules/ 不带。
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import { type Source, type Style } from './filmstyle';
import { GuideFile, StyleFile } from './install';
import { referencedAssets, specifiers, threeClosure } from './select';

const metaFile = 'style.json';

export interface DirectorySourceOptions {
  /** 来源 id（第三方插件的是 x-<站 id>）。 */
  id: string;
  /** 给人看的来源名。 */
  name: string;
  /** 风格库目录。 */
  dir: string;
  /** 装进项目时记下的版本（例如插件的 commit）。 */
  version: string;
  /** 补出来的 SKILL.md 里说它从哪来（例如「用户装的第三方插件「假发布」」）。 */
  origin: string;
  /** 只带实际用到的素材与 three.js 模块（见文件头）。 */
  onlyReferenced?: boolean;
}

/** 按引用挑文件时，不整棵拷的两个目录（风格目录与库根下都认）。 */
const pickedDirs = new Set(['assets', 'node_modules']);
const scriptExtensions = new Set(['.js', '.mjs', '.html', '.json', '.css']);

/** 风格目录里的脚本与页面（相对路径 → 内容），不含 assets/ 与 node_modules/：挑素材与模块的依据。 */
function styleTexts(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name))) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (rel === '' && pickedDirs.has(entry.name)) continue;
        walk(path.join(abs, entry.name), childRel);
      } else if (entry.isFile() && scriptExtensions.has(path.extname(entry.name).toLowerCase())) {
        out.set(childRel, fs.readFileSync(path.join(abs, entry.name), 'utf8'));
      }
    }
  };
  walk(dir, '');
  return out;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function copyFile(from: string, to: string): void {
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function readMeta(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

function copyTree(from: string, to: string, skip: ReadonlySet<string> = new Set()): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`风格库里不能有符号链接：${entry.name}`);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

export class DirectorySource implements Source {
  constructor(private readonly opts: DirectorySourceOptions) {}

  id(): string {
    return this.opts.id;
  }

  name(): string {
    return this.opts.name;
  }

  gallery(): string {
    return '';
  }

  catalog(): Style[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.opts.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Style[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
      const dir = path.join(this.opts.dir, entry.name);
      if (!fs.existsSync(path.join(dir, StyleFile))) continue;
      const meta = readMeta(path.join(dir, metaFile));
      const tags = Array.isArray(meta.tags) ? meta.tags.filter((t): t is string => typeof t === 'string') : [];
      out.push({
        source: this.id(),
        slug: entry.name,
        order: text(meta.order, entry.name),
        cn: text(meta.cn, entry.name),
        en: text(meta.en, entry.name),
        category_cn: text(meta.category_cn, '插件'),
        category_en: text(meta.category_en, 'Plugin'),
        uses: null,
        summary: text(meta.summary),
        ...(tags.length > 0 ? { tags } : {}),
      });
    }
    return out.sort((a, b) => compareBytes(a.order, b.order));
  }

  location(): string {
    return this.opts.dir;
  }

  check(): void {
    if (!fs.existsSync(this.opts.dir)) throw new Error(`「${this.opts.name}」的风格库不在了：${this.opts.dir}`);
  }

  async prepare(): Promise<void> {
    // 风格库就在本机目录里，没有要下载的。
  }

  poster(_env: Record<string, string>, slug: string): string {
    for (const name of ['poster.jpg', 'poster.png']) {
      const file = path.join(this.opts.dir, slug, name);
      if (fs.existsSync(file)) return file;
    }
    throw new Error(`风格 ${slug} 没有海报`);
  }

  fill(dir: string, style: Style): string {
    const from = path.join(this.opts.dir, style.slug);
    if (!fs.existsSync(path.join(from, StyleFile))) throw new Error(`风格 ${style.slug} 缺 ${StyleFile}`);
    if (this.opts.onlyReferenced) this.fillReferenced(from, dir);
    else copyTree(from, dir);
    if (!fs.existsSync(path.join(dir, GuideFile))) {
      fs.writeFileSync(
        path.join(dir, GuideFile),
        `# ${style.cn}\n\n这种整片风格来自${this.opts.origin}。动手前完整读同目录的 STYLE.md，照它定画面的配色、字体、构图与动效；同目录里的其他文件是它附带的参考素材，按 STYLE.md 的说明用。\n`,
      );
    }
    return this.opts.version;
  }

  /** 只带用到的：风格目录照拷（除 assets/、node_modules/），素材与 three.js 模块按引用从风格目录或库根挑。 */
  private fillReferenced(from: string, dir: string): void {
    copyTree(from, dir, pickedDirs);
    const texts = styleTexts(from);
    // 风格目录自己的在前：同名文件以风格目录的为准。
    for (const root of [path.join(from, 'assets'), path.join(this.opts.dir, 'assets')]) {
      if (!isDir(root)) continue;
      for (const rel of referencedAssets(root, texts)) copyFile(path.join(root, rel), path.join(dir, 'assets', rel));
    }
    const usesThree = [...texts.values()].some((t) => specifiers(t).some((sp) => sp === 'three' || sp.startsWith('three/') || sp.startsWith('/node_modules/three/')));
    if (!usesThree) return;
    const three = [path.join(from, 'node_modules', 'three'), path.join(this.opts.dir, 'node_modules', 'three')].find((d) => fs.existsSync(path.join(d, 'build', 'three.module.js')));
    if (!three) throw new Error(`「${this.opts.name}」的风格 ${path.basename(from)} 要用 three.js，风格目录与风格库里都没有 node_modules/three`);
    for (const rel of ['LICENSE', 'package.json', ...threeClosure(three, texts)]) {
      const file = path.join(three, rel);
      if (fs.existsSync(file)) copyFile(file, path.join(dir, 'node_modules', 'three', rel));
    }
  }
}
