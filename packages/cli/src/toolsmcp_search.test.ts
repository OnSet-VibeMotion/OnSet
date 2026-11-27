import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type * as director from '@onset/engine/director';
import { ResultMarker } from '@onset/engine/opworker';
import { groupSpawnOptions } from '@onset/engine/procgroup';
import { describe, expect, it } from 'vitest';
import { onsetTools, runBuiltinAgent } from './agent/command';
import { StreamWriter } from './agent/stream';
import {
  describeToolCatalog,
  describeTools,
  LegacyOnsetCallName,
  LegacyToolHelpName,
  type Spawner,
  serveToolsMCP,
  ToolCallName,
  ToolSearchName,
  ToolsFullEnv,
} from './toolsmcp';

async function callMCP(
  requests: Record<string, unknown>[],
  spawner: Spawner,
  options?: { compact?: boolean },
): Promise<Map<unknown, any>> {
  const out = new Map<unknown, any>();
  async function* lines() {
    for (const r of requests) yield JSON.stringify({ jsonrpc: '2.0', ...r });
  }
  await serveToolsMCP(
    lines(),
    (line) => {
      const msg = JSON.parse(line);
      out.set(msg.id, msg);
    },
    'orchestrator',
    spawner,
    undefined,
    options,
  );
  return out;
}

