/**
 * 本地模型前置下载（Hugging Face / 魔搭镜像自动探测与 sha256 校验）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { lookPath } from '../envutil';
import { abortReason } from '../procgroup';
import { dataDir } from '../toolpath';
import { download, type InstallOptions, run } from './download';

/**
 * 工具第一次运行时才会去下的模型（例如 MLX 强制对齐的 Qwen3-ForcedAligner）。不预先下好的话，就是在制作途中
 * 现下载一个 1 GB 多的模型，而 huggingface.co 在国内常常连不上（hf-mirror 现在也 308 跳回 huggingface.co，
 * 2026-11 实测）。所以它也是前置资源：onset setup 下到 <数据目录>/models/<仓库名>，能连上 Hugging Face 就从那里下，
 * 否则从魔搭（ModelScope，同一个仓库的镜像）下；每个文件按钉死的 sha256 核对，对不上的来源不用。
 */
export interface ModelSpec {
  /** Hugging Face 上的仓库，魔搭上同名。 */
  repo: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  /** 仅托管在单一来源的模型（例如只有 Hugging Face、魔搭没有同名仓库时）显式声明来源，不白探另一个源。 */
  sources?: readonly ('huggingface' | 'modelscope')[];
}

/** 选模型来源：huggingface 或 modelscope；不设时先探一下 Hugging Face 通不通。 */
export const ModelSourceEnv = 'ONSET_MODEL_SOURCE';

/** 覆盖 Hugging Face 站点地址（例如国内镜像）；文件都核对 sha256，换源也安全。 */
export const HFEndpointEnv = 'ONSET_HF_ENDPOINT';

/** 模型的本地目录。 */
export function modelDir(spec: ModelSpec, env: Record<string, string | undefined>): string {
  const data = dataDir(env);
  return data === '' ? '' : path.join(data, 'models', spec.repo.replace('/', '__'));
}

/** 模型的每个文件都在（只看大小，不重算摘要：下载时核对过）。 */
export function modelReady(spec: ModelSpec, env: Record<string, string | undefined>): boolean {
  const dir = modelDir(spec, env);
  if (dir === '') return false;
  return spec.files.every((f) => {
    try {
      return fs.statSync(path.join(dir, f.path)).size === f.size;
    } catch {
      return false;
    }
  });
}

function hfOrigin(env: Record<string, string | undefined>): string {
  const custom = (env[HFEndpointEnv] ?? '').trim().replace(/\/+$/, '');
  return custom !== '' ? custom : 'https://huggingface.co';
}

function modelURL(source: string, repo: string, file: string, env: Record<string, string | undefined>): string {
  if (source === 'modelscope') return `https://www.modelscope.cn/models/${repo}/resolve/master/${file}`;
  return `${hfOrigin(env)}/${repo}/resolve/main/${file}`;
}

/** Hugging Face 在几秒内能不能连上：连不上就别让每个文件各自重试一轮再换来源。 */
async function huggingFaceReachable(opts: InstallOptions): Promise<boolean> {
  const curl =
    process.platform === 'darwin' && fs.existsSync('/usr/bin/curl')
      ? '/usr/bin/curl'
      : lookPath('curl', opts.env.PATH ?? '');
  try {
    await run(
      curl,
      [
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '10',
        '--output',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
        `${hfOrigin(opts.env)}/api/models/mlx-community`,
      ],
      { ...opts, output: undefined },
    );
    return true;
  } catch {
    return false;
  }
}

/** 下好模型（已在就不动），返回本地目录。 */
export async function ensureModel(spec: ModelSpec, opts: InstallOptions): Promise<string> {
  const report = opts.progress ?? (() => {});
  const dir = opts.targetDir?.trim() || modelDir(spec, opts.env);
  if (dir === '') throw new Error('无法确定模型的存放目录：环境里没有 HOME');
  const ready = opts.targetDir?.trim()
    ? spec.files.every((f) => {
        const target = path.join(dir, f.path);
        return fs.existsSync(target) && fs.statSync(target).size === f.size;
      })
    : modelReady(spec, opts.env);
  if (ready) {
    report({ stage: '模型已就绪', percent: 100 });
    return dir;
  }
  fs.mkdirSync(dir, { recursive: true });
  const wanted = opts.env[ModelSourceEnv];
  let sources = wanted === 'huggingface' || wanted === 'modelscope' ? [wanted] : spec.sources ? [...spec.sources] : [];
  if (sources.length === 0) {
    report({ stage: '选择模型下载源', percent: 0, indeterminate: true });
    sources = (await huggingFaceReachable(opts)) ? ['huggingface', 'modelscope'] : ['modelscope'];
  }
  const total = spec.files.reduce((sum, f) => sum + f.size, 0);
  let base = 0;
  for (const file of spec.files) {
    const target = path.join(dir, file.path);
    if (!(fs.existsSync(target) && fs.statSync(target).size === file.size)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let lastErr: unknown;
      let done = false;
      for (const source of sources) {
        const offset = base;
        try {
          const got = await download(
            { url: modelURL(source, spec.repo, file.path, opts.env), sha256: file.sha256, size: file.size },
            path.dirname(target),
            path.basename(target) + '.download',
            opts,
            (bytes) =>
              report({
                stage: `下载模型（${source === 'modelscope' ? '魔搭' : 'Hugging Face'}）`,
                percent: Math.min(99, (100 * (offset + bytes)) / total),
              }),
          );
          fs.renameSync(got, target);
          done = true;
          break;
        } catch (err) {
          lastErr = err;
          if (opts.signal?.aborted) throw abortReason(opts.signal);
        }
      }
      if (!done)
        throw new Error(`下载模型文件 ${file.path} 失败：${(lastErr as Error)?.message ?? ''}`, { cause: lastErr });
    }
    base += file.size;
  }
  report({ stage: '模型已就绪', percent: 100 });
  return dir;
}
