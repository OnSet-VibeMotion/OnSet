/**
 * 预设生成器：把 preset 的画幅表与风格表渲染成两棵项目模板源树。移植自 internal/preset/gen。
 *
 *   assets/presets/<画幅>/              只随画幅变化（PROMPT-PRODUCTION.md）
 *   assets/styles/<风格>/<画幅>/        风格 × 画幅（frame.md、风格说明书、示例图）
 *   assets/styles/custom-draft/<画幅>/  自定义风格的草稿骨架（无示例图）
 *
 * 生成器刻意不做 YAML 重序列化：frame.md 的 frontmatter 用了 flow 映射、保留尾零的浮点写法和人工排定的键序，
 * 重新序列化一律还原不出来，会让「产物与签入版本逐字节相同」这条红线失守。这里只整体替换 canvas 与 safe_area
 * 两个块和占位符，其余原样透传。
 *
 * 模板的真相源是本目录下的 templates/（PROMPT-PRODUCTION.md 与 styles/<风格>/ 下三份模板）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { goQuote } from '../../gofmt';
import { PinnedVersion } from '../../hyperframes/constants';
import * as styleimage from '../../styleimage';
import * as preset from '../index';

export const canvasMarker = '# @@CANVAS_AND_SAFE_AREA@@';

/** 示例图在 contact sheet 里的缩略宽度，高度按画幅比例推算。 */
const thumbnailWidthPx = 405;

/** 一套风格的三份模板。 */
export interface Templates {
  frontmatter: string;
  frameBody: string;
  guideBody: string;
}

/** 模板目录：仓库里的 packages/engine/src/preset/gen/templates。 */
export function templatesDir(repo: string): string {
  return path.join(repo, 'packages', 'engine', 'src', 'preset', 'gen', 'templates');
}

/** 与风格无关的编排提示词模板。 */
export function loadProduction(repo: string): string {
  return fs.readFileSync(path.join(templatesDir(repo), 'PROMPT-PRODUCTION.md'), 'utf8');
}

/** 一套风格的模板，目录名即风格 id。 */
export function loadTemplates(repo: string, styleID: string): Templates {
  const read = (name: string) => {
    const file = path.join(templatesDir(repo), 'styles', styleID, name);
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error(`风格 ${styleID} 缺少模板 ${name}: open templates/styles/${styleID}/${name}: file does not exist`);
    }
  };
  return { frontmatter: read('frontmatter.yaml'), frameBody: read('frame.body.md'), guideBody: read('style-guide.body.md') };
}

/** frontmatter 里唯一随画幅变化的两个块；safe_area 用 flow 映射单行表示，与手写的 frame.md 一致。 */
export function canvasAndSafeArea(p: preset.Preset): string {
  const boxes = preset.resolveSafeArea(p);
  const lines = ['canvas:', `  width_px: ${p.canvas.widthPx}`, `  height_px: ${p.canvas.heightPx}`, `  fps: ${p.canvas.fps}`, '  orientation: ' + p.canvas.orientation, 'safe_area:'];
  for (const item of boxes) {
    lines.push(`  ${item.name}: {left_px: ${item.box.leftPx}, right_px: ${item.box.rightPx}, top_px: ${item.box.topPx}, bottom_px: ${item.box.bottomPx}}`);
  }
  return lines.join('\n');
}

/**
 * 替换模板里随画幅变化的占位符。版本号从 hyperframes 取，不在模板里写字面量：改了常量忘了模板，
 * 下发给渲染工具的锁定指令会停在旧版本上，而 am init 装的已经是新版。
 */
function substitute(p: preset.Preset, s: string): string {
  return s.split('{{CANVAS}}').join(preset.canvasLabel(p.canvas)).split('{{HYPERFRAMES_VERSION}}').join(PinnedVersion);
}

/** {{NAME}} 或带整数偏移的 {{NAME+8}} / {{NAME-16}}。偏移留给个别风格在推导值上做微调。 */
const numericPlaceholder = /\{\{([A-Z_]+)([+-][0-9]+)?\}\}/g;

/**
 * 替换风格模板里随画幅变化的占位符：像素一律从已推导的安全区算出，措辞取自画幅表。
 * 未知占位符直接报错，不原样留在产物里。
 */
