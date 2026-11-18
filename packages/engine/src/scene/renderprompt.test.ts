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
});
