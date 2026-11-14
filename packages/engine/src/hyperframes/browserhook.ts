/**
 * 在 HyperFrames 自己的进程里接管「启动浏览器」那一下，把客户端自带的 Chromium 借给它渲染——Windows 上用这条路。
 *
 * macOS 上 HYPERFRAMES_BROWSER_PATH 指向一个 sh 包装脚本（apps/desktop/src/main/clishim.ts 的 browserScript），
 * 它清掉 ELECTRON_RUN_AS_NODE、去掉调试管道参数，再以浏览器模式启动客户端，puppeteer 的 fd 3/4 直接传到客户端。
 * Windows 上这条路走不通：
 *   - puppeteer 不经 shell 直接 spawn 浏览器，Node 修了 CVE-2024-27980 之后不让这样启动 .cmd / .bat，包装只能是 .exe；
 *   - ELECTRON_RUN_AS_NODE 不能从 HyperFrames 的环境里整个删掉：它用 process.execPath 起看门狗、回收进程与并行渲染的
 *     工作进程，都靠这个变量才是 Node；
 *   - fd 3/4 在 Windows 上靠 C 运行时的另一套机制传，客户端接不接得住没人验证过。
 *
 * 所以改为：HyperFrames 经一段引导脚本（bootScript）启动，引导脚本先包住 child_process 的 spawn / spawnSync /
 * execFile / execFileSync（再 syncBuiltinESMExports，让 ESM 的具名导入也换掉），然后加载 HyperFrames。
 * 告诉 HyperFrames 的浏览器是一个替身文件（ONSET_BOOT_BROWSER，standInName，写在 CLI 目录里、从不真的运行），
 * 不是客户端的 .exe 本身：HyperFrames 自己的 process.execPath 就是客户端的 .exe，用同一个路径的话，
 * 它起看门狗、工作进程也会被当成启动浏览器（测试里实测撞上过）。要启动的是替身时：
 *   - 问版本（`--version`）直接用 Node 回一句 `Chromium <版本> (OnSet)`，不真的启动客户端；
 *   - 其余照包装脚本的规矩：只给这一个进程去掉 ELECTRON_RUN_AS_NODE、加 ONSET_BROWSER_MODE=1，去掉调试管道等参数；
 *   - 管道模式（stdio 有第 4、5 项）不传 fd 3/4：引导脚本开一个只有本机能连的命名管道（Unix 上是套接字文件），
 *     名字带随机口令，浏览器模式（browser.ts）按 ONSET_BROWSER_PIPE 连上来、先报口令；返回给 puppeteer 的进程对象上，
 *     stdio[3] / stdio[4] 换成接到这条连接上的流。puppeteer 只认这两项（BrowserLauncher 的 `stdio[3]`、`stdio[4]`），察觉不到区别。
 *
 * 不写原生启动器：不用给 Windows 加编译工具链，也不多一个没签名、容易被杀毒软件误报的 .exe。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 为真（'1'）时 HyperFrames 经引导脚本启动、由它接管浏览器的启动（客户端在 Windows 上设）。 */
export const BrowserHookEnv = 'ONSET_BROWSER_HOOK';

/** 开发时 Electron 要先拿到应用目录才知道加载哪个应用；打包后为空。 */
export const BrowserAppArgEnv = 'ONSET_BROWSER_APP_ARG';

/** 引导脚本写在 CLI 目录里的文件名。 */
export const bootFileName = 'onset-boot.cjs';

/** 浏览器替身的文件名：告诉 HyperFrames 的浏览器路径，被引导脚本换成客户端的 .exe，从不真的运行。 */
export const standInName = process.platform === 'win32' ? 'onset-browser.exe' : 'onset-browser';

/** 替身的内容：万一被直接运行（没经引导脚本），说清楚它是什么。 */
const standInBody = '#!/bin/sh\necho "onset-browser 只是浏览器的替身，要经 onset 的引导脚本启动" >&2\nexit 1\n';

/**
 * 引导脚本的全文：CommonJS，只用 Node 自带模块，在 HyperFrames 的运行时（客户端里是 Electron 带 ELECTRON_RUN_AS_NODE）里跑。
 * 参数：`<引导脚本> <HyperFrames 入口> <HyperFrames 的参数…>`；环境：ONSET_BOOT_BROWSER（浏览器替身的路径，
 * 就是告诉 HyperFrames 的那个）、ONSET_BOOT_APP_EXE（真正要启动的客户端）、ONSET_BOOT_APP_ARG（启动客户端时
 * 放在最前面的应用目录，开发时才有）。
 */
