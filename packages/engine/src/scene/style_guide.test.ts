import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetsBase } from '../assets';
import { audioTargetsOf, buildPrompt, canvasOf, load } from './scene';
import { tempDir, writeScene } from './testsupport';

const styleScene = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello","style_guide":"frame.md"}';

function frameWithTokens(extra: string): string {
  return '---\nstyle_id: ' + extra + 'canvas:\n  width_px: 1080\n  height_px: 1440\n  fps: 30\n  orientation: vertical\n---\n正文\n';
}

describe('style guide', () => {
  // 草稿风格不再是渲染前置条件；旧项目仍可读取其中的技术画布。
  it('load accepts a draft style guide', () => {
    const dir = writeScene(styleScene);
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithTokens('custom-draft\n'));
    expect(() => load(dir), '草稿风格不应阻止渲染').not.toThrow();
  });

  it('load accepts a finalized custom style guide', () => {
    const dir = writeScene(styleScene);
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithTokens('custom-warm-film\n'));
    expect(() => load(dir)).not.toThrow();
  });

  it('buildPrompt does not read mood refs', () => {
    const dir = writeScene(styleScene);
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithTokens('custom-warm-film\nmood_refs:\n  - assets/style-guide/mood/film.png\n'));
    let prompt = buildPrompt(load(dir), null);
    for (const banned of ['mood_refs', '氛围参照', '以 frame.md 的数值为准']) {
      expect(prompt, `提示词不应读取风格参照 ${banned}`).not.toContain(banned);
    }
    const plain = writeScene(styleScene);
    fs.writeFileSync(path.join(plain, 'frame.md'), frameWithTokens('custom-warm-film\n'));
    prompt = buildPrompt(load(plain), null);
    expect(prompt, '未声明 mood_refs 时提示词不应提到氛围参照').not.toContain('mood_refs');
  });

  // mood_refs 写错格式不能连累画幅解析：那是 am validate style 的事。
  it('canvasOf tolerates malformed mood refs', () => {
    const dir = writeScene(styleScene);
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithTokens('custom-warm-film\nmood_refs:\n  - 123\n  - {a: b}\n'));
    expect(canvasOf(dir, 'frame.md').heightPx).toBe(1440);
  });

  it('audioTargetsOf reads the final mix targets', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'frame.md'),
      frameWithTokens('x\naudio:\n  final_integrated_lufs: -16\n  final_lufs_tolerance: 1\n  true_peak_max_dbtp: -1\n'),
    );
    expect(audioTargetsOf(dir, 'frame.md')).toEqual({ integratedLUFS: -16, tolerance: 1, truePeakMax: -1 });
    // 缺一个字段就整体报错，不拿零值当目标。
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithTokens('x\naudio:\n  final_integrated_lufs: -16\n  final_lufs_tolerance: 1\n'));
    expect(() => audioTargetsOf(dir, 'frame.md')).toThrow('true_peak_max_dbtp');
  });

  // 生成出来的每份 frame.md 都必须读得出响度目标，否则 am review 会静默跳过比对。
  it('every generated frame has audio targets', () => {
    const stylesRoot = path.join(assetsBase(), 'assets', 'styles');
    const frames: string[] = [];
    for (const style of fs.readdirSync(stylesRoot)) {
      const styleDir = path.join(stylesRoot, style);
      if (!fs.statSync(styleDir).isDirectory()) continue;
      for (const canvas of fs.readdirSync(styleDir)) {
        const frame = path.join(styleDir, canvas, 'frame.md');
        if (fs.existsSync(frame)) frames.push(frame);
      }
    }
    expect(frames.length, '找不到生成的 frame.md').toBeGreaterThan(0);
    for (const frame of frames) {
      expect(() => audioTargetsOf(path.dirname(frame), 'frame.md'), frame).not.toThrow();
    }
  });

  // TS 额外：mood_refs 整个不是列表时与 yaml.v3 一样报错（Go 里它是 []any）。
  it('canvasOf rejects mood refs that are not a list', () => {
    const dir = writeScene(styleScene);
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithTokens('x\nmood_refs: 5\n'));
    expect(() => canvasOf(dir, 'frame.md')).toThrow('line 3: cannot unmarshal !!int `5` into []interface {}');
  });
});
