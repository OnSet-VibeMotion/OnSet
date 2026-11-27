import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as studioview from '@onset/engine/studioview';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeTools, type ServeToolsMCPOptions, type Spawner, serveToolsMCP } from './toolsmcp';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-toolsmcp-ask-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const unusedSpawner: Spawner = () => {
  throw new Error('studio_ask 不应起子进程');
};

async function callMCP(
  requests: Record<string, unknown>[],
  profile: 'orchestrator' | 'renderer' = 'orchestrator',
  options: ServeToolsMCPOptions = {},
  signal?: AbortSignal,
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
    profile,
    unusedSpawner,
    signal,
    options,
  );
  return out;
}

describe('studio_ask in onset tools MCP', () => {
  it('exposes studio_ask only on the orchestrator profile and documents it in tool_help', async () => {
    const orch = describeTools('orchestrator');
    expect(orch.map((t) => t.name)).toContain('studio_ask');
    expect(describeTools('renderer').map((t) => t.name)).not.toContain('studio_ask');
    const replies = await callMCP([
      { id: 1, method: 'tools/call', params: { name: 'tool_help', arguments: { tool: 'studio_ask' } } },
    ]);
    expect(replies.get(1).result.content[0].text).toContain('studio_ask(');
  });

  it('rejects invalid question payloads without touching the inbox', async () => {
    const replies = await callMCP(
      [{ id: 1, method: 'tools/call', params: { name: 'studio_ask', arguments: { questions: [] } } }],
      'orchestrator',
      { inbox: tmp },
    );
    expect(replies.get(1).result.isError).toBe(true);
    expect(replies.get(1).result.content[0].text).toContain('至少提供 1 个问题');
    expect(studioview.listQuestionRequests(tmp)).toEqual([]);
  });

  it('returns unavailable guidance when run outside the desktop studio (empty inbox)', async () => {
    const replies = await callMCP(
      [
        {
          id: 1,
          method: 'tools/call',
          params: {
            name: 'studio_ask',
            arguments: { questions: [{ question: '选风格？', options: [{ label: 'A' }, { label: 'B' }] }] },
          },
        },
      ],
      'orchestrator',
      { inbox: '' },
    );
    const res = replies.get(1).result;
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toEqual({ status: 'unavailable' });
    expect(res.content[0].text).toContain('```questions');
  });

  it('waits mid-turn for user answers in inbox and returns structured JSON plus summary', async () => {
    const watcher = setInterval(() => {
      const [item] = studioview.listQuestionRequests(tmp);
      if (!item || item.answered) return;
      studioview.writeQuestionResponse(tmp, item.request.id, {
        status: 'answered',
        answers: [
          { question_id: 'opening', label: '开场', selected: ['直接抛数据'] },
          { question_id: 'focus', label: '重点', selected: ['原理', '对比'], other: '补一页总结' },
        ],
        answer_map: { opening: '直接抛数据', focus: ['原理', '对比', '补一页总结'] },
      });
      clearInterval(watcher);
    }, 10);
    try {
      const replies = await callMCP(
        [
          {
            id: 1,
            method: 'tools/call',
            params: {
              name: 'studio_ask',
              arguments: {
                title: '规格确认',
                questions: [
                  {
                    id: 'opening',
                    header: '开场',
                    question: '怎么开场？',
                    options: [{ label: '直接抛数据', recommended: true }, { label: '留悬念' }],
                  },
                  {
                    id: 'focus',
                    header: '重点',
                    question: '重点讲啥？',
                    multi_select: true,
                    options: [{ label: '原理' }, { label: '对比' }],
                  },
                ],
              },
            },
          },
        ],
        'orchestrator',
        { inbox: tmp, questionPollInterval: 10, questionTimeoutMs: 2000 },
      );
      const res = replies.get(1).result;
      expect(res.isError).toBe(false);
      expect(res.structuredContent).toMatchObject({
        status: 'answered',
        answer_map: { opening: '直接抛数据', focus: ['原理', '对比', '补一页总结'] },
      });
      expect(res.content[0].text).toContain('1. [开场]：直接抛数据');
      expect(res.content[0].text).toContain('2. [重点]：原理、对比；补充：补一页总结');
    } finally {
      clearInterval(watcher);
    }
  });

  it('hands off gracefully with deferred status when waiting reaches the MCP timeout budget', async () => {
    const replies = await callMCP(
      [
        {
          id: 1,
          method: 'tools/call',
          params: {
            name: 'studio_ask',
            arguments: { questions: [{ question: '选风格？', options: [{ label: 'A' }, { label: 'B' }] }] },
          },
        },
      ],
      'orchestrator',
      { inbox: tmp, questionPollInterval: 10, questionTimeoutMs: 30 },
    );
    const res = replies.get(1).result;
    expect(res.isError).toBe(false);
    expect(res.structuredContent).toMatchObject({ status: 'deferred' });
    expect(studioview.listQuestionRequests(tmp)[0]).toMatchObject({ deferred: true, answered: false });
  });
});
