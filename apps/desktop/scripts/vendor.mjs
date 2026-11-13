// 准备随客户端下发的第三方文件（apps/desktop/vendor/，不进版本库）：固定版本的 npm。
//
// 客户端用户的机器上未必有 Node / npm；am setup 装 HyperFrames CLI 与 npm 类配音工具时，用这份 npm 由客户端自带的
// Electron 运行（ELECTRON_RUN_AS_NODE=1）。npm 是纯 JS，一份通吃 arm64 与 x64。
// 用 `npm pack` 从 registry 取包而不是装成依赖：装进 node_modules 的话，仓库里 npm 脚本调用的 npm 会被它顶掉。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NpmVersion = '11.6.2';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, '..', 'vendor');
const target = path.join(vendor, 'npm');
const marker = path.join(target, '.am-vendor');

if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === NpmVersion) {
  console.log(`vendor/npm 已是 ${NpmVersion}`);
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-vendor-'));
  try {
    const name = execFileSync('npm', ['pack', `npm@${NpmVersion}`, '--silent'], { cwd: tmp, encoding: 'utf8' }).trim().split('\n').at(-1);
    execFileSync('tar', ['-xzf', path.join(tmp, name), '-C', tmp]);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(vendor, { recursive: true });
    fs.renameSync(path.join(tmp, 'package'), target);
    fs.writeFileSync(marker, NpmVersion + '\n');
    console.log(`vendor/npm ← npm@${NpmVersion}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
