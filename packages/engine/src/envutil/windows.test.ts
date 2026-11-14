import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { onsetCommand, dataDir, lookPath, MissingToolError, normalizeWindowsEnv } from './index';

// Windows 上的差异按 platform 参数模拟，在 macOS / Linux 上也能跑；Windows CI 上测的是真实行为。
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-win-'));
  dirs.push(d);
  return d;
}

describe('Windows compatibility in envutil', () => {
  it('lookPath finds .exe and .cmd by PATHEXT without execute bits', () => {
    const a = temp();
    const b = temp();
    fs.writeFileSync(path.join(a, 'ffmpeg.exe'), '', { mode: 0o644 });
    fs.writeFileSync(path.join(b, 'claude.cmd'), '', { mode: 0o644 });
    const PATH = `${a};${b}`;
    expect(lookPath('ffmpeg', PATH, 'win32', '.COM;.EXE;.BAT;.CMD')).toBe(path.join(a, 'ffmpeg.exe'));
    expect(lookPath('claude', PATH, 'win32', '.COM;.EXE;.BAT;.CMD')).toBe(path.join(b, 'claude.cmd'));
    // 名字已经带扩展名就不再加。
    expect(lookPath('claude.cmd', PATH, 'win32', '.EXE;.CMD')).toBe(path.join(b, 'claude.cmd'));
    // PATHEXT 为空时用缺省的扩展名。
    expect(lookPath('ffmpeg', PATH, 'win32', '')).toBe(path.join(a, 'ffmpeg.exe'));
    expect(() => lookPath('missing', PATH, 'win32', '.EXE')).toThrow(MissingToolError);
    // 带反斜杠的名字是路径，原样返回。
    expect(lookPath('C:\\tools\\x.exe', PATH, 'win32')).toBe('C:\\tools\\x.exe');
  });

  it('lookPath still requires execute bits elsewhere', () => {
    const a = temp();
    fs.writeFileSync(path.join(a, 'tool'), '', { mode: 0o644 });
    expect(() => lookPath('tool', a, 'darwin')).toThrow(MissingToolError);
    fs.chmodSync(path.join(a, 'tool'), 0o755);
    expect(lookPath('tool', a, 'darwin')).toBe(path.join(a, 'tool'));
  });

  it('normalizes Path to PATH when copying the environment', () => {
    expect(normalizeWindowsEnv({ Path: 'C:\\bin', X: '1' }, 'win32')).toEqual({ PATH: 'C:\\bin', X: '1' });
    expect(normalizeWindowsEnv({ PATH: 'a', Path: 'b' }, 'win32')).toEqual({ PATH: 'a' });
    expect(normalizeWindowsEnv({ Path: 'b' }, 'darwin')).toEqual({ Path: 'b' });
  });

  it('keeps data in LOCALAPPDATA on Windows', () => {
    expect(dataDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32')).toBe('C:\\Users\\u\\AppData\\Local\\onset');
    expect(dataDir({ LOCALAPPDATA: 'C:\\L', HOME: '/h' }, 'win32')).toBe('C:\\L\\onset');
    expect(dataDir({ XDG_DATA_HOME: '/x', LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe(path.join('/x', 'onset'));
    expect(dataDir({ LOCALAPPDATA: 'C:\\L', HOME: '/h' }, 'darwin')).toBe(path.join('/h', '.local', 'share', 'onset'));
  });

  it('runs onset.cjs with the current runtime instead of as a program', () => {
    expect(onsetCommand('/app/bin/onset')).toEqual({ command: '/app/bin/onset', args: [], env: {} });
    const script = onsetCommand('C:\\app\\resources\\cli\\onset.cjs');
    expect(script.command).toBe(process.execPath);
    expect(script.args).toEqual(['C:\\app\\resources\\cli\\onset.cjs']);
    expect(script.env.ONSET_SELF).toBe('C:\\app\\resources\\cli\\onset.cjs');
  });
});
