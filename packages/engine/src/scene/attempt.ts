import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { usageJSON, type Usage } from '../tools';
import { ptrTo, sliceOf, unmarshal, type StructType } from './jsondecode';
import { outputPath, stderrLog, streamLog, userLog, type Scene } from './scene';

/** 本次渲染尝试的记录文件，与三份日志放在一起、一起归档。 */
export function attemptLog(s: Pick<Scene, 'directory' | 'id'>): string {
  return path.join(s.directory, attemptFileName(s.id));
}

/** 尝试记录的文件名（归档目录里也是这个名字）。 */
export function attemptFileName(id: string): string {
  return 'render-' + id + '.attempt.json';
}

/**
 * 一次渲染尝试的机器可读记录。
 *
 * 日志回答「渲染器说了什么」，这份记录回答「这次花了多久、用了多少、为什么
 * 失败、输入是哪一套」：跨多次运行对比镜头耗时、找出反复失败的镜头，都靠它，
 * 而这些信息过去只活在当次 run-all 的终端输出里。
 */
export interface Attempt {
  schema: number;
  scene_id: string;
  renderer: string;
  /**
   * 渲染工具实际用的模型：优先从输出流读，读不到时取工具配置文件
   * 声明的默认模型，都没有时为空。同一渲染工具换了模型，犯的错可能完全不同。
   */
  model: string;
  fingerprint: string;
  started_at: string;
  ended_at: string;
  seconds: number;
  outcome: string;
  exit_code: number | null;
  error: string;
  /** 模型异常退出但产物通过本机验收时，保留服务错误，不伪装成正常退出。 */
  warning?: string;
  problems: string[] | null;
  /** problems 对应的校验器 ID，见 VerificationError.checks。 */
  checks: string[] | null;
  retry: boolean;
  usage: Usage | null;
  /** 渲染工具这一次的会话号：中途异常退出时下一次靠它续接（resume.ts）。读不到为空。 */
  session_id: string;
  /** 这一次是怎么接着上一次做的：verify（验收已有视频）、render（onset 直接渲染）、session（续接会话）、files（照上次文件接着做）；从头做为空。 */
  resumed: string;
  /** 局部返修已回退时，不能续接成下一次正式渲染。 */
  local_repair?: boolean;
}

/** 零值尝试记录，测试与调用方构造时用。 */
export function newAttempt(fields: Partial<Attempt> = {}): Attempt {
  return {
    schema: 0,
    scene_id: '',
    renderer: '',
    model: '',
    fingerprint: '',
    started_at: '',
    ended_at: '',
    seconds: 0,
    outcome: '',
    exit_code: null,
    error: '',
    warning: '',
    problems: null,
    checks: null,
    retry: false,
    usage: null,
    session_id: '',
    resumed: '',
    ...fields,
  };
}

// 尝试结果。verification_failed 单列：它是确定性失败，不该与渲染器崩溃混在一起统计。
export const OutcomeSucceeded = 'succeeded';
export const OutcomeFailed = 'failed';
export const OutcomeVerificationFailed = 'verification_failed';
export const OutcomeInterrupted = 'interrupted';

/** 按 Go 的字段顺序与 omitempty 构造 Attempt 的 JSON 值。 */
export function attemptToJSON(a: Attempt): unknown {
  return {
    schema: a.schema,
    scene_id: a.scene_id,
    renderer: a.renderer,
    model: a.model || undefined,
    fingerprint: a.fingerprint || undefined,
    started_at: a.started_at,
    ended_at: a.ended_at,
    seconds: a.seconds,
    outcome: a.outcome,
    exit_code: a.exit_code ?? undefined,
    error: a.error || undefined,
    warning: a.warning || undefined,
    problems: a.problems && a.problems.length > 0 ? a.problems : undefined,
    checks: a.checks && a.checks.length > 0 ? a.checks : undefined,
    retry: a.retry,
    usage: a.usage ? usageJSON(a.usage) : undefined,
    session_id: a.session_id || undefined,
    resumed: a.resumed || undefined,
    local_repair: a.local_repair || undefined,
  };
}

const sessionTotalType: StructType = {
  kind: 'struct',
  goName: 'tools.SessionTotal',
  name: 'SessionTotal',
  fields: [
    ['input_tokens', 'int64'],
    ['output_tokens', 'int64'],
    ['cached_input_tokens', 'int64'],
    ['cost_usd', ptrTo('float')],
    ['credits', ptrTo('float')],
    ['turns', 'int'],
  ],
};

