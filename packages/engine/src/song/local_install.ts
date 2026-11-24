import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lookPath } from '../envutil';
import { lockFile } from '../hyperframes/cli';
import type { Progress, Writer } from '../hyperframes/progress';
import { runCommand } from '../hyperframes/util';
import { abortReason } from '../procgroup';
import { ensureModel, mirrored } from '../toolinstall';
import {
  AceStepGGUFModel,
  AcestepBinDirEnv,
  AcestepCppCommit,
  AcestepCppRepo,
  AcestepSourceEnv,
  binMarker,
  exeName,
  isFile,
  type LocalAcestepRuntime,
  localAcestepBinariesReady,
  localAcestepBinDir,
  localAcestepModelsDir,
} from './local_spec';
import { runProcess } from './proc';

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
      throw new Error(
        '构建本机 ACE-Step 需要 git；请先安装 git（macOS 可运行 xcode-select --install）或通过 ONSET_ACESTEP_BIN_DIR 指定已编译目录',
      );
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
      await runCommand(git, ['clone', '--filter=blob:none', '--no-checkout', repoURL, src], {
        env: gitEnv,
        stdout: sink,
        stderr: sink,
        signal: opts.signal,
      });
      await runCommand(git, ['-C', src, 'checkout', AcestepCppCommit], {
        env: gitEnv,
        stdout: sink,
        stderr: sink,
        signal: opts.signal,
      });
      report({ stage: '拉取 GGML 子模块', percent: 15 });
      await runCommand(git, ['-C', src, 'submodule', 'update', '--init', '--recursive', '--depth', '1'], {
        env: gitEnv,
        stdout: sink,
        stderr: sink,
        signal: opts.signal,
      });

      report({ stage: '配置 CMake（Metal / 原生加速）', percent: 25 });
      const cmakeArgs = ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release'];
      if (process.platform === 'win32') cmakeArgs.push('-DGGML_CPU_ALL_VARIANTS=ON', '-DGGML_BACKEND_DL=ON');
      await runCommand(cmake, cmakeArgs, { env: opts.env, stdout: sink, stderr: sink, signal: opts.signal });

      const jobs = String(Math.max(1, os.cpus().length));
      report({ stage: '编译 ace-lm 与 ace-synth', percent: 35 });
      await runCommand(
        cmake,
        ['--build', build, '--config', 'Release', '--target', 'ace-lm', 'ace-synth', '-j', jobs],
        {
          env: opts.env,
          stdout: sink,
          stderr: sink,
          signal: opts.signal,
        },
      );

      const outDir =
        process.platform === 'win32' && fs.existsSync(path.join(build, 'Release'))
          ? path.join(build, 'Release')
          : build;
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
              await runCommand('install_name_tool', ['-add_rpath', '@executable_path', to], {
                env: opts.env,
                stdout: sink,
                stderr: sink,
                signal: opts.signal,
              });
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
          await runProcess(
            path.join(staging, bin),
            [],
            opts.env,
            { stderr: (c) => (stderr += c.toString('utf8')) },
            opts.signal,
          );
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
