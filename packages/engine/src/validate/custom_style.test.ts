import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '../preset';
import { builtinFixture, errorOf, read, repoAssets, setPath, tempDir } from './testsupport';
import { regenerateExamples, style } from './validate';

const customID = 'custom-warm-film';

/** 把同一份内容写进 frame.md 与自定义说明书，保证两份 token 一致。 */
function writeCustomPair(root: string, text: string): void {
  for (const name of ['frame.md', preset.guideDoc(preset.CustomStyle)]) fs.writeFileSync(path.join(root, name), text);
}

/** 模拟定风格阶段完成后的项目：沿用默认风格的 token 与示例图，只把身份改成自定义风格。 */
function customFixture(presetID: string): string {
  const root = builtinFixture(preset.defaultStyle(), presetID);
  let text = read(path.join(root, 'frame.md'));
  text = text.replace('style_id: ' + preset.defaultStyle().id, () => 'style_id: ' + customID);
  text = text.replace('style_name: ' + preset.defaultStyle().name, () => 'style_name: 暖色胶片');
  fs.rmSync(path.join(root, preset.guideDoc(preset.defaultStyle())));
  writeCustomPair(root, text);
  return root;
}

function tamperCustom(root: string, from: string, to: string): void {
  const body = read(path.join(root, 'frame.md'));
  const replaced = body.replace(from, () => to);
  if (replaced === body) throw new Error(`frame.md 里找不到 ${JSON.stringify(from)}`);
  writeCustomPair(root, replaced);
}

/** 在 PATH 里放 rsvg-convert、fonttools 与 magick 的桩，只负责创建产物文件。 */
function stubImageTools(): void {
  const bin = tempDir();
  const magick = '#!/bin/sh\nfor last; do :; done\n: > "$last"\n';
  const rsvg = '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; : > "$1"; exit 0; fi\n  shift\ndone\nexit 1\n';
  for (const [name, body] of Object.entries({ magick, 'rsvg-convert': rsvg, fonttools: rsvg })) {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  }
  setPath(bin);
}

describe('custom style', () => {
  it('accepts a finalized custom style', () => {
    for (const p of preset.all()) style(customFixture(p.id));
  });

  // am init --style custom 刚下发的草稿必须被明确拒绝，并说清还差哪一步。
  it('rejects the custom draft with an actionable message', () => {
    const root = tempDir();
    const dir = repoAssets('styles', preset.CustomStyle.id, preset.defaultPreset().id);
    for (const name of ['frame.md', preset.guideDoc(preset.CustomStyle)]) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.copyFileSync(path.join(dir, name), path.join(root, name));
    }
    const err = errorOf(() => style(root));
    expect(err.message).toContain('定风格');
    expect(err.message).toContain('style-brief.md');
  });

  it('rejects a malformed custom id', () => {
    const root = customFixture(preset.defaultPreset().id);
    tamperCustom(root, 'style_id: ' + customID, 'style_id: custom-Warm');
    expect(errorOf(() => style(root)).message).toContain('未知风格');
  });

  it('rejects a custom style without a guide', () => {
    const root = customFixture(preset.defaultPreset().id);
    fs.rmSync(path.join(root, preset.guideDoc(preset.CustomStyle)));
    expect(() => style(root)).toThrow();
  });

  describe('checks mood refs', () => {
    const ref = 'assets/style-guide/mood/film.png';
    const cases: Array<{ name: string; file: string; create: boolean; wantErr: string }> = [
      { name: '存在的参照图', file: ref, create: true, wantErr: '' },
      { name: '缺失的参照图', file: ref, create: false, wantErr: 'mood_refs' },
      { name: '逃出项目', file: '../film.png', create: false, wantErr: '项目' },
      { name: '不是图片', file: 'docs/notes.txt', create: true, wantErr: 'mood_refs' },
    ];
    for (const tc of cases) {
      it(tc.name, () => {
        const root = customFixture(preset.defaultPreset().id);
        tamperCustom(root, 'forbidden:\n', 'mood_refs:\n  - ' + tc.file + '\nforbidden:\n');
        if (tc.create) {
          const file = path.join(root, tc.file);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, 'x');
        }
        if (tc.wantErr === '') {
          style(root);
          return;
        }
        expect(errorOf(() => style(root)).message).toContain(tc.wantErr);
      });
    }
  });

  it('rejects mood refs that are not a list', () => {
    const root = customFixture(preset.defaultPreset().id);
    tamperCustom(root, 'forbidden:\n', 'mood_refs: film.png\nforbidden:\n');
    expect(errorOf(() => style(root)).message).toContain('mood_refs');
  });
});

describe('regenerateExamples for a custom style', () => {
  // 自定义风格的示例图源是项目自己的 SVG：不能拿内置模板覆盖它，也不做重着色。
  it.skipIf(process.platform === 'win32')('renders the project SVGs', () => {
    const root = customFixture(preset.defaultPreset().id);
    const examples = path.join(root, 'assets', 'style-guide', 'examples');
    const marker = '<!-- project-owned -->';
    for (const id of preset.ArchetypeIDs) {
      fs.writeFileSync(path.join(examples, id + '.svg'), '<svg>' + marker + '</svg>');
      fs.rmSync(path.join(examples, id + '.png'), { force: true });
    }
    stubImageTools();
    let output = '';
    regenerateExamples(root, { write: (chunk: string) => (output += chunk) });
    for (const id of preset.ArchetypeIDs) {
      expect(read(path.join(examples, id + '.svg')), `${id}.svg 被改写了`).toContain(marker);
      expect(fs.existsSync(path.join(examples, id + '.png')), `缺少 ${id}.png`).toBe(true);
    }
    expect(output).toContain('contact-sheet.png');
  });

  it('lists every missing custom SVG', () => {
    const root = customFixture(preset.defaultPreset().id);
    const examples = path.join(root, 'assets', 'style-guide', 'examples');
    for (const id of preset.ArchetypeIDs) fs.rmSync(path.join(examples, id + '.svg'), { force: true });
    const err = errorOf(() => regenerateExamples(root, { write: () => undefined }));
    for (const id of preset.ArchetypeIDs) expect(err.message).toContain(id + '.svg');
  });
});
