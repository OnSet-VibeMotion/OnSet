/**
 * 本机 ACE-Step 1.5（acestep.cpp + GGUF）：零 Python 依赖的 GGML 音乐生成与换词翻唱运行时。
 *
 * 与 Breeze TTS 2 的集成方式同构：
 * - 前置资源由 `onset setup --only song`（客户端工具准备页「本机歌曲生成」卡片）统一准备；
 * - 推理引擎钉死 ServeurpersoCom/acestep.cpp（MIT）固定提交，只编译 ace-lm 与 ace-synth 两个 CLI
 *   （macOS 自动启用 Metal + Accelerate BLAS，Windows 启用 CUDA / Vulkan / CPU）；
 * - 模型权重用 toolinstall.ensureModel 下载 Serveurperso/ACE-Step-1.5-GGUF（Apache 2.0）Q8_0 均衡套装
 *   （Qwen3-Embedding-0.6B + 1.7B LM + Turbo DiT + BF16 VAE，约 5.6 GB），逐文件核对 SHA-256；
 * - 运行时按需单次调用 CLI（text2music 走 ace-lm → ace-synth；cover / cover-nofsq 跳过 ace-lm，
 *   直接由 ace-synth 读取 --src-audio 与可选 --ref-audio 按新歌词翻唱），不常驻服务、不占端口。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, lookPath } from '../envutil';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { lockFile } from '../hyperframes/cli';
import type { Progress, Writer } from '../hyperframes/progress';
import { errorText, runCommand } from '../hyperframes/util';
import { missing } from '../prereq';
import { abortReason } from '../procgroup';
import { ensureModel, mirrored, modelDir, modelReady, type ModelSpec } from '../toolinstall';
import { runProcess } from './proc';
import type { Config } from './types';

/** 覆盖本机 acestep.cpp 二进制目录（测试、自带编译产物或自定义安装用）。 */
export const AcestepBinDirEnv = 'ONSET_ACESTEP_BIN_DIR';

/** 覆盖本机 ACE-Step 1.5 GGUF 模型目录（复用已有模型或测试用）。 */
export const AcestepModelsDirEnv = 'ONSET_ACESTEP_MODELS_DIR';

/** 覆盖 acestep.cpp 源码仓地址（离线镜像或测试用）。 */
export const AcestepSourceEnv = 'ONSET_ACESTEP_SOURCE';

export const AcestepCppRepo = 'https://github.com/ServeurpersoCom/acestep.cpp.git';
export const AcestepCppCommit = '973517be024ff8b6bbd50e0adc9e308ab2ed71b3';
export const AcestepCppVersion = '1.5-gguf-' + AcestepCppCommit.slice(0, 7);

export const DefaultLocalTextEncoderModel = 'Qwen3-Embedding-0.6B-Q8_0.gguf';
export const DefaultLocalLMModel = 'acestep-5Hz-lm-1.7B-Q8_0.gguf';
export const DefaultLocalSynthModel = 'acestep-v15-turbo-Q8_0.gguf';
export const DefaultLocalVAEModel = 'vae-BF16.gguf';

const binMarker = '.onset-acestep-cpp';

/**
 * ACE-Step 1.5 GGUF Q8_0 均衡套装（约 5.64 GB，16GB/24GB Apple Silicon 与 8GB+ 显卡均可流畅运行）。
 * 摘要取自 Hugging Face Serveurperso/ACE-Step-1.5-GGUF（2026-11）；魔搭暂无同名仓库，显式走 Hugging Face
 * （可设 ONSET_HF_ENDPOINT 走国内镜像，或设 --proxy）。
 */
