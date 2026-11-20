// onset setup 下载的独立工具：ffmpeg / ffprobe 与 uv。装进 toolpath.binDir（默认 ~/.local/share/onset/bin），
// toolpath.find 先找那里再找 PATH，所以用户不必装 Homebrew。
//
// 为什么下载而不是打进 .app：HyperFrames 与 onset 自己的拼接都写死了 libx264（GPL），LGPL 构建渲染不了；
// 把 GPL 加 x264 的二进制随应用发布要背许可与专利义务，还让安装包大一百多 MB。由用户机器从上游下载，
// 不算我们分发。系统里已经有 ffmpeg（PATH 能找到）就直接算就绪，不重复下载。
//
// 每个文件都钉了版本与 sha256（来自上游 release 的 digest），下载后核对，对不上就丢掉：上游被替换、
// 镜像被篡改都会被拦下，所以也可以放心走镜像（ONSET_GITHUB_MIRROR）。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { lookPath, windowsPythonScript } from '../envutil';
import { marshal } from '../gojson';
import { watchSize, type Progress, type Writer } from '../hyperframes';
import { abortReason } from '../procgroup';
import { binDir, bundled, dataDir, findOptional, npmCommand, withNode } from '../toolpath';
import { ensureWindowsBreeze, windowsBreezeStatus } from '../windowsruntime/breeze';

/** GitHub release 下载地址的镜像前缀，例如 https://ghfast.top/https://github.com/ 。文件都有 sha256，走镜像也安全。 */
export const GitHubMirrorEnv = 'ONSET_GITHUB_MIRROR';

/** 一个钉死的下载文件。 */
interface Asset {
  url: string;
  sha256: string;
  /** 字节数：用来按已下载的大小算进度。 */
  size: number;
}

/** ffmpeg-static（eugeneware/ffmpeg-static）的 release：ffmpeg 6.0 静态构建，含 libx264、aac、libmp3lame、libopus、libvpx。 */
export const FFmpegRelease = 'b6.1.1';

const ffmpegAssets: Record<string, { ffmpeg: Asset; ffprobe: Asset }> = {
  'darwin/arm64': {
    ffmpeg: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffmpeg-darwin-arm64.gz`,
      sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa',
      size: 19246198,
    },
    ffprobe: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffprobe-darwin-arm64.gz`,
      sha256: 'd986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be',
      size: 19207077,
    },
  },
  'darwin/x64': {
    ffmpeg: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffmpeg-darwin-x64.gz`,
      sha256: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
      size: 25296431,
    },
    ffprobe: {
      url: `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFmpegRelease}/ffprobe-darwin-x64.gz`,
      sha256: 'd4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186',
      size: 25239438,
    },
  },
};

/** uv（astral-sh/uv）：给 Python 类工具建环境，它自己下载独立的 Python，不依赖系统 Python。 */
export const UVVersion = '0.13.1';

const uvAssets: Record<string, Asset & { dir: string }> = {
  'darwin/arm64': {
    url: `https://github.com/astral-sh/uv/releases/download/${UVVersion}/uv-aarch64-apple-darwin.tar.gz`,
    sha256: 'cfe454573412ff7380d15fc7dae5997ab53ffce72fce0a78e91ddbc84001acd2',
    size: 14280170,
    dir: 'uv-aarch64-apple-darwin',
  },
  'darwin/x64': {
    url: `https://github.com/astral-sh/uv/releases/download/${UVVersion}/uv-x86_64-apple-darwin.tar.gz`,
    sha256: 'bb7b805bdcf3d0bc8c74ceb94569e6b3e8aa35bd492acdbb9d46bf46d9d4ff6b',
    size: 17491796,
    dir: 'uv-x86_64-apple-darwin',
  },
};

function platformKey(): string {
  return `${process.platform}/${process.arch}`;
}

/** 一次安装。 */
export interface InstallOptions {
  /** 当前环境：HOME 决定装到哪，https_proxy 给 curl。 */
  env: Record<string, string>;
  output?: Writer;
  progress?: (p: Progress) => void;
  signal?: AbortSignal;
}

