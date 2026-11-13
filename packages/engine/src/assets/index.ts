/**
 * am 自带的项目骨架。移植自仓库根的 assets.go。
 *
 * Go 版用 //go:embed 把 assets/ 打进二进制；TS 版从磁盘读：开发时是仓库里的 assets/，
 * 打包后是应用资源目录里的 assets/（客户端与命令行的启动方经 AM_ASSETS_DIR 告知）。
 *
 * 两棵源树：
 *   assets/shared/                 与画幅、风格都无关，所有项目共用
 *   assets/styles/<风格>/<画幅>/    风格 × 画幅（文本由生成器产出，示例图手绘）
 * 制作提示词不拷进项目：段落在 assets/prompts/ 与 assets/plugins/<id>/sections/，开工时按流程组合（flow.composeFlowPrompt）。
 * 每棵树的内部路径就是它在项目根下的目标路径，project.initialize 直接叠加拷贝，不做路径改写。
 *
 * 遍历规则照搬 go:embed：目录里名字以 . 或 _ 开头的条目一律跳过（macOS 的 .DS_Store 就靠这条挡住），
 * 只有 Go 版显式列出的 assets/shared/.env.example 与 assets/shared/.agents 两个入口例外，
 * 它们的子目录里以 . 或 _ 开头的条目照样跳过。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 显式嵌入的点开头入口（相对 assets/ 的父目录，即仓库根）。 */
const explicitDotEntries = new Set(['assets/shared/.env.example', 'assets/shared/.agents']);

let cachedRoot: string | undefined;

/** 仓库根（含 assets/ 的那一层）。AM_ASSETS_DIR 指向 assets/ 本身。 */
export function assetsBase(): string {
  if (cachedRoot) return cachedRoot;
  const explicit = process.env.AM_ASSETS_DIR;
  if (explicit) {
    cachedRoot = path.dirname(path.resolve(explicit));
    return cachedRoot;
  }
  const starts = [typeof __dirname === 'string' ? __dirname : '', process.cwd()].filter(Boolean);
  for (const start of starts) {
    let dir = path.resolve(start);
    for (;;) {
      if (fs.existsSync(path.join(dir, 'assets', 'shared', 'article-to-motion.conf'))) {
        cachedRoot = dir;
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('找不到 am 自带的 assets 目录：请设置 AM_ASSETS_DIR');
}

/** 测试用：换一个资产根目录（null 恢复默认查找）。 */
export function setAssetsBaseForTest(dir: string | null): void {
  cachedRoot = dir ?? undefined;
}

/** 一棵只读的资产树，路径都相对树根、用 / 分隔，对应 Go 的 fs.FS。 */
export class AssetTree {
  constructor(
    /** 树根在磁盘上的绝对路径。 */
    readonly dir: string,
    /** 树根相对仓库根的路径（如 assets/shared），用来判定 go:embed 的显式入口。 */
    readonly embedPath: string,
  ) {}

  private abs(rel: string): string {
    const clean = path.posix.normalize(rel).replace(/^\/+/, '');
    if (clean === '..' || clean.startsWith('../')) throw new Error(`资产路径越界：${rel}`);
    return path.join(this.dir, clean);
  }

  readFile(rel: string): Buffer {
    return fs.readFileSync(this.abs(rel));
  }

  readText(rel: string): string {
    return fs.readFileSync(this.abs(rel), 'utf8');
  }

  exists(rel: string): boolean {
    return fs.existsSync(this.abs(rel));
  }

  /** 子树，对应 fs.Sub。 */
  sub(rel: string): AssetTree {
    return new AssetTree(this.abs(rel), path.posix.join(this.embedPath, rel));
  }

  /** 目录下的直接条目（已按 go:embed 规则过滤），按名字排序。 */
  readDir(rel = '.'): { name: string; isDir: boolean }[] {
    const embedDir = path.posix.join(this.embedPath, rel);
    return fs
      .readdirSync(this.abs(rel), { withFileTypes: true })
      .filter((entry) => included(embedDir, entry.name))
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 递归列出全部文件（相对树根，/ 分隔，按 fs.WalkDir 的词法顺序），对应 fs.WalkDir 只取文件。 */
  walkFiles(): string[] {
    const out: string[] = [];
    const visit = (rel: string) => {
      for (const entry of this.readDir(rel)) {
        const child = rel === '.' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDir) visit(child);
        else out.push(child);
      }
    };
    visit('.');
    return out;
  }
}

function included(embedDir: string, name: string): boolean {
  if (!name.startsWith('.') && !name.startsWith('_')) return true;
  return explicitDotEntries.has(path.posix.join(embedDir, name));
}

function tree(rel: string): AssetTree {
  return new AssetTree(path.join(assetsBase(), rel), rel);
}

/** 整个资产目录（assets/），对应 Go 的 Files 加上 "assets/" 前缀。 */
export function files(): AssetTree {
  return tree('assets');
}

/** 与画幅无关的那棵源树。 */
export function shared(): AssetTree {
  return tree('assets/shared');
}

/** 指定风格在指定画幅下的素材树（frame.md、风格说明书、示例图）。 */
export function style(styleID: string, canvasID: string): AssetTree {
  const sub = tree(`assets/styles/${styleID}/${canvasID}`);
  if (!fs.existsSync(sub.dir)) throw new Error(`找不到风格素材 ${styleID}/${canvasID}: open assets/styles/${styleID}/${canvasID}: file does not exist`);
  if (!sub.exists('frame.md')) throw new Error(`风格素材 ${styleID}/${canvasID} 不完整，缺少 frame.md`);
  return sub;
}

/**
 * 随 am 下发的技能名。从资产树现读而不是写死：新增内置技能只要放进
 * assets/shared/.agents/skills/ 就自动受保护，不会被上游同名技能悄悄覆盖。
 */
export function builtinSkills(): Set<string> {
  const out = new Set<string>();
  for (const entry of shared().readDir('.agents/skills')) if (entry.isDir) out.add(entry.name);
  if (out.size === 0) throw new Error('内置技能树是空的：assets/shared/.agents/skills');
  return out;
}

/** 字体在用户项目里的目录，与 frame.md typography.font_files 的前缀一致。 */
export const FontsDir = 'assets/fonts/';

/** 字体池里的一款字体：文件与它的许可证。对应 preset.Font 里用到的两个字段。 */
export interface FontRef {
  file: string;
  license: string;
}

/** 从字体池取出给定字体及其许可证，键是项目内的相对路径；许可证按文件去重。 */
export function fontFiles(fonts: FontRef[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const pool = tree('assets/fontpool');
  for (const font of fonts) {
    for (const name of [font.file, font.license]) {
      if (out.has(FontsDir + name)) continue;
      if (!pool.exists(name)) throw new Error(`字体池里没有文件 ${name}`);
      out.set(FontsDir + name, pool.readFile(name));
    }
  }
  return out;
}

/** 所选风格要从字体池带进项目的文件。 */
export function styleFonts(style: { id: string; fonts: FontRef[] }): Map<string, Buffer> {
  try {
    return fontFiles(style.fonts);
  } catch (err) {
    throw new Error(`风格 ${style.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