export const AceStepGGUFModel: ModelSpec = {
  repo: 'Serveurperso/ACE-Step-1.5-GGUF',
  sources: ['huggingface'],
  files: [
    { path: 'LICENSE', sha256: '05a6bce42a62636d2cfb24139cc008b6b899754e244175814bb5dd2f4a485357', size: 1064 },
    { path: 'Qwen3-Embedding-0.6B-Q8_0.gguf', sha256: '972f23255e46adfe744a0eb9a0039f3c63988f65753b0968d776e8b27168c321', size: 784144960 },
    { path: 'acestep-5Hz-lm-1.7B-Q8_0.gguf', sha256: '726f99a82f050b32ebc5c5e36acaa9d7acd06bfe5e579a62b00e0d0d6d0b7ec6', size: 1975837568 },
    { path: 'acestep-v15-turbo-Q8_0.gguf', sha256: '288f708a61cfc241013a98a62f98ba331f83fe34d0d3559acdd9b0f6a2f7cd6b', size: 2549528000 },
    { path: 'vae-BF16.gguf', sha256: '0599862ac5d15cd308e1d2e368373aea6c02e25ebd1737ad4a4562a0901b0ef8', size: 337420928 },
  ],
};

function exeName(base: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? base + '.exe' : base;
}

/** 本机 acestep.cpp 二进制目录。 */
export function localAcestepBinDir(env: Record<string, string | undefined>): string {
  const custom = (env[AcestepBinDirEnv] ?? '').trim();
  if (custom !== '') return custom;
  const root = dataDir(env);
  if (root === '') return '';
  return path.join(root, 'tools', 'acestep-cpp', AcestepCppCommit.slice(0, 12));
}

