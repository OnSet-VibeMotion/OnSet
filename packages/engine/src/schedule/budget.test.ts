import { describe, expect, it } from 'vitest';
import { onsetToolsServer } from '../tools';
import { renderBudget, renderBudgetArgs } from './budget';

const gib = 1024 ** 3;
describe('Shared render budgets', () => {
  it('enforces workers for absent, auto, explicit, equal and duplicate forms', () => {
    const env = { ONSET_RENDER_WORKERS: '3' };
    expect(renderBudgetArgs(['render', '--quality', 'delivery'], env)).toEqual(['render', '--quality', 'delivery', '--workers', '3']);
    expect(renderBudgetArgs(['render', '--workers', 'auto'], env)).toEqual(['render', '--workers', '3']);
    expect(renderBudgetArgs(['render', '--workers=6'], env)).toEqual(['render', '--workers', '3']);
    expect(renderBudgetArgs(['render', '--workers', '2', '--workers=12'], env)).toEqual(['render', '--workers', '2']);
    expect(() => renderBudgetArgs(['render', '--workers', '--fps', '30'], env)).toThrow(/workers/);
  });
  it('enforces budgets on all platforms and leaves unbudgeted calls and help untouched', () => {
    const args = ['render', '--workers', 'auto'];
    expect(renderBudgetArgs(args, { ONSET_RENDER_WORKERS: '3' })).toEqual(['render', '--workers', '3']);
    expect(renderBudgetArgs(args, {})).toBe(args);
    expect(renderBudgetArgs(['render', '--help'], { ONSET_RENDER_WORKERS: '3' })).toEqual(['render', '--help']);
  });
  it('caps Mac scene concurrency without treating cached memory as unavailable', () => {
    expect(renderBudget(22, 32 * gib, gib, 3, 9, 'darwin')).toEqual({ jobs: 3, workers: 3 });
    expect(renderBudget(22, 8 * gib, gib, 8, 9, 'darwin')).toEqual({ jobs: 2, workers: 1 });
    expect(renderBudget(22, 32 * gib, gib, 3, 1, 'darwin')).toEqual({ jobs: 1, workers: 10 });
    expect(renderBudget(2, 8 * gib, gib, 8, 9, 'darwin')).toEqual({ jobs: 1, workers: 1 });
    expect(renderBudget(8, 0, 0, 3, 0, 'darwin')).toEqual({ jobs: 1, workers: 6 });
  });
  it('retains the available-memory strategy on Windows', () => {
    expect(renderBudget(22, 32 * gib, 11 * gib, 8, 9, 'win32')).toEqual({ jobs: 6, workers: 1 });
  });
  it('carries the worker budget through the renderer MCP boundary without unrelated secrets', () => {
    const server = onsetToolsServer('onset', 'renderer', '.', { ONSET_RENDER_WORKERS: '2', SECRET: 'excluded' });
    expect(server.env).toHaveProperty('ONSET_RENDER_WORKERS', '2');
    expect(server.env).not.toHaveProperty('SECRET');
    expect(renderBudgetArgs(['render', '--workers', 'auto'], server.env ?? {})).toEqual(['render', '--workers', '2']);
  });
});
