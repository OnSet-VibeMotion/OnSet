import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../plugin';
import * as flow from '../flow';
import { fingerprint } from './record';
import { buildPrompt, load, renderPromptVersion } from './scene';
import { tempDir, testPlanSHA, writeScene } from './testsupport';

/** 项目根加一个镜头；version 为 0 时不写锁文件里的渲染提示词版本（更早建的项目）。 */
function project(version: number, timing: boolean) {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'onset.conf'), '');
  flow.recordFlow(root, { id: 'speech', canvas: 'vertical-3x4', ...(version > 0 ? { render_prompt: version } : {}) });
  fs.mkdirSync(path.join(root, 'scenes'));
  const block = timing ? `,"timing":{"fps":30,"start_frame":0,"end_frame_exclusive":30,"plan":"${testPlanSHA}"}` : '';
  const dir = path.join(root, 'scenes', 'one');
  fs.renameSync(writeScene(`{"id":"one","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"${block}}`), dir);
  return load(dir);
}

describe('render prompt version', () => {
  it('includes the short startup contract only in the live director prompt', () => {
    const s = project(4, true);
    const resolved = { hyperframes: '/installed/skills', 'scene-kit': '/installed/shared' };
    const normal = buildPrompt(s, resolved);
    const brief = buildPrompt(s, resolved, true);
    expect(normal).toContain('写组合 HTML 前必须读');
    expect(brief).not.toContain('写组合 HTML 前必须读');
    expect(brief).toContain('window.__timelines');
    expect(brief).toContain('data-track-index');
    expect(brief).toContain('SceneKit.attach');
    expect(brief).toContain('/installed/skills');
    expect(brief).toContain('scene_preview_check');
  });

  it('gives current projects one preview call and a handoff after visual checks', () => {
    const prompt = buildPrompt(project(flow.RenderPromptVersion, true), {});
    expect(prompt).toContain('scene_preview_check');
    expect(prompt).toContain('[[USER_MESSAGE]]画面自查通过，交给片场渲染');
    expect(buildPrompt(project(3, true), {})).not.toContain('scene_preview_check');
  });

  // 渲染提示词在镜头指纹里：更早建的项目照旧用老提示词，已渲染的镜头不因升级变 Stale；新项目才带开工须知。
  it('keeps old projects byte for byte and gives new ones the start notes', () => {
    const old = project(0, true);
    expect(renderPromptVersion(old)).toBe(1);
    const oldPrompt = buildPrompt(old, {});
    expect(crypto.createHash('sha256').update(oldPrompt).digest('hex')).toBe(process.platform === 'win32' ? '152b186f0366780b54fd00eec71def018e1c69c40d30ebf61314d08d9e8cb3f0' : '1adb7e84c335973c091bb6ae3c86df5b75d8c2420b62c7dcaaa856d9bff9970b');
    expect(oldPrompt).not.toContain('开工须知');
    expect(oldPrompt).toContain('先阅读完整字幕并检查素材。');

    const fresh = project(flow.RenderPromptVersion, true);
    expect(renderPromptVersion(fresh)).toBe(flow.RenderPromptVersion);
    const prompt = buildPrompt(fresh, {});
    expect(prompt).toContain('开工须知（强制）');
    expect(prompt).toContain('onset-scene.js（window.ONSET_SCENE.cues');
    expect(prompt).not.toContain('先阅读完整字幕');
    expect(prompt).toContain('先看联系表');
    expect(prompt).not.toContain('至少完成一轮');
    expect(buildPrompt(project(2, true), {})).toContain('至少完成一轮');
    expect(fingerprint(fresh, 'claude', {}).parts!.prompt).not.toBe(fingerprint(old, 'claude', {}).parts!.prompt);

    // 没有时间合同的镜头（卡点）没有裁好的字幕：开工须知不提字幕，开头那句照旧。
    const beat = buildPrompt(project(flow.RenderPromptVersion, false), {});
    expect(beat).toContain('开工须知（强制）');
    expect(beat).not.toContain('window.ONSET_SCENE.cues');
    expect(beat).toContain('先阅读完整字幕并检查素材。');
  });

  it('v5 puts a shared cacheable static prefix before per-scene details and gives all renderers the concise brief', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'onset.conf'), '');
    flow.recordFlow(root, { id: 'speech', canvas: 'vertical-3x4', render_prompt: 5 });
    fs.mkdirSync(path.join(root, 'scenes'));
    const mk = (id: string, text: string, start: number, end: number) => {
      const dir = path.join(root, 'scenes', id);
      fs.renameSync(writeScene(JSON.stringify({
        id,
        duration_seconds: (end - start) / 30,
        output: `${id}.mp4`,
        transcript: 'transcript.srt',
        text,
        timing: { fps: 30, start_frame: start, end_frame_exclusive: end, plan: testPlanSHA },
      })), dir);
      return load(dir);
    };
    const resolved = { hyperframes: '/installed/skills', 'scene-kit': '/installed/shared', 'hyperframes-cli': '/installed/skills' };
    const p1 = buildPrompt(mk('scene-001', '第一镜文案', 0, 30), resolved);
    const p2 = buildPrompt(mk('scene-002', '第二镜文案，完全不同的内容', 30, 90), resolved);
    const split1 = p1.indexOf('任务目标：\n');
    const split2 = p2.indexOf('任务目标：\n');
    expect(split1).toBeGreaterThan(1500);
    expect(split2).toBe(split1);
    expect(p1.slice(0, split1)).toBe(p2.slice(0, split2));
    // 所有渲染器都拿到精简开工契约、单帧细节检查指引与反模式规则。
    expect(p1).not.toContain('写组合 HTML 前必须读');
    expect(p1).toContain('window.__timelines');
    expect(p1).toContain('SceneKit.attach');
    expect(p1).toContain('zoom_frame');
    expect(p1).toContain('不要每条命令前都加 `cd <绝对路径> &&`');
    expect(p1).toContain('不要用 `magick`、`python`、`ffmpeg`');
    // 镜头差异只出现在后半段。
    expect(p1.slice(split1)).toContain('scene-001');
    expect(p2.slice(split2)).toContain('scene-002');
  });
});
