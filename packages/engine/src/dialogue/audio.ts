import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { find } from '../toolpath';
import { atomicWrite } from '../fsutil';
import { formatFixed, goTrimSpace } from '../gofmt';
import type { Toolchain } from '../mediaprobe';
import { windowsCommand } from '../procgroup/windows';

// 全部片段统一到这一种格式后再 -c copy 拼接，样本级精确。
// 格式不一致时 concat demuxer 会产出时长不可预期的结果，那正是漂移断言想拦的东西。
const sampleRate = 48000;
const channels = 1;
const codec = 'pcm_s16le';

/** trimSeconds 把秒数格式化成 ffmpeg 参数用的字符串，保留三位小数（毫秒精度）。 */
export function trimSeconds(seconds: number): string {
  return formatFixed(seconds, 3);
}

export function firstLine(value: string): string {
  const index = value.indexOf('\n');
  if (index >= 0) return goTrimSpace(value.slice(0, index));
  return goTrimSpace(value);
}

/** CombinedOutput；返回 Go 的 err.Error() 文案（成功为 null）与合并输出。 */
function combinedOutput(command: string, args: string[], env: Record<string, string>, signal?: AbortSignal): Promise<{ error: string | null; output: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ error: 'context canceled', output: '' });
      return;
    }
    const launch = process.platform === 'win32' ? windowsCommand(command, args, env) : {file:command,args,env:{}};
    const child = spawn(launch.file, launch.args, { env: process.platform === 'win32' ? {...env,...launch.env} : env, windowsHide: process.platform === 'win32' ? true : undefined, windowsVerbatimArguments: 'verbatim' in launch ? launch.verbatim : undefined, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    child.stderr?.on('data', (c: Buffer) => chunks.push(c));
    let settled = false;
    const settle = (error: string | null) => {
      if (!settled) {
        settled = true;
        resolve({ error, output: Buffer.concat(chunks).toString('utf8') });
      }
    };
    child.on('error', (e) => {
      if (child.pid === undefined && (e as NodeJS.ErrnoException).code !== 'ABORT_ERR') settle(`fork/exec ${command}: ${e.message}`);
    });
    child.on('close', (status, sig) => {
      if (sig) settle(`signal: ${sig === 'SIGKILL' ? 'killed' : sig}`);
      else settle(status === 0 ? null : `exit status ${status}`);
    });
  });
}

/**
 * Runner 是音频装配用的 ffmpeg 执行器。
 *
 * 不复用 concat 包：那个包是视频母版专用的，Normalize 写死 -an 会丢音轨，
 * Concat 带 -movflags +faststart 是 MP4 私有选项，wav muxer 上 ffmpeg 直接报错。
 * 这里沿用它的两条做法——先统一格式再 -c copy、用 concat demuxer 而不是 filter。
 */
export class Runner {
  constructor(
    readonly toolchain: Toolchain,
    readonly ffmpeg: string,
    readonly env: Record<string, string>,
  ) {}

  private async run(what: string, args: string[], signal?: AbortSignal): Promise<void> {
    const { error, output } = await combinedOutput(this.ffmpeg, args, this.env, signal);
    if (error) throw new Error(`${what}失败：${error}（${firstLine(output)}）`);
  }

  /** normalize 把一段 TTS 音频转成统一格式，保留原文件。 */
  async normalize(source: string, dest: string, signal?: AbortSignal): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
    await this.run(
      '规范化 ' + path.basename(source),
      ['-v', 'error', '-y', '-i', source, '-vn', '-ar', String(sampleRate), '-ac', String(channels), '-c:a', codec, dest],
      signal,
    );
  }

  /** silence 生成一段精确毫秒数的静音，格式与 normalize 一致。 */
  async silence(dest: string, ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) throw new Error(`静音时长必须为正，收到 ${ms} ms`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
    const source = `anullsrc=r=${sampleRate}:cl=mono`;
    await this.run('生成静音', ['-v', 'error', '-y', '-f', 'lavfi', '-i', source, '-t', trimSeconds(ms / 1000), '-c:a', codec, dest], signal);
  }

  /**
   * concat 按顺序拼接已规范化的片段，全程 -c copy。
   *
   * 契约：全部输入必须已经是 normalize/silence 产出的统一格式——48000Hz、单
   * 声道、pcm_s16le。concat 自己不转码，格式不一致时 concat demuxer 不会报
   * 错，只会静默产出时长不可预期的结果，那正是漂移断言要拦的东西。所以
   * concat 在拼接前会对每个输入探测一次格式，不满足直接报错并点名具体文件。
   */
  async concat(paths: string[], dest: string, signal?: AbortSignal): Promise<void> {
    if (paths.length === 0) throw new Error('没有可拼接的音频片段');
    for (const p of paths) this.checkFormat(p);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
    // 进程内唯一的清单文件名：固定文件名在同一目录并发跑多个 concat 时会互相覆盖对方还没读完的清单。
    const listPath = path.join(path.dirname(dest), `.onset-dialogue-list-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}.txt`);
    try {
      let list = '';
      for (const p of paths) {
        // concat demuxer 的清单里单引号要转义成 '\''，否则路径含单引号会截断。
        list += "file '" + path.resolve(p).split("'").join("'\\''") + "'\n";
      }
      atomicWrite(listPath, list, 0o644);
      await this.run('拼接音频', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', dest], signal);
    } finally {
      fs.rmSync(listPath, { force: true });
    }
  }

  /** checkFormat 校验 p 是否符合 normalize/silence 产出的统一格式。 */
  checkFormat(p: string): void {
    const media = this.toolchain.probe(p);
    if (!media.audio) throw new Error(`${p} 没有音轨，无法参与拼接`);
    if (media.audio.sample_rate !== sampleRate) {
      throw new Error(`${p} 采样率是 ${media.audio.sample_rate}Hz，拼接要求 ${sampleRate}Hz：请先用 Normalize 统一格式`);
    }
    if (media.audio.channels !== channels) throw new Error(`${p} 声道数是 ${media.audio.channels}，拼接要求 ${channels}：请先用 Normalize 统一格式`);
    if (media.audio.codec.toLowerCase() !== codec) throw new Error(`${p} 音频编码是 ${media.audio.codec}，拼接要求 ${codec}：请先用 Normalize 统一格式`);
  }
}

/** newRunner 解析 ffmpeg 并返回可用的执行器。 */
export function newRunner(env: Record<string, string>, toolchain: Toolchain): Runner {
  return new Runner(toolchain, find('ffmpeg', env), env);
}
