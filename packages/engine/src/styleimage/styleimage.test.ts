import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRenderer, compact, contactSheet, decompressFonts, fontconfigWith, quantizeThreshold, renderSVG } from './styleimage';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-styleimage-'));
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});
const unix = process.platform !== 'win32';

describe('styleimage', () => {
  // 缺 rsvg-convert 时必须报错并说清原因。
  // 退回 ImageMagick 是不可接受的降级：它的内置 SVG 渲染器返回 0 却产出黑底无字的图。
  it('renderSVG requires rsvg-convert', () => {
    process.env.PATH = temp();
    expect(() => renderSVG('in.svg', 'out.png')).toThrow(/rsvg-convert/);
  });

  it.skipIf(!unix)('renderSVG invokes rsvg-convert with output flag', () => {
    const bin = temp();
    const work = temp();
    // 桩把实参记进 args.log，并按 -o 指定的路径产出文件。
    const script =
      '#!/bin/sh\necho "$@" > "' +
      path.join(work, 'args.log') +
      '"\n' +
      'while [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; : > "$1"; exit 0; fi\n  shift\ndone\nexit 1\n';
    fs.writeFileSync(path.join(bin, 'rsvg-convert'), script, { mode: 0o755 });
    process.env.PATH = bin;

    const png = path.join(work, 'out.png');
    renderSVG(path.join(work, 'in.svg'), png);
    expect(fs.existsSync(png)).toBe(true);
    const args = fs.readFileSync(path.join(work, 'args.log'), 'utf8');
    // -background 会让 ImageMagick 落进内置渲染器；这里确认没有沿用那套参数。
    expect(args).not.toContain('-background');
    expect(args).toContain('-o');
  });

  it.skipIf(!unix)('renderSVG reports renderer failure', () => {
    const bin = temp();
    fs.writeFileSync(path.join(bin, 'rsvg-convert'), "#!/bin/sh\necho 'boom' >&2\nexit 3\n", { mode: 0o755 });
    process.env.PATH = bin;
    expect(() => renderSVG('in.svg', 'out.png')).toThrow('rsvg-convert 渲染 in.svg 失败: exit status 3: boom');
  });

  it('contactSheet requires ImageMagick', () => {
    process.env.PATH = temp();
    expect(() => contactSheet(['a.png'], 'out.png', '405x540', '#D5DEEB', '4x1')).toThrow();
  });

  it('checkRenderer requires rsvg-convert', () => {
    process.env.PATH = temp();
    expect(() => checkRenderer()).toThrow(/rsvg-convert/);
  });

  // 临时 fontconfig 必须引入系统默认配置、追加字体目录，并对路径做 XML 转义。
  it('fontconfigWith includes system config and escapes dirs', () => {
    const dir = path.join(temp(), 'a&b<c>');
    fs.mkdirSync(dir, { recursive: true });
    const [file, cleanup] = fontconfigWith([dir]);
    const text = fs.readFileSync(file, 'utf8');
    for (const want of ['<include ignore_missing="yes">/etc/fonts/fonts.conf</include>', 'a&amp;b&lt;c&gt;', '<cachedir>']) {
      expect(text).toContain(want);
    }
    cleanup();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('decompressFonts without fonts needs no tool', () => {
    process.env.PATH = temp();
    const [dir, cleanup] = decompressFonts([]);
    try {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('decompressFonts requires fonttools', () => {
    process.env.PATH = temp();
    expect(() => decompressFonts(['x.woff2'])).toThrow(/fonttools/);
  });

  // 用桩代替 fonttools：检查调用参数与产物命名（x.woff2 → x.ttf）。
  it.skipIf(!unix)('decompressFonts names output after source', () => {
    const bin = temp();
    const stub = '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; : > "$1"; exit 0; fi\n  shift\ndone\nexit 1\n';
    fs.writeFileSync(path.join(bin, 'fonttools'), stub, { mode: 0o755 });
    process.env.PATH = bin;
    const [dir, cleanup] = decompressFonts(['/fonts/pixel-400.woff2']);
    try {
      expect(fs.existsSync(path.join(dir, 'pixel-400.ttf'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it.skipIf(!unix)('decompressFonts reports tool failure', () => {
    const bin = temp();
    fs.writeFileSync(path.join(bin, 'fonttools'), '#!/bin/sh\necho boom >&2\nexit 2\n', { mode: 0o755 });
    process.env.PATH = bin;
    expect(() => decompressFonts(['/fonts/a.woff2'])).toThrow(/a\.woff2/);
  });

  it('compact leaves small files untouched', () => {
    process.env.PATH = temp();
    const file = path.join(temp(), 'small.png');
    fs.writeFileSync(file, 'tiny');
    compact(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('tiny');
    expect(() => compact(path.join(temp(), 'missing.png'))).toThrow(/^stat .*missing\.png: no such file or directory$/);
  });

  it.skipIf(!unix)('compact quantizes large files in place', () => {
    const bin = temp();
    // magick <in> ... PNG8:<out>：桩把最后一个参数去掉 PNG8: 前缀后写入。
    const stub = '#!/bin/sh\nfor last; do :; done\nout=${last#PNG8:}\necho quantized > "$out"\n';
    fs.writeFileSync(path.join(bin, 'magick'), stub, { mode: 0o755 });
    process.env.PATH = bin;
    const file = path.join(temp(), 'big.png');
    fs.writeFileSync(file, Buffer.alloc(quantizeThreshold + 1));
    compact(file);
    expect(fs.readFileSync(file, 'utf8').trim()).toBe('quantized');
    process.env.PATH = temp();
    fs.writeFileSync(file, Buffer.alloc(quantizeThreshold + 1));
    expect(() => compact(file)).toThrow(/magick/);
  });
});
