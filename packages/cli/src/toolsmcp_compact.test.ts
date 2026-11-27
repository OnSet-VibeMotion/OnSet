import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResultMarker } from '@onset/engine/opworker';
import { groupSpawnOptions } from '@onset/engine/procgroup';
import { describe, expect, it } from 'vitest';
import {
  describeToolCatalog,
  describeTools,
  OnsetCallToolName,
  type Spawner,
  serveToolsMCP,
  ToolsCompactEnv,
} from './toolsmcp';

/** 把一串 JSON-RPC 请求喂给工具服务，按 id 收集回复。 */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-mcp-compact-'));
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

describe('onset tools MCP compact mode (agy 32 KB eager budget)', () => {
  // agy acp 实测 eager MCP 工具声明预算约 32 KB（UTF-8 字节）且无 call_mcp_tool 回退；
  // 紧凑模式为每个项目流程留足 ≥ 12 KB 余量（含即将合入的 studio_ask 与用户全局 MCP 空间），
  // 并保证从配音到成片全链路核心工具 100% 直出、其余扩展工具 100% 可经 onset_call 调用。
  const speechCoreRequired = [
    'voice_synthesize',
    'align_text',
    'align_run',
    'align_build',
    'audio_check',
    'audio_mix',
    'timing_report',
    'phrase_frames',
    'scene_cues',
    'scene_prepare',
    'scene_run',
    'scene_run_all',
    'scene_frames_batch',
    'scene_frames',
    'scene_seams',
    'validate_reads',
    'concat',
    'validate_video',
    'review',
    'validate_publish',
    'film_style_list',
    'film_style_use',
    'config_get',
    'flow_guide',
    'inputs_manifest',
    'hyperframes',
    'studio_show',
    'studio_step',
    'studio_confirm',
    OnsetCallToolName,
    'job_wait',
    'job_cancel',
    'tool_help',
  ];

  it('keeps speech/beat/song/none compact tool payloads well under agy 32 KB limit with all core pipeline tools direct', () => {
    const limits: Array<{ flow: string | null; maxBytes: number; maxTools: number }> = [
      { flow: 'speech', maxBytes: 18_000, maxTools: 40 },
      { flow: 'beat', maxBytes: 18_000, maxTools: 42 },
      { flow: 'song', maxBytes: 18_000, maxTools: 44 },
      { flow: null, maxBytes: 24_000, maxTools: 56 },
    ];
    for (const { flow, maxBytes, maxTools } of limits) {
      withFlowDir(flow, (dir) => {
        const full = describeTools('orchestrator', dir);
        const catalog = describeToolCatalog('orchestrator', dir, { compact: true });
        const bytes = payloadBytes(catalog.exposed);
        expect(bytes, `flow=${flow ?? 'none'} compact bytes`).toBeLessThan(maxBytes);
        expect(catalog.exposed.length, `flow=${flow ?? 'none'} compact count`).toBeLessThanOrEqual(maxTools);
        // 即使再合入 studio_ask（约 600 字节）仍留足余量。
        expect(bytes + 600).toBeLessThan(26_000);
        // 完整模式与紧凑模式的全部底层 op 数量一致，能力零丢失。
        const fullOpNames = new Set(full.filter((t) => t.op).map((t) => t.name));
        const compactOpNames = new Set(catalog.all.filter((t) => t.op).map((t) => t.name));
        expect(compactOpNames).toEqual(fullOpNames);
        // 所有暴露的工具 schema 均合法。
        for (const tool of catalog.exposed) {
          expect(tool.inputSchema.type).toBe('object');
          expect(tool.description.trim()).not.toBe('');
        }
        if (flow === 'speech' || flow === null) {
          const exposedNames = catalog.exposed.map((t) => t.name);
          for (const core of speechCoreRequired) {
            expect(exposedNames, `flow=${flow ?? 'none'} missing core tool ${core}`).toContain(core);
          }
        }
        if (flow === 'beat') {
          const exposedNames = catalog.exposed.map((t) => t.name);
          for (const core of [
            'beat_import',
            'beat_analyze',
            'beat_confirm',
            'beat_cues',
            'validate_beat',
            'scene_run_all',
            'concat',
            'review',
          ]) {
            expect(exposedNames).toContain(core);
          }
        }
        if (flow === 'song') {
          const exposedNames = catalog.exposed.map((t) => t.name);
          for (const core of [
            'song_configure',
            'song_generate',
            'song_cues',
            'song_mux',
            'validate_song',
            'scene_run_all',
            'concat',
            'review',
          ]) {
            expect(exposedNames).toContain(core);
          }
        }
      });
    }
  });

  it('leaves renderer profile unchanged when compact is enabled', () => {
    expect(describeTools('renderer', '', { compact: true }).map((t) => t.name)).toEqual(
      describeTools('renderer', '', { compact: false }).map((t) => t.name),
    );
  });

  it('routes non-core tools through onset_call and exposes full docs via tool_help', async () => {
    const replies = await callMCP(
      [
        { id: 1, method: 'initialize', params: {} },
        { id: 2, method: 'tools/list', params: {} },
        { id: 3, method: 'tools/call', params: { name: 'tool_help', arguments: { tool: 'sfx_search' } } },
        { id: 4, method: 'tools/call', params: { name: 'tool_help', arguments: { tool: '*' } } },
        {
          id: 5,
          method: 'tools/call',
          params: { name: OnsetCallToolName, arguments: { tool: 'brand_kit_list', arguments: { project_root: '.' } } },
        },
        {
          id: 6,
          method: 'tools/call',
          params: { name: OnsetCallToolName, arguments: { tool: 'brand_kit_list', arguments: '{"project_root":"."}' } },
        },
        {
          id: 7,
          method: 'tools/call',
          params: { name: OnsetCallToolName, arguments: { tool: 'job_wait', arguments: { job: 'job-1' } } },
        },
        {
          id: 8,
          method: 'tools/call',
          params: { name: OnsetCallToolName, arguments: { tool: 'brand_kit_list', arguments: '{bad-json' } },
        },
      ],
      fakeWorker({ ok: true, data: { kits: [] }, exit_code: 0 }),
      { compact: true },
    );

    expect(replies.get(1).result.instructions).toContain(OnsetCallToolName);
    const listedNames = replies.get(2).result.tools.map((t: { name: string }) => t.name);
    expect(listedNames).toContain(OnsetCallToolName);
    expect(listedNames).toContain('voice_synthesize');
    expect(listedNames).toContain('scene_run_all');
    expect(listedNames).not.toContain('brand_kit_list');

    // tool_help 对被折叠的扩展工具返回完整说明并附带 onset_call 调用指引。
    const helpSfx = replies.get(3).result.content[0].text;
    expect(replies.get(3).result.isError).toBe(false);
    expect(helpSfx).toContain('sfx_search');
    expect(helpSfx).toContain(`经 ${OnsetCallToolName}({"tool": "sfx_search"`);

    // tool_help({"tool": "*"}) 列出直出与扩展全表。
    const index = replies.get(4).result.content[0].text;
    expect(index).toContain('voice_synthesize');
    expect(index).toContain('brand_kit_list');

    // onset_call 同时接受对象参数与 JSON 字符串参数。
    expect(replies.get(5).result.isError).toBe(false);
    expect(replies.get(5).result.content[0].text).toContain('op=brand_kit_list');
    expect(replies.get(6).result.isError).toBe(false);
    expect(replies.get(6).result.content[0].text).toContain('op=brand_kit_list');

    // 拒绝转发控制工具与非法 JSON。
    expect(replies.get(7).result.isError).toBe(true);
    expect(replies.get(7).result.content[0].text).toContain('请直接调用 job_wait');
    expect(replies.get(8).result.isError).toBe(true);
    expect(replies.get(8).result.content[0].text).toContain('合法 JSON');
  });

  it('activates compact mode automatically when ONSET_TOOLS_COMPACT=1 is set', async () => {
    const saved = process.env[ToolsCompactEnv];
    process.env[ToolsCompactEnv] = '1';
    try {
      const replies = await callMCP([{ id: 1, method: 'tools/list', params: {} }], fakeWorker());
      const names = replies.get(1).result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain(OnsetCallToolName);
      expect(names).toContain('voice_synthesize');
      expect(names).toContain('scene_run_all');
      expect(names).toContain('concat');
      expect(names).toContain('review');
      expect(names).not.toContain('brand_kit_list');
    } finally {
      if (saved === undefined) delete process.env[ToolsCompactEnv];
      else process.env[ToolsCompactEnv] = saved;
    }
  });
});