/** ffmpeg 与 ffprobe 都能找到（自带、onset 下载的或 PATH 里的）。where 是 ffmpeg 的位置，缺时是将要装到的目录。 */
export function ffmpegStatus(env: Record<string, string | undefined>): { ok: boolean; where: string } {
  const ffmpeg = findOptional('ffmpeg', env);
  const ffprobe = findOptional('ffprobe', env);
  if (ffmpeg !== '' && ffprobe !== '') return { ok: true, where: ffmpeg };
  return { ok: false, where: binDir(env) };
}

/** 装好 ffmpeg 与 ffprobe（已能找到就不动），返回 ffmpeg 的路径。 */
export async function ensureFFmpeg(opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const status = ffmpegStatus(opts.env);
  if (status.ok) {
    report({ stage: 'ffmpeg 已就绪', percent: 100 });
    return status.where;
  }
  const assets = ffmpegAssets[platformKey()];
  if (!assets) throw new Error(`没有给 ${platformKey()} 准备 ffmpeg 的下载：请用系统的包管理器安装 ffmpeg（含 ffprobe）后重试`);
  const dir = requireBinDir(opts.env);
  const total = assets.ffmpeg.size + assets.ffprobe.size;
  let base = 0;
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    if (bundled(name, opts.env) !== '') {
      base += assets[name].size;
      continue;
    }
    const asset = assets[name];
    const offset = base;
    const archive = await download(asset, dir, name + '.gz', opts, (bytes) =>
      report({ stage: `下载 ${name}`, percent: Math.min(99, (100 * (offset + bytes)) / total) }),
    );
    const target = path.join(dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(archive)), { mode: 0o755 });
    fs.renameSync(tmp, target);
    fs.rmSync(archive, { force: true });
    base += asset.size;
  }
  fs.writeFileSync(path.join(dir, '.ffmpeg-release'), FFmpegRelease + '\n');
  report({ stage: 'ffmpeg 已就绪', percent: 100 });
  return path.join(dir, 'ffmpeg');
}

/** uv 能找到（onset 下载的或 PATH 里的）。 */
export function uvStatus(env: Record<string, string | undefined>): { ok: boolean; where: string } {
  const uv = findOptional('uv', env);
  return uv !== '' ? { ok: true, where: uv } : { ok: false, where: binDir(env) };
}

