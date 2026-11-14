import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { renderWorkers, systemMemory } from '../schedule';
import { analysisScript, analyzeScript } from '../beat/analyze';
import { envPython } from '../beat/env';
import { cliCommandFor } from '../hyperframes';
import { onsetToolsServer } from '../tools';
import path from 'node:path';
import { renderBudgetArgs, windowsRenderMetrics, windowsRenderWorkers, windowsSceneJobs } from './performance';

describe('Windows performance boundaries', () => {
  it('budgets 32 GiB across three simultaneous scenes and reports Windows RAM', () => {
    expect(renderWorkers(22, 32 * 1024 ** 3, 3)).toBe(3);
    if (process.platform === 'win32') expect(systemMemory()).toBe(os.totalmem());
    expect(windowsRenderWorkers(22, 32 * 1024 ** 3, 24 * 1024 ** 3, 3)).toBe(3);
    expect(windowsRenderWorkers(22, 32 * 1024 ** 3, 11 * 1024 ** 3, 3)).toBe(2);
    expect(windowsRenderWorkers(22, 32 * 1024 ** 3, 11 * 1024 ** 3, 8)).toBe(1);
  });
  it('enforces workers for absent, auto, explicit, equal and duplicate forms', () => {
    const env = { ONSET_RENDER_WORKERS: '3' };
    expect(renderBudgetArgs(['render', '--quality', 'delivery'], env, 'win32')).toEqual(['render', '--quality', 'delivery', '--workers', '3']);
    expect(renderBudgetArgs(['render', '--workers', 'auto'], env, 'win32')).toEqual(['render', '--workers', '3']);
    expect(renderBudgetArgs(['render', '--workers=6'], env, 'win32')).toEqual(['render', '--workers', '3']);
    expect(renderBudgetArgs(['render', '--workers', '2', '--workers=12'], env, 'win32')).toEqual(['render', '--workers', '2']);
    expect(() => renderBudgetArgs(['render', '--workers', '--fps', '30'], env, 'win32')).toThrow(/workers/);
  });
  it('caps simultaneous scenes when one browser each would still exceed the available memory', () => {
    const gib = 1024 ** 3;
    const jobs = windowsSceneJobs(22, 32 * gib, 11 * gib, 8);
    expect(jobs).toBe(6);
    expect(jobs * windowsRenderWorkers(22, 32 * gib, 11 * gib, jobs) * 1.5 * gib).toBeLessThanOrEqual(9 * gib);
    expect(windowsSceneJobs(22, 32 * gib, 24 * gib, 3)).toBe(3);
    expect(windowsSceneJobs(2, 8 * gib, gib, 8)).toBe(1);
  });
  it('leaves other platforms, unbudgeted CLI calls and help untouched', () => {
    const args = ['render', '--workers', 'auto'];
    for (const platform of ['darwin', 'linux'] as const) expect(renderBudgetArgs(args, { ONSET_RENDER_WORKERS: '3' }, platform)).toBe(args);
    expect(renderBudgetArgs(args, {}, 'win32')).toBe(args);
    expect(renderBudgetArgs(['render', '--help'], { ONSET_RENDER_WORKERS: '3' }, 'win32')).toEqual(['render', '--help']);
  });
  it('selects Windows CUDA without changing the POSIX analyzer', () => {
    expect(analysisScript('win32')).toContain('torch.cuda.is_available()');
    expect(analysisScript('win32')).toContain('device=device');
    expect(analysisScript('darwin')).toBe(analyzeScript);
    expect(analysisScript('linux')).toBe(analyzeScript);
    expect(envPython('venv', 'win32')).toBe(path.join('venv', 'Scripts', 'python.exe'));
    expect(envPython('venv', 'darwin')).toBe(path.join('venv', 'bin', 'python'));
  });
  it('records the browser GPU path separately from encoding work', () => {
    expect(windowsRenderMetrics('screenshot capture · hardware gpu · compile 0.5s · setup 1.1s · capture 7.8s · encode 0.1s · assemble 0.2s')).toEqual({ browser_hardware: 'gpu', seconds: { compile: 0.5, setup: 1.1, capture: 7.8, encode: 0.1, assemble: 0.2 } });
    expect(windowsRenderMetrics('render failed')).toBeUndefined();
    expect(windowsRenderMetrics('screenshot capture · hardware gpu · setup 1m 43.0s · capture 1h 2m 3.5s · encode 8.5s')).toEqual({ browser_hardware: 'gpu', seconds: { setup: 103, capture: 3723.5, encode: 8.5 } });
  });
  it.skipIf(process.platform !== 'win32')('carries stable capture and browser budgets through the renderer MCP boundary', () => {
    const env = { PRODUCER_EXPERIMENTAL_FAST_CAPTURE: 'false', ONSET_RENDER_WORKERS: '2', DO_NOT_TRACK: '1', SECRET: 'excluded' };
    const server = onsetToolsServer('onset', 'renderer', '.', env);
    expect(server.env).toMatchObject({ PRODUCER_EXPERIMENTAL_FAST_CAPTURE: 'false', ONSET_RENDER_WORKERS: '2', DO_NOT_TRACK: '1' });
    expect(server.env).not.toHaveProperty('SECRET');
    expect(cliCommandFor('not-installed', {}, ['render']).env.PRODUCER_EXPERIMENTAL_FAST_CAPTURE).toBe('false');
    expect(cliCommandFor('not-installed', { PRODUCER_EXPERIMENTAL_FAST_CAPTURE: 'true' }, ['render']).env.PRODUCER_EXPERIMENTAL_FAST_CAPTURE).toBe('true');
  });
});
