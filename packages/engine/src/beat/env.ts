// 节拍分析环境：装有固定版本 beat-this 的 Python 虚拟环境，按版本装在用户级目录里，所有卡点项目共用。
//
// 以前 beat.yaml 默认写 `python: python3`，系统 Python 里没有 beat-this，编排工具就在对话里自己
// `python -m venv` + `pip install`：每个新项目都可能另建一套（torch 一套约 800 MB），还要边做边联网。
// 现在它和 HyperFrames CLI 一样是前置资源：只由 am setup 安装并预下载默认权重，其余路径
// （am beat analyze / doctor、客户端）只检查，缺了抛 prereq.MissingError 指向 am setup。
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../envutil';
import { lockFile } from '../hyperframes/cli';
import type { Progress, Writer } from '../hyperframes/progress';
import { errorText, runCommand } from '../hyperframes/util';
import { abortReason } from '../procgroup';
import { missing } from '../prereq';
import { GitHubMirrorEnv, mirrored, pythonInstallDir } from '../toolinstall';
import { findOptional } from '../toolpath';
import { AnalyzerVersion } from './store';

/** 覆盖节拍分析环境的目录（测试与特殊部署用）。 */
export const EnvDirEnv = 'AM_BEAT_ENV_DIR';

/** 指定建环境用的 Python（默认在 PATH 里按 basePythonCandidates 挑一个 torch 支持的版本）。 */
export const BasePythonEnv = 'AM_BEAT_BASE_PYTHON';

/** am setup 预下载的权重：beat.yaml 的默认 checkpoint。换别的 checkpoint 时用 am beat doctor 下载。 */
export const DefaultCheckpoint = 'final0';

/** 写在环境目录里，内容是 beat-this 版本：只有装完、自检通过、权重下好的环境才有它。 */
const envMarker = '.am-beat-env';

/**
 * 建环境时按顺序找的 Python。torch 的预编译包跟不上最新的 Python（系统 python3 是 3.15 时装不上），
 * 所以先找已知可用的版本，最后才退回 python3，并且只接受 supportedPython 范围里的版本。
 */
const basePythonCandidates = ['python3.12', 'python3.13', 'python3.11', 'python3.14', 'python3.10', 'python3'];
const supportedPython = { min: [3, 10], max: [3, 14] } as const;

/** 节拍分析环境目录；env 里既没有 EnvDirEnv 也没有 HOME / XDG_DATA_HOME 时为空。 */
export function envDir(env: Record<string, string | undefined>): string {
  const dir = env[EnvDirEnv];
  if (dir) return dir;
  let root = '';
  if (env.XDG_DATA_HOME) root = path.join(env.XDG_DATA_HOME, 'am');
  else if (env.HOME) root = path.join(env.HOME, '.local', 'share', 'am');
  if (root === '') return '';
  return path.join(root, 'beat', 'venv-' + AnalyzerVersion);
}

/** 环境里的 Python。 */
export function envPython(dir: string): string {
  return path.join(dir, 'bin', 'python');
}

/** dir 是装好的节拍分析环境。 */
export function envReady(dir: string): boolean {
  if (dir === '') return false;
  try {
    if (fs.readFileSync(path.join(dir, envMarker), 'utf8').trim() !== AnalyzerVersion) return false;
    return fs.statSync(envPython(dir)).isFile();
  } catch {
    return false;
  }
}

/** 返回已装好的环境里的 Python，没装好抛 prereq.MissingError，不联网。 */
export function requireEnv(env: Record<string, string | undefined>): string {
  const dir = envDir(env);
  const what = '节拍分析环境 beat-this ' + AnalyzerVersion;
  if (envReady(dir)) return envPython(dir);
  if (dir === '') throw missing(what, '环境里没有 HOME，也没有 ' + EnvDirEnv);
  throw missing(what, '没有装在 ' + dir);
}