/** 装好 uv（已能找到就不动），返回它的路径。 */
export async function ensureUV(opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const status = uvStatus(opts.env);
  if (status.ok) {
    report({ stage: 'uv 已就绪', percent: 100 });
    return status.where;
  }
  const asset = uvAssets[platformKey()];
  if (!asset) throw new Error(`没有给 ${platformKey()} 准备 uv 的下载：请按 https://docs.astral.sh/uv/ 安装 uv 后重试`);
  const dir = requireBinDir(opts.env);
  const archive = await download(asset, dir, 'uv.tar.gz', opts, (bytes) => report({ stage: '下载 uv', percent: Math.min(99, (100 * bytes) / asset.size) }));
  const unpack = fs.mkdtempSync(path.join(dir, '.uv-'));
  try {
    await run(lookPath('tar', opts.env.PATH || '/usr/bin:/bin'), ['-xzf', archive, '-C', unpack], opts);
    for (const name of ['uv', 'uvx']) {
      const from = path.join(unpack, asset.dir, name);
      if (!fs.existsSync(from)) {
        if (name === 'uv') throw new Error(`uv 的压缩包里没有 ${asset.dir}/uv：包结构已变`);
        continue;
      }
      fs.chmodSync(from, 0o755);
      fs.renameSync(from, path.join(dir, name));
    }
  } finally {
    fs.rmSync(unpack, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
  }
  report({ stage: 'uv 已就绪', percent: 100 });
  return path.join(dir, 'uv');
}

function requireBinDir(env: Record<string, string | undefined>): string {
  const dir = binDir(env);
  if (dir === '') throw new Error('无法确定工具的安装目录：环境里没有 HOME');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 镜像改写：只改 GitHub 的地址。 */
export function mirrored(url: string, env: Record<string, string | undefined>): string {
  const mirror = env[GitHubMirrorEnv];
  if (!mirror || !url.startsWith('https://github.com/')) return url;
  return mirror.replace(/\/?$/, '/') + url.slice('https://github.com/'.length);
}

/**
 * 下载 asset 到 dir/name，核对 sha256 后返回路径。断点续传：中途失败留下 .partial，下次接着下；
 * 核对不过就删掉重下（每次运行最多重试 3 次）。
 */
async function download(asset: Asset, dir: string, name: string, opts: InstallOptions, onBytes: (bytes: number) => void): Promise<string> {
  const target = path.join(dir, name);
  const partial = target + '.partial';
  const curl = process.platform === 'darwin' && fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : lookPath('curl', opts.env.PATH ?? '');
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const timer = setInterval(() => {
      try {
        onBytes(fs.statSync(partial).size);
      } catch {
        // 还没开始写
      }
    }, 500);
    try {
      await run(
        curl,
        [
          '--fail', '--silent', '--show-error', '--location', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '--speed-limit', '1024', '--speed-time', '60',
          // 只在有上次没下完的文件时续传：全新下载不带 Range，少一种出错的可能。
          ...(fs.existsSync(partial) ? ['--continue-at', '-'] : []),
          '--output', partial, mirrored(asset.url, opts.env),
        ],
        opts,
      );
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw abortReason(opts.signal);
      opts.output?.write(`下载 ${name} 失败（${attempt}/3）：${(err as Error).message}\n`);
      // 416：本地 .partial 已经比远端大或已完整，丢掉重下。
      if (/416/.test(String((err as Error).message))) fs.rmSync(partial, { force: true });
      continue;
    } finally {
      clearInterval(timer);
    }
    const digest = await sha256File(partial);
    if (digest === asset.sha256) {
      fs.renameSync(partial, target);
      return target;
    }
    fs.rmSync(partial, { force: true });
    lastErr = new Error(`${name} 的 sha256 是 ${digest}，期望 ${asset.sha256}`);
    opts.output?.write(`${(lastErr as Error).message}，删掉重下\n`);
  }
  throw new Error(`下载 ${name} 失败（可以加 --proxy 走代理，或设 ${GitHubMirrorEnv} 用镜像；断了重跑会接着下）：${(lastErr as Error)?.message ?? ''}`, {
    cause: lastErr,
  });
}

/**
 * 按流算文件的 sha256。不能 readFileSync 整个读进来：Node 单个 Buffer 上限 2 GiB，
 * Breeze TTS 2 的权重 3.9 GB，读的时候直接抛「File size … is greater than 2 GiB」（实测）。
 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function run(file: string, args: string[], opts: InstallOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortReason(opts.signal));
      return;
    }
    const child = spawn(file, args, { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => opts.output?.write(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      opts.output?.write(chunk.toString('utf8'));
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} 退出码 ${code}：${stderr.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

/** uv 下载的独立 Python 放在哪：<数据目录>/python，节拍分析环境与 Python 类工具共用。 */
export function pythonInstallDir(env: Record<string, string | undefined>): string {
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'python');
}

/** uv 给工具用的 Python 版本：各家工具与 torch 都有预编译包。 */
export const ToolPythonVersion = '3.12';

/**
 * 一个由 onset setup 安装的命令行工具（配音、对齐）。版本都钉死，同一台机器两次安装得到同一个东西。
 * - npm：npm 包，用 onset 自己的运行时执行（客户端用户不必装 Node）。
 * - uv-tool：Python 包的命令行入口，`uv tool install` 装进独立环境，用 uv 带的 Python。
 * - uv-venv：没有命令行入口的 Python 包（funasr），装进专用环境，再写一个调用那份 Python 的小脚本。
 */
export type ToolSpec =
  | { kind: 'native-breeze'; version: string; bins: string[]; platforms: string[] }
  | { kind: 'npm'; package: string; version: string; bins: string[] }
  | { kind: 'uv-tool'; package: string; version: string; bins: string[]; prerelease?: boolean; platforms?: string[] }
  | { kind: 'uv-venv'; name: string; packages: string[]; bin: string; platforms?: string[] };

