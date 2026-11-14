// 包内共用的小工具：错误文案、Go 的 %q / %v 写法、跑外部命令。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ExitError, abortReason } from '../procgroup';
import type { Writer } from './progress';

/** 错误的文字（对应 %v / %w 的展开）。 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Go 的 %q：带引号、转义的字符串。可打印的非 ASCII 字符原样保留，与 strconv.Quote 一致。 */
export function goQuote(s: string): string {
  return JSON.stringify(s);
}

/** Go 对 []string 的 %v：[a b c]。 */
export function goList(values: string[]): string {
  return '[' + values.join(' ') + ']';
}

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** 标准输出接到这里；不给时收集起来作为返回值（对应 cmd.Output()）。 */
  stdout?: Writer;
  /** 标准错误接到这里；不给时丢弃。 */
  stderr?: Writer;
  signal?: AbortSignal;
}

/**
 * 跑一个外部命令并等它结束，对应 exec.CommandContext(...).Output() / Run()。
 * 返回收集到的标准输出（去掉首尾空白之前的原文）；非零退出抛 procgroup.ExitError
 * （文案与 Go 的 *exec.ExitError 相同：exit status N）；signal 取消时杀掉进程（SIGKILL，
 * 与 CommandContext 相同）并抛取消原因。
 */
export function runCommand(file: string, args: string[], options: CommandOptions = {}): Promise<string> {
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', options.stderr ? 'pipe' : 'ignore'],
    });
    let out = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (options.stdout) options.stdout.write(chunk);
      else out += chunk;
    });
    if (options.stderr) {
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => options.stderr!.write(chunk));
    }
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let failed = false;
    child.once('error', (err) => {
      failed = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (failed) return;
      if (signal?.aborted) reject(abortReason(signal));
      else if (sig) reject(new ExitError(-1, sig));
      else if (code !== 0) reject(new ExitError(code ?? -1, null));
      else resolve(out);
    });
  });
}

/** 一个目录（含子目录）里文件的总字节数；读不了的条目跳过，不跟随符号链接。最多看 maxEntries 个条目。 */
export async function dirSize(dir: string, maxEntries = 200_000): Promise<number> {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0 && seen < maxEntries) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen++;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += (await fs.promises.stat(full)).size;
        } catch {
          // 量的时候被删了（安装器在挪文件）
        }
      }
    }
  }
  return total;
}

/**
 * 每隔一会儿量一次这几个目录合起来有多大，把「比开始时多了多少字节」交给 onBytes；返回停止函数。
 * 给没有可量进度的步骤用（npm install、pip install、浏览器下载）：安装器一声不吭时，
 * 目录在长就说明还在干活，长得多快就是它下得多快。量是异步的，上一次没量完不开下一次。
 */
export function watchSize(dirs: string[], onBytes: (bytes: number) => void, everyMs = 1500): () => void {
  let base: number | null = null;
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      let size = 0;
      for (const dir of dirs) if (dir !== '') size += await dirSize(dir);
      if (stopped) return;
      if (base === null) base = size;
      onBytes(Math.max(0, size - base));
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
