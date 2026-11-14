import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { acquireWindowsSceneLease, SceneBusyError } from './windowslease';
import { writeLive } from './live';
const roots: string[] = [];
const fixture = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-lease-')); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
test('Windows lease blocks a duplicate before live marker and releases only its own lease', () => {
  const dir = fixture();
  const release = acquireWindowsSceneLease(dir, 'one', 'win32');
  expect(() => acquireWindowsSceneLease(dir, 'one', 'win32')).toThrow(SceneBusyError);
  expect(fs.readdirSync(path.join(dir, '.onset-render-leases'))).toHaveLength(1);
  release();
  acquireWindowsSceneLease(dir, 'one', 'win32')();
});
test('existing active render is preserved; other platforms do not create leases', () => {
  const dir = fixture();
  writeLive(dir, 'one', { pid: process.pid, renderer: 'test', started_at: '' });
  expect(() => acquireWindowsSceneLease(dir, 'one', 'win32')).toThrow(SceneBusyError);
  acquireWindowsSceneLease(dir, 'one', 'darwin')();
  expect(fs.existsSync(path.join(dir, '.onset-render-leases'))).toBe(false);
});
test('dead owner can resume; malformed lease safely blocks without deletion', () => {
  const dir = fixture(), leases = path.join(dir, '.onset-render-leases');
  fs.mkdirSync(leases);
  fs.writeFileSync(path.join(leases, 'dead.json'), JSON.stringify({ pid: 2147483647 }));
  acquireWindowsSceneLease(dir, 'one', 'win32')();
  expect(fs.existsSync(path.join(leases, 'dead.json'))).toBe(true);
  fs.writeFileSync(path.join(leases, 'incomplete.json'), '');
  expect(() => acquireWindowsSceneLease(dir, 'one', 'win32')).toThrow(SceneBusyError);
  expect(fs.readdirSync(leases)).toHaveLength(2);
});
