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
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { errorText } from '../hyperframes/util';
import { buildLocalRequest, isCoverTask, isFile, requireLocalAcestep } from './local_spec';
import { runProcess } from './proc';
import type { Config } from './types';

export {
  ensureLocalAcestep,
  ensureLocalAcestepBinaries,
  type LocalAcestepInstallOptions,
} from './local_install';
export {
  AceStepGGUFModel,
  AcestepBinDirEnv,
  AcestepCppCommit,
  AcestepCppRepo,
  AcestepCppVersion,
  AcestepModelsDirEnv,
  AcestepSourceEnv,
  buildLocalRequest,
  DefaultLocalLMModel,
  DefaultLocalSynthModel,
  DefaultLocalTextEncoderModel,
  DefaultLocalVAEModel,
  isCoverTask,
  type LocalAcestepRuntime,
  type LocalAcestepStatus,
  localAcestepBinariesReady,
  localAcestepBinDir,
  localAcestepModelsDir,
  localAcestepModelsReady,
  localAcestepStatus,
  missingLocalModelFiles,
  requiredLocalModelFiles,
  requireLocalAcestep,
  resolveLocalLMModel,
  resolveLocalSynthModel,
} from './local_spec';

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
