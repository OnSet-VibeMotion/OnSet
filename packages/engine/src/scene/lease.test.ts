import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { acquireSceneLease, SceneBusyError } from './lease';
import { writeLive } from './live';
const roots: string[] = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-lease-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
test('Scene lease blocks a duplicate before live marker and releases only its own lease', () => {
  const dir = fixture();
  const release = acquireSceneLease(dir, 'one');
  expect(() => acquireSceneLease(dir, 'one')).toThrow(SceneBusyError);
  expect(fs.readdirSync(path.join(dir, '.onset-render-leases'))).toHaveLength(1);
  release();
  acquireSceneLease(dir, 'one')();
});
test('existing active render is protected on every platform', () => {
  const dir = fixture();
  writeLive(dir, 'one', { pid: process.pid, renderer: 'test', started_at: '' });
  expect(() => acquireSceneLease(dir, 'one')).toThrow(SceneBusyError);
  expect(fs.existsSync(path.join(dir, '.onset-render-leases'))).toBe(false);
});
test('dead owner can resume; malformed lease safely blocks without deletion', () => {
  const dir = fixture(), leases = path.join(dir, '.onset-render-leases');
  fs.mkdirSync(leases);
  fs.writeFileSync(path.join(leases, 'dead.json'), JSON.stringify({ pid: 2147483647 }));
  acquireSceneLease(dir, 'one')();
  expect(fs.existsSync(path.join(leases, 'dead.json'))).toBe(true);
  fs.writeFileSync(path.join(leases, 'incomplete.json'), '');
  expect(() => acquireSceneLease(dir, 'one')).toThrow(SceneBusyError);
  expect(fs.readdirSync(leases)).toHaveLength(2);
});
