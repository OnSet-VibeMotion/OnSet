// 把 SVG 渲染成 PNG、把几张 PNG 拼成概览图（角色包预览用）。
//
// 独立成包是因为渲染器的选择有个不显眼的坑（见 renderSVG），调用点要共用同一份判断。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookPath } from '../envutil';
import { combinedOutput } from './run';

const rsvgMissing = '需要 librsvg 的 `rsvg-convert` 命令（ImageMagick 的内置 SVG 渲染器会产出黑底无字的图）';

/** Go 的 exec.LookPath：按本进程的 PATH 查找，找不到返回 null。 */
function find(name: string): string | null {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return null;
  }
}

/**
 * 把 svgPath 渲染成 pngPath。
 *
 * 必须用 rsvg-convert 而不是 ImageMagick：多数 ImageMagick 构建自带一个内置的
 * XML SVG 渲染器（magick -list format 里的 MSVG / SVG "XML x.y.z"），它会抢在
 * rsvg 委托前面接管 .svg，却渲染不出文字、也画不对背景填充——产出的是一张黑底
 * 无字的图，而且退出码为 0，不会报错。静默坏掉比直接失败更糟。
 *
 * 加 -background 参数同样会落进内置渲染器，所以这里连试都不试 ImageMagick。
 */
export function renderSVG(svgPath: string, pngPath: string, ...fontDirs: string[]): void {
  const rsvg = find('rsvg-convert');
  if (!rsvg) throw new Error(rsvgMissing);
  let env: NodeJS.ProcessEnv | undefined;
  let cleanup: (() => void) | undefined;
  if (fontDirs.length > 0) {
    const [config, done] = fontconfigWith(fontDirs);
    cleanup = done;
    // macOS 上 Homebrew 的 pango 默认走 CoreText，完全不读 fontconfig，
    // FONTCONFIG_FILE 会被静默忽略；强制 fc 后端，额外字体目录才生效。
    env = { ...process.env, FONTCONFIG_FILE: config, PANGOCAIRO_BACKEND: 'fc' };
  }
  try {
    const { output, error } = combinedOutput(rsvg, ['-o', pngPath, svgPath], env);
    if (error) throw new Error(`rsvg-convert 渲染 ${path.basename(svgPath)} 失败: ${error}: ${output.trim()}`);
  } finally {
    cleanup?.();
  }
}

/**
 * 写一份临时 fontconfig 配置：先引入系统默认配置，再追加
 * fontDirs：随项目下发的字体不装进系统也能被 rsvg-convert 找到。
 */
export function fontconfigWith(fontDirs: string[]): [string, () => void] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-fontconfig-'));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    let b = '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n';
    // FONTCONFIG_FILE 会整体替换默认配置，所以把各平台常见的默认配置都引进来。
    for (const system of ['/opt/homebrew/etc/fonts/fonts.conf', '/usr/local/etc/fonts/fonts.conf', '/etc/fonts/fonts.conf']) {
      b += `  <include ignore_missing="yes">${system}</include>\n`;
    }
    for (const fontDir of fontDirs) b += `  <dir>${xmlEscape(path.resolve(fontDir))}</dir>\n`;
    b += `  <cachedir>${xmlEscape(path.join(dir, 'cache'))}</cachedir>\n</fontconfig>\n`;
    const file = path.join(dir, 'fonts.conf');
    fs.writeFileSync(file, b, { mode: 0o644 });
    return [file, cleanup];
  } catch (err) {
    cleanup();
    throw err;
  }
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/**
 * 把若干张 PNG 拼成一张概览图。
 * 这一步的输入已经是位图，ImageMagick 的 montage 没有上面那个问题。
 *
 * tile 必须由调用方按图片数量算好传入（如 "4x1"、"4x3"）：montage 在图片数
 * 超过 tile 容量时不报错，而是静默产出 out-0.png、out-1.png 多个文件，
 * outputPath 那个路径根本不存在。这里不设默认值，逼调用方自己算。
 */
export function contactSheet(pngPaths: string[], outputPath: string, geometry: string, background: string, tile: string): void {
  const magick = find('magick');
  if (!magick) throw new Error('需要 ImageMagick 的 `magick` 命令');
  // -depth 8：montage 默认输出 16 位 PNG，体积翻倍却没有可见差别。
  const args = ['montage', ...pngPaths, '-thumbnail', geometry, '-tile', tile, '-geometry', geometry + '+10+10', '-background', background, '-depth', '8', outputPath];
  const { output, error } = combinedOutput(magick, args);
  if (error) throw new Error(`ImageMagick 生成 contact sheet 失败: ${error}: ${output.trim()}`);
}