export const bootScript = `'use strict';
// 由 onset 写出：接管 HyperFrames 启动浏览器的那一下，把客户端自带的 Chromium 借给它（见 engine 的 hyperframes/browserhook.ts）。
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');

const browser = process.env.ONSET_BOOT_BROWSER || '';
const appExe = process.env.ONSET_BOOT_APP_EXE || '';
const appArg = process.env.ONSET_BOOT_APP_ARG || '';
const chrome = process.versions.chrome || '0';
// 浏览器模式自己接管通信；无头参数 Electron 不认（窗口本来就不显示）；Electron 不支持单进程。
const dropped = /^--(remote-debugging-pipe|remote-debugging-port=.*|headless(=.*)?|single-process)$/;
const norm = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const target = browser === '' ? '' : norm(browser);
const isBrowser = (file) => typeof file === 'string' && target !== '' && norm(file) === target;
const isVersion = (args) => args.length === 1 && args[0] === '--version';

/** 问版本：用 Node 回一句，不启动客户端。 */
function versionCall(options) {
  const env = { ...((options && options.env) || process.env), ELECTRON_RUN_AS_NODE: '1' };
  const line = 'Chromium ' + chrome + ' (OnSet)\\n';
  return { file: process.execPath, args: ['-e', 'process.stdout.write(' + JSON.stringify(line) + ')'], options: { ...options, env } };
}

/** 启动浏览器模式：只给这一个进程去掉 ELECTRON_RUN_AS_NODE、加 ONSET_BROWSER_MODE。 */
function browserCall(file, args, options, extra) {
  if (isVersion(args)) return versionCall(options);
  const env = { ...((options && options.env) || process.env), ONSET_BROWSER_MODE: '1', ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  const kept = args.filter((a) => !dropped.test(a));
  return { file: appExe, args: appArg === '' ? kept : [appArg, ...kept], options: { ...options, env } };
}

const original = { spawn: cp.spawn, spawnSync: cp.spawnSync, execFile: cp.execFile, execFileSync: cp.execFileSync };

cp.spawn = function spawn(file, maybeArgs, maybeOptions) {
  if (!isBrowser(file)) return original.spawn.apply(this, arguments);
  const args = Array.isArray(maybeArgs) ? maybeArgs : [];
  const options = (Array.isArray(maybeArgs) ? maybeOptions : maybeArgs) || {};
  const stdio = Array.isArray(options.stdio) ? options.stdio : null;
  if (stdio === null || stdio.length < 5 || isVersion(args)) {
    const call = browserCall(file, args, options, {});
    return original.spawn.call(cp, call.file, call.args, call.options);
  }
  // 管道模式：不传 fd 3/4，开一条只有本机能连的命名管道，名字带随机口令；浏览器模式连上来先报口令。
  const token = crypto.randomBytes(16).toString('hex');
  const address = process.platform === 'win32' ? '\\\\\\\\.\\\\pipe\\\\onset-browser-' + token : path.join(os.tmpdir(), 'onset-browser-' + token.slice(0, 16) + '.sock');
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(10);
      if (nl < 0) {
        if (head.length > 128) socket.destroy();
        return;
      }
      socket.off('data', onData);
      if (head.subarray(0, nl).toString('latin1') !== token) {
        socket.destroy();
        return;
      }
      server.close();
      socket.on('error', () => {});
      const rest = head.subarray(nl + 1);
      if (rest.length > 0) fromBrowser.write(rest);
      toBrowser.pipe(socket);
      socket.pipe(fromBrowser);
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  server.on('error', (err) => fromBrowser.destroy(err));
  server.listen(address);
  const call = browserCall(file, args, options, { ONSET_BROWSER_PIPE: address, ONSET_BROWSER_TOKEN: token });
  const child = original.spawn.call(cp, call.file, call.args, { ...call.options, stdio: stdio.slice(0, 3) });
  child.stdio[3] = toBrowser;
  child.stdio[4] = fromBrowser;
  const finish = () => {
    server.close();
    fromBrowser.end();
  };
  child.once('exit', finish);
  child.once('error', finish);
  return child;
};

for (const name of ['spawnSync', 'execFile', 'execFileSync']) {
  cp[name] = function (file) {
    if (!isBrowser(file)) return original[name].apply(this, arguments);
    const rest = Array.prototype.slice.call(arguments, 1);
    const args = Array.isArray(rest[0]) ? rest.shift() : [];
    const options = rest.length > 0 && rest[0] !== null && typeof rest[0] === 'object' ? rest.shift() : {};
    const call = browserCall(file, args, options, {});
    return original[name].call(cp, call.file, call.args, call.options, ...rest);
  };
}
syncBuiltinESMExports();

const entry = process.argv[2];
process.argv.splice(1, 2, entry);
import(pathToFileURL(entry).href).catch((err) => {
  console.error(err);
  process.exit(1);
});
`;

function writeIfChanged(file: string, body: string, mode: number): void {
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    existing = '';
  }
  if (existing === body) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode });
  fs.renameSync(tmp, file);
}

/** 把引导脚本与浏览器替身写进 dir（内容相同就不动），返回两者的路径。 */
export function writeBootScript(dir: string): { boot: string; standIn: string } {
  const boot = path.join(dir, bootFileName);
  const standIn = path.join(dir, standInName);
  writeIfChanged(boot, bootScript, 0o644);
  // 可执行：HyperFrames 与 puppeteer 启动前会查浏览器文件在不在、能不能执行。
  writeIfChanged(standIn, standInBody, 0o755);
  return { boot, standIn };
}