export function substituteCanvas(p: preset.Preset, s: string): string {
  const box = new Map(preset.resolveSafeArea(p).map((item) => [item.name, item.box]));
  const get = (name: string) => box.get(name) ?? { leftPx: 0, rightPx: 0, topPx: 0, bottomPx: 0 };
  const width = p.canvas.widthPx;
  const numbers: Record<string, number> = {
    CONTENT_LEFT_PX: get('main_content').leftPx,
    CONTENT_WIDTH_PX: width - get('main_content').leftPx - get('main_content').rightPx,
    SUBTITLE_MAX_WIDTH_PX: width - get('subtitles').leftPx - get('subtitles').rightPx,
    COVER_MAX_WIDTH_PX: width - get('cover_title').leftPx - get('cover_title').rightPx,
    CRITICAL_LEFT_PX: get('critical_text').leftPx,
    CRITICAL_WIDTH_PX: width - get('critical_text').leftPx - get('critical_text').rightPx,
  };
  const words: Record<string, string> = {
    ORIENTATION: p.platform.orientation,
    PLATFORM_UI: p.platform.ui,
    UI_ZONE: p.platform.zone,
    AVOIDANCE_ZONES: p.platform.avoidance(get('critical_text')),
  };
  const unknown: string[] = [];
  const out = s.replace(numericPlaceholder, (match: string, name: string, offset: string | undefined) => {
    if (name in numbers) return String(numbers[name] + (offset ? parseInt(offset, 10) : 0));
    if (name in words && !offset) return words[name];
    if (name === 'CANVAS' || name === 'HYPERFRAMES_VERSION' || name.startsWith('SCENE_')) return match;
    unknown.push(match);
    return match;
  });
  if (unknown.length > 0) throw new Error(`预设 ${p.id} 遇到未知占位符：${unknown.join(' ')}`);
  return substitute(p, out);
}

/** 画幅源树的文件：只有编排提示词随画幅变化而与风格无关。 */
export function renderCanvas(p: preset.Preset, production: string): Map<string, string> {
  return new Map([['PROMPT-PRODUCTION.md', substituteCanvas(p, production)]]);
}

/** 模板里的 style_id / style_name 必须与风格表一致：validate 靠 style_id 反查说明书文件名。 */
function checkIdentity(style: preset.Style, frontmatter: string): void {
  for (const line of [`style_id: ${style.id}\n`, `style_name: ${style.name}\n`]) {
    if (!frontmatter.includes('\n' + line) && !frontmatter.startsWith(line)) {
      throw new Error(`风格 ${style.id} 的 frontmatter 模板缺少 ${goQuote(line.trim())}，与风格表不一致`);
    }
  }
}

/** 风格 × 画幅源树内相对路径到文件内容的映射。 */
export function renderStyle(p: preset.Preset, style: preset.Style, tpl: Templates): Map<string, string> {
  const block = canvasAndSafeArea(p);
  if (!tpl.frontmatter.includes(canvasMarker)) throw new Error(`风格 ${style.id} 的 frontmatter 模板缺少标记 ${canvasMarker}`);
  checkIdentity(style, tpl.frontmatter);
  const frontmatter = substituteCanvas(p, tpl.frontmatter.replace(canvasMarker, block));
  // 原文件结构是 ---\n<frontmatter>---<body>，body 自带前导换行。
  const compose = (body: string) => {
    let text = substituteCanvas(p, body);
    if (p.layoutNotes) text = text.replace(/\n+$/, '') + '\n' + p.layoutNotes;
    return '---\n' + frontmatter + '---' + text;
  };
  return new Map([
    ['frame.md', compose(tpl.frameBody)],
    [preset.guideDoc(style), compose(tpl.guideBody)],
  ]);
}

/** 生成器要产出的全部风格：内置风格加自定义草稿骨架（它同样随画幅变化、同样要过 CI 的幂等门）。 */
export function generatedStyles(): preset.Style[] {
  return [...preset.allStyles(), preset.CustomStyle];
}

export function selectTargets(id: string): preset.Preset[] {
  if (id === '') return preset.all();
  const p = preset.byID(id);
  if (!p) throw new Error(`未知预设 ${goQuote(id)}，可选：${preset.ids().join(' ')}`);
  return [p];
}

export function selectStyles(id: string): preset.Style[] {
  if (id === '') return generatedStyles();
  if (id === preset.CustomStyle.id) return [preset.CustomStyle];
  const s = preset.styleByID(id);
  if (!s) throw new Error(`未知风格 ${goQuote(id)}，可选：${preset.styleIDs().join(' ')}`);
  return [s];
}

