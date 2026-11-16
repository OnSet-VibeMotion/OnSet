/**
 * 在子进程里执行第三方站的一条操作。
 *
 * 协议：工作目录是项目根；stdin 是一行 JSON（params、project_root、station_dir、data_dir）；stdout 是给人看的文字，
 * 以 `onset-result ` 开头的最后一行是结构化结果（JSON），没有就当成没有结构化结果；退出码 0 是成功。
 *
 * 环境只给最少的几样：PATH、HOME、语言、代理、证书，加上 ONSET_STATION_DATA（插件自己的数据目录，凭据放这里）。
 * 项目 .env、onset 与编排工具的设置一概不传。HOME 照给：很多工具（git、npm、各家 SDK）离了它不工作。
 *
 * 这不是沙箱：操作是用户电脑上的普通程序，能读写用户的文件、能联网。onset 只做两件事：不把凭据交给它，
 * 以及前后各扫一遍项目树，它写了声明范围（produces、站点 outputs）之外的项目文件时照实列出来（scope.ts）；
 * 写到 onset 自己的文件时这次操作按失败处理（文件已经写了，撤销不了）。
 *
 * 运行时：command 的第一个元素可以写 `{node}`（onset 自己的运行时，客户端里是 Electron 带 ELECTRON_RUN_AS_NODE=1，
 * 用户机器上不必装 Node）或 `{python}`（onset setup 用 uv 装进 <数据目录>/onset/python 的 Python，没有时报缺前置资源，
 * 不现下载）。占位符后面第一个参数是脚本：相对路径按站目录解析。裸写 `node` / `python3` 照旧按 PATH 找。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath, WindowsBaseEnvKeys } from '../envutil';
import { MissingError } from '../prereq';
import { groupSpawnOptions, killTree } from '../procgroup';
import { pythonInstallDir, ToolPythonVersion } from '../toolinstall';
import { nodeCommand } from '../toolpath';
import { loadStations, stationsDir, type LoadedStation, type ManifestOp } from './external';
import { scopeReport, scopeText, statProject, type ScopeReport } from './scope';
import { stationSettings } from './settings';
import { StationBrowserEnv } from './browser';

export const ResultPrefix = 'onset-result ';
/** 进度行：`onset-progress 0.4 正在上传`（0–1 的小数，后面是说明）。客户端的任务进度条显示它。 */
export const ProgressPrefix = 'onset-progress ';

/** 解析一行进度；不是进度行返回 null。 */
export function parseProgressLine(line: string): { progress: number; message: string } | null {
  if (!line.startsWith(ProgressPrefix)) return null;
  const rest = line.slice(ProgressPrefix.length).trim();
  const cut = rest.indexOf(' ');
  const n = Number(cut < 0 ? rest : rest.slice(0, cut));
  if (!Number.isFinite(n)) return null;
  return { progress: Math.min(1, Math.max(0, n)), message: cut < 0 ? '' : rest.slice(cut + 1).trim() };
}
export const StationDataEnv = 'ONSET_STATION_DATA';

const passKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', ...WindowsBaseEnvKeys];

/** 第三方站子进程的环境。 */
export function stationEnv(base: Record<string, string | undefined>, dataDir: string, root: string, stationDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of passKeys) if (base[key] !== undefined) out[key] = base[key]!;
  out[StationDataEnv] = dataDir;
  out.ONSET_PROJECT_ROOT = root;
  out.ONSET_STATION_DIR = stationDir;
  return out;
}

export interface StationResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  exit_code: number;
  /** 写了声明范围之外的项目文件（相对路径，最多 MaxListedPaths 条）；没有越界时不出现。 */
  out_of_scope?: string[];
  /** 没列出来的越界文件还有几个。 */
  out_of_scope_more?: number;
  /** 越界文件里属于 onset 自己的（有它时 ok 为 false）。 */
  reserved?: string[];
}

/** command 的第一个元素写它：用 onset 自己的运行时跑脚本。 */
export const NodePlaceholder = '{node}';
/** command 的第一个元素写它：用 onset setup 装的 Python 跑脚本。 */
export const PythonPlaceholder = '{python}';

/**
 * onset setup 用 uv 装进 <数据目录>/onset/python 的 Python（uv 的目录名形如 cpython-3.12.12-macos-aarch64-none）。
 * 优先工具用的那个小版本，其余按版本从新到旧；没有就抛 MissingError，指向工具准备页——不现下载。
 */