/** 这份工具要提供的命令名。 */
export function toolBins(spec: ToolSpec): string[] {
  return spec.kind === 'uv-venv' ? [spec.bin] : spec.bins;
}

/** 这台机器能不能装：mlx-audio 只有 Apple Silicon。 */
export function toolSupported(spec: ToolSpec): boolean {
  const platforms = spec.kind === 'npm' ? undefined : spec.platforms;
  return !platforms || platforms.includes(platformKey());
}

/** 工具的命令都能找到（onset 装的或用户自己装的）。 */
export function toolStatus(spec: ToolSpec, env: Record<string, string | undefined>): { ok: boolean; where: string } {
  if (spec.kind === 'native-breeze') return windowsBreezeStatus(env);
  const found = toolBins(spec).map((bin) => findOptional(bin, env));
  if (found.every((f) => f !== '')) return { ok: true, where: found[0] };
  return { ok: false, where: binDir(env) };
}

/** 装好一个工具（命令都能找到就不动），返回第一个命令的路径。 */
export async function ensureTool(spec: ToolSpec, opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const status = toolStatus(spec, opts.env);
  if (status.ok) {
    report({ stage: '已就绪', percent: 100 });
    return status.where;
  }
  if (!toolSupported(spec)) throw new Error(`这个工具不支持 ${platformKey()}`);
  const bin = requireBinDir(opts.env);
  const data = dataDir(opts.env);
  switch (spec.kind) {
    case 'native-breeze':
      return ensureWindowsBreeze(opts);
    case 'npm':
      await installNpmTool(spec, path.join(data, 'tools', 'npm'), bin, opts);
      break;
    case 'uv-tool':
    case 'uv-venv': {
      const uv = await ensureUV({ ...opts, progress: (p) => report({ ...p, stage: p.stage === 'uv 已就绪' ? '准备 uv' : p.stage }) });
      if (spec.kind === 'uv-tool') await installUVTool(spec, uv, data, bin, opts);
      else await installUVVenv(spec, uv, data, bin, opts);
      break;
    }
  }
  const after = toolStatus(spec, opts.env);
  if (!after.ok) throw new Error(`装完了但找不到 ${toolBins(spec).join('、')}：包结构可能已变`);
  report({ stage: '已就绪', percent: 100 });
  return after.where;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function writeExecutable(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o755 });
  fs.renameSync(tmp, file);
}

/**
 * npm 包装进 <数据目录>/tools/npm/<包>@<版本>（先在临时目录装好再改名进位），每个命令写一个小脚本进 bin：
 * 用 onset 的运行时执行包的入口；客户端换了位置导致运行时不在时，退回 PATH 里的 node。
 */
