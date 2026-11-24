import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applySeriesDefaultsToProject,
  BindingFile,
  bindProject,
  createSeries,
  DirEnv,
  defaultDir,
  deleteSeries,
  formatEpisodeName,
  getSeries,
  listSeries,
  readBinding,
  readBrief,
  slugifySeriesId,
  unbindProject,
  updateSeries,
  validateSeriesId,
  writeBrief,
} from './index';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-series-unit-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('series store & helpers', () => {
  it('resolves directory from ONSET_SERIES_DIR or user data dir', () => {
    expect(defaultDir({ [DirEnv]: '/tmp/my-series' })).toBe('/tmp/my-series');
    expect(defaultDir({ XDG_DATA_HOME: '/tmp/xdg' })).toBe(path.join('/tmp/xdg', 'onset', 'series'));
  });

  it('validates ids, generates safe slugs, and formats episode names', () => {
    expect(validateSeriesId('ai-explainer')).toBe('ai-explainer');
    expect(() => validateSeriesId('../evil')).toThrow();
    expect(() => validateSeriesId('UpperCase')).toThrow();
    expect(slugifySeriesId('AI 硬核拆解')).toBe('ai');
    expect(slugifySeriesId('硬核科普专栏')).toMatch(/^series-[0-9a-f]{8}$/);
    expect(formatEpisodeName('EP{nn}-{title}', 3, '量子计算')).toBe('EP03-量子计算');
    expect(formatEpisodeName('第{n}期-{title}', 12, 'A/B:测试')).toBe('第12期-A-B-测试');
    expect(formatEpisodeName(undefined, undefined, '番外篇')).toBe('番外篇');
  });

  it('creates, lists, updates, manages brief, and deletes series', () => {
    const root = tempDir();
    const s1 = createSeries(root, {
      name: 'AI 硬核拆解',
      description: '每周讲透一个底层原理',
      defaults: { canvas: 'landscape-16x9', delivery: 'speech', tts_voice: '沉稳男声' },
      brief: '开头三秒抛结论。',
    });
    expect(s1.id).toBe('ai');
    expect(s1.next_episode).toBe(1);
    expect(readBrief(root, s1.id)).toBe('开头三秒抛结论。\n');

    const s2 = createSeries(root, { name: 'AI 新系列' });
    expect(s2.id).toBe('ai-2');

    const all = listSeries(root);
    expect(all.map((s) => s.id).sort()).toEqual(['ai', 'ai-2']);

    const updated = updateSeries(root, s1.id, {
      name: 'AI 深度拆解',
      next_episode: 5,
      defaults: { canvas: 'vertical-3x4', tts_voice: '温暖女声' },
      brief: '   ',
    });
    expect(updated.name).toBe('AI 深度拆解');
    expect(updated.next_episode).toBe(5);
    expect(updated.defaults.canvas).toBe('vertical-3x4');
    expect(readBrief(root, s1.id)).toBe('');

    writeBrief(root, s1.id, '# 专栏规范\n保持紧凑。');
    expect(readBrief(root, s1.id)).toContain('保持紧凑');

    deleteSeries(root, s2.id);
    expect(getSeries(root, s2.id)).toBeNull();
  });

  it('binds and unbinds projects in place without moving directories, and applies defaults', () => {
    const root = tempDir();
    const projectDir = tempDir();
    const s = createSeries(root, {
      id: 'weekly-tech',
      name: '每周科技',
      defaults: { tts_voice: '主理人音色' },
    });

    const binding = bindProject(root, s.id, projectDir, { episode: 2 });
    expect(binding.series_id).toBe('weekly-tech');
    expect(binding.episode).toBe(2);
    expect(fs.existsSync(path.join(projectDir, BindingFile))).toBe(true);
    expect(readBinding(projectDir)?.episode).toBe(2);
    expect(getSeries(root, s.id)?.next_episode).toBe(3);

    // 不指定期号的番外篇不强改 next_episode。
    const extraDir = tempDir();
    const extraBinding = bindProject(root, s.id, extraDir);
    expect(extraBinding.episode).toBeUndefined();
    expect(getSeries(root, s.id)?.next_episode).toBe(3);

    // 预写默认音色且不覆盖已有配置。
    applySeriesDefaultsToProject(projectDir, s);
    const prodConf = JSON.parse(fs.readFileSync(path.join(projectDir, 'production', 'production-config.json'), 'utf8'));
    expect(prodConf.ttsVoice).toBe('主理人音色');

    fs.writeFileSync(
      path.join(projectDir, 'production', 'production-config.json'),
      JSON.stringify({ ttsVoice: '自定义音色' }),
    );
    applySeriesDefaultsToProject(projectDir, s);
    const after = JSON.parse(fs.readFileSync(path.join(projectDir, 'production', 'production-config.json'), 'utf8'));
    expect(after.ttsVoice).toBe('自定义音色');

    unbindProject(projectDir);
    expect(readBinding(projectDir)).toBeNull();
  });
});