export interface Log {
  write(text: string): void;
}

/** 把 files 写进 root/dir，按路径排序输出日志，让日志稳定可比对。 */
function writeFiles(root: string, dir: string, files: Map<string, string>, out: Log): void {
  for (const name of [...files.keys()].sort()) {
    const file = path.join(root, dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, files.get(name)!, { mode: 0o644 });
    out.write(`generated ${path.posix.join(dir.split(path.sep).join('/'), name)}\n`);
  }
}

/**
 * 把画幅源树与风格 × 画幅源树的文本产物写进 root/assets/。examples 为真时另用 rsvg-convert 重渲染示例 PNG
 * （默认关闭：不同版本的 rsvg-convert 输出字节不同，纳进幂等门会让门随机失败）。
 */
export function generate(repo: string, root: string, targets: preset.Preset[], styles: preset.Style[], examples: boolean, out: Log): void {
  const production = loadProduction(repo);
  for (const p of targets) {
    writeFiles(root, path.join('assets', 'presets', p.id), renderCanvas(p, production), out);
  }
  for (const style of styles) {
    const tpl = loadTemplates(repo, style.id);
    for (const p of targets) {
      let files: Map<string, string>;
      try {
        files = renderStyle(p, style, tpl);
      } catch (err) {
        throw new Error(`渲染风格 ${style.id} × 画幅 ${p.id}: ${(err as Error).message}`);
      }
      const dir = path.join('assets', 'styles', style.id, p.id);
      writeFiles(root, dir, files, out);
      // 草稿骨架没有示例图：示例图由定风格阶段按用户描述现画。
      if (examples && style.id !== preset.CustomStyle.id) {
        try {
          renderExamples(repo, path.join(root, dir), p, style, out);
        } catch (err) {
          throw new Error(`风格 ${style.id} × 画幅 ${p.id} 的示例图: ${(err as Error).message}`);
        }
      }
    }
  }
}

/** 把该风格 × 画幅手写的 4 张 SVG 转成 PNG 并拼 contact sheet。SVG 是手工绘制的排版基准，生成器不改动它们的内容。 */
export function renderExamples(repo: string, dir: string, p: preset.Preset, style: preset.Style, out: Log): void {
  const examples = path.join(dir, 'assets', 'style-guide', 'examples');
  // 先查手绘 SVG 是否齐全：缺稿是作者该修的问题，不该被缺工具的报错盖住。
  for (const name of preset.ArchetypeIDs) {
    const svg = path.join(examples, name + '.svg');
    if (!fs.existsSync(svg)) throw new Error(`缺少手写示例图 ${name}.svg: stat ${svg}: no such file or directory`);
  }
  styleimage.checkRenderer();
  const [fontDir, cleanup] = styleimage.decompressFonts(exampleFonts(repo, style));
  try {
    const pngPaths: string[] = [];
    for (const name of preset.ArchetypeIDs) {
      const svgPath = path.join(examples, name + '.svg');
      const pngPath = path.join(examples, name + '.png');
      styleimage.renderSVG(svgPath, pngPath, fontDir);
      styleimage.compact(pngPath);
      out.write(`generated ${pngPath}\n`);
      pngPaths.push(pngPath);
    }
    const thumb = `${thumbnailWidthPx}x${Math.trunc((thumbnailWidthPx * p.canvas.heightPx) / p.canvas.widthPx)}`;
    const sheet = path.join(examples, 'contact-sheet.png');
    styleimage.contactSheet(pngPaths, sheet, thumb, style.sheetBackground, '4x1');
    out.write(`generated ${sheet}\n`);
  } finally {
    cleanup();
  }
}

/** 示例图可用的字体：共用正文字体加该风格从字体池带的字体，与 am init 下发给项目的字体完全一致。 */
function exampleFonts(repo: string, style: preset.Style): string[] {
  return [
    ...preset.SharedFonts.map((f) => path.join(repo, 'assets', 'shared', 'assets', 'fonts', f.file)),
    ...style.fonts.map((f) => path.join(repo, 'assets', 'fontpool', f.file)),
  ];
}

/** 从 start 向上找到仓库根：同时有 assets/shared 与 package.json 的那一层。 */
export function repoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'assets', 'shared'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('找不到仓库根目录（向上未发现含 assets/shared 的 package.json 目录）');
    dir = parent;
  }
}