async function installNpmTool(spec: Extract<ToolSpec, { kind: 'npm' }>, root: string, bin: string, opts: InstallOptions): Promise<void> {
  const report = opts.progress ?? (() => {});
  const dir = path.join(root, `${spec.package.replace('/', '+')}@${spec.version}`);
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.onset-tool'))) {
    const staging = fs.mkdtempSync(path.join(root, '.staging-'));
    try {
      fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}\n');
      const stage = `安装 ${spec.package}@${spec.version}`;
      report({ stage, percent: 0, indeterminate: true });
      const npm = npmCommand(opts.env, ['install', '--no-audit', '--no-fund', '--loglevel=error', '--save-exact', `${spec.package}@${spec.version}`]);
      const sink: Writer = opts.output ?? { write: () => true };
      // npm 一声不吭：量临时目录长了多少，界面才看得出它在下载。
      const stop = watchSize([staging], (bytes) => report({ stage, percent: 0, indeterminate: true, bytes }));
      await runCommandIn(npm.file, npm.args, staging, withNode({ ...opts.env, ...npm.env }), sink, opts.signal).finally(stop);
      fs.writeFileSync(path.join(staging, '.onset-tool'), `${spec.package}@${spec.version}\n`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  const pkgDir = path.join(dir, 'node_modules', ...spec.package.split('/'));
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
  for (const name of spec.bins) {
    const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
    if (!rel) throw new Error(`${spec.package}@${spec.version} 没有 ${name} 这个命令`);
    const entry = path.join(pkgDir, rel);
    if (process.platform === 'win32') {
      // bin 与工具数据可在不同盘：在 bin 留一个可被 cmd-shim 识别的 JS 入口，
      // 由同一 Node/Electron 运行时启动真正的入口，保留 require.main、ESM 与多行参数。
      const bridge = `${name}.onset.cjs`;
      writeExecutable(path.join(bin, bridge), [
        "const { spawnSync } = require('node:child_process');",
        `const result = spawnSync(process.execPath, [${marshal(entry)}, ...process.argv.slice(2)], { env: process.env, stdio: 'inherit', windowsHide: true });`,
        'if (result.error) { console.error(result.error.message); process.exitCode = 1; }',
        'else process.exitCode = result.status ?? 1;',
        '',
      ].join('\n'));
      const runtime = process.execPath.replaceAll('%', '%%');
      writeExecutable(path.join(bin, name + '.cmd'), [
        '@echo off', 'chcp 65001 >nul', 'setlocal',
        `if exist "${runtime}" (`, '  set "ELECTRON_RUN_AS_NODE=1"',
        `  "${runtime}" "%~dp0\\${bridge}" %*`,
        ') else (', `  node "%~dp0\\${bridge}" %*`, ')', '',
      ].join('\r\n'));
      continue;
    }
    writeExecutable(
      path.join(bin, name),
      [
        '#!/bin/sh',
        `# 由 onset setup 写出：用 onset 的运行时执行 ${spec.package}@${spec.version}。`,
        `r=${q(process.execPath)}`,
        `if [ -x "$r" ]; then ELECTRON_RUN_AS_NODE=1 exec "$r" ${q(entry)} "$@"; fi`,
        `exec node ${q(entry)} "$@"`,
        '',
      ].join('\n'),
    );
  }
}

/** uv 的公共环境：工具、Python 都装在 onset 的数据目录；Python 包的源沿用用户 pip.conf 里的镜像。 */
function uvEnv(data: string, bin: string, opts: InstallOptions): Record<string, string> {
  const env: Record<string, string> = {
    ...opts.env,
    UV_TOOL_DIR: path.join(data, 'tools', 'uv'),
    UV_TOOL_BIN_DIR: bin,
    UV_PYTHON_INSTALL_DIR: pythonInstallDir(opts.env),
    UV_PYTHON_PREFERENCE: 'only-managed',
  };
  if (!env.UV_DEFAULT_INDEX && !env.UV_INDEX_URL) {
    const index = pipIndexURL(opts.env);
    if (index !== '') env.UV_DEFAULT_INDEX = index;
  }
  if (opts.env[GitHubMirrorEnv]) env.UV_PYTHON_INSTALL_MIRROR = mirrored('https://github.com/astral-sh/python-build-standalone/releases/download', opts.env);
  return env;
}

async function installUVTool(spec: Extract<ToolSpec, { kind: 'uv-tool' }>, uv: string, data: string, bin: string, opts: InstallOptions): Promise<void> {
  const report = opts.progress ?? (() => {});
  const stage = `安装 ${spec.package}==${spec.version}`;
  report({ stage, percent: 0, indeterminate: true });
  const args = ['tool', 'install', '--force', '--python', ToolPythonVersion];
  if (spec.prerelease) args.push('--prerelease', 'allow');
  args.push(`${spec.package}==${spec.version}`);
  // uv 装 Python 与包时量这两个目录长了多少：界面据此显示下了多少、多快。
  const stop = watchSize([path.join(data, 'tools', 'uv'), pythonInstallDir(opts.env)], (bytes) => report({ stage, percent: 0, indeterminate: true, bytes }));
  await runCommandIn(uv, args, data, uvEnv(data, bin, opts), opts.output ?? { write: () => true }, opts.signal).finally(stop);
}

async function installUVVenv(spec: Extract<ToolSpec, { kind: 'uv-venv' }>, uv: string, data: string, bin: string, opts: InstallOptions): Promise<void> {
  const report = opts.progress ?? (() => {});
  const venv = path.join(data, 'tools', 'venv', spec.name);
  const env = uvEnv(data, bin, opts);
  const sink: Writer = opts.output ?? { write: () => true };
  const make = `建 ${spec.name} 的 Python 环境`;
  report({ stage: make, percent: 0, indeterminate: true });
  fs.rmSync(venv, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(venv), { recursive: true });
  let stop = watchSize([pythonInstallDir(opts.env)], (bytes) => report({ stage: make, percent: 0, indeterminate: true, bytes }));
  await runCommandIn(uv, ['venv', '--python', ToolPythonVersion, venv], data, env, sink, opts.signal).finally(stop);
  const install = `安装 ${spec.packages.join(' ')}`;
  report({ stage: install, percent: 0, indeterminate: true });
  const windows = process.platform === 'win32';
  const python = windows ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  // torch 这类包几百 MB：量环境目录长了多少，界面才看得出它在下载。
  stop = watchSize([venv], (bytes) => report({ stage: install, percent: 0, indeterminate: true, bytes }));
  await runCommandIn(uv, ['pip', 'install', '--python', python, ...spec.packages], data, env, sink, opts.signal).finally(stop);
  if (windows) writeExecutable(path.join(bin, spec.bin + '.cmd'), windowsPythonScript(python));
  else writeExecutable(path.join(bin, spec.bin), `#!/bin/sh\n# 由 onset setup 写出：${spec.name} 专用的 Python 环境。\nexec ${q(python)} "$@"\n`);
}

/**
 * 用户 pip 配置里的 index-url（PIP_INDEX_URL 优先，其次 pip.conf）：国内用户多半配了镜像，
 * 而 uv 自己的安装器不读 pip.conf，不转过去的话 torch 这种几百 MB 的包会从境外直连。
 */
export function pipIndexURL(env: Record<string, string | undefined>): string {
  if (env.PIP_INDEX_URL) return env.PIP_INDEX_URL;
  const home = env.HOME ?? '';
  const files = [
    env.PIP_CONFIG_FILE ?? '',
    home && path.join(home, '.config', 'pip', 'pip.conf'),
    home && path.join(home, '.pip', 'pip.conf'),
    home && path.join(home, 'Library', 'Application Support', 'pip', 'pip.conf'),
    '/Library/Application Support/pip/pip.conf',
    '/etc/pip.conf',
  ].filter(Boolean);
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const m = /^\s*index-url\s*[=:]\s*(\S+)/m.exec(text);
    if (m) return m[1];
  }
  return '';
}

