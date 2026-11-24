import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindProject,
  createSeries,
  deleteSeriesAsset,
  diffSeriesAssets,
  listProjectAssetCandidates,
  listSeriesAssets,
  materializeSeriesIntoProject,
  promoteAssetToSeries,
  readPublishTemplate,
  seriesPromptBrief,
  syncAssetToProject,
  writeDirections,
  writePublishTemplate,
} from './index';

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-series-assets-'));
  temps.push(dir);
  return dir;
}

function writeFile(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('series cross-episode assets, dual bumper modes, and 3-way sync', () => {
  it('promotes shared components, video & template bumpers, cast, audio, and publish template, then materializes into EP2', () => {
    const seriesRoot = tempDir();
    const ep1 = tempDir();
    const ep2 = tempDir();

    const s = createSeries(seriesRoot, { id: 'tech-weekly', name: '科技周刊', brief: '保持克制。' });
    bindProject(seriesRoot, s.id, ep1, { episode: 1 });

    // 1. 共用组件（校验 README + js/css）
    writeFile(path.join(ep1, 'production/shared/brand-badge/README.md'), '# Badge\n导出 renderBadge()');
    writeFile(path.join(ep1, 'production/shared/brand-badge/badge.js'), 'export const v = 1;\n');
    const sharedRes = promoteAssetToSeries(seriesRoot, s.id, ep1, { kind: 'shared', name: 'brand-badge' });
    expect(sharedRes.replaced).toBe(false);
    expect(sharedRes.files).toBe(2);

    // 2. 片头：固定成片 MP4 模式
    writeFile(path.join(ep1, 'scenes/intro/intro.mp4'), Buffer.from('fake-mp4-v1'));
    const introRes = promoteAssetToSeries(seriesRoot, s.id, ep1, {
      kind: 'bumper',
      name: 'intro',
      from: 'scenes/intro',
    });
    expect(introRes.bumper_mode).toBe('video');

    // 3. 片尾：可参数化 HTML 模板模式
    writeFile(path.join(ep1, 'scenes/outro/index.html'), '<html><body>{{EPISODE}}</body></html>');
    writeFile(path.join(ep1, 'scenes/outro/README.md'), '替换 {{EPISODE}} 为本期号');
    const outroRes = promoteAssetToSeries(seriesRoot, s.id, ep1, {
      kind: 'bumper',
      name: 'outro',
      from: 'scenes/outro',
    });
    expect(outroRes.bumper_mode).toBe('template');

    // 4. 固定音频与常驻角色
    writeFile(path.join(ep1, 'assets/bgm/theme.mp3'), Buffer.from('fake-bgm'));
    promoteAssetToSeries(seriesRoot, s.id, ep1, { kind: 'audio', name: 'main-bgm', from: 'assets/bgm/theme.mp3' });
    writeFile(path.join(ep1, 'cast/host/profile.yaml'), 'name: 主播\n');
    promoteAssetToSeries(seriesRoot, s.id, ep1, { kind: 'cast', name: 'host' });

    // 5. 语气指导与发布模板
    writeDirections(seriesRoot, s.id, '语速偏快，收尾干脆。');
    const tpl = writePublishTemplate(seriesRoot, s.id, {
      title_pattern: '【EP{nn}】{title}',
      default_hashtags: ['#科技周刊', '#科普'],
      cover_guidelines: '左上角带 EP 徽章',
      description_footer: '欢迎订阅专栏。',
    });
    expect(tpl?.title_pattern).toBe('【EP{nn}】{title}');
    expect(readPublishTemplate(seriesRoot, s.id)?.default_hashtags).toEqual(['#科技周刊', '#科普']);

    // 6. 新建 EP2 并自动快照拷入全部专栏资产
    bindProject(seriesRoot, s.id, ep2, { episode: 2 });
    const applied = materializeSeriesIntoProject(seriesRoot, ep2);
    expect(applied.length).toBe(7);
    expect(fs.existsSync(path.join(ep2, 'production/shared/brand-badge/badge.js'))).toBe(true);
    expect(fs.existsSync(path.join(ep2, 'assets/series/bumpers/intro/intro.mp4'))).toBe(true);
    expect(fs.existsSync(path.join(ep2, 'assets/series/bumpers/outro/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(ep2, 'assets/series/audio/main-bgm/theme.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(ep2, 'cast/host/profile.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(ep2, 'production/audio/directions.md'))).toBe(true);
    expect(fs.existsSync(path.join(ep2, 'assets/series/publish-template.json'))).toBe(true);

    // 候选扫描与规范提示词自动包含跨期资产与发布模板
    expect(listProjectAssetCandidates(ep2).map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      'audio:main-bgm',
      'bumper:intro',
      'bumper:outro',
      'cast:host',
      'shared:brand-badge',
    ]);
    const brief = seriesPromptBrief(seriesRoot, ep2).text;
    expect(brief).toContain('[shared] brand-badge');
    expect(brief).toContain('[bumper] intro → assets/series/bumpers/intro（固定成片视频');
    expect(brief).toContain('[bumper] outro → assets/series/bumpers/outro（HTML 模板镜头');
    expect(brief).toContain('标题规则：【EP{nn}】{title}');

    // 7. 三方摘要比对：EP1 更新组件并覆盖沉淀后，EP2 应识别为 update_available，拉取前不静默改 EP2
    writeFile(path.join(ep1, 'production/shared/brand-badge/badge.js'), 'export const v = 2;\n');
    expect(() => promoteAssetToSeries(seriesRoot, s.id, ep1, { kind: 'shared', name: 'brand-badge' })).toThrow(/replace/);
    promoteAssetToSeries(seriesRoot, s.id, ep1, { kind: 'shared', name: 'brand-badge', replace: true });

    const beforePull = diffSeriesAssets(seriesRoot, ep2).find((x) => x.key === 'shared:brand-badge');
    expect(beforePull?.status).toBe('update_available');
    expect(fs.readFileSync(path.join(ep2, 'production/shared/brand-badge/badge.js'), 'utf8')).toContain('v = 1');

    syncAssetToProject(seriesRoot, ep2, { kind: 'shared', name: 'brand-badge' });
    expect(fs.readFileSync(path.join(ep2, 'production/shared/brand-badge/badge.js'), 'utf8')).toContain('v = 2');

    // 8. 冲突保护：两边都改后未传 replace 拒绝覆盖，传 replace: true 后覆盖成功
    writeFile(path.join(ep2, 'production/shared/brand-badge/badge.js'), 'export const v = 99;\n');
    writeFile(path.join(ep1, 'production/shared/brand-badge/badge.js'), 'export const v = 3;\n');
    promoteAssetToSeries(seriesRoot, s.id, ep1, { kind: 'shared', name: 'brand-badge', replace: true });
    expect(diffSeriesAssets(seriesRoot, ep2).find((x) => x.key === 'shared:brand-badge')?.status).toBe('conflict');
    expect(() => syncAssetToProject(seriesRoot, ep2, { kind: 'shared', name: 'brand-badge' })).toThrow(/replace/);
    syncAssetToProject(seriesRoot, ep2, { kind: 'shared', name: 'brand-badge', replace: true });
    expect(fs.readFileSync(path.join(ep2, 'production/shared/brand-badge/badge.js'), 'utf8')).toContain('v = 3');

    // 删除专栏资产不影响已有项目文件
    deleteSeriesAsset(seriesRoot, s.id, 'shared', 'brand-badge');
    expect(listSeriesAssets(seriesRoot, s.id).some((x) => x.key === 'shared:brand-badge')).toBe(false);
    expect(fs.existsSync(path.join(ep2, 'production/shared/brand-badge/badge.js'))).toBe(true);
  });
});
