import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onsetCommand, dataDir, lookPath, MissingToolError, normalizeWindowsEnv, windowsPython, windowsPythonScript, agentBinDir, preferWindowsGit, addToolsLocation } from './index';

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
  it('prioritizes installed Git over extensionless shell shadows only on Windows', () => {
    const shadow = temp(), installed = temp();
    fs.writeFileSync(path.join(shadow, 'git'), '');
    fs.writeFileSync(path.join(installed, 'git.exe'), 'fixture');
    const original = `${shadow};${installed}`;
    const env = { PATH: original };
    preferWindowsGit(env, 'win32');
    expect(env.PATH).toBe(`${installed};${shadow}`);
    preferWindowsGit(env, 'win32');
    expect(env.PATH).toBe(`${installed};${shadow}`);
    for (const platform of ['darwin', 'linux'] as const) {
      const other = { PATH: original }; preferWindowsGit(other, platform);
      expect(other.PATH).toBe(original);
    }
    const missing = { PATH: shadow }; preferWindowsGit(missing, 'win32');
    expect(missing.PATH).toBe(shadow);
    if (process.platform === 'win32') {
      const agent = { PATH: original, ONSET_BIN_DIR: temp(), ONSET_AGENT_BIN_DIR: temp() };
      addToolsLocation(agent);
      expect(agent.PATH.split(';').slice(0, 2)).toEqual([agent.ONSET_AGENT_BIN_DIR, installed]);
    }
  });
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
    if (process.platform === 'win32') {
      // NTFS 的 chmod 不提供 Unix 执行位；按同一平台分支验证权限判断。
      const stat = vi.spyOn(fs, 'statSync');
      try {
        stat.mockReturnValue({ isFile: () => true, mode: 0o644 } as fs.Stats);
        expect(() => lookPath('tool', '/tools', 'darwin')).toThrow(MissingToolError);
        stat.mockReturnValue({ isFile: () => true, mode: 0o755 } as fs.Stats);
        expect(lookPath('tool', '/tools', 'darwin')).toBe(path.join('/tools', 'tool'));
      } finally { stat.mockRestore(); }
      return;
    }
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

  it('prefers the prepared Windows Python and leaves other platforms alone', () => {
    const root = temp();
    const python = path.join(root, 'onset', 'tools', 'venv', 'funasr', 'Scripts', 'python.exe');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, 'fixture');
    const env = { XDG_DATA_HOME: root, PATH: '' };
    expect(windowsPython(env, 'win32')).toBe(python);
    expect(windowsPython(env, 'darwin')).toBe('');
    expect(windowsPython(env, 'linux')).toBe('');
    expect(windowsPythonScript('C:\\中文%用户\\python.exe')).toContain('"C:\\中文%%用户\\python.exe" %*');
    if (process.platform === 'win32') {
      const bin = agentBinDir({ ...env, ONSET_AGENT_BIN_DIR: path.join(root, 'agent') });
      expect(fs.readFileSync(path.join(bin, 'python3.cmd'), 'utf8')).toContain(`"${python}" %*`);
      expect(fs.readFileSync(path.join(bin, 'python3.cmd'), 'utf8')).toContain('exit /b %errorlevel%');
    }
  });
});
