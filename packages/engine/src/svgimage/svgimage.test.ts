import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contactSheet, fontconfigWith, renderSVG } from './svgimage';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-svgimage-'));
const savedPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = savedPath;
});
const unix = process.platform !== 'win32';

describe('svgimage', () => {
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
});
