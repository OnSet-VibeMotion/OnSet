// 给测试造一份「已装好」的 HyperFrames CLI，免得测试真的去 npm install。
import fs from 'node:fs';
import path from 'node:path';
import { PinnedVersion, cliBinary } from '../index';

/**
 * 在 dir 里写出带完成标记的假 CLI：它打印版本号并原样回显参数，退出码 0。
 * 测试的 setup 把 CLIDirEnv 指向这里。
 */
export function fakeCLI(dir: string): void {
  const bin = cliBinary(dir);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const script = '#!/bin/sh\nif [ "$1" = --version ]; then echo ' + PinnedVersion + '; exit 0; fi\necho "fake hyperframes $*"\n';
  fs.writeFileSync(bin, script, { mode: 0o755 });
  if (process.platform === 'win32') {
    const pkg = path.join(dir, 'node_modules', 'hyperframes');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'hyperframes', version: PinnedVersion, bin: { hyperframes: 'cli.cjs' } }));
    fs.writeFileSync(path.join(pkg, 'cli.cjs'), `console.log(process.argv[2] === '--version' ? '${PinnedVersion}' : 'fake hyperframes ' + process.argv.slice(2).join(' '));\n`);
  }
  fs.writeFileSync(path.join(dir, '.onset-cli'), PinnedVersion + '\n', { mode: 0o644 });
}

/**
 * 在 dir 里写出一个假的浏览器包装脚本并返回它的路径：渲染前的 requireBrowser 只查它可执行，
 * 测试的 setup 把 BrowserEnv（ONSET_BROWSER）指向它，免得测试去找真的 headless-shell。
 */
export function fakeBrowser(dir: string): string {
  const file = path.join(dir, 'onset-browser');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\necho "Chromium 0.0 (fake)"\n', { mode: 0o755 });
  return file;
}
