/**
 * 在子进程里执行第三方站的一条操作。
 *
 * 协议：工作目录是项目根；stdin 是一行 JSON（params、project_root、station_dir、data_dir）；stdout 是给人看的文字，
 * 以 `am-result ` 开头的最后一行是结构化结果（JSON），没有就当成没有结构化结果；退出码 0 是成功。
 *
 * 环境只给最少的几样：PATH、HOME、语言、代理、证书，加上 AM_STATION_DATA（插件自己的数据目录，凭据放这里）。
 * 项目 .env、am 与编排工具的设置一概不传。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lookPath, WindowsBaseEnvKeys } from '../envutil';
import { groupSpawnOptions, killTree } from '../procgroup';
import { loadProjectStations, stationsDir, type LoadedStation, type ManifestOp } from './external';
import { stationSettings } from './settings';

export const ResultPrefix = 'am-result ';
/** 进度行：`am-progress 0.4 正在上传`（0–1 的小数，后面是说明）。客户端的任务进度条显示它。 */
export const ProgressPrefix = 'am-progress ';

/** 解析一行进度；不是进度行返回 null。 */
export function parseProgressLine(line: string): { progress: number; message: string } | null {
  if (!line.startsWith(ProgressPrefix)) return null;
  const rest = line.slice(ProgressPrefix.length).trim();
  const cut = rest.indexOf(' ');
  const n = Number(cut < 0 ? rest : rest.slice(0, cut));
  if (!Number.isFinite(n)) return null;
  return { progress: Math.min(1, Math.max(0, n)), message: cut < 0 ? '' : rest.slice(cut + 1).trim() };
}
export const StationDataEnv = 'AM_STATION_DATA';

const passKeys = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', ...WindowsBaseEnvKeys];

/** 第三方站子进程的环境。 */
export function stationEnv(base: Record<string, string | undefined>, dataDir: string, root: string, stationDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of passKeys) if (base[key] !== undefined) out[key] = base[key]!;
  out[StationDataEnv] = dataDir;
  out.AM_PROJECT_ROOT = root;
  out.AM_STATION_DIR = stationDir;
  return out;
}

export interface StationResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  exit_code: number;
}

/** 找到项目里某个站的某条操作。 */
export function findStationOp(root: string, stationID: string, opName: string, env: Record<string, string | undefined> = process.env): { station: LoadedStation; op: ManifestOp } {
  const { stations, problems } = loadProjectStations(root, env);
  const station = stations.find((s) => s.manifest.id === stationID);
  if (!station) {
    const why = problems.find((p) => p.startsWith(`第三方站 ${stationID}：`));
    throw new Error(why ?? `这个项目没有加第三方站 ${stationID}`);
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

/** 从输出里取出最后一行 am-result。 */
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
 * 执行一条第三方操作。文字边跑边写进 write（am-result 那一行不转发）；取消时整组结束子进程。
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
  const { station, op } = findStationOp(root, stationID, opName, env);
  const checked = checkParams(op, params);
  const dataDir = path.join(stationsDir(env), station.manifest.id, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const childEnv = stationEnv(env, dataDir, root, station.dir);
  const [head, ...rest] = op.command;
  const file = head.includes('/') || head.includes('\\') ? path.join(station.dir, head) : lookPath(head, childEnv.PATH ?? '');
  const args = rest.map((a) => a.replaceAll('{station_dir}', station.dir));
  write(`第三方站 ${station.manifest.name}（${station.manifest.id} ${station.manifest.version}）：${op.summary}\n`);
  const child = spawn(file, args, { cwd: root, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], ...groupSpawnOptions() });
  // 设置（含插件自己的密钥）只经 stdin 交给它，不进环境变量，也不进命令行。
  const input: Record<string, unknown> = { params: checked, settings: stationSettings(env, station.manifest), project_root: root, station_dir: station.dir, data_dir: dataDir };
  if (event) input.event = event;
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
  const { data, bad } = parseResultLine(stdout);
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-3).join('\n');
    return { ok: false, error: `第三方站 ${stationID} 的 ${opName} 失败（退出码 ${code}）${tail ? '：' + tail : ''}`, exit_code: code };
  }
  if (bad) return { ok: false, error: `第三方站 ${stationID} 的结果行不是合法的 JSON：${bad.slice(0, 200)}`, exit_code: 1 };
  return data === undefined ? { ok: true, exit_code: 0 } : { ok: true, data, exit_code: 0 };
}
