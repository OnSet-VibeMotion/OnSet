// 移植自 internal/validate/validate_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '../preset';
import {
  builtinFixture,
  errorOf,
  presetFixture,
  presetSource,
  read,
  replaceOnce,
  setPath,
  styleFixture,
  styleFixtureFor,
  tamperBoth,
  tempDir,
} from './testsupport';
import { pngDimensions, regenerateExamples, style, validateFontStacks, validateNumericMap } from './validate';

const guidePath = () => presetSource(preset.guideDoc(preset.defaultStyle()));

describe('style', () => {
  // 素材拆成两棵源树后仓库根不再是一个可校验的项目，改为在铺好的夹具上验。
  it('passes the style guide pair', () => {
    style(styleFixture(read(presetSource('frame.md')), read(guidePath())));
  });

  it('rejects token drift and missing documents', () => {
    const root = tempDir();
    expect(() => style(root)).toThrow();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'frame.md'), read(presetSource('frame.md')));
    fs.writeFileSync(path.join(root, preset.guideDoc(preset.defaultStyle())), replaceOnce(read(guidePath()), 'width_px: 1080', 'width_px: 999'));
    expect(() => style(root)).toThrow();
  });

  describe('rejects invalid schema sections', () => {
    const cases: Record<string, [string, string]> = {
      schema: ['schema_version: 1', 'schema_version: 2'],
      identity: ['style_id: clear-system-blueprint-v1', 'style_id: [invalid]'],
      scope: ['  - knowledge_explainer', '  []'],
      canvas: ['width_px: 1080', 'width_px: 999'],
      'safe-area': ['left_px: 40', 'left_px: -1'],
      colors: ['canvas: "#F5F7FB"', 'canvas: "not-a-color"'],
      typography: ['    cover_min: 78', '    cover_min: 0'],
      spacing: ['  content_left_px: 88', '  content_left_px: -1'],
      radius: ['  pill_px: 999', '  pill_px: 10'],
      archetypes: ['  - id: proposition', '  - id: unknown'],
      motion: ['phases: {build: 0.30, breathe: 0.40, resolve: 0.30}', 'phases: {build: 0.30, breathe: 0.40, resolve: 0.10}'],
      audio: ['  sample_rate_hz: 48000', '  sample_rate_hz: 44100'],
      subtitles: ['  required: false', '  removed: false'],
      cover: ['  stable_frames: 18', '  stable_frames: 1'],
      forbidden: ['forbidden:\n  - black_or_blank_frame_zero', 'forbidden: []\n  # black_or_blank_frame_zero'],
    };
    for (const [name, [from, to]] of Object.entries(cases)) {
      it(name, () => {
        const frame = read(presetSource('frame.md'));
        const root = tempDir();
        fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
        const modified = replaceOnce(frame, from, to);
        expect(modified, `fixture replacement did not match: ${from}`).not.toBe(frame);
        fs.writeFileSync(path.join(root, 'frame.md'), modified);
        fs.writeFileSync(path.join(root, preset.guideDoc(preset.defaultStyle())), read(guidePath()));
        expect(() => style(root)).toThrow();
      });
    }
  });

  it('passes the unmodified fixture itself', () => {
    // 否则每个拒绝用例都会空过。
    style(styleFixture(read(presetSource('frame.md')), read(guidePath())));
  });

  // 渲染机是一台干净的无头 Chrome。字体栈里出现只存在于本机的系统字体时，
  // 本地渲染会因为回退而"看着正常"，云端 / CI 上排版却是错的——必须在 token 层挡住。
  describe('rejects fonts that do not ship with the project', () => {
    const cases: Record<string, [string, string]> = {
      'system-font-in-primary': [`primary_stack: '"Inter", "Noto Sans SC", sans-serif'`, `primary_stack: '"Inter", "PingFang SC", sans-serif'`],
      'system-font-in-mono': [`mono_stack: '"JetBrains Mono", "Noto Sans SC", monospace'`, `mono_stack: '"JetBrains Mono", "Hiragino Sans GB", monospace'`],
      'declaration-without-use': [
        `    - {family: "Noto Sans SC", weight: 900, file: "assets/fonts/noto-sans-sc-900.woff2"}`,
        `    - {family: "Unused Face", weight: 900, file: "assets/fonts/noto-sans-sc-900.woff2"}`,
      ],
      'missing-font-files': ['  font_files:', '  unused_key:'],
    };
    for (const [name, [from, to]] of Object.entries(cases)) {
      it(name, () => {
        const frame = read(presetSource('frame.md'));
        const guide = read(guidePath());
        // 两份文件一起改，否则失败原因会是 token 漂移而不是字体规则。
        const modifiedFrame = replaceOnce(frame, from, to);
        const modifiedGuide = replaceOnce(guide, from, to);
        expect(modifiedFrame).not.toBe(frame);
        expect(modifiedGuide).not.toBe(guide);
        const err = errorOf(() => style(styleFixture(modifiedFrame, modifiedGuide)));
        expect(err.message).toContain('typography');
      });
    }
  });

  it('rejects a declared font file that is missing', () => {
    const frame = read(presetSource('frame.md'));
    const guide = read(guidePath());
    const old = 'file: "assets/fonts/noto-sans-sc-400.woff2"';
    const replacement = 'file: "assets/fonts/absent.woff2"';
    const modifiedFrame = replaceOnce(frame, old, replacement);
    const modifiedGuide = replaceOnce(guide, old, replacement);
    expect(modifiedFrame).not.toBe(frame);
    expect(modifiedGuide).not.toBe(guide);
    expect(errorOf(() => style(styleFixture(modifiedFrame, modifiedGuide))).message).toContain('absent.woff2');
  });

  // 每套内置风格 × 画幅的产物都必须自洽，新增风格或画幅无需再改这个用例。
  describe('accepts every builtin preset', () => {
    for (const s of preset.allStyles()) {
      for (const p of preset.all()) {
        it(`${s.id}/${p.id}`, () => {
          style(builtinFixture(s, p.id));
        });
      }
    }
  });

  // frame.md 的 style_id 不在风格表里时，找不到对应说明书，必须明确报错。
  it('rejects an unknown style id', () => {
    const root = presetFixture('vertical-3x4');
    tamperBoth(root, 'style_id: ' + preset.defaultStyle().id, 'style_id: unknown-style-v1');
    expect(errorOf(() => style(root)).message).toContain('未知风格');
  });

  // 手改安全区在改造前查不出来：旧校验只看字段齐全且非负。
  it('rejects a tampered safe area', () => {
    const root = presetFixture('vertical-3x4');
    tamperBoth(root, 'top_px: 990', 'top_px: 1000');
    expect(errorOf(() => style(root)).message).toContain('subtitles');
  });

  it('rejects an unknown canvas', () => {
    const root = presetFixture('vertical-3x4');
    tamperBoth(root, 'height_px: 1440', 'height_px: 1600');
    expect(errorOf(() => style(root)).message).toContain('vertical-9x16');
  });

  // 9:16 的 frame.md 配 3:4 的示例图必须被挡住。
  it('rejects examples from another canvas', () => {
    const dir = path.join(path.dirname(presetSource()), 'vertical-9x16');
    const root = styleFixtureFor('vertical-3x4', read(path.join(dir, 'frame.md')), read(path.join(dir, preset.guideDoc(preset.defaultStyle()))));
    expect(errorOf(() => style(root)).message).toContain('1080x1920');
  });

  // display_stack 可选：声明了就按同样规则校验，展示字可以只出现在这里。
  it('accepts an optional display stack', () => {
    const typography: Record<string, unknown> = {
      primary_stack: '"Noto Sans SC", sans-serif',
      mono_stack: '"JetBrains Mono", monospace',
      display_stack: '"Pixel Display", "Noto Sans SC", sans-serif',
      font_files: [
        { family: 'Noto Sans SC', weight: 400, file: 'assets/fonts/a.woff2' },
        { family: 'Pixel Display', weight: 400, file: 'assets/fonts/b.woff2' },
      ],
    };
    validateFontStacks(typography);
    typography.display_stack = '"PingFang SC", sans-serif';
    expect(() => validateFontStacks(typography)).toThrow();
  });
});

