/**
 * 第三方插件带来的整片风格库：实现 filmstyle.Source，来源 ID 是 x-<站 id>。
 *
 * 风格库在插件目录里（随插件按 commit 钉死），不联网、没有前置资源。装进项目走 filmstyle.install 的同一份契约：
 * 风格目录整个拷进 .agents/skills/am-film-style/（或额外风格目录），缺 SKILL.md 时补一份通用的。
 * 插件来源只对加了这个插件的项目可见：用到风格来源的地方先 syncStyleSources(项目根)。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as filmstyle from '../filmstyle';
import { compareBytes } from '../gojson';
import { loadProjectStations, type LoadedStation } from './external';

const metaFile = 'style.json';

function readMeta(file: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** 插件没写 SKILL.md 时给渲染器的通用说明（契约要求每种风格都有它）。 */
function defaultSkill(style: filmstyle.Style, plugin: string): string {
  return `# ${style.cn}\n\n这种整片风格来自用户添加的第三方插件「${plugin}」。动手前完整读同目录的 STYLE.md，照它定画面的配色、字体、构图与动效；同目录里的其他文件是它附带的参考素材，按 STYLE.md 的说明用。\n`;
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`插件风格里不能有符号链接：${entry.name}`);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

export class PluginStyleSource implements filmstyle.Source {
  constructor(private readonly station: LoadedStation) {}

  private dir(): string {
    return path.join(this.station.dir, this.station.manifest.film_styles!.dir);
  }

  id(): string {
    return filmstyle.PluginSourcePrefix + this.station.manifest.id;
  }

  name(): string {
    return `${this.station.manifest.film_styles!.name}（插件）`;
  }

  gallery(): string {
    return '';
  }

  catalog(): filmstyle.Style[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: filmstyle.Style[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
      const dir = path.join(this.dir(), entry.name);
      if (!fs.existsSync(path.join(dir, filmstyle.StyleFile))) continue;
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
    return this.dir();
  }

  check(): void {
    if (!fs.existsSync(this.dir())) throw new Error(`插件「${this.station.manifest.name}」的风格库不在了：${this.dir()}`);
  }

  async prepare(): Promise<void> {
    // 风格库随插件下来，没有要下载的。
  }

  poster(_env: Record<string, string>, slug: string): string {
    for (const name of ['poster.jpg', 'poster.png']) {
      const file = path.join(this.dir(), slug, name);
      if (fs.existsSync(file)) return file;
    }
    throw new Error(`风格 ${slug} 没有海报`);
  }

  fill(dir: string, style: filmstyle.Style): string {
    const from = path.join(this.dir(), style.slug);
    if (!fs.existsSync(path.join(from, filmstyle.StyleFile))) throw new Error(`插件风格 ${style.slug} 缺 ${filmstyle.StyleFile}`);
    copyTree(from, dir);
    if (!fs.existsSync(path.join(dir, filmstyle.GuideFile))) fs.writeFileSync(path.join(dir, filmstyle.GuideFile), defaultSkill(style, this.station.manifest.name));
    return this.station.entry.commit || `${this.station.manifest.id}@${this.station.manifest.version}`;
  }

  envKeys(): string[] {
    return [];
  }
}

/** 按项目换上插件的风格来源（root 为空时只去掉插件来源）。 */
export function syncStyleSources(root: string, env: Record<string, string | undefined> = process.env): void {
  const stations = root === '' ? [] : loadProjectStations(root, env).stations;
  filmstyle.replacePluginSources(stations.filter((s) => s.manifest.film_styles).map((s) => new PluginStyleSource(s)));
}
