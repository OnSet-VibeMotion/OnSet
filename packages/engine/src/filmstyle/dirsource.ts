/**
 * 目录式风格库：一个目录里每种风格一个子目录（目录名就是风格的 slug），子目录里至少有 STYLE.md，
 * 可选 style.json（名字、分类、顺序、一句话说明、标记）、SKILL.md、poster.jpg / poster.png 与其他参考素材。
 *
 * 第三方插件清单的 film_styles 就是这种风格库（flow.syncStyleSources 按项目换上）；内置插件也可以拿它登记
 * 一个随插件下发的风格库（ctx.filmStyleSource(new DirectorySource(...))）。风格库在本机目录里，不联网、没有前置资源。
 * 装进项目时整个子目录拷进去，缺 SKILL.md 时补一份通用的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes } from '../gojson';
import { type Source, type Style } from './filmstyle';
import { GuideFile, StyleFile } from './install';

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
  /** 补出来的 SKILL.md 里说它从哪来（例如「用户添加的第三方插件「假发布」」）。 */
  origin: string;
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

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
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
    copyTree(from, dir);
    if (!fs.existsSync(path.join(dir, GuideFile))) {
      fs.writeFileSync(
        path.join(dir, GuideFile),
        `# ${style.cn}\n\n这种整片风格来自${this.opts.origin}。动手前完整读同目录的 STYLE.md，照它定画面的配色、字体、构图与动效；同目录里的其他文件是它附带的参考素材，按 STYLE.md 的说明用。\n`,
      );
    }
    return this.opts.version;
  }
}
