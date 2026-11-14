import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserAppArgEnv, BrowserHookEnv, bootFileName, standInName, writeBootScript } from './browserhook';
import { BrowserEnv, cliCommandFor } from './cli';

// 假的「浏览器」：照浏览器模式（apps/desktop/src/main/browser.ts）连上 ONSET_BROWSER_PIPE、先报口令，
// 再把收到的每条 NUL 结尾的消息连同自己的环境与参数回给对方。
const fakeBrowser = `
const net = require('node:net');
const socket = net.connect(process.env.ONSET_BROWSER_PIPE);
socket.write(process.env.ONSET_BROWSER_TOKEN + '\\n');
let buf = '';
socket.on('data', (chunk) => {
  buf += chunk;
  let end;
  while ((end = buf.indexOf('\\0')) !== -1) {
    const msg = buf.slice(0, end);
    buf = buf.slice(end + 1);
    socket.write(JSON.stringify({
      echo: msg,
      runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      mode: process.env.ONSET_BROWSER_MODE ?? null,
      argv: process.argv.slice(2),
    }) + '\\0');
  }
});
socket.on('close', () => process.exit(0));
`;

// 假的「HyperFrames」：用 ESM 的具名导入（与上游一样），问版本、以管道模式起浏览器、再起一个普通子进程。
const fakeEntry = `
import { execFileSync, spawn } from 'node:child_process';
const browser = process.env.ONSET_BOOT_BROWSER;
const version = execFileSync(browser, ['--version'], { encoding: 'utf8' }).trim();
const other = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))'], { encoding: 'utf8' });
const child = spawn(browser, ['--remote-debugging-pipe', '--headless=new', '--user-data-dir=/tmp/x'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
child.stdio[3].write('hello\\0');
let got = '';
child.stdio[4].on('data', (chunk) => {
  got += chunk;
  const end = got.indexOf('\\0');
  if (end === -1) return;
  process.stdout.write(JSON.stringify({ version, other, argv1: process.argv[1], args: process.argv.slice(2), reply: JSON.parse(got.slice(0, end)) }));
  child.stdio[3].end();
  child.kill();
});
`;

describe('browser hook', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('lends the browser over a named pipe without fd 3/4', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-hook-'));
    dirs.push(dir);
    const { boot, standIn } = writeBootScript(dir);
    const entry = path.join(dir, 'entry.mjs');
    const browserScript = path.join(dir, 'browser.cjs');
    fs.writeFileSync(entry, fakeEntry);
    fs.writeFileSync(browserScript, fakeBrowser);
    const result = spawnSync(process.execPath, [boot, entry, 'render', '--quality', 'draft'], {
      encoding: 'utf8',
      timeout: 20_000,
      // 告诉「HyperFrames」的浏览器是替身；真正启动的「客户端」就是 node 自己（与 HyperFrames 的 process.execPath 相同，
      // 正是客户端里的情形），应用目录参数换成假浏览器脚本：引导脚本照样会把它放在参数最前面。
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ONSET_BOOT_BROWSER: standIn, ONSET_BOOT_APP_EXE: process.execPath, ONSET_BOOT_APP_ARG: browserScript },
    });
    expect(result.stderr).toBe('');
    const out = JSON.parse(result.stdout);
    // 问版本：直接回答，不启动客户端。
    expect(out.version).toMatch(/^Chromium \S+ \(OnSet\)$/);
    // 引导脚本把自己从参数里拿掉：HyperFrames 看到的入口与参数和直接运行时一样。
    expect(out.argv1).toBe(entry);
    expect(out.args).toEqual(['render', '--quality', 'draft']);
    // 别的子进程（看门狗、工作进程）用的是同一个运行时，但不是浏览器：照样带着 ELECTRON_RUN_AS_NODE，不被接管。
    expect(out.other).toBe('1');
    // 浏览器那一个进程：去掉 ELECTRON_RUN_AS_NODE、进浏览器模式，调试管道与无头参数去掉，其余照传。
    expect(out.reply).toEqual({ echo: 'hello', runAsNode: null, mode: '1', argv: ['--user-data-dir=/tmp/x'] });
  });

  it('is used only for the lent browser, not one the user picked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-hook-'));
    dirs.push(dir);
    const pkg = path.join(dir, 'node_modules', 'hyperframes');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { hyperframes: 'dist/cli.js' } }));
    fs.writeFileSync(path.join(pkg, 'dist', 'cli.js'), '');
    const env = { [BrowserEnv]: process.execPath, [BrowserHookEnv]: '1', [BrowserAppArgEnv]: '/app' };
    const hooked = cliCommandFor(dir, env, ['render']);
    expect(hooked.args).toContain(path.join(dir, bootFileName));
    // HyperFrames 看到的是替身，真正启动的是客户端。
    expect(hooked.env.HYPERFRAMES_BROWSER_PATH).toBe(path.join(dir, standInName));
    expect(hooked.env.ONSET_BOOT_BROWSER).toBe(path.join(dir, standInName));
    expect(hooked.env.ONSET_BOOT_APP_EXE).toBe(process.execPath);
    expect(hooked.env.ONSET_BOOT_APP_ARG).toBe('/app');
    // 用户自己指定了浏览器：照直运行，不接管。
    const own = cliCommandFor(dir, { ...env, HYPERFRAMES_BROWSER_PATH: '/usr/bin/true' }, ['render']);
    expect(own.args).not.toContain(path.join(dir, bootFileName));
    // 没打开接管：照直运行（macOS 走包装脚本）。
    const plain = cliCommandFor(dir, { [BrowserEnv]: process.execPath }, ['render']);
    expect(plain.args).not.toContain(path.join(dir, bootFileName));
  });
});