const usageType: StructType = {
  kind: 'struct',
  goName: 'tools.Usage',
  name: 'Usage',
  fields: [
    ['input_tokens', 'int64'],
    ['output_tokens', 'int64'],
    ['cached_input_tokens', 'int64'],
    ['cost_usd', ptrTo('float')],
    ['credits', ptrTo('float')],
    ['turns', 'int'],
    ['partial', 'bool'],
    ['basis', 'string'],
    ['source', 'string'],
    ['session_total', ptrTo(sessionTotalType)],
  ],
};

const attemptType: StructType = {
  kind: 'struct',
  goName: 'scene.Attempt',
  name: 'Attempt',
  fields: [
    ['schema', 'int'],
    ['scene_id', 'string'],
    ['renderer', 'string'],
    ['model', 'string'],
    ['fingerprint', 'string'],
    ['started_at', 'string'],
    ['ended_at', 'string'],
    ['seconds', 'float'],
    ['outcome', 'string'],
    ['exit_code', ptrTo('int')],
    ['error', 'string'],
    ['problems', sliceOf('string')],
    ['checks', sliceOf('string')],
    ['retry', 'bool'],
    ['usage', ptrTo(usageType)],
    ['session_id', 'string'],
    ['resumed', 'string'],
    ['warning', 'string'],
    ['local_repair', 'bool'],
  ],
};

/** json.Unmarshal 一份尝试记录（Go 的 nil 写成 null）。 */
export function parseAttempt(body: string | Uint8Array): Attempt {
  return unmarshal<Attempt>(body, attemptType);
}

export function writeAttempt(s: Pick<Scene, 'directory' | 'id'>, attempt: Attempt): void {
  const body = marshalIndent(attemptToJSON({ ...attempt, schema: 1 }));
  atomicWrite(attemptLog(s), body + '\n', 0o644);
}

/** Go 的 t.UTC().Format(time.RFC3339)：秒级、带 Z。 */
export function timestamp(t: Date): string {
  return t.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function lexists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把上一次尝试留下的产物、日志与尝试记录移进 attempts/attempt-NN，
 * 返回该目录；没有任何可归档的文件时返回空字符串，不建空目录。
 *
 * 渲染开始前与调度层重试前都走这里：日志以截断方式重新打开，不先挪走的话，
 * 手动重跑一次镜头就抹掉了上一次的全部现场。
 */
export function archiveAttempt(s: Scene, keepOutput = false): string {
  const output = outputPath(s);
  const present = [output, streamLog(s), stderrLog(s), userLog(s), attemptLog(s)].filter(lexists);
  if (present.length === 0) return '';
  const attemptsRoot = path.join(s.directory, 'attempts');
  try {
    fs.mkdirSync(attemptsRoot, { recursive: true });
  } catch {
    // 与 Go 一样忽略：下面的改名会各自失败。
  }
  let entries = 0;
  try {
    entries = fs.readdirSync(attemptsRoot).length;
  } catch {
    // 读不了按 0 计。
  }
  let number = entries + 1;
  const name = (n: number) => path.join(attemptsRoot, `attempt-${String(n).padStart(2, '0')}`);
  let destination = name(number);
  while (lexists(destination)) {
    number++;
    destination = name(number);
  }
  try {
    fs.mkdirSync(destination, { recursive: true });
  } catch {
    // 忽略，同上。
  }
  for (const file of present) {
    try {
      const target = path.join(destination, path.basename(file));
      if (keepOutput && file === output) fs.copyFileSync(file, target);
      else fs.renameSync(file, target);
    } catch {
      // 忽略单个文件的失败。
    }
  }
  return destination;
}

/** Go 的 path.Match 里的 `attempt-*`：* 匹配任意不含分隔符的串。 */
function attemptDirs(dir: string): string[] {
  const root = path.join(dir, 'attempts');
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((name) => name.startsWith('attempt-')).sort(compareBytes);
}

/**
 * 读出镜头目录里全部尝试记录：attempts/attempt-NN/ 下归档的，
 * 加上当前这一份，按开始时间排序。读不了的跳过。
 *
 * 用量统计以它为准：重渲染前上一次的记录会被挪进 attempts/，不读归档的话，
 * 失败重试烧掉的 token 就从账上消失了。
 */
export function attemptHistory(dir: string, id: string): Attempt[] {
  const file = 'render-' + id + '.attempt.json';
  const paths = attemptDirs(dir)
    .map((name) => path.join(dir, 'attempts', name, file))
    .filter(lexists);
  paths.push(path.join(dir, file));
  const out: Attempt[] = [];
  for (const p of paths) {
    let body: Buffer;
    try {
      body = fs.readFileSync(p);
    } catch {
      continue;
    }
    try {
      const attempt = parseAttempt(body);
      if (attempt.outcome !== '') out.push(attempt);
    } catch {
      // 不是合法记录就跳过。
    }
  }
  out.sort((a, b) => compareBytes(a.started_at, b.started_at));
  return out;
}