function runCommandIn(file: string, args: string[], cwd: string, env: Record<string, string>, output: Writer, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let tail = '';
    const take = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-2000);
      output.write(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(file)} ${args.slice(0, 2).join(' ')} 退出码 ${code}：${tail.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

/**
 * 工具第一次运行时才会去下的模型（例如 MLX 强制对齐的 Qwen3-ForcedAligner）。不预先下好的话，就是在制作途中
 * 现下载一个 1 GB 多的模型，而 huggingface.co 在国内常常连不上（hf-mirror 现在也 308 跳回 huggingface.co，
 * 2026-11 实测）。所以它也是前置资源：onset setup 下到 <数据目录>/models/<仓库名>，能连上 Hugging Face 就从那里下，
 * 否则从魔搭（ModelScope，同一个仓库的镜像）下；每个文件按钉死的 sha256 核对，对不上的来源不用。
 */
export interface ModelSpec {
  /** Hugging Face 上的仓库，魔搭上同名。 */
  repo: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  /** 仅托管在单一来源的模型（例如只有 Hugging Face、魔搭没有同名仓库时）显式声明来源，不白探另一个源。 */
  sources?: readonly ('huggingface' | 'modelscope')[];
}

/** 选模型来源：huggingface 或 modelscope；不设时先探一下 Hugging Face 通不通。 */
export const ModelSourceEnv = 'ONSET_MODEL_SOURCE';

/** 覆盖 Hugging Face 站点地址（例如国内镜像）；文件都核对 sha256，换源也安全。 */
export const HFEndpointEnv = 'ONSET_HF_ENDPOINT';

/** 模型的本地目录。 */
export function modelDir(spec: ModelSpec, env: Record<string, string | undefined>): string {
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'models', spec.repo.replace('/', '__'));
}

