import { describe, expect, it } from 'vitest';
import { onsetToolsServer } from '../tools';
import { ACPTranslator, isAcpToolsServerCall } from './acp';
import { codexItemEvents } from './codexapp';
import { type Event, KindToolCall, KindToolResult, newParser, unwrapOnsetToolCall } from './parse';

describe('unified tool_call / onset_call transparent unwrapping across all 9 backends + director', () => {
  it('unwraps all backend naming prefixes for both tool_call and legacy onset_call', () => {
    for (const wrappedName of [
      'tool_call',
      'onset_call',
      'mcp__onset__tool_call',
      'mcp__onset__onset_call',
      'mcp_onset_tool_call',
      'mcp_onset_onset_call',
      'onset_tool_call',
      'onset_onset_call',
      'onset.tool_call',
      'onset.onset_call',
    ]) {
      expect(
        unwrapOnsetToolCall(wrappedName, { tool: 'brand_kit_list', arguments: { project_root: '.' } }),
        wrappedName,
      ).toEqual({
        tool: 'mcp__onset__brand_kit_list',
        input: { project_root: '.' },
      });
    }
    expect(unwrapOnsetToolCall('mcp__onset__tool_call', { tool: 'sfx_search', arguments: '{"query":"hit"}' })).toEqual({
      tool: 'mcp__onset__sfx_search',
      input: { query: 'hit' },
    });
    expect(unwrapOnsetToolCall('mcp__onset__scene_run', { scene: 'scenes/scene-001' })).toEqual({
      tool: 'mcp__onset__scene_run',
      input: { scene: 'scenes/scene-001' },
    });
  });

  it('unwraps claude, qoder, qoder-intl, codebuddy, and director stream-json events', () => {
    for (const backend of ['claude', 'qoder', 'qoder-intl', 'codebuddy', 'director']) {
      const parser = newParser(backend);
      const events = parser.parse(
        JSON.stringify({
          type: 'assistant',
          session_id: 's1',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'c1',
                name: backend === 'director' ? 'tool_call' : 'mcp__onset__tool_call',
                input: { tool: 'sfx_search', arguments: { query: 'whoosh' } },
              },
              {
                type: 'tool_use',
                id: 'c2',
                name: backend === 'director' ? 'onset_call' : 'mcp__onset__onset_call',
                input: { tool: 'brand_kit_list', arguments: '{"project_root":"."}' },
              },
            ],
          },
        }),
      );
      const calls = events.filter((e) => e.kind === KindToolCall);
      expect(calls, backend).toEqual([
        { kind: KindToolCall, tool: 'mcp__onset__sfx_search', call_id: 'c1', input: { query: 'whoosh' } },
        { kind: KindToolCall, tool: 'mcp__onset__brand_kit_list', call_id: 'c2', input: { project_root: '.' } },
      ]);
    }

    // Qoder 懒加载 mcp_call 包裹 mcp__onset__tool_call 时也层层解包。
    const qoderParser = newParser('qoder');
    const qEvents = qoderParser.parse(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sq',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'cq',
              name: 'mcp_call',
              input: {
                toolName: 'mcp__onset__tool_call',
                arguments: { tool: 'project_export_jianying', arguments: { out: 'draft' } },
              },
            },
          ],
        },
      }),
    );
    expect(qEvents.filter((e) => e.kind === KindToolCall)).toEqual([
      { kind: KindToolCall, tool: 'mcp__onset__project_export_jianying', call_id: 'cq', input: { out: 'draft' } },
    ]);
  });

  it('unwraps codex exec and codex app-server mcp_tool_call events', () => {
    const parser = newParser('codex');
    const started = parser.parse(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'm1',
          type: 'mcp_tool_call',
          server: 'onset',
          tool: 'tool_call',
          arguments: { tool: 'brand_kit_list', arguments: { project_root: '.' } },
        },
      }),
    );
    const completed = parser.parse(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'm1',
          type: 'mcp_tool_call',
          server: 'onset',
          tool: 'tool_call',
          arguments: { tool: 'brand_kit_list', arguments: { project_root: '.' } },
          status: 'completed',
          result: { content: [{ type: 'text', text: 'ok' }] },
        },
      }),
    );
    expect(started).toEqual([
      { kind: KindToolCall, tool: 'mcp__onset__brand_kit_list', call_id: 'm1', input: { project_root: '.' } },
    ]);
    expect(completed).toEqual([
      {
        kind: KindToolResult,
        tool: 'mcp__onset__brand_kit_list',
        call_id: 'm1',
        input: { project_root: '.' },
        text: 'ok',
        is_error: false,
      },
    ]);

    const appStarted = codexItemEvents('started', {
      id: 'm2',
      type: 'mcpToolCall',
      server: 'onset',
      tool: 'onset_call',
      arguments: { tool: 'sfx_search', arguments: { query: 'bell' } },
    });
    const appCompleted = codexItemEvents('completed', {
      id: 'm2',
      type: 'mcpToolCall',
      server: 'onset',
      tool: 'onset_call',
      arguments: { tool: 'sfx_search', arguments: { query: 'bell' } },
      status: 'completed',
    });
    expect(appStarted).toEqual([
      { kind: KindToolCall, tool: 'mcp__onset__sfx_search', call_id: 'm2', input: { query: 'bell' } },
    ]);
    expect(appCompleted).toEqual([
      {
        kind: KindToolResult,
        tool: 'mcp__onset__sfx_search',
        call_id: 'm2',
        input: { query: 'bell' },
        is_error: undefined,
      },
    ]);
  });

  it('unwraps opencode run, mcode exec, agy headless, and ACP translator events', () => {
    const oc = newParser('opencode').parse(
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'so',
        part: {
          id: 'p1',
          tool: 'onset_tool_call',
          state: {
            status: 'completed',
            input: { tool: 'font_catalog', arguments: { query: '思源' } },
            output: 'fonts',
          },
        },
      }),
    );
    expect(oc.filter((e) => e.kind === KindToolCall)).toEqual([
      { kind: KindToolCall, tool: 'mcp__onset__font_catalog', call_id: 'p1', input: { query: '思源' } },
    ]);
    expect(oc.filter((e) => e.kind === KindToolResult)).toEqual([
      { kind: KindToolResult, tool: 'mcp__onset__font_catalog', call_id: 'p1', text: 'fonts' },
    ]);

    const mcode = newParser('mcode');
    const mcStart = mcode.parse(
      JSON.stringify({
        type: 'item.started',
        sessionId: 'sm',
        item: {
          id: 'i1',
          type: 'tool_call',
          toolCall: {
            id: 'tc1',
            name: 'mcp__onset__tool_call',
            input: { tool: 'brand_kit_get', arguments: { id: 'acme' } },
          },
        },
      }),
    );
    const mcDone = mcode.parse(
      JSON.stringify({
        type: 'item.completed',
        sessionId: 'sm',
        item: {
          id: 'i1',
          type: 'tool_call',
          toolCall: {
            id: 'tc1',
            name: 'mcp__onset__tool_call',
            status: 2,
            output: { content: [{ type: 'text', text: 'done' }] },
          },
        },
      }),
    );
    expect(mcStart.filter((e) => e.kind === KindToolCall)).toEqual([
      { kind: KindToolCall, tool: 'mcp__onset__brand_kit_get', call_id: 'tc1', input: { id: 'acme' } },
    ]);
    expect(mcDone.filter((e) => e.kind === KindToolResult)).toEqual([
      { kind: KindToolResult, tool: 'mcp__onset__brand_kit_get', call_id: 'tc1', text: 'done', is_error: false },
    ]);

    const acpEvents: Event[] = [];
    const translator = new ACPTranslator((ev) => acpEvents.push(ev));
    translator.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'acp-1',
      kind: 'other',
      name: 'mcp_onset_tool_call',
      rawInput: { tool: 'review_comments_list', arguments: '{"project_root":"."}' },
    });
    translator.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'acp-1',
      status: 'completed',
      rawOutput: { output: '0 comments' },
    });
    expect(acpEvents).toEqual([
      { kind: KindToolCall, tool: 'mcp__onset__review_comments_list', call_id: 'acp-1', input: { project_root: '.' } },
      {
        kind: KindToolResult,
        tool: 'mcp__onset__review_comments_list',
        call_id: 'acp-1',
        text: '0 comments',
        is_error: undefined,
      },
    ]);
  });

  it('auto-approves tool_search, tool_call, and legacy aliases on onset MCP server in ACP', () => {
    const server = onsetToolsServer('/app/bin/onset', 'orchestrator', '/proj');
    for (const name of [
      'mcp_onset_tool_search',
      'mcp_onset_tool_call',
      'mcp_onset_onset_call',
      'mcp__onset__tool_search',
      'mcp__onset__tool_call',
      'mcp__onset__onset_call',
    ]) {
      expect(isAcpToolsServerCall({ name }, server), name).toBe(true);
    }
    expect(
      isAcpToolsServerCall({ name: 'call_mcp_tool', rawInput: { ServerName: 'onset', ToolName: 'tool_call' } }, server),
    ).toBe(true);
    expect(isAcpToolsServerCall({ name: 'mcp__other__tool_call' }, server)).toBe(false);
  });
});
