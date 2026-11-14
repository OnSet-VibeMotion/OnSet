import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as scene from '../scene';
import { resetActivityCache, sceneActivity, sniffStreamTool } from './activity';
import { sceneRendering, type SceneSummary } from './scenes';
import { tempDir } from './testsupport';

function summary(dir: string): SceneSummary {
  return { id: 's1', directory: dir, exists: false, stale: false, attempts: 0 };
}

const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x', model: 'claude-test' });
const callRead = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/scene.json' } }] },
  session_id: 'x',
});
const resultRead = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, session_id: 'x' });
const callRender = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__am__hyperframes', input: { subcommand: 'render', args: [], code: 'x'.repeat(5000) } }] },
  session_id: 'x',
});
const say = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '画面已经排好，开始渲染。' }] }, session_id: 'x' });

describe('scene activity', () => {
  afterEach(() => resetActivityCache());

  it('sniffs which CLI wrote the stream', () => {
    expect(sniffStreamTool(init)).toBe('claude');
    expect(sniffStreamTool('{"type":"thread.started","thread_id":"a"}')).toBe('codex');
    expect(sniffStreamTool('{"type":"step_start","sessionID":"s","part":{}}')).toBe('opencode');
    expect(sniffStreamTool('not json')).toBe('');
  });

  // 渲染器边写、界面边读：半行留到下一次，结果回填到对应的调用上，长参数截短。
  it('parses the stream incrementally and pairs results with calls', () => {
    const dir = tempDir();
    const log = path.join(dir, 'render-s1.stream.jsonl');
    const half = Math.floor(callRender.length / 2);
    fs.writeFileSync(log, [init, callRead, resultRead, say].join('\n') + '\n' + callRender.slice(0, half));
    let a = sceneActivity(summary(dir)) as Record<string, any>;
    expect(a.model).toBe('claude-test');
    expect(a.renderer).toBe('claude');
    expect(a.steps.map((s: any) => [s.kind, s.state ?? ''])).toEqual([
      ['tool', 'done'],
      ['text', ''],
    ]);
    expect(a.steps[1].text).toBe('画面已经排好，开始渲染。');

    fs.appendFileSync(log, callRender.slice(half) + '\n');
    a = sceneActivity(summary(dir)) as Record<string, any>;
    expect(a.step_count).toBe(3);
    const render = a.steps[2];
    expect(render.tool).toBe('mcp__am__hyperframes');
    expect(render.state).toBe('running');
    expect((render.input.code as string).length).toBeLessThan(400);
  });

  // 重渲染前旧日志被挪走、新日志从头写：不能接着旧的偏移读。
  it('starts over when the log is replaced', () => {
    const dir = tempDir();
    const log = path.join(dir, 'render-s1.stream.jsonl');
    fs.writeFileSync(log, [init, callRead, resultRead, say].join('\n') + '\n');
    expect((sceneActivity(summary(dir)) as any).step_count).toBe(2);
    fs.renameSync(log, path.join(dir, 'old.jsonl'));
    fs.writeFileSync(log, init + '\n' + say + '\n');
    expect((sceneActivity(summary(dir)) as any).step_count).toBe(1);
  });

  // 渲染视频的几分钟里流日志不动：有进行中标记时看进程，不看日志静默了多久。
  it('rendering follows the live marker, not log silence', () => {
    const dir = tempDir();
    const log = path.join(dir, 'render-s1.stream.jsonl');
    fs.writeFileSync(log, init + '\n');
    const hourAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(log, hourAgo, hourAgo);
    expect(sceneRendering(dir, 's1'), '没有标记、日志一小时没动：不算渲染中').toBe(false);

    scene.writeLive(dir, 's1', { pid: process.pid, renderer: 'claude', started_at: '2026-11-09T00:00:00Z' });
    expect(sceneRendering(dir, 's1'), '标记里的进程还在：渲染中').toBe(true);
    expect((sceneActivity(summary(dir)) as any).started_at).toBe('2026-11-09T00:00:00Z');

    // 找一个肯定不存在的 pid：进程被强杀、来不及删标记。
    scene.writeLive(dir, 's1', { pid: 2 ** 22 + 12345, renderer: 'claude', started_at: '' });
    expect(sceneRendering(dir, 's1'), '标记里的进程没了：不算渲染中').toBe(false);

    scene.removeLive(dir, 's1');
    expect(fs.existsSync(scene.liveFile(dir, 's1'))).toBe(false);
  });
});
