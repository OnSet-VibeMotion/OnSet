import fs from 'node:fs';
import path from 'node:path';
import { dataDir, windowsPython } from '../envutil';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { start } from '../procgroup';
import { nodeCommand } from '../toolpath';
import { lockFile } from '../hyperframes/cli';
import type { InstallOptions } from '../toolinstall';
import adapter from './breeze-adapter.cjs.tmpl';
import installer from './breeze-install.py.tmpl';

export const BreezeWindowsVersion = '0.9.4';
export const BreezeModelSHA256 = 'b17b89b1c21107c44e8d556ab0a856d7acd06bdd0c914e68e0e57f6e33f555a3';
export const BreezeModelBytes = 5079670336;
const runtimeFiles = ['audiocpp_cli.exe', 'ggml.dll', 'ggml-base.dll', 'ggml-cuda.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll'];

export function windowsResourceRoot(env: Record<string, string | undefined>): string {
  return env.ONSET_WINDOWS_RESOURCES_DIR || (env.ONSET_BIN_DIR ? path.dirname(env.ONSET_BIN_DIR) : dataDir(env));
}

export function windowsBreezePaths(env: Record<string, string | undefined>) {
  const home = windowsResourceRoot(env);
  return { home, bin: path.join(home, 'bin', 'breeze-tts.cmd'), binary: path.join(home, 'tools', 'audio-cpp', 'v' + BreezeWindowsVersion, 'audiocpp_cli.exe'), model: path.join(home, 'models', 'Breeze-TTS-2-GGUF', 'breeze-tts-2-q8_0.gguf'), marker: path.join(home, 'tools', 'breeze', 'install.json') };
}

/** 只有校验过文件、完成真实合成自检后才就绪；下拉框选择与空包装脚本都不构成安装。 */
export function windowsBreezeStatus(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): { ok: boolean; where: string } {
  const paths = windowsBreezePaths(env);
  if (platform !== 'win32' || !paths.home) return { ok: false, where: paths.home };
  try {
    const marker = JSON.parse(fs.readFileSync(paths.marker, 'utf8'));
    const model = fs.statSync(paths.model);
    if (marker.runtime_version !== BreezeWindowsVersion || marker.model_sha256 !== BreezeModelSHA256 || marker.synthesis_verified !== true || marker.backend !== 'cuda' || model.size !== BreezeModelBytes || model.mtimeMs !== marker.model_mtime_ms) return { ok: false, where: paths.model };
    for (const file of [paths.bin, paths.binary, path.join(path.dirname(paths.bin), 'breeze-tts.cjs')]) if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) return { ok: false, where: file };
    for (const name of runtimeFiles) {
      const file = path.join(path.dirname(paths.binary), name);
      const stat = fs.statSync(file);
      const recorded = marker.runtime_files?.[name];
      if (!recorded || stat.size !== recorded.size || stat.mtimeMs !== recorded.mtime_ms) return { ok: false, where: file };
    }
    return { ok: true, where: paths.bin };
  } catch { return { ok: false, where: paths.model }; }
}

export function writeWindowsBreezeAdapter(env: Record<string, string | undefined>): string {
  const paths = windowsBreezePaths(env);
  atomicWrite(path.join(path.dirname(paths.bin), 'breeze-tts.cjs'), adapter);
  atomicWrite(paths.bin, '@echo off\r\nnode "%~dp0\\breeze-tts.cjs" %*\r\n');
  return paths.bin;
}

/** 安装公开固定版本的 CUDA 运行时和 Q8 模型，全部位于同一资源目录。 */
export async function ensureWindowsBreeze(opts: InstallOptions): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Windows Breeze installer is only available on Windows');
  const paths = windowsBreezePaths(opts.env);
  if (windowsBreezeStatus(opts.env).ok) return paths.bin;
  fs.mkdirSync(path.dirname(paths.marker), { recursive: true });
  const unlock = await lockFile(paths.marker + '.lock', opts.signal);
  try {
    if (windowsBreezeStatus(opts.env).ok) return paths.bin;
    return await installWindowsBreeze(opts);
  } finally { unlock(); }
}