/** 本机 ACE-Step 1.5 GGUF 模型目录。 */
export function localAcestepModelsDir(env: Record<string, string | undefined>): string {
  const custom = (env[AcestepModelsDirEnv] ?? '').trim();
  if (custom !== '') return custom;
  return modelDir(AceStepGGUFModel, env);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** ace-lm 与 ace-synth 二进制是否已就绪。 */
export function localAcestepBinariesReady(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): boolean {
  const dir = localAcestepBinDir(env);
  if (dir === '') return false;
  const lm = path.join(dir, exeName('ace-lm', platform));
  const synth = path.join(dir, exeName('ace-synth', platform));
  if (!isFile(lm) || !isFile(synth)) return false;
  // 用户通过环境变量指向自备目录时，只要两个二进制在即可；托管目录则须有构建完成标记。
  if ((env[AcestepBinDirEnv] ?? '').trim() !== '') return true;
  try {
    return fs.readFileSync(path.join(dir, binMarker), 'utf8').trim() === AcestepCppCommit;
  } catch {
    return false;
  }
}

/** 按生成模式与所选模型计算必需的 GGUF 权重文件清单。 */
export function requiredLocalModelFiles(cfg?: Pick<Config, 'model' | 'lm_model' | 'task_type'>): string[] {
  const files = [
    resolveLocalSynthModel(cfg?.model ?? ''),
    DefaultLocalTextEncoderModel,
    DefaultLocalVAEModel,
  ];
  if (!isCoverTask(cfg?.task_type ?? '')) {
    files.push(resolveLocalLMModel(cfg?.lm_model ?? ''));
  }
  return files;
}

/** 找出指定模型目录里缺失的必需 GGUF 文件。 */
export function missingLocalModelFiles(modelsDir: string, cfg?: Pick<Config, 'model' | 'lm_model' | 'task_type'>): string[] {
  if (modelsDir === '') return requiredLocalModelFiles(cfg);
  return requiredLocalModelFiles(cfg).filter((file) => !isFile(path.join(modelsDir, file)));
}

/** GGUF 模型是否已就绪。 */
export function localAcestepModelsReady(env: Record<string, string | undefined>, cfg?: Pick<Config, 'model' | 'lm_model' | 'task_type'>): boolean {
  const custom = (env[AcestepModelsDirEnv] ?? '').trim();
  if (custom !== '') {
    return missingLocalModelFiles(custom, cfg).length === 0;
  }
  if (!cfg) return modelReady(AceStepGGUFModel, env);
  return missingLocalModelFiles(modelDir(AceStepGGUFModel, env), cfg).length === 0;
}

export interface LocalAcestepStatus {
  ok: boolean;
  where: string;
  binDir: string;
  modelsDir: string;
  binariesReady: boolean;
  modelsReady: boolean;
}

/** 不联网检查本机 ACE-Step 1.5 的就绪状态。 */
export function localAcestepStatus(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  cfg?: Pick<Config, 'model' | 'lm_model' | 'task_type'>,
): LocalAcestepStatus {
  const binDir = localAcestepBinDir(env);
  const modelsDir = localAcestepModelsDir(env);
  const binariesReady = localAcestepBinariesReady(env, platform);
  const modelsReady = localAcestepModelsReady(env, cfg);
  const ok = binariesReady && modelsReady;
  const where = !binariesReady ? binDir : !modelsReady ? modelsDir : binDir;
  return { ok, where, binDir, modelsDir, binariesReady, modelsReady };
}

export interface LocalAcestepRuntime {
  aceLm: string;
  aceSynth: string;
  modelsDir: string;
}

/** 返回已就绪的本机二进制与模型路径；缺任意一项抛 prereq.MissingError，不联网。 */
export function requireLocalAcestep(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  cfg?: Pick<Config, 'model' | 'lm_model' | 'task_type'>,
): LocalAcestepRuntime {
  const status = localAcestepStatus(env, platform, cfg);
  const what = '本机歌曲生成 ACE-Step 1.5（acestep.cpp + GGUF）';
  if (!status.binariesReady) {
    if (status.binDir === '') throw missing(what, `环境里没有 HOME，也没有 ${AcestepBinDirEnv}`);
    throw missing(what, `缺少推理程序（ace-lm / ace-synth）：${status.binDir}`);
  }
  if (!status.modelsReady) {
    if (status.modelsDir === '') throw missing(what, `环境里没有 HOME，也没有 ${AcestepModelsDirEnv}`);
    const lacking = missingLocalModelFiles(status.modelsDir, cfg);
    const detail = lacking.length > 0 ? `（缺少：${lacking.join('、')}）` : '';
    throw missing(what, `缺少 GGUF 模型权重：${status.modelsDir}${detail}`);
  }
  return {
    aceLm: path.join(status.binDir, exeName('ace-lm', platform)),
    aceSynth: path.join(status.binDir, exeName('ace-synth', platform)),
    modelsDir: status.modelsDir,
  };
}

export interface LocalAcestepInstallOptions {
  /** 常规环境（PATH、HOME 等）。 */
  env: Record<string, string>;
  /** git 拉取源码与子模块用的环境（带 git 代理配置）。 */
  gitEnv?: Record<string, string>;
  /** 下载模型权重用的环境（带 --proxy 代理）。 */
  downloadEnv?: Record<string, string>;
  output?: Writer;
  progress?: (p: Progress) => void;
  signal?: AbortSignal;
}

/**
 * 构建钉死版本的 acestep.cpp（仅 ace-lm 与 ace-synth 目标），原子安装到托管目录。
 * 只由 onset setup / 客户端工具准备页调用。
 */
export async function ensureLocalAcestepBinaries(opts: LocalAcestepInstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const sink: Writer = opts.output ?? { write: () => true };
  const dir = localAcestepBinDir(opts.env);
  if (dir === '') throw new Error(`无法确定本机 ACE-Step 目录：环境里没有 HOME，可用 ${AcestepBinDirEnv} 指定`);
  if (localAcestepBinariesReady(opts.env)) {
    report({ stage: 'acestep.cpp 已就绪', percent: 100 });
    return dir;
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const unlock = await lockFile(dir + '.lock', opts.signal);
  try {
    if (localAcestepBinariesReady(opts.env)) return dir;
    const pathValue = opts.env.PATH ?? '';
    let git: string;
    let cmake: string;
    try {
      git = lookPath('git', pathValue);
    } catch {
      throw new Error('构建本机 ACE-Step 需要 git；请先安装 git（macOS 可运行 xcode-select --install）或通过 ONSET_ACESTEP_BIN_DIR 指定已编译目录');
    }
    try {
      cmake = lookPath('cmake', pathValue);
    } catch {
      const hint = process.platform === 'darwin' ? '可运行 brew install cmake' : '请安装 CMake 与 C++ 编译工具链';
      throw new Error(`构建本机 ACE-Step 需要 cmake（${hint}），或通过 ${AcestepBinDirEnv} 指定已编译目录`);
    }

    const work = fs.mkdtempSync(path.join(path.dirname(dir), '.acestep-build-'));
    try {
      const src = path.join(work, 'src');
      const build = path.join(work, 'build');
      const gitEnv = opts.gitEnv ?? opts.env;
      const repoURL = (opts.env[AcestepSourceEnv] ?? '').trim() || mirrored(AcestepCppRepo, opts.env);
      report({ stage: '拉取 acestep.cpp 源码', percent: 5 });
      await runCommand(git, ['clone', '--filter=blob:none', '--no-checkout', repoURL, src], { env: gitEnv, stdout: sink, stderr: sink, signal: opts.signal });
      await runCommand(git, ['-C', src, 'checkout', AcestepCppCommit], { env: gitEnv, stdout: sink, stderr: sink, signal: opts.signal });
      report({ stage: '拉取 GGML 子模块', percent: 15 });
      await runCommand(git, ['-C', src, 'submodule', 'update', '--init', '--recursive', '--depth', '1'], { env: gitEnv, stdout: sink, stderr: sink, signal: opts.signal });

      report({ stage: '配置 CMake（Metal / 原生加速）', percent: 25 });
      const cmakeArgs = ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release'];
      if (process.platform === 'win32') cmakeArgs.push('-DGGML_CPU_ALL_VARIANTS=ON', '-DGGML_BACKEND_DL=ON');
      await runCommand(cmake, cmakeArgs, { env: opts.env, stdout: sink, stderr: sink, signal: opts.signal });

      const jobs = String(Math.max(1, os.cpus().length));
      report({ stage: '编译 ace-lm 与 ace-synth', percent: 35 });
      await runCommand(cmake, ['--build', build, '--config', 'Release', '--target', 'ace-lm', 'ace-synth', '-j', jobs], {
        env: opts.env,
        stdout: sink,
        stderr: sink,
        signal: opts.signal,
      });

      const outDir = process.platform === 'win32' && fs.existsSync(path.join(build, 'Release')) ? path.join(build, 'Release') : build;
      const lmBuilt = path.join(outDir, exeName('ace-lm'));
      const synthBuilt = path.join(outDir, exeName('ace-synth'));
      if (!isFile(lmBuilt) || !isFile(synthBuilt)) {
        throw new Error('acestep.cpp 编译完成但找不到 ace-lm 或 ace-synth');
      }

      const staging = fs.mkdtempSync(path.join(path.dirname(dir), '.acestep-stage-'));
      try {
        for (const name of [exeName('ace-lm'), exeName('ace-synth')]) {
          const from = path.join(outDir, name);
          const to = path.join(staging, name);
          fs.copyFileSync(from, to);
          if (process.platform !== 'win32') fs.chmodSync(to, 0o755);
          if (process.platform === 'darwin') {
            try {
              await runCommand('install_name_tool', ['-add_rpath', '@executable_path', to], { env: opts.env, stdout: sink, stderr: sink, signal: opts.signal });
            } catch {
              // rpath 已存在时忽略。
            }
          }
        }
        // 复制同目录的 GGML 动态库（macOS .dylib / Linux .so / Windows .dll）。
        for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
          const name = entry.name;
          const isLib =
            (process.platform === 'darwin' && name.endsWith('.dylib')) ||
            (process.platform === 'win32' && name.toLowerCase().endsWith('.dll')) ||
            (process.platform === 'linux' && (name.endsWith('.so') || name.includes('.so.')));
          if (!isLib) continue;
          const from = path.join(outDir, name);
          const to = path.join(staging, name);
          const stat = fs.lstatSync(from);
          if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
          else if (stat.isFile()) fs.copyFileSync(from, to);
        }
        // 轻量烟雾自检：确认二进制可启动（不加载模型）。
        report({ stage: '校验 ace-lm 与 ace-synth', percent: 90 });
        for (const bin of [exeName('ace-lm'), exeName('ace-synth')]) {
          let stderr = '';
          await runProcess(path.join(staging, bin), [], opts.env, { stderr: (c) => (stderr += c.toString('utf8')) }, opts.signal);
          if (!stderr.includes('Usage:') && !stderr.includes('acestep.cpp')) {
            throw new Error(`${bin} 启动自检异常`);
          }
        }
        fs.writeFileSync(path.join(staging, binMarker), AcestepCppCommit + '\n', { mode: 0o644 });
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(staging, dir);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
      report({ stage: 'acestep.cpp 已就绪', percent: 100 });
      return dir;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      if (opts.signal?.aborted) throw abortReason(opts.signal);
    }
  } finally {
    unlock();
  }
}

/** 准备本机 ACE-Step 1.5 的推理程序与 GGUF 权重。 */
export async function ensureLocalAcestep(opts: LocalAcestepInstallOptions): Promise<LocalAcestepRuntime> {
  const report = opts.progress ?? (() => {});
  await ensureLocalAcestepBinaries({
    ...opts,
    progress: (p) => report({ ...p, percent: Math.round(p.percent * 0.25) }),
  });
  const targetDir = localAcestepModelsDir(opts.env);
  const modelsDir = await ensureModel(AceStepGGUFModel, {
    env: opts.downloadEnv ?? opts.env,
    targetDir,
    output: opts.output,
    progress: (p) => report({ ...p, percent: 25 + Math.round(p.percent * 0.75) }),
    signal: opts.signal,
  });
  return {
    aceLm: path.join(localAcestepBinDir(opts.env), exeName('ace-lm')),
    aceSynth: path.join(localAcestepBinDir(opts.env), exeName('ace-synth')),
    modelsDir,
  };
}

/** 将 song.yaml 的 model 简写或完整 GGUF 文件名归一化为 acestep.cpp 的 synth_model 名称。 */
export function resolveLocalSynthModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed === '' || trimmed === 'acestep-v15-turbo') return DefaultLocalSynthModel;
  if (trimmed.endsWith('.gguf')) return trimmed;
  return `${trimmed}-Q8_0.gguf`;
}