export function managedPython(env: Record<string, string | undefined>): string {
  const dir = pythonInstallDir(env);
  let names: string[] = [];
  try {
    names = dir === '' ? [] : fs.readdirSync(dir).filter((n) => /^cpython-3\.\d+\.\d+-/.test(n) && !n.includes('+'));
  } catch {
    names = [];
  }
  const version = (n: string) => n.split('-')[1].split('.').map(Number);
  const preferred = Number(ToolPythonVersion.split('.')[1]);
  const rank = (n: string) => {
    const [, minor, patch] = version(n);
    return [minor === preferred ? 1 : 0, minor, patch];
  };
  names.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  for (const name of names) {
    const file = process.platform === 'win32' ? path.join(dir, name, 'python.exe') : path.join(dir, name, 'bin', 'python3');
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // 装了一半：看下一个。
    }
  }
  throw new MissingError('插件用的 Python', dir === '' ? '' : `${dir} 里没有；在工具准备页装一项用到 Python 的工具时会带上它`);
}

/** 解析 command：占位符、站目录里的相对路径、PATH 里的命令。返回要起的程序、参数与额外的环境变量。 */
export function resolveCommand(
  command: readonly string[],
  stationDir: string,
  env: Record<string, string | undefined>,
  pathValue: string,
): { file: string; args: string[]; env: Record<string, string> } {
  const [head, ...rest] = command;
  const args = rest.map((a) => a.replaceAll('{station_dir}', stationDir));
  if (head === NodePlaceholder || head === PythonPlaceholder) {
    // 第一个参数是脚本：相对路径按站目录解析（`-m 模块`、`-c 代码` 这类选项不动）。
    const [script, ...more] = args;
    if (script === undefined) throw new Error(`command 写了 ${head} 就要接着写脚本，例如 ["${head}", "bin/run.${head === NodePlaceholder ? 'js' : 'py'}"]`);
    const resolved = script.startsWith('-') || path.isAbsolute(script) ? script : path.join(stationDir, script);
    if (head === PythonPlaceholder) return { file: managedPython(env), args: [resolved, ...more], env: {} };
    const node = nodeCommand(resolved, more);
    return { file: node.file, args: node.args, env: node.env };
  }
  if (head.includes('/') || head.includes('\\')) return { file: path.join(stationDir, head), args, env: {} };
  try {
    return { file: lookPath(head, pathValue), args, env: {} };
  } catch (err) {
    if (/^(node|python(3(\.\d+)?)?)$/.test(head)) {
      const placeholder = head === 'node' ? NodePlaceholder : PythonPlaceholder;
      throw new Error(`${(err as Error).message}。用户的电脑上不一定装了 ${head}：插件作者可以把 command 的 "${head}" 改成 "${placeholder}"，由片场提供运行时`, { cause: err });
    }
    throw err;
  }
}

/** 找到某个插件的某条操作（插件装在用户级，对所有项目一样）。 */
export function findStationOp(stationID: string, opName: string, env: Record<string, string | undefined> = process.env): { station: LoadedStation; op: ManifestOp } {
  const { stations, problems } = loadStations(env);
  const station = stations.find((s) => s.manifest.id === stationID);
  if (!station) {
    const why = problems.find((p) => p.id === stationID);
    throw new Error(why?.message ?? `没有装插件 ${stationID}`);
  }
  const op = station.manifest.ops.find((o) => o.name === opName);
  if (!op) throw new Error(`第三方站 ${stationID} 没有操作 ${opName}`);
  return { station, op };
}

/** 按清单检查并补全参数：未知参数、类型不对、缺必填一律报错。 */
export function checkParams(op: ManifestOp, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unknown = Object.keys(params).filter((k) => !(k in op.params));
  if (unknown.length > 0) throw new Error(`操作 ${op.name} 没有参数：${unknown.join('、')}`);
  for (const [key, spec] of Object.entries(op.params)) {
    const v = params[key] ?? spec.default;
    if (v === undefined) {
      if (spec.required) throw new Error(`操作 ${op.name} 缺参数 ${key}`);
      continue;
    }
    const ok =
      spec.type === 'string' ? typeof v === 'string'
      : spec.type === 'boolean' ? typeof v === 'boolean'
      : spec.type === 'integer' ? Number.isInteger(v)
      : spec.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (!ok) throw new Error(`操作 ${op.name} 的参数 ${key} 要是 ${spec.type}`);
    out[key] = v;
  }
  return out;
}

