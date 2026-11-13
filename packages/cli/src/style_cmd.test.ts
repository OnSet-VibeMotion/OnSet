import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '@am/engine/preset';
import { Buffer, run, setenv, tempDir, writeExecutable } from './testutil';

/** 返回一个带 frame.md 的目录，add-font 靠它认出项目根。 */
function projectDir(): string {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'frame.md'), '---\n---\n');
  return root;
}

async function exec(args: string[]): Promise<{ code: number; out: string }> {
  const out = new Buffer();
  const code = await run(args, out, out);
  return { code, out: out.text };
}

/**
 * 在 PATH 里放 rsvg-convert、fonttools 与 magick 的桩。rsvg-convert 的桩写出一个只有 PNG 头的文件，
 * 宽高等于画布，足够过尺寸校验。
 */
function stubImageToolsWithPNG(width: number, height: number): void {
  const bin = tempDir();
  const header = globalThis.Buffer.alloc(24);
  globalThis.Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR', 'latin1').copy(header);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const template = path.join(bin, 'template.png');
  fs.writeFileSync(template, header);
  const copyOut = `#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; cp '${template}' "$1"; exit 0; fi\n  shift\ndone\nexit 1\n`;
  const touchOut = '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; : > "$1"; exit 0; fi\n  shift\ndone\nexit 1\n';
  const magick = '#!/bin/sh\nfor last; do :; done\n: > "$last"\n';
  writeExecutable(path.join(bin, 'rsvg-convert'), copyOut);
  writeExecutable(path.join(bin, 'fonttools'), touchOut);
  writeExecutable(path.join(bin, 'magick'), magick);
  // 桩里的 cp 要靠系统目录；真的图像工具装在 Homebrew 等目录，不在这两个里。
  setenv('PATH', [bin, '/bin', '/usr/bin'].join(path.delimiter));
}

const repoAssets = path.resolve(__dirname, '..', '..', '..', 'assets');

describe('style fonts / add-font', () => {
  it('fonts lists the whole pool', async () => {
    const { code, out } = await exec(['style', 'fonts']);
    expect(code, out).toBe(0);
    const missing = [...preset.allFontsCopy(), ...preset.SharedFonts].filter((f) => !out.includes(f.family) || !out.includes(f.file));
    expect(missing.map((f) => `${f.family}（${f.file}）`)).toEqual([]);
  });

  it('add-font rejects a non-project directory', async () => {
    const root = tempDir();
    const { code, out } = await exec(['style', 'add-font', 'Fredoka', '--project-root', root]);
    expect(code, out).not.toBe(0);
    expect(out).toContain('frame.md');
    expect(fs.existsSync(path.join(root, 'assets')), '失败时不应建出 assets/').toBe(false);
  });

  it('add-font copies the font and its license', async () => {
    const root = projectDir();
    const args = ['style', 'add-font', 'Fredoka', '--weight', '700', '--project-root', root];
    let { code, out } = await exec(args);
    expect(code, out).toBe(0);
    for (const name of [preset.FontFredoka700.file, preset.FontFredoka700.license]) {
      expect(fs.existsSync(path.join(root, 'assets', 'fonts', name)), `缺少 ${name}`).toBe(true);
    }
    expect(fs.existsSync(path.join(root, 'assets', 'fonts', preset.FontFredoka600.file)), '指定字重时不应拷入其他字重').toBe(false);
    expect(out, '输出应列出字体相对路径').toContain('assets/fonts/');
    // 重复执行是幂等的。
    ({ code, out } = await exec(args));
    expect(code, `重复执行应成功：${out}`).toBe(0);
  });

  it('add-font without --weight copies every weight', async () => {
    const root = projectDir();
    const { code, out } = await exec(['style', 'add-font', 'fredoka', '--project-root', root]);
    expect(code, out).toBe(0);
    for (const font of [preset.FontFredoka600, preset.FontFredoka700]) {
      expect(fs.existsSync(path.join(root, 'assets', 'fonts', font.file)), `缺少 ${font.file}`).toBe(true);
    }
  });

  it('add-font rejects unknown fonts and conflicts', async () => {
    const root = projectDir();
    let { code, out } = await exec(['style', 'add-font', 'Comic Sans', '--project-root', root]);
    expect(code, out).not.toBe(0);
    expect(out, '未知字体应失败并指向 style_fonts').toContain('style_fonts()');
    ({ code, out } = await exec(['style', 'add-font', 'Fredoka', '--weight', '900', '--project-root', root]));
    expect(code, `字体池里没有的字重应失败：${out}`).not.toBe(0);
    const dir = path.join(root, 'assets', 'fonts');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, preset.FontCaveat600.file), 'user font');
    ({ code, out } = await exec(['style', 'add-font', 'Caveat', '--project-root', root]));
    expect(code, `目标已存在且内容不同应失败：${out}`).not.toBe(0);
    expect(fs.readFileSync(path.join(dir, preset.FontCaveat600.file), 'utf8'), '不得覆盖用户已有的字体文件').toBe('user font');
  });

  // 端到端：旧版 init 自定义风格 → 模拟补齐兼容文件、画好 SVG → --regenerate-examples 渲染 PNG →
  // validate style 通过。草稿阶段就能出图，否则示例图要等 validate 通过才能生成，而 validate 又要先有示例图。
  it.skipIf(process.platform === 'win32')('custom style end to end', async () => {
    const canvas = preset.defaultPreset();
    const target = path.join(tempDir(), 'video');
    let { code, out } = await exec(['init', target, '--canvas', canvas.id, '--style', 'custom', '--style-brief', '暖色胶片', '--skip-hyperframes']);
    expect(code, out).toBe(0);
    // 用默认风格的 token 充当定稿结果，只换身份。
    const source = path.join(repoAssets, 'styles', preset.defaultStyle().id, canvas.id);
    const frame = fs.readFileSync(path.join(source, 'frame.md'), 'utf8');
    const final = frame.replace('style_id: ' + preset.defaultStyle().id, 'style_id: custom-warm-film');
    for (const name of ['frame.md', preset.guideDoc(preset.CustomStyle)]) fs.writeFileSync(path.join(target, name), final);
    const examples = path.join(target, 'assets', 'style-guide', 'examples');
    fs.mkdirSync(examples, { recursive: true });
    for (const id of preset.ArchetypeIDs) {
      fs.copyFileSync(path.join(source, 'assets', 'style-guide', 'examples', id + '.svg'), path.join(examples, id + '.svg'));
    }
    stubImageToolsWithPNG(canvas.canvas.widthPx, canvas.canvas.heightPx);
    ({ code, out } = await exec(['validate', 'style', '--project-root', target, '--regenerate-examples']));
    expect(code, out).toBe(0);
    expect(out, '应校验通过').toContain('旧版风格文件校验通过');
  });
});