function fakeWorker(result: Record<string, unknown> = { ok: true, exit_code: 0 }): Spawner {
  if (process.platform === 'win32') {
    const code = `process.stdout.write("op=" + process.argv[1] + " params=" + process.argv[2] + "\\n" + ${JSON.stringify(ResultMarker + JSON.stringify(result) + '\n')});`;
    return (name, params) =>
      spawn(process.execPath, ['-e', code, name, JSON.stringify(params)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...groupSpawnOptions(),
      });
  }
  const marker = ResultMarker.replace('\u0000', '\\0');
  const script = `echo "op=$1 params=$2"\nprintf '${marker}%s\\n' '${JSON.stringify(result)}'`;
  return (name, params) =>
    spawn('/bin/sh', ['-c', script, 'onset', name, JSON.stringify(params)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
}

function payloadBytes(tools: ReturnType<typeof describeTools>): number {
  const wire = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  return Buffer.byteLength(JSON.stringify(wire), 'utf8');
}

function withFlowDir(flowId: string | null, fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mcp-search-'));
  try {
    if (flowId) {
      fs.writeFileSync(
        path.join(dir, 'onset.flow.json'),
        JSON.stringify({ version: 1, production: { id: flowId, canvas: 'vertical-3x4' } }),
      );
    }
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('global static compact mode, unified tool_search, and tool_call', () => {
  // 15 项核心主干（含 studio_ask）必须在 speech / none 默认顶层直出，彻底根治 agy ~32 KB 预算截断。
  const core15 = [
    'studio_ask',
    'voice_synthesize',
    'align_run',
    'align_build',
    'audio_check',
    'audio_mix',
    'timing_report',
    'scene_cues',
    'scene_run_all',
    'scene_frames_batch',
    'scene_frames',
    'validate_reads',
    'concat',
    'validate_video',
    'review',
  ];

  it('defaults orchestrator to static compact mode under <18 KB / <24 KB with 100% op reachability', () => {
    const limits: Array<{ flow: string | null; maxBytes: number; maxTools: number }> = [
      { flow: 'speech', maxBytes: 18_000, maxTools: 40 },
      { flow: 'beat', maxBytes: 18_000, maxTools: 42 },
      { flow: 'song', maxBytes: 18_000, maxTools: 44 },
      { flow: null, maxBytes: 24_000, maxTools: 56 },
    ];
    for (const { flow, maxBytes, maxTools } of limits) {
      withFlowDir(flow, (dir) => {
        const compact = describeToolCatalog('orchestrator', dir);
        const full = describeToolCatalog('orchestrator', dir, { compact: false });
        const bytes = payloadBytes(compact.exposed);
        expect(bytes, `flow=${flow ?? 'none'} compact bytes`).toBeLessThan(maxBytes);
        expect(compact.exposed.length, `flow=${flow ?? 'none'} compact count`).toBeLessThanOrEqual(maxTools);
        // 相比全量直省显著体积。
        expect(bytes).toBeLessThan(payloadBytes(full.exposed) * 0.35);

        // 全量底层 Op 100% 保留可达，零能力丢失。
        const fullOps = new Set(full.all.filter((t) => t.op).map((t) => t.name));
        const compactOps = new Set(compact.all.filter((t) => t.op).map((t) => t.name));
        expect(compactOps).toEqual(fullOps);

        const exposedNames = compact.exposed.map((t) => t.name);
        expect(exposedNames).toContain(ToolSearchName);
        expect(exposedNames).toContain(ToolCallName);
        expect(exposedNames).not.toContain(LegacyToolHelpName);
        expect(exposedNames).not.toContain(LegacyOnsetCallName);
        expect(exposedNames).not.toContain('brand_kit_list');

        // studio_ask 保留嵌套 questions[].options[] 结构。
        const askTool = compact.exposed.find((t) => t.name === 'studio_ask');
        expect(askTool).toBeDefined();
        expect(askTool!.inputSchema.properties?.questions?.items?.properties?.options?.type).toBe('array');

        if (flow === 'speech' || flow === null) {
          for (const core of core15) {
            expect(exposedNames, `flow=${flow ?? 'none'} missing ${core}`).toContain(core);
          }
        }
      });
    }
  });

  it('supports ONSET_TOOLS_FULL=1 opt-out and keeps renderer profile unchanged', () => {
    const saved = process.env[ToolsFullEnv];
    process.env[ToolsFullEnv] = '1';
    try {
      const fullNames = describeTools('orchestrator').map((t) => t.name);
      expect(fullNames).toContain('brand_kit_list');
      expect(fullNames).toContain('sfx_search');
      expect(fullNames).toContain(ToolSearchName);
      expect(fullNames).not.toContain(ToolCallName);
    } finally {
      if (saved === undefined) delete process.env[ToolsFullEnv];
      else process.env[ToolsFullEnv] = saved;
    }

    const rendererNames = describeTools('renderer').map((t) => t.name);
    expect(rendererNames).toContain(LegacyToolHelpName);
    expect(rendererNames).not.toContain(ToolCallName);
    expect(rendererNames).not.toContain(ToolSearchName);
  });

  it('supports exact lookup, Chinese/English keywords, category, "*", inline details, and legacy tool_help', async () => {
    const replies = await callMCP(
      [
        { id: 1, method: 'initialize', params: {} },
        { id: 2, method: 'tools/call', params: { name: ToolSearchName, arguments: { query: 'sfx_search' } } },
        { id: 3, method: 'tools/call', params: { name: ToolSearchName, arguments: { query: '品牌包' } } },
        { id: 4, method: 'tools/call', params: { name: ToolSearchName, arguments: { query: '剪映' } } },
        { id: 5, method: 'tools/call', params: { name: ToolSearchName, arguments: { query: 'brand_kit' } } },
        {
          id: 6,
          method: 'tools/call',
          params: { name: ToolSearchName, arguments: { category: 'brand_kit', detail: true } },
        },
        { id: 7, method: 'tools/call', params: { name: ToolSearchName, arguments: { query: '*' } } },
        { id: 8, method: 'tools/call', params: { name: ToolSearchName, arguments: { query: '批注' } } },
        // 旧别名 tool_help 永久静默兼容。
        { id: 9, method: 'tools/call', params: { name: LegacyToolHelpName, arguments: { tool: 'sfx_search' } } },
        { id: 10, method: 'tools/call', params: { name: LegacyToolHelpName, arguments: { tool: '*' } } },
        { id: 11, method: 'tools/call', params: { name: LegacyToolHelpName, arguments: { tool: 'no_such_tool_xyz' } } },
      ],
      fakeWorker(),
    );

    expect(replies.get(1).result.instructions).toContain(ToolSearchName);
    expect(replies.get(1).result.instructions).toContain(ToolCallName);

    // 精确查单工具：返回完整参数与 tool_call 指引。
    const exact = replies.get(2).result.content[0].text;
    expect(replies.get(2).result.isError).toBe(false);
    expect(exact).toContain('sfx_search');
    expect(exact).toContain('参数：');
    expect(exact).toContain(`经 ${ToolCallName}({"tool": "sfx_search"`);

    // 中文关键词「品牌包」。
    const brandCn = replies.get(3).result.content[0].text;
    expect(brandCn).toContain('brand_kit_list');
    expect(brandCn).toContain('brand_kit_apply');

    // 中文关键词「剪映」单命中直接内联完整参数 Schema（减少往返）。
    const jy = replies.get(4).result.content[0].text;
    expect(jy).toContain('project_export_jianying');
    expect(jy).toContain('参数：');
    expect(jy).toContain(`经 ${ToolCallName}({"tool": "project_export_jianying"`);

    // 英文前缀检索。
    expect(replies.get(5).result.content[0].text).toContain('brand_kit_extract');

    // category + detail: true 内联多条完整参数。
    const catDetail = replies.get(6).result.content[0].text;
    expect(catDetail).toContain('### brand_kit_list');
    expect(catDetail).toContain('参数：');

    // query: "*" 返回按领域分组的紧凑全目录。
    const idx = replies.get(7).result.content[0].text;
    expect(idx).toContain('【品牌包 (brand_kit)】');
    expect(idx).toContain('voice_synthesize');
    expect(idx).toContain('brand_kit_list [tool_call]');

    // 中文关键词「批注」。
    expect(replies.get(8).result.content[0].text).toContain('review_comments_add');

    // 旧别名 tool_help 静默兼容。
    expect(replies.get(9).result.isError).toBe(false);
    expect(replies.get(9).result.content[0].text).toContain('sfx_search');
    expect(replies.get(10).result.isError).toBe(false);
    expect(replies.get(10).result.content[0].text).toContain('brand_kit_list');
    expect(replies.get(11).result.isError).toBe(true);
    expect(replies.get(11).result.content[0].text).toContain('没有这个工具');
  });

  it('validates and executes extended tools via tool_call and legacy onset_call while blocking control tools', async () => {
    let spawnedCount = 0;
    const spawner: Spawner = (name, params) => {
      spawnedCount++;
      return fakeWorker({ ok: true, data: { ok: true }, exit_code: 0 })(name, params);
    };
    const replies = await callMCP(
      [
        {
          id: 1,
          method: 'tools/call',
          params: { name: ToolCallName, arguments: { tool: 'brand_kit_list', arguments: { project_root: '.' } } },
        },
        {
          id: 2,
          method: 'tools/call',
          params: { name: ToolCallName, arguments: { tool: 'brand_kit_list', arguments: '{"project_root":"."}' } },
        },
        // 旧别名 onset_call 永久静默兼容。
        {
          id: 3,
          method: 'tools/call',
          params: {
            name: LegacyOnsetCallName,
            arguments: { tool: 'brand_kit_list', arguments: { project_root: '.' } },
          },
        },
        // 参数校验失败不启动子进程。
        {
          id: 4,
          method: 'tools/call',
          params: { name: ToolCallName, arguments: { tool: 'sfx_search', arguments: { bogus_param: 1 } } },
        },
        // 禁止嵌套转发控制/交互工具。
        {
          id: 5,
          method: 'tools/call',
          params: { name: ToolCallName, arguments: { tool: ToolSearchName, arguments: { query: '*' } } },
        },
        {
          id: 6,
          method: 'tools/call',
          params: { name: ToolCallName, arguments: { tool: 'studio_ask', arguments: {} } },
        },
        {
          id: 7,
          method: 'tools/call',
          params: { name: ToolCallName, arguments: { tool: 'brand_kit_list', arguments: '{not-json' } },
        },
      ],
      spawner,
    );

    expect(replies.get(1).result.isError).toBe(false);
    expect(replies.get(1).result.content[0].text).toContain('op=brand_kit_list');
    expect(replies.get(2).result.isError).toBe(false);
    expect(replies.get(2).result.content[0].text).toContain('op=brand_kit_list');
    expect(replies.get(3).result.isError).toBe(false);
    expect(replies.get(3).result.content[0].text).toContain('op=brand_kit_list');
    expect(spawnedCount).toBe(3);

    expect(replies.get(4).result.isError).toBe(true);
    expect(replies.get(4).result.content[0].text).toMatch(/没有参数|缺少参数/);
    expect(replies.get(5).result.isError).toBe(true);
    expect(replies.get(5).result.content[0].text).toContain(`请直接调用 ${ToolSearchName}`);
    expect(replies.get(6).result.isError).toBe(true);
    expect(replies.get(6).result.content[0].text).toContain('请直接调用 studio_ask');
    expect(replies.get(7).result.isError).toBe(true);
    expect(replies.get(7).result.content[0].text).toContain('合法 JSON');
  });

  it('compacts director onsetTools(), runs tool_search/tool_call, and silently accepts legacy aliases', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-director-compact-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'onset.flow.json'),
        JSON.stringify({ version: 1, production: { id: 'speech', canvas: 'vertical-3x4' } }),
      );
      const { tools, jobs } = onsetTools(
        fakeWorker({ ok: true, data: { kits: [] }, exit_code: 0 }),
        dir,
        'orchestrator',
      );
      try {
        const searchTool = tools.find((t) => t.name === ToolSearchName)!;
        const callTool = tools.find((t) => t.name === ToolCallName)!;
        expect(searchTool.sequential).toBe(false);
        expect(callTool.sequential).toBe(true);
        expect(tools.length).toBeLessThanOrEqual(36);
        const bytes = Buffer.byteLength(
          JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))),
          'utf8',
        );
        expect(bytes).toBeLessThan(16_000);

        const found = await searchTool.execute({ query: '品牌包' }, undefined);
        expect(found.isError).toBe(false);
        expect(found.text).toContain('brand_kit_list');

        const executed = await callTool.execute(
          { tool: 'brand_kit_list', arguments: { project_root: '.' } },
          undefined,
        );
        expect(executed.isError).toBe(false);
        expect(executed.text).toContain('op=brand_kit_list');

        const blocked = await callTool.execute({ tool: 'tool_search', arguments: {} }, undefined);
        expect(blocked.isError).toBe(true);
      } finally {
        jobs.stopAll();
      }

      // StreamWriter 直接解包 director 的 tool_call / onset_call。
      const emitted: string[] = [];
      const writer = new StreamWriter((l) => emitted.push(l), 'sd');
      writer.event({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'tc1',
              name: ToolCallName,
              arguments: { tool: 'brand_kit_list', arguments: { project_root: '.' } },
            },
          ],
        },
      });
      expect(JSON.parse(emitted[0]!).message.content[0]).toMatchObject({
        type: 'tool_use',
        name: 'mcp__onset__brand_kit_list',
        input: { project_root: '.' },
      });

      // runBuiltinAgent 静默把旧会话里的 onset_call 与 tool_help 映射到 tool_call / tool_search。
      const faux = fauxProvider({ provider: 'faux', models: [{ id: 'm1' }] });
      faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall('tool_help', { tool: 'brand_kit_list' }),
            fauxToolCall('onset_call', { tool: 'brand_kit_list', arguments: { project_root: '.' } }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('完成'),
      ]);
      const service: director.ResolvedService = {
        id: 's1',
        name: 'faux',
        protocol: 'openai',
        base_url: 'https://faux.invalid/v1',
        model: 'm1',
        vision: true,
        key: 'sk-faux',
      };
      const lines: string[] = [];
      const res = await runBuiltinAgent(
        { workdir: dir, prompt: '查品牌包', agent_dir: path.join(dir, 'agent'), service },
        (l) => lines.push(l),
        undefined,
        {
          spawner: fakeWorker({ ok: true, data: { kits: [] }, exit_code: 0 }),
          setupModels: async (runtime) => {
            (runtime as { registerNativeProvider(p: unknown): void }).registerNativeProvider(faux.provider);
            return 'faux/m1';
          },
          env: {},
        },
      );
      expect(res).toEqual({ ok: true });
      const joined = lines.join('\n');
      expect(joined).toContain('mcp__onset__brand_kit_list');
      expect(joined).toContain('op=brand_kit_list');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
