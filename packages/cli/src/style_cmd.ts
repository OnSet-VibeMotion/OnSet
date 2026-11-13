/**
 * 旧版字体管理命令，供存量项目使用。移植自 internal/cli/style_cmd.go。
 *
 * 字体只能来自字体池或用户自带文件：渲染机没有系统字体，临时下载的字体既不可复现，许可也说不清。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '@am/engine/assets';
import { goQuote } from '@am/engine/gofmt';
import * as preset from '@am/engine/preset';
import * as project from '@am/engine/project';
import { exactArgs, noArgs } from './cli';
import { Command, type Out, ref } from './cobra';
import { padRight } from './canvas';

export function newStyleCommand(stdout: Out): Command {
  const styleCmd = new Command({
    use: 'style',
    short: '旧版项目的字体工具',
    long: `旧版项目或需要本地字体的镜头可以使用。

fonts 列出可用字体：随每个项目下发的正文字体，以及字体池里可按需拷入的字体。
add-font 把字体池里的字体连同许可证拷进项目的 assets/fonts/；拷入后还要在
镜头代码通过相对路径引用；不要依赖系统字体。`,
  });
  const fontLine = (font: preset.Font) => `  ${padRight(font.family, 32)} ${String(font.weight).padStart(4)}  ${assets.FontsDir}${font.file}\n`;
  styleCmd.addCommand(
    new Command({
      use: 'fonts',
      args: noArgs,
      short: '列出可用字体',
      long: `列出自定义风格可以使用的全部字体：族名、字重与项目内路径。

第一组随每个项目下发；第二组在字体池里，要先用 am style add-font 拷进项目。
不在清单里的字体只能由用户自带 woff2 文件，
不得引用本机系统字体——渲染机上没有。`,
      example: '  am style fonts',
      runE: () => {
        stdout.write('随项目下发（无需拷入，可直接声明）：\n');
        for (const font of preset.SharedFonts) stdout.write(fontLine(font));
        stdout.write('字体池（用 style_add_font({"args": ["<字体族>"]}) 拷入，可加 "weight"）：\n');
        for (const font of preset.allFontsCopy()) stdout.write(fontLine(font));
      },
    }),
  );
  const projectRoot = ref('');
  const weight = ref(0);
  const addCmd = new Command({
    use: 'add-font FAMILY',
    args: exactArgs(1, 'FAMILY'),
    short: '把字体池里的字体拷进项目',
    long: `把字体池里 FAMILY 的字体文件与许可证拷进 assets/fonts/。族名不区分大小写；
不传 --weight 时拷入该族全部字重。

已存在且内容相同的文件跳过，内容不同时整体失败、不覆盖。`,
    example: `  am style add-font "LXGW WenKai"
  am style add-font Fredoka --weight 700 --project-root .`,
    runE: (_cmd, args) => {
      const fonts = poolFonts(args[0], weight.value);
      const files = assets.fontFiles(fonts);
      const rootDir = projectRoot.value || '.';
      // 写错目录时不能凭空建出 assets/fonts/ 还报成功。
      let isFile = false;
      try {
        isFile = fs.statSync(path.join(rootDir, 'frame.md')).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) throw new Error(`${rootDir} 不是 am 项目（缺少 frame.md），用 --project-root 指向项目根目录`);
      const result = project.initializeWithFiles(rootDir, files);
      stdout.write(`已拷入 ${fonts[0].family}（新增 ${result.created}，未变 ${result.unchanged}）。请在镜头代码中用相对路径引用：\n`);
      for (const font of fonts) stdout.write(`  - {family: ${goQuote(font.family)}, weight: ${font.weight}, file: ${goQuote(assets.FontsDir + font.file)}}\n`);
    },
  });
  addCmd.flags().stringVar(projectRoot, 'project-root', '', '项目根目录，缺省为当前目录');
  addCmd.flags().intVar(weight, 'weight', 0, '只拷入指定字重，缺省为该族全部字重');
  styleCmd.addCommand(addCmd);
  return styleCmd;
}

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