/** 将 song.yaml 的 lm_model 归一化为 acestep.cpp 的 lm_model 名称。 */
export function resolveLocalLMModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed === '') return DefaultLocalLMModel;
  if (trimmed.endsWith('.gguf')) return trimmed;
  return `${trimmed}-Q8_0.gguf`;
}

/** 是否为翻唱（cover / cover-nofsq）模式。 */
export function isCoverTask(taskType: string): boolean {
  return taskType === 'cover' || taskType === 'cover-nofsq';
}

/** 构造传给 ace-lm / ace-synth 的 AceRequest JSON。 */
export function buildLocalRequest(c: Config, lyrics: string): Record<string, unknown> {
  const taskType = c.task_type || 'text2music';
  const base: Record<string, unknown> = {
    caption: c.style,
    lyrics,
    bpm: c.bpm,
    vocal_language: c.language,
    task_type: taskType,
    synth_batch_size: 1,
    output_format: 'mp3',
    mp3_bitrate: 192,
    synth_model: resolveLocalSynthModel(c.model),
    vae: DefaultLocalVAEModel,
  };
  if (isCoverTask(taskType)) {
    // 翻唱模式：由原曲音频决定时长，跳过 LM，audio_cover_strength 控制贴合原曲的步数比例。
    base.audio_cover_strength = c.cover_strength > 0 ? c.cover_strength : taskType === 'cover-nofsq' ? 0.35 : 0.5;
  } else {
    base.duration = c.target_seconds;
    base.lm_mode = 'generate';
    base.lm_batch_size = 1;
    base.lm_model = resolveLocalLMModel(c.lm_model);
    base.use_cot_caption = false;
  }
  return base;
}

