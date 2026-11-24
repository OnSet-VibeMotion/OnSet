import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as memory from '../memory';
import { bindProject, createSeries, seriesPromptBrief } from './index';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-series-brief-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('series brief injection and series-scoped preferences', () => {
  it('returns empty brief for standalone projects and full brief for series projects', () => {
    const seriesRoot = tempDir();
    const standalone = tempDir();
    expect(seriesPromptBrief(seriesRoot, standalone)).toEqual({ seriesId: '', seriesName: '', text: '', digest: '' });

    const s = createSeries(seriesRoot, {
      id: 'ai-lab',
      name: 'AI 实验室',
      description: '硬核动画科普',
      defaults: { tts_voice: '主理人' },
      brief: '全片背景用炭黑，重点词用琥珀高亮。',
    });
    const ep1 = tempDir();
    bindProject(seriesRoot, s.id, ep1, { episode: 1 });

    const out = seriesPromptBrief(seriesRoot, ep1);
    expect(out.seriesId).toBe('ai-lab');
    expect(out.text).toContain('AI 实验室');
    expect(out.text).toContain('第 1 期（EP01）');
    expect(out.text).toContain('全片背景用炭黑，重点词用琥珀高亮。');
    expect(out.text).toContain('"scope": "series"');
    expect(out.digest).toHaveLength(16);
  });

  it('isolates series preferences across series and shares them across episodes of the same series', () => {
    const memDir = tempDir();
    const store = memory.open(memDir);

    // 分别记三条偏好：全局、专栏 A、项目 EP1。
    store.remember({ name: 'pref-global', body: '全局禁用表情符号', global: true });
    store.remember({ name: 'pref-series-a', body: '专栏 A 开头 3 秒先抛结论', scope: 'series', series: 'series-a' });
    store.remember({ name: 'pref-ep1', body: '仅 EP1 节奏更慢', project: 'ep1', scope: 'project' });

    // 同专栏的 EP2：看到全局 + 专栏 A，看不到 EP1 专属。
    const ep2Brief = store.preferenceBrief('ep2', 0, 'series-a').text;
    expect(ep2Brief).toContain('【pref-global】（全局）');
    expect(ep2Brief).toContain('【pref-series-a】（本专栏）');
    expect(ep2Brief).not.toContain('pref-ep1');
    expect(ep2Brief).toContain('"scope": "series"');

    // 专栏 B：看不到专栏 A 的偏好。
    const seriesBBrief = store.preferenceBrief('other-ep', 0, 'series-b').text;
    expect(seriesBBrief).toContain('pref-global');
    expect(seriesBBrief).not.toContain('pref-series-a');

    // 独立项目（无 seriesId）：不带专栏偏好，也不改动既有提示词指引文字。
    const soloBrief = store.preferenceBrief('solo-ep', 0).text;
    expect(soloBrief).toContain('pref-global');
    expect(soloBrief).not.toContain('pref-series-a');
    expect(soloBrief).not.toContain('"scope": "series"');

    // 镜头召回同样按 series 过滤。
    const memories = store.memories().memories;
    const recalledA = memory.recall({
      memories,
      stats: {},
      renderer: 'claude',
      features: [],
      text: '',
      project: 'ep2',
      series: 'series-a',
      budget: 2000,
    });
    expect(recalledA.items.map((x) => x.name).sort()).toEqual(['pref-global', 'pref-series-a']);

    const recalledB = memory.recall({
      memories,
      stats: {},
      renderer: 'claude',
      features: [],
      text: '',
      project: 'other-ep',
      series: 'series-b',
      budget: 2000,
    });
    expect(recalledB.items.map((x) => x.name)).toEqual(['pref-global']);

    // 把项目级偏好一键提升为专栏级。
    store.setPreferenceScope('pref-ep1', memory.seriesScope('series-a'));
    const afterPromote = store.preferenceBrief('ep2', 0, 'series-a').text;
    expect(afterPromote).toContain('【pref-ep1】（本专栏）');
  });
});
