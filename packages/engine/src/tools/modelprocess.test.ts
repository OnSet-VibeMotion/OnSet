import { marshal } from '../gojson';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from '../procgroup';
import { fetchMcodeModels } from './mcodemodels';
import { fetchQoderModels } from './qodermodels';

vi.hoisted(() => vi.resetModules());
vi.mock('../procgroup', async importOriginal => {
  const original = await importOriginal<typeof import('../procgroup')>();
  return { ...original, start: vi.fn(original.start) };
});
afterEach(() => vi.restoreAllMocks());

const queries = [
  ['mcode', fetchMcodeModels],
  ['qoder', (binary: string, env: Record<string, string>, signal?: AbortSignal) => fetchQoderModels('qoder', binary, env, signal)],
] as const;

describe.each(queries)('%s model process', (_, query) => {
  it('does not start an already cancelled query', async () => {
    const signal = AbortSignal.abort(new Error('cancelled before start'));
    const calls = vi.mocked(start).mock.calls.length;
    await expect(query('missing-binary', {}, signal)).rejects.toThrow('cancelled before start');
    expect(vi.mocked(start).mock.calls).toHaveLength(calls);
  });
  it('cleans its directory and abort listener when spawning fails', async () => {
    const controller = new AbortController();
    const temp = fs.mkdtempSync;
    let directory = '';
    vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => (directory = temp(prefix))) as typeof fs.mkdtempSync);
    const listeners = getEventListeners(controller.signal, 'abort').length;
    await expect(query(path.join(os.tmpdir(), 'onset-missing-model-binary'), {}, controller.signal)).rejects.toThrow();
    expect(fs.existsSync(directory)).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(listeners);
  });
});

it('reports a broken mcode input pipe without an unhandled stream error', async () => {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('broken pipe'), { code: 'EPIPE' })); } });
  child.stdout = new PassThrough();
  Object.defineProperty(child, 'exitCode', { value: 0 });
  vi.mocked(start).mockResolvedValueOnce({ child, wait: async () => {} });
  await expect(fetchMcodeModels('fake', {})).rejects.toThrow();
  await new Promise(resolve => setImmediate(resolve));
  expect(child.stdin.listenerCount('error')).toBeGreaterThan(0);
});

it('probes the thinking variant when the current mcode model is not thinking', async () => {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  const configOptions = [{ id: 'model', currentValue: 'm:p:model:v:', options: [{ value: 'm:p:model:v:' }, { value: 'm:p:model:v:thinking' }] }];
  const selected: string[] = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString());
    let result: unknown = {};
    if (request.method === 'session/new') result = { sessionId: 's', configOptions };
    if (request.method === 'session/set_config_option') {
      selected.push(request.params.value);
      result = { configOptions: [{ id: 'thinkingEffort', options: [{ value: 'high' }] }] };
    }
    setImmediate(() => child.stdout!.emit('data', marshal({ id: request.id, result }) + '\n'));
    done();
  } });
  vi.mocked(start).mockImplementationOnce(async (_binary, _args, options) => ({
    child,
    wait: () => new Promise(resolve => options?.signal?.addEventListener('abort', () => { child.stdout!.emit('end'); resolve(); }, { once: true })),
  }));
  expect(await fetchMcodeModels('fake', {})).toEqual([{ id: 'p/model', label: 'p/model', isDefault: true, efforts: ['high'] }]);
  expect(selected).toEqual(['m:p:model:v:thinking']);
});


it('rejects cancellation during a model switch rather than caching a partial model table', async () => {
  const external = new AbortController();
  const child = new EventEmitter() as ChildProcess;
  child.stdout = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(chunk.toString());
    if (request.method === 'session/set_config_option') external.abort(new Error('cancelled during switch'));
    else {
      const result = request.method === 'session/new' ? { sessionId: 's', configOptions: [{ id: 'model', currentValue: 'm:p:a:v:thinking', options: [{ value: 'm:p:a:v:thinking' }, { value: 'm:p:b:v:thinking' }] }] } : {};
      setImmediate(() => child.stdout!.emit('data', marshal({ id: request.id, result }) + '\n'));
    }
    done();
  } });
  vi.mocked(start).mockImplementationOnce(async (_binary, _args, options) => ({ child, wait: () => new Promise(resolve => options?.signal?.addEventListener('abort', () => { child.stdout!.emit('end'); resolve(); }, { once: true })) }));
  await expect(fetchMcodeModels('fake', {}, external.signal)).rejects.toThrow('cancelled during switch');
});