export interface LocalGenerateOptions {
  config: Config;
  lyrics: string;
  /** 项目内已校验的原曲音频绝对路径（cover / cover-nofsq 必填）。 */
  sourceAudio?: string;
  /** 项目内已校验的音色参考音频绝对路径（可选）。 */
  referenceAudio?: string;
  /** 目标 MP3 路径。 */
  dest: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * 调用本机 ace-lm / ace-synth 生成或翻唱一首歌曲，并将结果 MP3 原子写入 dest。
 * - text2music: ace-lm (request.json -> request0.json) -> ace-synth (request0.json -> request00.mp3)
 * - cover / cover-nofsq: 跳过 ace-lm，直接 ace-synth --src-audio [--ref-audio] (request.json -> request0.mp3)
 */
export async function generateLocalAcestep(opts: LocalGenerateOptions): Promise<void> {
  const runtime = requireLocalAcestep(opts.env, process.platform, opts.config);
  const taskType = opts.config.task_type || 'text2music';
  const cover = isCoverTask(taskType);
  if (cover && !opts.sourceAudio) {
    throw new Error(`翻唱模式（${taskType}）必须提供 source_audio 原曲文件`);
  }
  for (const [label, audio] of [
    ['source_audio', opts.sourceAudio],
    ['reference_audio', opts.referenceAudio],
  ] as const) {
    if (!audio) continue;
    const ext = path.extname(audio).toLowerCase();
    if (ext !== '.wav' && ext !== '.mp3') {
      throw new Error(`本机 ACE-Step 的 ${label} 仅支持 WAV 或 MP3 音频（收到 ${ext || '无扩展名'}）`);
    }
    if (!isFile(audio)) throw new Error(`找不到 ${label} 音频文件：${audio}`);
  }

  fs.mkdirSync(path.dirname(opts.dest), { recursive: true, mode: 0o755 });
  const work = fs.mkdtempSync(path.join(path.dirname(opts.dest), '.acestep-work-'));
  try {
    const reqFile = path.join(work, 'request.json');
    const payload = buildLocalRequest(opts.config, opts.lyrics);
    atomicWrite(reqFile, marshalIndent(payload) + '\n', 0o644);

    let synthInput = reqFile;
    let expectedOut = path.join(work, 'request0.mp3');

    if (!cover) {
      let lmErr = '';
      const lmRes = await runProcess(
        runtime.aceLm,
        ['--models', runtime.modelsDir, '--request', reqFile],
        opts.env,
        { stderr: (c) => (lmErr = (lmErr + c.toString('utf8')).slice(-4000)) },
        opts.signal,
      );
      if (lmRes.error) {
        const tail = lmErr.trim().split('\n').slice(-4).join(' | ');
        throw new Error(`本机 ACE-Step LM 阶段失败（${lmRes.error}）${tail ? '：' + tail : ''}`);
      }
      synthInput = path.join(work, 'request0.json');
      expectedOut = path.join(work, 'request00.mp3');
      if (!isFile(synthInput)) throw new Error('本机 ACE-Step LM 未产出 request0.json');
    }

    const synthArgs = ['--models', runtime.modelsDir, '--request', synthInput];
    if (opts.sourceAudio) synthArgs.push('--src-audio', opts.sourceAudio);
    // cover-nofsq 未单设 reference_audio 时，按上游最佳实践将 ref-audio 同指向 src-audio 以保真旋律与音色。
    const refAudio = opts.referenceAudio || (taskType === 'cover-nofsq' ? opts.sourceAudio : undefined);
    if (refAudio) synthArgs.push('--ref-audio', refAudio);

    let synthErr = '';
    const synthRes = await runProcess(
      runtime.aceSynth,
      synthArgs,
      opts.env,
      { stderr: (c) => (synthErr = (synthErr + c.toString('utf8')).slice(-4000)) },
      opts.signal,
    );
    if (synthRes.error) {
      const tail = synthErr.trim().split('\n').slice(-4).join(' | ');
      throw new Error(`本机 ACE-Step 音频合成阶段失败（${synthRes.error}）${tail ? '：' + tail : ''}`);
    }
    if (!isFile(expectedOut) || fs.statSync(expectedOut).size === 0) {
      throw new Error('本机 ACE-Step 未生成有效音频文件');
    }
    fs.renameSync(expectedOut, opts.dest);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function formatLocalError(err: unknown): string {
  return errorText(err);
}
