import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookPath } from '../envutil';
import { CLIDirEnv, cliCommandFor, cliDir, cliReady, ensureCLI } from './index';
import { fakeCLI } from './hftest';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'onset-hyperframes-cli-'));
}

function which(name: string): string {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return '';
  }
}

const hasNpm = which('npm') !== '';
const node = which('node');

class Sink {
  text = '';
  write(chunk: string): void {
    this.text += chunk;
  }
}

/**
 * 造一个本地 npm 包：bin 名为 hyperframes，--version 打印 version。
 * 用 file: 规格安装，走的是与真实安装相同的 npm install 路径，完全离线。
 */
function fakePackage(version: string): string {
  const dir = tempDir();
  const files: Record<string, string> = {
    'package.json': `{"name":"hyperframes","version":"${version}","bin":{"hyperframes":"cli.js"}}`,
    'cli.js': "#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('" + version + "'); } else { console.log('ran ' + process.argv.slice(2).join(' ')); }\n",
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  return dir;
}

describe('hyperframes CLI', () => {
  // onset 管理 CLI：装进指定目录、自检通过才算装好；再调用时直接用，不再碰 npm。
  it.skipIf(!hasNpm || node === '')('ensureCLI installs once and reuses the cache', { timeout: 120_000 }, async () => {
    const pkg = fakePackage('9.9.9');
    const dir = path.join(tempDir(), 'cli-9.9.9');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', [CLIDirEnv]: dir };
    const got = await ensureCLI({ env, version: '9.9.9', package: 'file:' + pkg, output: new Sink() });
    // 应当装进 dir 并带完成标记。
    expect(got).toBe(dir);
    expect(cliReady(dir, '9.9.9')).toBe(true);
    const command = cliCommandFor(dir, env, ['render', '--quality', 'high']);
    const out = execFileSync(command.file, command.args, { env: command.env, encoding: 'utf8' });
    // 应当把参数原样转给 CLI。
    expect(out).toContain('ran render --quality high');
    // 第二次连 npm 都找不到，照样可用：说明走的是缓存。
    env.PATH = tempDir() + path.delimiter + path.dirname(node);
    await expect(ensureCLI({ env, version: '9.9.9', package: 'file:' + pkg })).resolves.toBe(dir);
  });

  // 版本对不上（自检失败）就不算装好，也不留下残缺目录；版本号写在完成标记里，换版本会重装。
  it.skipIf(!hasNpm)('ensureCLI rejects wrong version', { timeout: 300_000 }, async () => {
    const pkg = fakePackage('1.0.0');
    const dir = path.join(tempDir(), 'cli-9.9.9');
    const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', [CLIDirEnv]: dir };
    const err = await ensureCLI({ env, version: '9.9.9', package: 'file:' + pkg, output: new Sink() }).catch((e: Error) => e);
    // 报告的版本不对时应当失败。
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('期望 9.9.9');
    // 失败的安装不该留下目录，也不该被当成可用。
    expect(fs.existsSync(dir)).toBe(false);
    expect(cliReady(dir, '9.9.9')).toBe(false);
  });

  it('cliDir follows environment', () => {
    // 默认目录。
    expect(cliDir({ HOME: '/h' }, '1.2.3')).toBe(path.join('/h', '.local/share/onset/hyperframes/cli-1.2.3'));
    // 应当遵循 XDG_DATA_HOME。
    expect(cliDir({ HOME: '/h', XDG_DATA_HOME: '/x' }, '1.2.3')).toBe(path.join('/x', 'onset/hyperframes/cli-1.2.3'));
    // 显式指定的目录优先。
    expect(cliDir({ HOME: '/h', [CLIDirEnv]: '/c' }, '1.2.3')).toBe('/c');
    // 没有 HOME 时不猜家目录。
    expect(cliDir({}, '1.2.3')).toBe('');
  });

  // TS 额外：hftest.fakeCLI 写出的目录被认作已装好，并回显参数。
  it('hftest fake CLI is ready', async () => {
    const { PinnedVersion } = await import('./index');
    const dir = tempDir();
    fakeCLI(dir);
    expect(cliReady(dir, PinnedVersion)).toBe(true);
    const command = cliCommandFor(dir, { PATH: process.env.PATH ?? '' }, ['lint']);
    expect(execFileSync(command.file, command.args, { env: command.env, encoding: 'utf8' })).toBe('fake hyperframes lint\n');
  });
});
