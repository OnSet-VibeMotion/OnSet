import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AllowMarker } from '../determinism';
import { buildPrompt, load, selfReviewSection, withRenderWorkers, withRetryNote } from './scene';
import { hyperFramesCLIPrompt, hyperFramesPrompt } from './skills';
import { frameWithCanvas, writeScene } from './testsupport';

const plainScene = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}';

describe('review sections', () => {
  // 数量配额是可逐项打勾的指标，渲染器会为了达标堆砌与文案无关的动效。
  it('animation prompt has no numeric quotas', () => {
    for (const dir of ['', '/proj/.agents/skills']) {
      const section = hyperFramesPrompt(dir);
      for (const banned of ['至少组合 3 条', '3 个不同分类', '至少再动用 2 个属性', '45 帧', '贯穿整个镜头时长']) {
        expect(section, `skillsDir=${dir} 时，动效提示词仍含配额 ${banned}`).not.toContain(banned);
      }
    }
  });

  // 产物校验只查规格，观感问题只能靠渲染器正式渲染前看自己的静帧发现。
  it('buildPrompt requires a snapshot self-review', () => {
    const prompt = buildPrompt(load(writeScene(plainScene)), null);
    for (const want of ['画面自查（强制', 'snapshot --at', '--describe false', '至少完成一轮', '越出画布安全区']) {
      expect(prompt).toContain(want);
    }
    expect(prompt, '首次渲染不应出现重试说明').not.toContain('上一次尝试失败');
  });

  // 自查靠 snapshot；preview 在无头环境里没用。--describe 默认会把画面发给外部视觉服务，必须显式关掉。
  it('CLI prompt allows snapshot', () => {
    const section = hyperFramesCLIPrompt('');
    for (const want of ['snapshot', '--describe false']) expect(section).toContain(want);
    expect(section, 'CLI 提示词仍把 preview 列为可用命令').not.toContain('render、check、preview');
  });

  // 风格示例不再成为渲染器的强制参照。
  it('buildPrompt ignores style examples', () => {
    const dir = writeScene('{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello","style_guide":"frame.md"}');
    fs.writeFileSync(path.join(dir, 'frame.md'), frameWithCanvas(1080, 1920));
    const prompt = buildPrompt(load(dir), null);
    for (const banned of ['scene_archetypes', 'example_png', '不照抄', 'display_stack']) {
      expect(prompt, `提示词不应引用风格示例 ${banned}`).not.toContain(banned);
    }
  });

  // 重试时把失败原因交给渲染器，不再原样重发。
  it('buildPrompt carries the retry note', () => {
    const s = load(writeScene(plainScene));
    const retried = withRetryNote(s, '- 失败原因：渲染器退出码 3');
    expect(s.retryNote, 'withRetryNote 修改了原镜头').toBe('');
    const prompt = buildPrompt(retried, null);
    for (const want of ['上一次尝试失败', '渲染器退出码 3', '不要原样重复']) expect(prompt).toContain(want);
  });

  // 源码扫描判失败不重试，渲染器必须事先知道哪些写法会被拦、豁免怎么写；
  // 豁免标记必须与扫描器认的是同一个字符串。
  it('buildPrompt announces the determinism gate', () => {
    const prompt = buildPrompt(load(writeScene(plainScene)), null);
    for (const want of ['确定性（强制', 'Math.random()', 'requestAnimationFrame', '完整版本号', AllowMarker]) {
      expect(prompt).toContain(want);
    }
  });

  // 并发渲染时每镜头的 worker 数写进提示词；单镜头渲染不写，沿用上游 auto。
  it('buildPrompt carries the render worker budget', () => {
    const s = load(writeScene(plainScene));
    expect(buildPrompt(s, null), '单镜头渲染不应限制 worker 数').not.toContain('--workers');
    expect(buildPrompt(withRenderWorkers(s, 3), null), '并发渲染时提示词应带 --workers 3').toContain('--workers 3');
    expect(s.renderWorkers, 'withRenderWorkers 不得修改原镜头').toBe(0);
  });

  // 静帧看不出动作：一帧蹦出、匀速、齐动、信息点抢拍只有连续帧能看出来。
  it('self-review covers motion, not only stills', () => {
    for (const want of ['连续截取该段的每一帧', '一帧蹦出', '同一帧、以同一幅度齐动', '上一个信息点读完之前', '自查量下限']) {
      expect(selfReviewSection).toContain(want);
    }
  });
});