/** 模型的每个文件都在（只看大小，不重算摘要：下载时核对过）。 */
export function modelReady(spec: ModelSpec, env: Record<string, string | undefined>): boolean {
  const dir = modelDir(spec, env);
  if (dir === '') return false;
  return spec.files.every((f) => {
    try {
      return fs.statSync(path.join(dir, f.path)).size === f.size;
    } catch {
      return false;
    }
  });
}

function hfOrigin(env: Record<string, string | undefined>): string {
  const custom = (env[HFEndpointEnv] ?? '').trim().replace(/\/+$/, '');
  return custom !== '' ? custom : 'https://huggingface.co';
}

function modelURL(source: string, repo: string, file: string, env: Record<string, string | undefined>): string {
  if (source === 'modelscope') return `https://www.modelscope.cn/models/${repo}/resolve/master/${file}`;
  return `${hfOrigin(env)}/${repo}/resolve/main/${file}`;
}

/** Hugging Face 在几秒内能不能连上：连不上就别让每个文件各自重试一轮再换来源。 */
async function huggingFaceReachable(opts: InstallOptions): Promise<boolean> {
  const curl = process.platform === 'darwin' && fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : lookPath('curl', opts.env.PATH ?? '');
  try {
    await run(curl, ['--fail', '--silent', '--show-error', '--max-time', '10', '--output', process.platform === 'win32' ? 'NUL' : '/dev/null', `${hfOrigin(opts.env)}/api/models/mlx-community`], { ...opts, output: undefined });
    return true;
  } catch {
    return false;
  }
}

/** 下好模型（已在就不动），返回本地目录。 */
export async function ensureModel(spec: ModelSpec, opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const dir = modelDir(spec, opts.env);
  if (dir === '') throw new Error('无法确定模型的存放目录：环境里没有 HOME');
  if (modelReady(spec, opts.env)) {
    report({ stage: '模型已就绪', percent: 100 });
    return dir;
  }
  fs.mkdirSync(dir, { recursive: true });
  const wanted = opts.env[ModelSourceEnv];
  let sources = wanted === 'huggingface' || wanted === 'modelscope' ? [wanted] : spec.sources ? [...spec.sources] : [];
  if (sources.length === 0) {
    report({ stage: '选择模型下载源', percent: 0, indeterminate: true });
    sources = (await huggingFaceReachable(opts)) ? ['huggingface', 'modelscope'] : ['modelscope'];
  }
  const total = spec.files.reduce((sum, f) => sum + f.size, 0);
  let base = 0;
  for (const file of spec.files) {
    const target = path.join(dir, file.path);
    if (!(fs.existsSync(target) && fs.statSync(target).size === file.size)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let lastErr: unknown;
      let done = false;
      for (const source of sources) {
        const offset = base;
        try {
          const got = await download({ url: modelURL(source, spec.repo, file.path, opts.env), sha256: file.sha256, size: file.size }, path.dirname(target), path.basename(target) + '.download', opts, (bytes) =>
            report({ stage: `下载模型（${source === 'modelscope' ? '魔搭' : 'Hugging Face'}）`, percent: Math.min(99, (100 * (offset + bytes)) / total) }),
          );
          fs.renameSync(got, target);
          done = true;
          break;
        } catch (err) {
          lastErr = err;
          if (opts.signal?.aborted) throw abortReason(opts.signal);
        }
      }
      if (!done) throw new Error(`下载模型文件 ${file.path} 失败：${(lastErr as Error)?.message ?? ''}`, { cause: lastErr });
    }
    base += file.size;
  }
  report({ stage: '模型已就绪', percent: 100 });
  return dir;
}
