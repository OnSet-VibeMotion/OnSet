import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import { findOp, normalizeParams } from './ops/op';
import { Buffer, tempDir } from './testutil';
import './scene_cmd';

it('Queue prioritizes representatives, refills before a slow scene ends, and writes a complete trace', async () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  fs.writeFileSync(path.join(root, 'onset.conf'), 'MEMORY=off\n');
  for (let n = 1; n <= 9; n++) {
    const id = 'scene-' + String(n).padStart(3, '0'), dir = path.join(root, 'scenes', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({ id, duration_seconds: 1, output: 'out.mp4', transcript: 'transcript.srt', text: 'hello' }));
  }
  process.chdir(root);
  const op = findOp('scene_run_all')!, out = new Buffer(), signal = new AbortController().signal;
  const context = { out, err: out, signal, unsafe: false };
  const params = { scenes: 'scenes', jobs: 3, priority_scenes: ['scene-001','scene-004','scene-009'], retries: 0, queue_trace_json: 'production/queue.jsonl' };
  const budget = vi.spyOn(schedule, 'renderBudget').mockReturnValue({ jobs: 3, workers: 2 });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  let slowDone = false;
  const mock = vi.spyOn(scene, 'run').mockImplementation(async s => {
    started.push(s.id);
    if (s.id === 'scene-004') { await hold; slowDone = true; }
  });
  try {
    const running = op.run(normalizeParams(op, params), context);
    try {
      await vi.waitFor(() => expect(started).toContain('scene-002'));
      expect(slowDone).toBe(false);
      expect(started.slice(0,3)).toEqual(['scene-001','scene-004','scene-009']);
    } finally { release(); }
    const result = (await running)?.data as any;
    expect(result.counts.succeeded).toBe(9);
    expect(result.queue_trace_ok).toBe(true);
    const events = fs.readFileSync(result.queue_trace_json, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events).toHaveLength(18);
    expect(Math.max(...events.map(e => e.active))).toBeLessThanOrEqual(3);
    expect(new Set(started).size).toBe(9);
    expect(events.every(e => typeof e.at === 'string')).toBe(true);
    await expect(op.run(normalizeParams(op, params), context)).rejects.toThrow(); // 不覆盖已有监控证据。
    expect(started).toHaveLength(9);
    await expect(op.run(normalizeParams(op, { ...params, priority_scenes: ['unknown'] }), context)).rejects.toThrow(/priority_scenes/);
    await expect(op.run(normalizeParams(op, { ...params, queue_trace_json: '../outside.jsonl' }), context)).rejects.toThrow(/production/);
    expect(started).toHaveLength(9);
    vi.useFakeTimers({toFake:['Date']});
    try {
      vi.setSystemTime(new Date('2026-11-14T04:00:00Z'));
      const defaults={...params,queue_trace_json:''};
      const first=(await op.run(normalizeParams(op,defaults),context))?.data as any;
      const firstBytes=fs.readFileSync(first.queue_trace_json);
      const second=(await op.run(normalizeParams(op,defaults),context))?.data as any;
      expect(first.queue_trace_json).not.toBe(second.queue_trace_json);
      expect(fs.readFileSync(first.queue_trace_json)).toEqual(firstBytes);
      expect(fs.readFileSync(second.queue_trace_json,'utf8').trim().split('\n')).toHaveLength(18);
    } finally {vi.useRealTimers();}
  } finally { mock.mockRestore(); budget.mockRestore(); }
});

it('Standalone scenes without a project root still render; only an explicit queue log needs one', async () => {
  const root = tempDir();
  for (let n = 1; n <= 2; n++) {
    const id = 'scene-' + String(n).padStart(3, '0'), dir = path.join(root, 'scenes', id);
    fs.mkdirSync(dir, { recursive: true });
    // 没有 onset.conf：画幅只看镜头目录自己的 frame.md。
    fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
    fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
    fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({ id, duration_seconds: 1, output: 'out.mp4', transcript: 'transcript.srt', text: 'hello' }));
  }
  process.chdir(root);
  const op = findOp('scene_run_all')!, out = new Buffer(), signal = new AbortController().signal;
  const context = { out, err: out, signal, unsafe: false };
  const budget = vi.spyOn(schedule, 'renderBudget').mockReturnValue({ jobs: 2, workers: 1 });
  const started: string[] = [];
  const mock = vi.spyOn(scene, 'run').mockImplementation(async s => { started.push(s.id); });
  try {
    const result = (await op.run(normalizeParams(op, { scenes: 'scenes', jobs: 2, retries: 0 }), context))?.data as any;
    expect(result.counts.succeeded).toBe(2);
    expect(result.queue_trace_json).toBeUndefined();
    expect(fs.existsSync(path.join(root, 'production'))).toBe(false);
    await expect(op.run(normalizeParams(op, { scenes: 'scenes', jobs: 2, retries: 0, queue_trace_json: 'production/queue.jsonl' }), context)).rejects.toThrow(/onset\.conf/);
    expect(started).toHaveLength(2);
    await expect(op.run(normalizeParams(op, { scenes: 'scenes', only_scenes: ['unknown'], force: true }), context)).rejects.toThrow(/only_scenes/);
    const selected = await op.run(normalizeParams(op, { scenes: 'scenes', only_scenes: ['scene-002'], force: true }), context);
    expect(selected?.data).toMatchObject({ counts: { succeeded: 1 } });
    expect(started.slice(2)).toEqual(['scene-002']);
  } finally { mock.mockRestore(); budget.mockRestore(); }
});


it('does not charge the same attempt again when existing output is accepted', async () => {
  const root = tempDir(), dir = path.join(root, 'scenes', 'one');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'onset.conf'), 'MEMORY=off\n');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"one","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}');
  process.chdir(root);
  const mock = vi.spyOn(scene, 'run').mockImplementation(async s => {
    const attempt = scene.newAttempt({ scene_id: s.id, usage: { input_tokens: 100, output_tokens: 20, turns: 1, source: 'test', basis: 'total-input' } });
    s.afterAttempt?.(attempt);
    s.afterAttempt?.({ ...attempt, resumed: 'verify', outcome: scene.OutcomeSucceeded });
  });
  try {
    const op = findOp('scene_run_all')!, out = new Buffer();
    const result = (await op.run(normalizeParams(op, { scenes: 'scenes', jobs: 1, retries: 0 }), { out, err: out, signal: new AbortController().signal, unsafe: false }))?.data as any;
    expect(result.usage).toMatchObject({ input_tokens: 100, output_tokens: 20, turns: 1 });
  } finally { mock.mockRestore(); }
});
