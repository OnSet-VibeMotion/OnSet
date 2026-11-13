import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdArgument, cmdShimEntry, windowsCommand } from './windows';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'am-win-'));
  dirs.push(d);
  return d;
}

// npm 7+ 的 cmd-shim 生成的 claude.cmd（npm install -g @anthropic-ai/claude-code）。
const npmShim = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

describe('Windows commands', () => {
  it('reads the JS entry out of an npm cmd shim', () => {
    expect(cmdShimEntry('C:\\npm\\claude.cmd', () => npmShim)).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
    expect(cmdShimEntry('C:\\npm\\old.cmd', () => '@"%~dp0\\node_modules\\old\\bin\\old.js"   %*')).toBe('C:\\npm\\node_modules\\old\\bin\\old.js');
    expect(cmdShimEntry('C:\\tools\\other.cmd', () => '@echo hi')).toBe('');
  });

  it('runs an npm shim with node so multi-line prompts survive', () => {
    const npm = temp();
    const nodeDir = temp();
    fs.writeFileSync(path.join(npm, 'claude.cmd'), npmShim);
    fs.writeFileSync(path.join(nodeDir, 'node.exe'), '');
    const cmd = windowsCommand(path.join(npm, 'claude.cmd'), ['-p', '第一行\n第二行'], { PATH: nodeDir, PATHEXT: '.EXE' });
    expect(cmd.file).toBe(path.join(nodeDir, 'node.exe'));
    expect(cmd.args[0]).toMatch(/node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js$/);
    expect(cmd.args.slice(1)).toEqual(['-p', '第一行\n第二行']);
    expect(cmd.verbatim).toBeUndefined();
  });

  it('runs other batch files through cmd.exe with escaping, and refuses multi-line arguments', () => {
    const dir = temp();
    const file = path.join(dir, 'tool.bat');
    fs.writeFileSync(file, '@echo off\r\necho %*');
    const cmd = windowsCommand(file, ['a b', 'x&y'], { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    expect(cmd.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(cmd.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(cmd.args[3]).toContain('^"a^ b^"');
    expect(cmd.args[3]).toContain('^"x^&y^"');
    expect(cmd.verbatim).toBe(true);
    expect(() => windowsCommand(file, ['one\ntwo'], {})).toThrow('多行参数');
  });

  it('leaves executables alone', () => {
    expect(windowsCommand('C:\\bin\\ffmpeg.exe', ['-i', 'a b'], {})).toEqual({ file: 'C:\\bin\\ffmpeg.exe', args: ['-i', 'a b'], env: {} });
  });

  it('quotes arguments the way cmd.exe needs', () => {
    expect(cmdArgument('plain')).toBe('^"plain^"');
    expect(cmdArgument('say "hi"')).toBe('^"say^ \\^"hi\\^"^"');
    expect(cmdArgument('trailing\\')).toBe('^"trailing\\\\^"');
    expect(cmdArgument('100%')).toBe('^"100^%^"');
  });
});