async function installWindowsBreeze(opts: InstallOptions): Promise<string> {
  const paths = windowsBreezePaths(opts.env);
  const python = windowsPython(opts.env);
  if (!python) throw new Error('请先准备客户端 Python，再安装 Windows Breeze');
  const script = path.join(paths.home, 'tools', 'breeze', 'install.py');
  atomicWrite(script, installer);
  opts.progress?.({ stage: '下载并校验 Windows Breeze CUDA 与 Q8 模型（约 6.2 GB）', percent: 0, indeterminate: true });
  const fetch = await start(python, [script, paths.home], { env: { ...opts.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, signal: opts.signal, stdio: ['ignore', 'pipe', 'pipe'] });
  let pending = '';
  const downloaded = new Map<string, number>();
  fetch.child.stdout!.on('data', data => {
    const text = data.toString('utf8');
    opts.output?.write(text);
    pending += text;
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      try {
        const row = JSON.parse(line);
        if (typeof row.file === 'string' && typeof row.bytes === 'number') {
          downloaded.set(row.file, Math.max(downloaded.get(row.file) ?? 0, row.bytes));
          const bytes = [...downloaded.values()].reduce((sum, value) => sum + value, 0);
          opts.progress?.({ stage: '下载并校验 Windows Breeze CUDA 与 Q8 模型', percent: Math.min(94, Math.trunc(bytes / 6154744430 * 94)), bytes });
        }
      } catch { /* Python 的其他诊断仍完整留在安装日志中。 */ }
    }
  });
  let errorTail = '';
  fetch.child.stderr!.on('data', data => { errorTail = (errorTail + data.toString('utf8')).slice(-4000); });
  try { await fetch.wait(); } catch (error) { throw new Error('Windows Breeze 资源安装失败：' + errorTail, { cause: error }); }
  writeWindowsBreezeAdapter(opts.env);
  opts.progress?.({ stage: '实测 Windows Breeze CUDA 合成', percent: 95 });
  const testOutput = path.join(paths.home, 'tools', 'breeze', 'setup-audition-' + process.pid + '-' + Date.now() + '.wav');
  const command = nodeCommand(path.join(path.dirname(paths.bin), 'breeze-tts.cjs'), ['--text', '你好，这是本机语音合成测试。', '--instruct', '清晰自然的中文旁白。', '--cfg_scale', '4', '--max_tokens', '180', '--output', testOutput]);
  const test = await start(command.file, command.args, { env: { ...opts.env, ...command.env }, signal: opts.signal, stdio: ['ignore', 'pipe', 'pipe'] });
  test.child.stdout!.on('data', data => opts.output?.write(data.toString('utf8')));
  test.child.stderr!.on('data', data => opts.output?.write(data.toString('utf8')));
  await test.wait();
  const wav = fs.readFileSync(testOutput);
  if (wav.subarray(0, 4).toString() !== 'RIFF' || wav.subarray(8, 12).toString() !== 'WAVE' || wav.length < 4800) throw new Error('Breeze 合成自检没有生成有效 WAV');
  const files = Object.fromEntries(runtimeFiles.map(name => { const stat = fs.statSync(path.join(path.dirname(paths.binary), name)); return [name, { size: stat.size, mtime_ms: stat.mtimeMs }]; }));
  atomicWrite(paths.marker, marshalIndent({ runtime_version: BreezeWindowsVersion, model_sha256: BreezeModelSHA256, model_mtime_ms: fs.statSync(paths.model).mtimeMs, runtime_files: files, backend: 'cuda', synthesis_verified: true, verified_at: new Date().toISOString(), audition: testOutput }) + '\n');
  opts.progress?.({ stage: 'Windows Breeze CUDA 已就绪', percent: 100 });
  return paths.bin;
}
