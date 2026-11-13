import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as beat from '../beat';
import { builtinFlows, builtinStations, chineseNumber, composePrompt, detectFlow, gateFiles, route, stationOfPath } from './index';

const templates = path.join(__dirname, '..', '..', '..', '..', 'assets', 'prompts');

describe('stations and flows', () => {
  it('every flow names existing stations and has unique stops', () => {
    for (const f of builtinFlows) {
      const ids = route(f.id).map((r) => r.node.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('keeps the route order of the production map', () => {
    expect(route('speech').map((r) => r.node.id)).toEqual([
      'intake', 'script', 'gate-script', 'voice', 'gate-voice', 'timeline', 'style', 'plan', 'gate-storyboard',
      'render', 'visual-qc', 'assemble', 'sound', 'review', 'gate-final', 'publish',
    ]);
    expect(route('beat').map((r) => r.node.id)).toEqual([
      'story', 'gate-story', 'music', 'grid', 'gate-grid', 'style', 'plan', 'gate-beat-storyboard',
      'render', 'visual-qc', 'assemble', 'sound', 'review', 'gate-final', 'publish',
    ]);
  });

  it('collects the gates confirmed from the client', () => {
    expect(Object.keys(gateFiles()).sort()).toEqual(['gate-beat-storyboard', 'gate-script', 'gate-story', 'gate-storyboard', 'gate-voice']);
  });

  it('detects the beat flow by its marker file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-flow-'));
    expect(detectFlow(root)).toBe('speech');
    fs.writeFileSync(path.join(root, beat.ConfigFile), 'bpm: 120\n');
    expect(detectFlow(root)).toBe('beat');
  });
});

describe('stationOfPath', () => {
  it('prefers the most specific rule', () => {
    expect(stationOfPath('production/audio/try-a.mp3', 'speech')).toBe('voice');
    expect(stationOfPath('production/audio/voice.srt', 'speech')).toBe('timeline');
    expect(stationOfPath('production/audio/premix.wav', 'speech')).toBe('sound');
    expect(stationOfPath('scenes/scene-001/prompt.md', 'speech')).toBe('plan');
    expect(stationOfPath('scenes/scene-001/index.html', 'speech')).toBe('render');
    expect(stationOfPath('production/beat/music-a.mp3', 'beat')).toBe('music');
    expect(stationOfPath('production/beat/story.md', 'beat')).toBe('story');
    expect(stationOfPath('production/beat/grid-draft.json', 'beat')).toBe('grid');
    expect(stationOfPath('production\\audio\\voice.srt', 'speech')).toBe('timeline');
  });

  it('ignores host state and stations outside the flow', () => {
    expect(stationOfPath('production/studio/step.json', 'speech')).toBe('');
    expect(stationOfPath('production/usage/orchestrator.jsonl', 'beat')).toBe('');
    expect(stationOfPath('production/script-final.md', 'beat')).toBe('');
    expect(stationOfPath('production/audio/voice.srt', 'beat')).toBe('');
    // 卡点的分镜计划不算口播项目的「拆分镜头」。
    expect(stationOfPath('production/beat/plan.json', 'speech')).toBe('');
    expect(stationOfPath('production/beat/plan.json', 'beat')).toBe('plan');
  });
});

describe('composePrompt', () => {
  it('numbers stages in order and resolves references', () => {
    const text: Record<string, string> = {
      'host/head': '# 标题\n见{{STAGE:review}}。\n',
      'intake/stage': '## {{STAGE:intake}}：盘点\n',
      'review/stage': '## {{STAGE:review}}：复查\n第{{STAGE_N:intake}}、{{STAGE_N:review}}阶段\n',
    };
    const out = composePrompt(['host/head', 'intake/stage', 'review/stage'], (s, sec) => text[`${s}/${sec}`]);
    expect(out).toBe('# 标题\n见第二阶段。\n## 第一阶段：盘点\n## 第二阶段：复查\n第一、二阶段\n');
  });

  it('rejects unknown sections and stages', () => {
    expect(() => composePrompt(['host/nope'], () => '')).toThrow('没有这段提示词：host/nope');
    expect(() => composePrompt(['nope'], () => '')).toThrow('没有这段提示词：nope');
    expect(() => composePrompt(['host/head'], () => '{{STAGE:render}}')).toThrow('提示词引用了没有的阶段：{{STAGE:render}}');
  });

  it('writes Chinese stage numbers', () => {
    expect([1, 9, 10, 11, 13, 20, 23].map(chineseNumber)).toEqual(['一', '九', '十', '十一', '十三', '二十', '二十三']);
  });

  it('has a template for every section and no orphan templates', () => {
    const declared = builtinStations.flatMap((s) => s.prompt.map((p) => `${s.id}/${p.id}`)).sort();
    const files = fs
      .readdirSync(templates, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replaceAll('\\', '/').replace(/\.md$/, ''))
      .sort();
    expect(files).toEqual(declared);
    // 每一段都至少进一个内置流程的提示词，每个流程的段落都声明过、不重复。
    const used = new Set(builtinFlows.flatMap((f) => f.prompt ?? []));
    expect([...used].sort()).toEqual(declared);
    for (const f of builtinFlows) expect(new Set(f.prompt).size, f.id).toBe(f.prompt!.length);
  });

  it('leaves no hard-coded stage numbers in the sections', () => {
    for (const ref of new Set(builtinFlows.flatMap((f) => f.prompt ?? []))) {
      const body = fs.readFileSync(path.join(templates, ref + '.md'), 'utf8');
      expect(body, ref).not.toMatch(/第[一二三四五六七八九十]+阶段/);
    }
  });
});