/** 一次环境安装。 */
export interface EnvOptions {
  /** pip 的环境：沿用用户自己的 pip.conf（镜像、代理）。 */
  env?: Record<string, string>;
  /** 下载权重的环境：am setup --proxy 时带 HTTPS_PROXY（权重在境外服务器上）。留空同 env。 */
  weightsEnv?: Record<string, string>;
  output?: Writer;
  progress?: (p: Progress) => void;
  /** 要安装的包规格，留空取 beat-this==<AnalyzerVersion>。测试用它指向本地包。 */
  package?: string;
  /** 预下载权重的脚本：传给环境里的 Python 执行，参数是 checkpoint 名。测试用它绕开真实模型。 */
  warmScript?: string;
}

/** pip install 的尝试次数：torch 一个包几百 MB，国内网络下被掐断是常态。 */
const installAttempts = 3;

/**
 * 返回装好的环境目录，没有时新建。只有 am setup 调用它。
 *
 * 在环境目录里直接建（venv 里的脚本写死了绝对路径，建好再改名会坏），完成标记最后才写：
 * 中途失败的残缺环境没有标记，下次整个删掉重来。同一时间只有一个进程在装（锁文件）。
 */
export async function ensureEnv(opts: EnvOptions, signal?: AbortSignal): Promise<string> {
  const env = opts.env ?? {};
  const dir = envDir(env);
  if (dir === '') throw new Error(`无法确定节拍分析环境的目录：环境里没有 HOME，可用 ${EnvDirEnv} 指定`);
  if (envReady(dir)) return dir;
  const report = opts.progress ?? (() => {});
  const sink: Writer = opts.output ?? { write: () => true };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const unlock = await lockFile(dir + '.lock', signal);
  try {
    if (envReady(dir)) return dir;
    const base = await chooseBase(env, signal);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= installAttempts; attempt++) {
      const retry = attempt > 1 ? `（重试 ${attempt}/${installAttempts}）` : '';
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        report({ stage: '建 Python 环境' + retry, percent: 0, indeterminate: true });
        await createVenv(base, dir, env, opts.weightsEnv ?? env, sink, signal);
        report({ stage: `安装 beat-this ${AnalyzerVersion} 与 torch${retry}`, percent: 0, indeterminate: true });
        const pkg = opts.package || 'beat-this==' + AnalyzerVersion;
        await runCommand(envPython(dir), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', pkg], {
          env,
          stdout: sink,
          stderr: sink,
          signal,
        });
        report({ stage: `下载 ${DefaultCheckpoint} 权重${retry}`, percent: 0, indeterminate: true });
        await runCommand(envPython(dir), ['-c', opts.warmScript ?? warmScript, DefaultCheckpoint], {
          env: opts.weightsEnv ?? env,
          stdout: sink,
          stderr: sink,
          signal,
        });
        fs.writeFileSync(path.join(dir, envMarker), AnalyzerVersion + '\n', { mode: 0o644 });
        report({ stage: '节拍分析环境已就绪', percent: 100 });
        return dir;
      } catch (err) {
        lastErr = err;
      }
      if (signal?.aborted) throw abortReason(signal);
      if (attempt < installAttempts) sink.write(`安装节拍分析环境失败，重试（${attempt + 1}/${installAttempts}）：${errorText(lastErr)}\n`);
    }
    throw new Error(
      `安装节拍分析环境失败（用 ${base.path}${base.version ? '，Python ' + base.version : ''}；pip 用的是你自己的 pip.conf，网络好转后重新运行即可）：${errorText(lastErr)}`,
      { cause: lastErr },
    );
  } finally {
    unlock();
  }
}

/** 加载一次模型：首次运行会把权重下载进 torch 的用户级缓存（~/.cache/torch），所有环境共用。 */
const warmScript = `import sys
from beat_this.inference import Audio2Beats
Audio2Beats(checkpoint_path=sys.argv[1], device='cpu', dbn=False)
`;

/** 建环境用什么：系统里合适的 Python，或者 uv（它自己下载独立的 Python）。 */
interface Base {
  kind: 'python' | 'uv';
  path: string;
  /** Python 版本；用 uv 时为空。 */
  version: string;
}

/** uv 建环境用的 Python 版本：torch 的预编译包一定有。 */
export const UVPythonVersion = '3.12';

