import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as scene from '@onset/engine/scene';
import { Buffer, run, setenv, tempDir } from './testutil';
import { describeTools, prepareCall } from './toolsmcp';
import { runOpWorker } from './ops/worker';

afterEach(() => vi.restoreAllMocks());

function renderProject(jobs: number): { peak: () => number; rendered: () => number } {
  const root = tempDir();
  const settings = path.join(tempDir(), 'settings.conf');
  fs.writeFileSync(settings, `SCENE_JOBS=${jobs}\n`);
  setenv('ONSET_SETTINGS_FILE', settings);
  setenv('SCENE_JOBS', '');
  setenv('MEMORY', 'off');
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\nSCENE_JOBS=\n');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  for (let i = 1; i <= 6; i++) {
    const id = `scene-00${i}`;
    const dir = path.join(root, 'scenes', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\n测试\n');
    fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({ id, duration_seconds: 1, output: 'out.mp4', transcript: 'transcription.srt', text: '测试' }));
  }
  process.chdir(root);
  // Windows 仍保留资源预算；这里提供足够资源，专门检查配置与调用参数的优先级。
  vi.spyOn(os, 'availableParallelism').mockReturnValue(24);
  vi.spyOn(os, 'totalmem').mockReturnValue(64 * 1024 ** 3);
  vi.spyOn(os, 'freemem').mockReturnValue(32 * 1024 ** 3);
  let active = 0, peak = 0, rendered = 0;
  // 只替换昂贵的渲染步骤，参数解析、配置读取与并发调度都走真实实现。
  vi.spyOn(scene, 'run').mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    rendered++;
  });
  return { peak: () => peak, rendered: () => rendered };
}

describe('render concurrency follows user settings', () => {
  it.each(['scene_run_all', 'scene_seams'])('%s does not offer a concurrency override to agents', (name) => {
    const tool = describeTools('orchestrator').find((t) => t.name === name)!;
    expect(tool.inputSchema.properties).not.toHaveProperty('jobs');
    expect(tool.help).not.toMatch(/"jobs"\s*:|jobs（/);
    // 续接的旧会话仍可能照旧例子传 jobs；忽略它，不打断制作。
    expect(prepareCall(tool, { scenes: 'scenes', jobs: 3 }).jobs).toBe(0);
  });

  it.each([2, 6])('uses configured concurrency %i for an MCP call carrying old jobs: 3', async (jobs) => {
    const observed = renderProject(jobs);
    const tool = describeTools('orchestrator').find((t) => t.name === 'scene_run_all')!;
    const params = prepareCall(tool, { scenes: 'scenes', jobs: 3, retries: 0 });
    const out = new Buffer();
    expect(await runOpWorker(tool.name, JSON.stringify(params), out, new AbortController().signal, false), out.text).toBe(0);
    expect(observed.rendered()).toBe(6);
    expect(observed.peak()).toBe(jobs);
    expect(out.text).toContain(`镜头调度：并发上限 ${jobs}，本批待渲染 6 个，最多同时运行 ${jobs} 个`);
  });

  it('also ignores an override passed directly by the desktop backend', async () => {
    const observed = renderProject(6);
    const out = new Buffer();
    expect(await runOpWorker('scene_run_all', JSON.stringify({ scenes: 'scenes', jobs: 3, retries: 0 }), out, new AbortController().signal, false), out.text).toBe(0);
    expect(observed.peak()).toBe(6);
  });

  it('keeps explicit concurrency available to the development CLI', async () => {
    const observed = renderProject(6);
    const out = new Buffer();
    expect(await run(['scene', 'run-all', 'scenes', '--jobs', '3', '--retries', '0'], out), out.text).toBe(0);
    expect(observed.rendered()).toBe(6);
    expect(observed.peak()).toBe(3);
  });
});
