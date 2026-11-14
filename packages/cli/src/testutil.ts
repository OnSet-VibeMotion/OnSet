// 本包测试共用的辅助，对应 internal/cli 测试里的包级辅助（main_test.go 的 TestMain、cast_test.go 的 runCLI、
// media_test.go 的 requireFFmpeg / makeClip 等）。不参与打包（只被 *.test.ts 导入）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, onTestFinished } from 'vitest';
import * as hyperframes from '@onset/engine/hyperframes';
import { fakeBrowser, fakeCLI } from '@onset/engine/hyperframes/hftest';
import { execute } from './cli';
import type { Out } from './cobra';

// main_test.go 的 TestMain：把记忆库指到临时目录（渲染记忆默认打开，没设 ONSET_MEMORY_DIR 的测试
// 会把经历与快照写进开发者真实的 ~/.local/share/onset/memory）；渲染前会确保 onset 管理的
// HyperFrames CLI 已装好，测试里换成假的，免得真的去 npm install。导入本文件即生效。
const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-memory-test-'));
process.env.ONSET_MEMORY_DIR = memoryDir;
const fakeCLIDir = path.join(memoryDir, 'hyperframes-cli');
fakeCLI(fakeCLIDir);
process.env.ONSET_BROWSER = fakeBrowser(fakeCLIDir);
// onset setup 下载的工具目录指到空目录：开发机上 ~/.local/share/onset/bin 里真实的 ffmpeg、mmx 不能混进测试。
process.env.ONSET_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-bin-test-'));
process.env[hyperframes.CLIDirEnv] = fakeCLIDir;
// 音色库同理：用户积累的声音不能被测试写进或删掉。
process.env.ONSET_VOICES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-voices-test-'));

// 每个用例结束后恢复工作目录与环境变量（Go 的 t.Chdir / t.Setenv）。
const startDir = process.cwd();
const startEnv = { ...process.env };
afterEach(() => {
  process.chdir(startDir);
  for (const key of Object.keys(process.env)) if (!(key in startEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(startEnv)) process.env[key] = value;
});

/** t.TempDir()：测试结束时删掉。返回真实路径（macOS 的 /var 是 /private/var 的链接）。 */
export function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-cli-')));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 收集写入的文字，对应 bytes.Buffer。 */
export class Buffer implements Out {
  text = '';
  write(text: string): void {
    this.text += text;
  }
  toString(): string {
    return this.text;
  }
}

/** Execute(args, &out, &err)：返回退出码。out 与 err 可以是同一个 Buffer。 */
export async function run(args: string[], out: Out = new Buffer(), err: Out = out, signal?: AbortSignal): Promise<number> {
  return execute(args, out, err, signal);
}

/** 在 dir 下执行（os.Chdir + Execute），stdout 与 stderr 合在一起返回。 */
export async function runIn(dir: string, args: string[]): Promise<{ code: number; out: string }> {
  const old = process.cwd();
  process.chdir(dir);
  try {
    const out = new Buffer();
    const code = await execute(args, out, out);
    return { code, out: out.text };
  } finally {
    process.chdir(old);
  }
}

/** cast_test.go 的 runCLI：非零退出码时抛错，错误消息是「退出码 N：输出」。 */
export async function runCLI(root: string, ...args: string[]): Promise<string> {
  const { code, out } = await runIn(root, args);
  if (code !== 0) throw new Error(`退出码 ${code}：${out}`);
  return out;
}

/** t.Setenv。afterEach 会还原。 */
export function setenv(key: string, value: string): void {
  process.env[key] = value;
}

/** 在 PATH 里找命令。 */
export function lookPath(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续找
    }
  }
  return '';
}

export const hasFfmpeg = lookPath('ffmpeg') !== '' && lookPath('ffprobe') !== '';

/** media_test.go 的 makeClip：ffmpeg -f lavfi 合成一段素材。 */
export function makeClip(file: string, filter: string, ...extra: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', filter, ...extra, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file];
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`生成素材失败：${result.stderr}`);
}

/** cli_test.go 的 initProject：铺一个真实项目供校验类用例使用。 */
export async function initProject(): Promise<string> {
  const root = path.join(tempDir(), 'video');
  const out = new Buffer();
  const code = await execute(['init', root, '--canvas', 'vertical-3x4', '--skip-hyperframes'], out, out);
  if (code !== 0) throw new Error(`init code=${code} output=${out.text}`);
  return root;
}

/** 写可执行脚本。 */
export function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

/** 按 ffmpeg 滤镜里的 size= 给镜头目录写一份 frame.md（画幅只从 frame.md 取）。 */
export function writeFrameFor(dir: string, filter: string): void {
  const m = /size=(\d+)x(\d+)/.exec(filter);
  const [w, h] = m ? [m[1], m[2]] : ['1080', '1440'];
  fs.writeFileSync(path.join(dir, 'frame.md'), `---\ncanvas:\n  width_px: ${w}\n  height_px: ${h}\n  fps: 30\n---\n`);
}

/** media_test.go 的 makeSceneDir：建一个可被 scene.load 读取的镜头目录，产物用 ffmpeg 合成。 */
export function makeSceneDir(root: string, id: string, duration: number, filter: string): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  const body = `{"id":"${id}","duration_seconds":${String(duration)},"output":"out.mp4","transcript":"transcript.srt","text":"hello"}`;
  fs.writeFileSync(path.join(dir, 'scene.json'), body);
  writeFrameFor(dir, filter);
  makeClip(path.join(dir, 'out.mp4'), filter);
  return dir;
}

/** review_test.go 的 makeFilm：拼出带音轨的成片，视频 videoSeconds 秒，音频 audioSeconds 秒。 */
export function makeFilm(file: string, videoSeconds: string, audioSeconds: string): void {
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=' + videoSeconds];
  args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=' + audioSeconds);
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file);
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`生成成片失败：${result.stderr}`);
}