describe('regenerateExamples', () => {
  it.skipIf(process.platform === 'win32')('uses ImageMagick and writes all artifacts', () => {
    const root = tempDir();
    const bin = path.join(root, 'bin');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'frame.md'), read(presetSource('frame.md')));
    fs.writeFileSync(path.join(root, preset.guideDoc(preset.defaultStyle())), read(guidePath()));
    // montage 的产物是最后一个参数；rsvg-convert 的产物在 -o 之后，两者桩法不同。
    fs.writeFileSync(path.join(bin, 'magick'), '#!/bin/sh\nfor last; do :; done\n: > "$last"\n', { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, 'rsvg-convert'),
      '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; : > "$1"; exit 0; fi\n  shift\ndone\nexit 1\n',
      { mode: 0o755 },
    );
    setPath(bin);
    let output = '';
    regenerateExamples(root, { write: (chunk: string) => (output += chunk) });
    for (const name of ['proposition.svg', 'proposition.png', 'comparison.svg', 'comparison.png', 'process.svg', 'process.png', 'capability_deck.svg', 'capability_deck.png', 'contact-sheet.png']) {
      expect(fs.existsSync(path.join(root, 'assets', 'style-guide', 'examples', name)), `missing ${name}`).toBe(true);
    }
    expect(output).toContain('contact-sheet.png');
  });
});

describe('pngDimensions', () => {
  it('rejects truncated and non-PNG files', () => {
    const cases: Record<string, Buffer> = {
      truncated: Buffer.from('short'),
      'wrong-signature': Buffer.concat([Buffer.from('not-png!'), Buffer.alloc(16)]),
    };
    for (const [name, body] of Object.entries(cases)) {
      const file = path.join(tempDir(), name);
      fs.writeFileSync(file, body);
      expect(() => pngDimensions(file), name).toThrow();
    }
    expect(() => pngDimensions(path.join(tempDir(), 'missing.png'))).toThrow();
    expect(() => validateNumericMap({ bad: '.nan' }, 'numbers', 0)).toThrow();
  });
});
