import { describe, expect, it } from 'vitest';
import { agyMcpJSON, onsetToolsServer } from '../tools';
import { acpMcpServers, isAcpToolsServerCall } from './acp';
import { KindToolCall, KindToolResult, newParser, normalizeAgyTool } from './parse';

describe('agy compact MCP configuration and tool normalization', () => {
  it('enables ONSET_TOOLS_COMPACT for agy ACP while leaving other ACP backends full-schema', () => {
    const server = onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj');
    const agyMcp = acpMcpServers(server, 'agy')[0] as { env: Array<{ name: string; value: string }> };
    expect(agyMcp.env).toEqual(
      expect.arrayContaining([
        { name: 'ONSET_TOOLS_MAX_WAIT', value: '150' },
        { name: 'ONSET_TOOLS_COMPACT', value: '1' },
      ]),
    );
    for (const other of ['opencode', 'codebuddy', 'mcode']) {
      const mcp = acpMcpServers(server, other)[0] as { env: Array<{ name: string; value: string }> };
      expect(
        mcp.env.some((e) => e.name === 'ONSET_TOOLS_COMPACT'),
        other,
      ).toBe(false);
    }
  });

  it('enables ONSET_TOOLS_COMPACT in agyMcpJSON for orchestrator only, preserving renderer eager tools', () => {
    const orch = JSON.parse(agyMcpJSON(onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj')));
    expect(orch.mcpServers.onset.env.ONSET_TOOLS_COMPACT).toBe('1');
    const rend = JSON.parse(agyMcpJSON(onsetToolsServer('/app/bin/onset', 'renderer', '/proj/scenes/s1')));
    expect(rend.mcpServers.onset.env.ONSET_TOOLS_COMPACT).toBeUndefined();
    expect(Object.keys(rend.mcpServers.onset.tools)).toContain('hyperframes');
  });

  it('auto-approves and unwraps mcp_onset_onset_call to the real onset tool name', () => {
    const server = onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj');
    expect(isAcpToolsServerCall({ name: 'mcp_onset_onset_call' }, server)).toBe(true);
    expect(normalizeAgyTool('mcp_onset_onset_call', { tool: 'sfx_search', arguments: { query: 'whoosh' } })).toEqual({
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
          tool_name: 'mcp_onset_onset_call',
          tool_info: {
            name: 'mcp_onset_onset_call',
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
