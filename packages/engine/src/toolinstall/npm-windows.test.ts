import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dataDir, envMap } from '../envutil';
import { cmdShimEntry, windowsCommand } from '../procgroup/windows';
import { ensureTool, toolStatus } from './index';

describe.skipIf(process.platform !== 'win32')('Windows npm tool entry', () => {
  it.each(['commonjs', 'module'])('repairs a cached %s package and runs without Node on PATH', async type => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-npm-windows-'));
    const bin = path.join(root, '中文 工具', 'bin');
    const env = { ...envMap(), HOME: root, XDG_DATA_HOME: path.join(root, 'data'), ONSET_BIN_DIR: bin, ONSET_BUNDLED_BIN: '', PATH: path.join(process.env.SystemRoot!, 'System32') };
    const spec = { kind: 'npm' as const, package: 'fixture-cli', version: '1.0.0', bins: ['fixture'] };
    const dir = path.join(dataDir(env), 'tools/npm/fixture-cli@1.0.0');
    const pkg = path.join(dir, 'node_modules/fixture-cli');
    fs.mkdirSync(pkg, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(dir, '.onset-tool'), 'fixture-cli@1.0.0\n');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ type, bin: { fixture: 'main.js' } }));
    fs.writeFileSync(path.join(pkg, 'main.js'), (type === 'commonjs' ? 'if (require.main !== module) throw Error("not the main module");\n' : '') +
      'if (process.argv[2] === "fail") process.exit(7);\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
    // 旧版本写的 sh 文件不会被 Windows 识别，修复不应联网重装缓存包。
    fs.writeFileSync(path.join(bin, 'fixture'), '#!/bin/sh\n');
    expect(toolStatus(spec, env).ok).toBe(false);
    const shim = await ensureTool(spec, { env });
    expect(shim).toBe(path.join(bin, 'fixture.cmd'));
    expect(cmdShimEntry(shim)).toBe(path.join(bin, 'fixture.onset.cjs'));
    const args = ['中文 空格', 'first\nsecond', 'a&b', '"quoted"'];
    const command = windowsCommand(shim, args, env);
    const result = spawnSync(command.file, command.args, { env: { ...env, ...command.env }, encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    const direct = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${shim}" "中文 空格""`], {
      env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true,
    });
    expect(direct.status, direct.stderr).toBe(0);
    expect(JSON.parse(direct.stdout)).toEqual(['中文 空格']);
    const fail = windowsCommand(shim, ['fail'], env);
    expect(spawnSync(fail.file, fail.args, { env: { ...env, ...fail.env }, windowsHide: true }).status).toBe(7);
    expect(toolStatus(spec, env)).toEqual({ ok: true, where: shim });
  });
});
