import { describe, expect, it } from 'vitest';
import { agyMcpJSON, onsetToolsServer, ToolsFullEnv } from '../tools';
import { acpMcpServers, isAcpToolsServerCall } from './acp';
import { KindToolCall, KindToolResult, newParser, normalizeAgyTool } from './parse';

describe('agy MCP configuration and tool normalization', () => {
  it('sets ONSET_TOOLS_MAX_WAIT=150 for agy ACP and passes through ONSET_TOOLS_FULL when explicitly set', () => {
    const server = onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj');
    const agyMcp = acpMcpServers(server, 'agy')[0] as { env: Array<{ name: string; value: string }> };
    expect(agyMcp.env).toEqual(expect.arrayContaining([{ name: 'ONSET_TOOLS_MAX_WAIT', value: '150' }]));
    // 紧凑模式已全局默认开启，不再针对 agy 单独注入 ONSET_TOOLS_COMPACT。
    expect(agyMcp.env.some((e) => e.name === 'ONSET_TOOLS_COMPACT')).toBe(false);

    const fullServer = onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj', { [ToolsFullEnv]: '1' });
    const fullMcp = acpMcpServers(fullServer, 'agy')[0] as { env: Array<{ name: string; value: string }> };
    expect(fullMcp.env).toEqual(expect.arrayContaining([{ name: ToolsFullEnv, value: '1' }]));
  });

  it('preserves renderer eager tools in agyMcpJSON without injecting agy-only compact env', () => {
    const orch = JSON.parse(agyMcpJSON(onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj')));
    expect(orch.mcpServers.onset.env.ONSET_TOOLS_COMPACT).toBeUndefined();
    const rend = JSON.parse(agyMcpJSON(onsetToolsServer('/app/bin/onset', 'renderer', '/proj/scenes/s1')));
    expect(rend.mcpServers.onset.env.ONSET_TOOLS_COMPACT).toBeUndefined();
    expect(Object.keys(rend.mcpServers.onset.tools)).toContain('hyperframes');
  });

  it('auto-approves and unwraps mcp_onset_tool_call and legacy mcp_onset_onset_call', () => {
    const server = onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj');
    expect(isAcpToolsServerCall({ name: 'mcp_onset_tool_call' }, server)).toBe(true);
    expect(isAcpToolsServerCall({ name: 'mcp_onset_tool_search' }, server)).toBe(true);
    expect(isAcpToolsServerCall({ name: 'mcp_onset_onset_call' }, server)).toBe(true);

    expect(normalizeAgyTool('mcp_onset_tool_call', { tool: 'sfx_search', arguments: { query: 'whoosh' } })).toEqual({
      tool: 'mcp__onset__sfx_search',
      input: { query: 'whoosh' },
    });
    expect(
      normalizeAgyTool('mcp_onset_onset_call', { tool: 'brand_kit_list', arguments: '{"project_root":"."}' }),
    ).toEqual({
      tool: 'mcp__onset__brand_kit_list',
      input: { project_root: '.' },
    });

    const parser = newParser('agy');
    const events = parser.parse(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'c1',
          step_index: 5,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'mcp_onset_tool_call',
          tool_info: {
            name: 'mcp_onset_tool_call',
            parameters: { tool: 'sfx_search', arguments: { query: 'whoosh' } },
            output: 'found',
          },
        },
      }),
    );
    expect(events.filter((e) => e.kind === KindToolCall)).toEqual([
      { kind: KindToolCall, tool: 'mcp__onset__sfx_search', call_id: 'step-5', input: { query: 'whoosh' } },
    ]);
    expect(events.filter((e) => e.kind === KindToolResult)).toEqual([
      { kind: KindToolResult, tool: 'mcp__onset__sfx_search', call_id: 'step-5', text: 'found' },
    ]);
  });
});
