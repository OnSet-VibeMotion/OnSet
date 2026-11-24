import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../envutil';
import { missing } from '../prereq';
import { type ModelSpec, modelDir, modelReady } from '../toolinstall';
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

export const binMarker = '.onset-acestep-cpp';

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
    {
      path: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
      sha256: '972f23255e46adfe744a0eb9a0039f3c63988f65753b0968d776e8b27168c321',
      size: 784144960,
    },
    {
      path: 'acestep-5Hz-lm-1.7B-Q8_0.gguf',
      sha256: '726f99a82f050b32ebc5c5e36acaa9d7acd06bfe5e579a62b00e0d0d6d0b7ec6',
      size: 1975837568,
    },
    {
      path: 'acestep-v15-turbo-Q8_0.gguf',
      sha256: '288f708a61cfc241013a98a62f98ba331f83fe34d0d3559acdd9b0f6a2f7cd6b',
      size: 2549528000,
    },
    {
      path: 'vae-BF16.gguf',
      sha256: '0599862ac5d15cd308e1d2e368373aea6c02e25ebd1737ad4a4562a0901b0ef8',
      size: 337420928,
    },
  ],
};

export function exeName(base: string, platform: NodeJS.Platform = process.platform): string {
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

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** ace-lm 与 ace-synth 二进制是否已就绪。 */
export function localAcestepBinariesReady(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): boolean {
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
  const files = [resolveLocalSynthModel(cfg?.model ?? ''), DefaultLocalTextEncoderModel, DefaultLocalVAEModel];
  if (!isCoverTask(cfg?.task_type ?? '')) {
    files.push(resolveLocalLMModel(cfg?.lm_model ?? ''));
  }
  return files;
}

const managedModelSizes = new Map(AceStepGGUFModel.files.map((f) => [f.path, f.size]));

/** 找出指定模型目录里缺失或残缺的必需 GGUF 文件；托管目录同时核对清单里的精确文件大小。 */
export function missingLocalModelFiles(
  modelsDir: string,
  cfg?: Pick<Config, 'model' | 'lm_model' | 'task_type'>,
  managed = false,
): string[] {
  if (modelsDir === '') return requiredLocalModelFiles(cfg);
  return requiredLocalModelFiles(cfg).filter((file) => {
    const full = path.join(modelsDir, file);
    if (!isFile(full)) return true;
    const expectedSize = managed ? managedModelSizes.get(file) : undefined;
    if (expectedSize !== undefined) {
      try {
        return fs.statSync(full).size !== expectedSize;
      } catch {
        return true;
      }
    }
    return false;
  });
}

/** GGUF 模型是否已就绪。 */
export function localAcestepModelsReady(
  env: Record<string, string | undefined>,
  cfg?: Pick<Config, 'model' | 'lm_model' | 'task_type'>,
): boolean {
  const custom = (env[AcestepModelsDirEnv] ?? '').trim();
  if (custom !== '') {
    return missingLocalModelFiles(custom, cfg, false).length === 0;
  }
  if (!cfg) return modelReady(AceStepGGUFModel, env);
  return missingLocalModelFiles(modelDir(AceStepGGUFModel, env), cfg, true).length === 0;
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
    const managed = (env[AcestepModelsDirEnv] ?? '').trim() === '';
    const lacking = missingLocalModelFiles(status.modelsDir, cfg, managed);
    const detail = lacking.length > 0 ? `（缺少或文件不完整：${lacking.join('、')}）` : '';
    throw missing(what, `缺少 GGUF 模型权重：${status.modelsDir}${detail}`);
  }
  return {
    aceLm: path.join(status.binDir, exeName('ace-lm', platform)),
    aceSynth: path.join(status.binDir, exeName('ace-synth', platform)),
    modelsDir: status.modelsDir,
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
