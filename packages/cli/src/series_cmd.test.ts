import fs from 'node:fs';
import path from 'node:path';
import * as series from '@onset/engine/series';
import { describe, expect, it } from 'vitest';
import './cli';
import { findOp, normalizeToolParams, TextSink } from './ops/op';
import { runOpWorker } from './ops/worker';
import { runIn, tempDir } from './testutil';
import { describeToolCatalog, opCommand, prepareCall } from './toolsmcp';

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

    // 回归：显式传入 default_hashtags: [] 或空字符串应能局部清空对应字段，同时保留未指定的字段
    const op = findOp('series_update_publish_template')!;
    const prevCwd = process.cwd();
    try {
      process.chdir(ep1);
      const out1 = new TextSink();
      await op.run(normalizeToolParams(op, { default_hashtags: ['#硬核', '#动画'], description_footer: '订阅专栏' }), {
        out: out1,
        err: out1,
        signal: new AbortController().signal,
        unsafe: false,
      });
      expect(series.readPublishTemplate(seriesRoot, s.id)?.default_hashtags).toEqual(['#硬核', '#动画']);
      expect(series.readPublishTemplate(seriesRoot, s.id)?.description_footer).toBe('订阅专栏');

      const out2 = new TextSink();
      await op.run(normalizeToolParams(op, { default_hashtags: [], description_footer: '' }), {
        out: out2,
        err: out2,
        signal: new AbortController().signal,
        unsafe: false,
      });
      const afterClear = series.readPublishTemplate(seriesRoot, s.id);
      expect(afterClear?.title_pattern).toBe('【EP{nn}】{title}');
      expect(afterClear?.default_hashtags).toBeUndefined();
      expect(afterClear?.description_footer).toBeUndefined();

      // 回归（MCP 跨进程路径）：prepareCall -> opCommand -> runOpWorker 不得把未传字段的默认值误判为显式清空
      const mcpTool = describeToolCatalog('orchestrator').all.find((t) => t.name === 'series_update_publish_template')!;
      const runViaMCP = async (input: Record<string, unknown>) => {
        const prepared = prepareCall(mcpTool, input);
        const cmd = opCommand(mcpTool.name, prepared);
        const paramsJSON = cmd.args[cmd.args.length - 1] ?? '{}';
        const sink = new TextSink();
        const code = await runOpWorker(mcpTool.name, paramsJSON, sink, new AbortController().signal, false);
        expect(code).toBe(0);
      };

      await runViaMCP({ default_hashtags: ['#MCP标签'] });
      const afterMcpPartial = series.readPublishTemplate(seriesRoot, s.id);
      expect(afterMcpPartial?.title_pattern).toBe('【EP{nn}】{title}');
      expect(afterMcpPartial?.cover_guidelines).toBe('左上角带 EP 徽章');
      expect(afterMcpPartial?.default_hashtags).toEqual(['#MCP标签']);

      await runViaMCP({ default_hashtags: [] });
      const afterMcpClear = series.readPublishTemplate(seriesRoot, s.id);
      expect(afterMcpClear?.title_pattern).toBe('【EP{nn}】{title}');
      expect(afterMcpClear?.default_hashtags).toBeUndefined();

      await runViaMCP({});
      expect(series.readPublishTemplate(seriesRoot, s.id)?.title_pattern).toBe('【EP{nn}】{title}');
    } finally {
      process.chdir(prevCwd);
    }

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