/** uv 下载的独立 Python 放在哪：与 toolinstall 的 Python 类工具共用 <数据目录>/python，不进 uv 默认的 ~/.local/share/uv。 */
export function uvPythonDir(env: Record<string, string | undefined>): string {
  return pythonInstallDir(env);
}

/**
 * 系统里有没有能装 torch 的 Python（或用户显式指定了一个）。没有时 am setup 先下载 uv，
 * 由 uv 带一份独立的 Python：客户端用户的 Mac 上常常只有 Xcode 的占位 python3，或者是 torch 还不支持的新版本。
 */
export async function hasBasePython(env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  try {
    await findBasePython(env, signal);
    return true;
  } catch {
    return false;
  }
}

async function chooseBase(env: Record<string, string>, signal?: AbortSignal): Promise<Base> {
  try {
    return { kind: 'python', ...(await findBasePython(env, signal)) };
  } catch (err) {
    if (env[BasePythonEnv]) throw err;
    const uv = findOptional('uv', env);
    if (uv !== '') return { kind: 'uv', path: uv, version: '' };
    throw new Error(`${errorText(err)}；或者运行 am setup --only beat，让 am 下载 uv 并带一份独立的 Python`, { cause: err });
  }
}

/**
 * 在 dir 建 venv。用 uv 时带 --seed 装上 pip：后面照旧用 `python -m pip install`，沿用用户 pip.conf 里的国内镜像
 * （uv 自己的安装器不读 pip.conf）。uv 下载 Python 走 downloadEnv（带 --proxy 的代理）；设了 AM_GITHUB_MIRROR
 * 时把 Python 的下载也换到镜像。
 */
async function createVenv(base: Base, dir: string, env: Record<string, string>, downloadEnv: Record<string, string>, sink: Writer, signal?: AbortSignal): Promise<void> {
  if (base.kind === 'python') {
    await runCommand(base.path, ['-m', 'venv', dir], { env, stdout: sink, stderr: sink, signal });
    return;
  }
  const uvEnv: Record<string, string> = { ...downloadEnv, UV_PYTHON_INSTALL_DIR: uvPythonDir(env), UV_NO_CONFIG: '1' };
  const mirror = env[GitHubMirrorEnv];
  if (mirror) uvEnv.UV_PYTHON_INSTALL_MIRROR = mirrored('https://github.com/astral-sh/python-build-standalone/releases/download', env);
  await runCommand(base.path, ['venv', '--seed', '--python', UVPythonVersion, '--python-preference', 'only-managed', dir], {
    env: uvEnv,
    stdout: sink,
    stderr: sink,
    signal,
  });
}

/** 找一个能建环境的 Python：BasePythonEnv 指定的优先，否则按 basePythonCandidates 找第一个版本合适的。 */
async function findBasePython(env: Record<string, string>, signal?: AbortSignal): Promise<{ path: string; version: string }> {
  const pathValue = env.PATH ?? '';
  const tried: string[] = [];
  const explicit = env[BasePythonEnv];
  const names = explicit ? [explicit] : basePythonCandidates;
  for (const name of names) {
    let binary: string;
    try {
      binary = lookPath(name, pathValue);
    } catch {
      continue;
    }
    let version: string;
    try {
      version = (await runCommand(binary, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { env, signal })).trim();
    } catch {
      continue;
    }
    if (explicit || inRange(version)) return { path: binary, version };
    tried.push(`${binary}（${version}）`);
  }
  const range = `${supportedPython.min.join('.')}–${supportedPython.max.join('.')}`;
  if (explicit) throw new Error(`找不到 ${BasePythonEnv} 指定的 Python：${explicit}`);
  throw new Error(
    `找不到能装 torch 的 Python（需要 ${range}${tried.length > 0 ? '，找到的是 ' + tried.join('、') : ''}）。可以用 ${BasePythonEnv} 指定一个`,
  );
}

function inRange(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  const v = major * 100 + minor;
  const lo = supportedPython.min[0] * 100 + supportedPython.min[1];
  const hi = supportedPython.max[0] * 100 + supportedPython.max[1];
  return Number.isFinite(v) && v >= lo && v <= hi;
}
