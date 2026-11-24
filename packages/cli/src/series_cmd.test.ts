import fs from 'node:fs';
import path from 'node:path';
import * as series from '@onset/engine/series';
import { describe, expect, it } from 'vitest';
import { runIn, tempDir } from './testutil';

describe('CLI / MCP series operations', () => {
  it('runs series_info, series_promote_asset, series_sync_asset, series_update_brief, and series_update_publish_template', async () => {
    const seriesRoot = tempDir();
    process.env[series.DirEnv] = seriesRoot;
    const ep1 = tempDir();
    const ep2 = tempDir();

    const s = series.createSeries(seriesRoot, { id: 'cli-series', name: 'CLI 测试专栏' });
    series.bindProject(seriesRoot, s.id, ep1, { episode: 1 });
    series.bindProject(seriesRoot, s.id, ep2, { episode: 2 });

    // 准备一个共用组件
    const comp = path.join(ep1, 'production/shared/lower-third');
    fs.mkdirSync(comp, { recursive: true });
    fs.writeFileSync(path.join(comp, 'README.md'), '# Lower Third\n');
    fs.writeFileSync(path.join(comp, 'index.js'), 'export const label = "v1";\n');

    const promote = await runIn(ep1, ['series', 'promote', '--kind', 'shared', '--name', 'lower-third']);
    expect(promote.code).toBe(0);
    expect(promote.out).toContain('已沉淀专栏资产 shared:lower-third');

    const briefRes = await runIn(ep1, ['series', 'brief', '--content', '每期统一炭黑底色。']);
    expect(briefRes.code).toBe(0);
    expect(series.readBrief(seriesRoot, s.id)).toContain('炭黑底色');

    const tplRes = await runIn(ep1, [
      'series',
      'publish-template',
      '--title-pattern',
      '【EP{nn}】{title}',
      '--cover-guidelines',
      '右下角放主图',
    ]);
    expect(tplRes.code).toBe(0);
    expect(series.readPublishTemplate(seriesRoot, s.id)?.title_pattern).toBe('【EP{nn}】{title}');

    // 回归：局部更新只改封面规范应保留原 title_pattern；无参数调用不清空现有模板
    const partialRes = await runIn(ep1, ['series', 'publish-template', '--cover-guidelines', '左上角带 EP 徽章']);
    expect(partialRes.code).toBe(0);
    expect(series.readPublishTemplate(seriesRoot, s.id)?.title_pattern).toBe('【EP{nn}】{title}');
    expect(series.readPublishTemplate(seriesRoot, s.id)?.cover_guidelines).toBe('左上角带 EP 徽章');

    const noopRes = await runIn(ep1, ['series', 'publish-template']);
    expect(noopRes.code).toBe(0);
    expect(series.readPublishTemplate(seriesRoot, s.id)?.title_pattern).toBe('【EP{nn}】{title}');

    // 在 EP2 里查状态并拉取组件
    const infoBefore = await runIn(ep2, ['series', 'info', '--json']);
    expect(infoBefore.code).toBe(0);
    const parsed = JSON.parse(infoBefore.out) as {
      bound: boolean;
      assets: { key: string; status: string }[];
    };
    expect(parsed.bound).toBe(true);
    expect(parsed.assets.find((a) => a.key === 'shared:lower-third')?.status).toBe('missing');

    const syncRes = await runIn(ep2, ['series', 'sync', '--kind', 'shared', '--name', 'lower-third']);
    expect(syncRes.code).toBe(0);
    expect(fs.existsSync(path.join(ep2, 'production/shared/lower-third/index.js'))).toBe(true);
  });
});
