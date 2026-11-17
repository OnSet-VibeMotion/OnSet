import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { fetchArchive } from './archive';

vi.hoisted(() => vi.resetModules());
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
vi.mock('../envutil', async importOriginal => {
  const original = await importOriginal<typeof import('../envutil')>();
  return { ...original, lookPath: (name: string) => name };
});

it('waits for the download process to close before removing its files after cancellation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-archive-abort-'));
  const dest = path.join(dir, 'plugin');
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new PassThrough();
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  let finished = false;
  try {
    const downloading = fetchArchive('https://example.com/plugin.tar.gz', 'sha256:' + '0'.repeat(64), dest, {});
    const checked = expect(downloading).rejects.toThrow('cancelled');
    downloading.catch(() => { finished = true; });
    fs.writeFileSync(dest + '.tar.gz', 'partial');
    child.emit('error', new Error('cancelled'));
    await new Promise(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(fs.existsSync(dest + '.tar.gz')).toBe(true);
    child.emit('close', null);
    await checked;
    expect(fs.existsSync(dest + '.tar.gz')).toBe(false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); }
});
