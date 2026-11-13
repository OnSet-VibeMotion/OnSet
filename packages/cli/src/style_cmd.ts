/**
 * 旧版字体管理操作，供存量项目使用。移植自 internal/cli/style_cmd.go。
 *
 * 字体只能来自字体池或用户自带文件：渲染机没有系统字体，临时下载的字体既不可复现，许可也说不清。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '@am/engine/assets';
import { goQuote } from '@am/engine/gofmt';
import * as preset from '@am/engine/preset';
import * as project from '@am/engine/project';
import { padRight } from './canvas';
import { defineGroup } from './ops/cli';
import { num, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['style'],
  summary: '旧版项目的字体工具',
  description: `旧版项目或需要本地字体的镜头可以使用。

style_fonts 列出可用字体：随每个项目下发的正文字体，以及字体池里可按需拷入的字体。
style_add_font 把字体池里的字体连同许可证拷进项目的 assets/fonts/；拷入后还要在
镜头代码通过相对路径引用；不要依赖系统字体。`,
});

const fontLine = (font: preset.Font) => `  ${padRight(font.family, 32)} ${String(font.weight).padStart(4)}  ${assets.FontsDir}${font.file}\n`;
const fontData = (font: preset.Font) => ({ family: font.family, weight: font.weight, file: assets.FontsDir + font.file });

defineOp({
  name: 'style_fonts',
  cli: ['style', 'fonts'],
  summary: '列出可用字体',
  description: `列出自定义风格可以使用的全部字体：族名、字重与项目内路径。

第一组随每个项目下发；第二组在字体池里，要先用 style_add_font({"family": "<字体族>"}) 拷进项目。
不在清单里的字体只能由用户自带 woff2 文件，
不得引用本机系统字体——渲染机上没有。`,
  examples: ['style_fonts()'],
  params: {},
  run: (_p, { out }) => {
    out.write('随项目下发（无需拷入，可直接声明）：\n');
    for (const font of preset.SharedFonts) out.write(fontLine(font));
    out.write('字体池（用 style_add_font({"family": "<字体族>"}) 拷入，可加 "weight"）：\n');
    for (const font of preset.allFontsCopy()) out.write(fontLine(font));
    return { data: { shared: preset.SharedFonts.map(fontData), pool: preset.allFontsCopy().map(fontData) } };
  },
});

defineOp({
  name: 'style_add_font',
  cli: ['style', 'add-font'],
  summary: '把字体池里的字体拷进项目',
  description: `把字体池里 family 的字体文件与许可证拷进 assets/fonts/。族名不区分大小写；
不给 weight 时拷入该族全部字重。

已存在且内容相同的文件跳过，内容不同时整体失败、不覆盖。`,
  examples: ['style_add_font({"family": "LXGW WenKai"})', 'style_add_font({"family": "Fredoka", "weight": 700})'],
  params: {
    family: { type: 'string', description: '字体族名', required: true, positional: 0 },
    weight: { type: 'integer', description: '只拷入指定字重，缺省为该族全部字重' },
    project_root: { type: 'string', description: '项目根目录，缺省为当前目录' },
  },
  run: (p, { out }) => {
    const fonts = poolFonts(str(p.family), num(p.weight));
    const files = assets.fontFiles(fonts);
    const rootDir = str(p.project_root) || '.';
    // 写错目录时不能凭空建出 assets/fonts/ 还报成功。
    let isFile = false;
    try {
      isFile = fs.statSync(path.join(rootDir, 'frame.md')).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new Error(`${rootDir} 不是 am 项目（缺少 frame.md），用 project_root 指向项目根目录`);
    const result = project.initializeWithFiles(rootDir, files);
    out.write(`已拷入 ${fonts[0].family}（新增 ${result.created}，未变 ${result.unchanged}）。请在镜头代码中用相对路径引用：\n`);
    for (const font of fonts) out.write(`  - {family: ${goQuote(font.family)}, weight: ${font.weight}, file: ${goQuote(assets.FontsDir + font.file)}}\n`);
    return { data: { fonts: fonts.map(fontData), created: result.created, unchanged: result.unchanged } };
  },
});

/** 按族名（不区分大小写）与可选字重在字体池里查字体。 */
export function poolFonts(family: string, weight: number): preset.Font[] {
  const matched: preset.Font[] = [];
  const weights: string[] = [];
  for (const font of preset.allFontsCopy()) {
    if (font.family.toLowerCase() !== family.trim().toLowerCase()) continue;
    weights.push(String(font.weight));
    if (weight === 0 || font.weight === weight) matched.push(font);
  }
  if (weights.length === 0) throw new Error(`字体池里没有字体族 ${goQuote(family)}，用 style_fonts() 查看可选字体`);
  if (matched.length === 0) throw new Error(`字体族 ${goQuote(family)} 没有字重 ${weight}，可选：${weights.join(' ')}`);
  return matched;
}