/** 从输出里取出最后一行 onset-result。 */
export function parseResultLine(stdout: string): { data?: unknown; bad?: string } {
  const lines = stdout.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
  const last = lines[lines.length - 1];
  if (!last || !last.startsWith(ResultPrefix)) return {};
  try {
    return { data: JSON.parse(last.slice(ResultPrefix.length)) };
  } catch {
    return { bad: last };
  }
}

/**
 * 执行一条第三方操作。文字边跑边写进 write（onset-result 那一行不转发）；取消时整组结束子进程。
 */
export async function runStationOp(
  root: string,
  stationID: string,
  opName: string,
  params: Record<string, unknown>,
  write: (text: string) => void,
  signal?: AbortSignal,
  env: Record<string, string | undefined> = process.env,
  /** 事件钩子触发时的事件（交给插件的 stdin）。 */
  event?: Record<string, unknown>,
): Promise<StationResult> {
  const { station, op } = findStationOp(stationID, opName, env);
  const checked = checkParams(op, params);
  const dataDir = path.join(stationsDir(env), station.manifest.id, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // 不需要项目的操作（登录、管理账号这类插件自己的配置）没打开项目时：工作目录是插件的数据目录，不扫项目。
  const projectless = root === '';
  if (projectless && op.project !== false) throw new Error(`第三方站 ${stationID} 的 ${opName} 要在项目里执行，先打开一个项目`);
  const projectRoot = root;
  const childEnv = stationEnv(env, dataDir, projectRoot, station.dir);
  const cmd = resolveCommand(op.command, station.dir, env, childEnv.PATH ?? '');
  write(`第三方站 ${station.manifest.name}（${station.manifest.id} ${station.manifest.version}）：${op.summary}\n`);
  const before = projectless ? null : statProject(root);
  const child = spawn(cmd.file, cmd.args, { cwd: projectless ? dataDir : root, env: { ...childEnv, ...cmd.env }, stdio: ['pipe', 'pipe', 'pipe'], ...groupSpawnOptions() });
  // 设置（含插件自己的密钥）只经 stdin 交给它，不进环境变量，也不进命令行。
  const input: Record<string, unknown> = { params: checked, settings: stationSettings(env, station.manifest), project_root: projectRoot, station_dir: station.dir, data_dir: dataDir };
  if (event) input.event = event;
  if (op.trigger === 'user' && station.manifest.browser && !event && env[StationBrowserEnv]) input.browser = JSON.parse(env[StationBrowserEnv]!);
  child.stdin.end(JSON.stringify(input) + '\n');
  let stdout = '';
  let stderr = '';
  let pending = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stdout += text;
    pending += text;
    const cut = pending.lastIndexOf('\n');
    if (cut < 0) return;
    const ready = pending.slice(0, cut + 1);
    pending = pending.slice(cut + 1);
    const visible = ready.split('\n').filter((l) => !l.startsWith(ResultPrefix)).join('\n');
    if (visible !== '') write(visible);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    write(text);
  });
  const onAbort = () => {
    if (child.pid !== undefined && !killTree(child.pid, 'SIGTERM')) child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      stderr += err.message;
      resolve(127);
    });
    child.on('close', (c, sig) => resolve(c ?? (sig ? 130 : 1)));
  });
  signal?.removeEventListener('abort', onAbort);
  if (pending !== '' && !pending.startsWith(ResultPrefix)) write(pending + '\n');
  const scope = before ? scopeReport(station.manifest, before, statProject(root)) : null;
  if (scope) write(scopeText(station.manifest.name, scope));
  const { data, bad } = parseResultLine(stdout);
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-3).join('\n');
    return withScope({ ok: false, error: `第三方站 ${stationID} 的 ${opName} 失败（退出码 ${code}）${tail ? '：' + tail : ''}`, exit_code: code }, scope);
  }
  if (scope && scope.reserved.length > 0) {
    return withScope({ ok: false, error: `第三方站 ${stationID} 的 ${opName} 写了片场自己的文件（${scope.reserved.join('、')}），按失败处理`, exit_code: 1 }, scope);
  }
  if (bad) return withScope({ ok: false, error: `第三方站 ${stationID} 的结果行不是合法的 JSON：${bad.slice(0, 200)}`, exit_code: 1 }, scope);
  return withScope(data === undefined ? { ok: true, exit_code: 0 } : { ok: true, data, exit_code: 0 }, scope);
}

function withScope(r: StationResult, scope: ScopeReport | null): StationResult {
  if (!scope) return r;
  return { ...r, out_of_scope: scope.out_of_scope, out_of_scope_more: scope.out_of_scope_more, ...(scope.reserved.length > 0 ? { reserved: scope.reserved } : {}) };
}
