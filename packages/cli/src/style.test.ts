// canvas.test.ts 没有覆盖的 init 用例
// （resolveStyle / stylePicker / resolveStyleBrief 的纯函数用例在 canvas.test.ts）。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as preset from '@am/engine/preset';
import { Buffer, run, tempDir } from './testutil';
import { styleBriefPath } from './canvas';

async function exec(args: string[]): Promise<{ code: number; out: string }> {
  const out = new Buffer();
  const code = await run(args, out, out);
  return { code, out: out.text };
}

describe('init --style', () => {
  it('without --style uses the custom draft instead of a builtin pack', async () => {
    const target = path.join(tempDir(), 'video');
    const { code, out } = await exec(['init', target, '--canvas', 'vertical-3x4', '--skip-hyperframes']);
    expect(code, `默认自由视觉初始化失败：${out}`).toBe(0);
    const frame = fs.readFileSync(path.join(target, 'frame.md'), 'utf8');
    expect(frame, '未传 --style 时应写入自定义草稿').toContain('style_id: ' + preset.DraftStyleID);
    const brief = fs.readFileSync(path.join(target, preset.CustomStyleBriefPath), 'utf8');
    expect(brief, '默认自由视觉说明未写入').toContain(preset.AutomaticStyleBrief);
    expect(fs.existsSync(path.join(target, preset.guideDoc(preset.defaultStyle()))), '默认初始化不应加载内置风格说明书').toBe(false);
  });

  // 每套风格 × 画幅都要能 init 成功（共用树、画幅树、风格树之间没有路径冲突），
  // 且产物能过 validate style（说明书能按 style_id 找到、示例图尺寸对、字体随项目走）。
  describe('every style and canvas passes style validation', () => {
    for (const style of preset.allStyles()) {
      for (const canvas of preset.all()) {
        it(`${style.id}/${canvas.id}`, async () => {
          const target = path.join(tempDir(), 'video');
          let { code, out } = await exec(['init', target, '--canvas', canvas.id, '--style', style.id, '--skip-hyperframes']);
          expect(code, `init 失败：${out}`).toBe(0);
          expect(out, 'init 不应把风格写入初始化结果').not.toContain('风格 ' + style.name);
          expect(fs.existsSync(path.join(target, preset.guideDoc(style))), '缺少风格说明书').toBe(true);
          ({ code, out } = await exec(['validate', 'style', '--project-root', target]));
          expect(code, `validate style 失败：${out}`).toBe(0);
        });
      }
    }
  });

  it('rejects an unknown style', async () => {
    const { code, out } = await exec(['init', path.join(tempDir(), 'video'), '--canvas', 'vertical-3x4', '--style', 'no-such-style', '--skip-hyperframes']);
    expect(code, out).not.toBe(0);
    expect(out).toContain('未知风格');
  });

  describe('custom style writes the brief and the draft', () => {
    for (const canvas of preset.all()) {
      it(canvas.id, async () => {
        const target = path.join(tempDir(), 'video');
        let { code, out } = await exec(['init', target, '--canvas', canvas.id, '--style', 'custom', '--style-brief', '暖色胶片、手写标注', '--skip-hyperframes']);
        expect(code, `init 失败：${out}`).toBe(0);
        const brief = fs.readFileSync(path.join(target, styleBriefPath), 'utf8');
        expect(brief, `描述未写入 ${styleBriefPath}`).toContain('暖色胶片、手写标注');
        expect(out, 'init 不应再把定风格作为渲染前置条件').not.toContain('定风格');
        for (const name of ['frame.md', preset.guideDoc(preset.CustomStyle)]) {
          expect(fs.existsSync(path.join(target, name)), `缺少 ${name}`).toBe(true);
        }
        ({ code, out } = await exec(['validate', 'style', '--project-root', target]));
        expect(code, `草稿项目的 validate style 应失败：${out}`).not.toBe(0);
        expect(out, '应提示定风格').toContain('定风格');
      });
    }
  });

  it('custom style defaults to a model-directed brief without a terminal', async () => {
    const { code, out } = await exec(['init', path.join(tempDir(), 'video'), '--canvas', 'vertical-3x4', '--style', 'custom', '--skip-hyperframes']);
    expect(code, `缺少旧版描述应使用兼容说明：${out}`).toBe(0);
  });
});
