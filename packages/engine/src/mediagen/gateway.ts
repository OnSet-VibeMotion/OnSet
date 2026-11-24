/**
 * BYOK 多模态媒体生成网关（金融级幂等 + 两阶段防重落盘 + 云端续查 resume）：
 * - 支持 OpenAI 兼容、阿里云百炼 DashScope、fal.ai、以及本机 Codex CLI 登录态生图；
 * - 绝不静默重试付费请求；下载完成后先写 outputs.json（save_pending=true）再落库；
 * - 落库失败可走 retry_save 零付费抢救本地字节；远端超时可走 resume 续查原 remote_id。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../fsutil';
import { compareBytes, marshalIndent } from '../gojson';
import { defaultAssetsDir, importAssetFile, importAssetToProject } from './library';
import { loadMediaProviderConfigs } from './providers';
import type { AssetRef, MediaJob, MediaProviderConfig, MediaProviderId, Modality, StagedJobOutput } from './types';

export {
  defaultMediaConfigPath,
  listMediaProviders,
  loadMediaProviderConfigs,
  MediaConfigEnv,
  type ProviderSummary,
  saveMediaProviderConfig,
} from './providers';

export interface ProviderGenerationResult {
  remote_id?: string;
  outputs: Array<{ filename: string; bytes: Buffer; mime_type: string }>;
}

export type ProviderRunner = (
  job: MediaJob,
  provider: MediaProviderConfig,
  signal?: AbortSignal,
) => Promise<ProviderGenerationResult>;

function jobsDir(assetsRoot: string): string {
  return path.join(assetsRoot, 'jobs');
}

function jobFile(assetsRoot: string, jobId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(jobId)) throw new Error(`非法 job_id：${jobId}`);
  return path.join(jobsDir(assetsRoot), `${jobId}.json`);
}

function jobReceiptFile(assetsRoot: string, requestId: string): string {
  const h = crypto.createHash('sha256').update(requestId).digest('hex');
  return path.join(assetsRoot, 'job-requests', `${h}.json`);
}

function saveJob(assetsRoot: string, job: MediaJob): void {
  atomicWrite(jobFile(assetsRoot, job.id), marshalIndent(job) + '\n', 0o644);
}

export function getMediaJob(assetsRoot: string, jobId: string): MediaJob | undefined {
  const file = jobFile(assetsRoot, jobId);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as MediaJob;
}

export function listMediaJobs(assetsRoot: string): MediaJob[] {
  const dir = jobsDir(assetsRoot);
  if (!fs.existsSync(dir)) return [];
  const jobs: MediaJob[] = [];
  for (const name of fs.readdirSync(dir).sort(compareBytes)) {
    if (!name.endsWith('.json')) continue;
    try {
      jobs.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as MediaJob);
    } catch {
      // 忽略损坏任务文件
    }
  }
  return jobs.sort((a, b) => (a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0));
}

function defaultOpenAICompatibleRunner(fetcher: typeof fetch): ProviderRunner {
  return async (job, provider, signal) => {
    if (!provider.api_key) throw new Error(`供应商 ${provider.id} 尚未配置 API Key`);
    const base = (provider.base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    if (job.modality === 'image') {
      const resp = await fetcher(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.api_key}` },
        body: JSON.stringify({
          model: job.model,
          prompt: job.prompt,
          response_format: 'b64_json',
          ...(job.parameters ?? {}),
        }),
        signal,
      });
      if (!resp.ok) throw new Error(`图像生成失败（HTTP ${resp.status}）`);
      const json = (await resp.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const outputs: ProviderGenerationResult['outputs'] = [];
      for (let i = 0; i < (json.data?.length ?? 0); i++) {
        const item = json.data![i];
        if (item.b64_json) {
          outputs.push({
            filename: `${job.id}-${i}.png`,
            bytes: Buffer.from(item.b64_json, 'base64'),
            mime_type: 'image/png',
          });
        } else if (item.url) {
          const imgResp = await fetcher(item.url, { signal });
          if (!imgResp.ok) throw new Error(`下载生成图片失败（HTTP ${imgResp.status}）`);
          outputs.push({
            filename: `${job.id}-${i}.png`,
            bytes: Buffer.from(await imgResp.arrayBuffer()),
            mime_type: 'image/png',
          });
        }
      }
      if (outputs.length === 0) throw new Error('图像接口未返回有效图片字节');
      return { outputs };
    }
    throw new Error(`供应商 ${provider.id} 暂不支持通过默认通道直接生成 ${job.modality}`);
  };
}

function stageOutputs(
  assetsRoot: string,
  jobId: string,
  outputs: ProviderGenerationResult['outputs'],
): StagedJobOutput[] {
  const workDir = path.join(assetsRoot, 'work', jobId);
  fs.mkdirSync(workDir, { recursive: true });
  return outputs.map((out, i) => {
    const safeName = path.basename(out.filename).replace(/[^a-zA-Z0-9._-]/g, '_') || `out-${i}.bin`;
    const localFile = path.join(workDir, `${i}-${safeName}`);
    atomicWrite(localFile, out.bytes, 0o644);
    return {
      index: i,
      local_file: localFile,
      original_name: safeName,
      mime_type: out.mime_type,
      bytes: out.bytes.length,
      sha256: crypto.createHash('sha256').update(out.bytes).digest('hex'),
    };
  });
}

/**
 * 第一阶段落盘（暂存输出 + 校验清单），然后执行第二阶段入库与项目拷贝。
 * 若第二阶段失败，保留本地暂存字节并置 status='save_failed', save_pending=true，允许零付费 retry_save。
 */
function commitStagedOutputs(assetsRoot: string, job: MediaJob): MediaJob {
  const staged = job.staged_outputs ?? [];
  if (staged.length === 0) {
    job.status = 'save_unavailable';
    job.save_pending = false;
    job.error = '没有可抢救的本地暂存输出';
    job.updated_at = new Date().toISOString();
    saveJob(assetsRoot, job);
    return job;
  }

  for (const item of staged) {
    if (!fs.existsSync(item.local_file)) {
      job.status = 'save_unavailable';
      job.save_pending = false;
      job.error = `留存输出文件已丢失：${item.original_name}`;
      job.updated_at = new Date().toISOString();
      saveJob(assetsRoot, job);
      return job;
    }
    const buf = fs.readFileSync(item.local_file);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== item.bytes || hash !== item.sha256) {
      job.status = 'save_unavailable';
      job.save_pending = false;
      job.error = `留存输出文件校验损坏：${item.original_name}`;
      job.updated_at = new Date().toISOString();
      saveJob(assetsRoot, job);
      return job;
    }
  }

  job.status = 'saving';
  job.updated_at = new Date().toISOString();
  saveJob(assetsRoot, job);

  const savedAssets: AssetRef[] = [];
  const projectFiles: string[] = [];
  try {
    for (const item of staged) {
      const imported = importAssetFile(assetsRoot, {
        source_path: item.local_file,
        name: `${job.modality}-${job.id.slice(-6)}-${item.index + 1}`,
        modality: job.modality,
        origin: 'generated',
        request_id: `${job.id}-output-${item.index}`,
        asset_id: staged.length === 1 ? job.target_asset_id : undefined,
        parent_version_id: staged.length === 1 ? job.parent_version_id : undefined,
        provider: job.provider,
        model: job.model,
        prompt: job.prompt,
        parameters: job.parameters,
        references: job.references,
        job_id: job.id,
      });
      const ref: AssetRef = { asset_id: imported.asset.id, version_id: imported.version.version_id };
      savedAssets.push(ref);
      if (job.project_root) {
        const copied = importAssetToProject(assetsRoot, ref, job.project_root);
        projectFiles.push(copied.project_path);
      }
    }
    job.saved_assets = savedAssets;
    job.project_files = projectFiles.length > 0 ? projectFiles : undefined;
    job.save_pending = false;
    job.status = 'completed';
    job.error = undefined;
    job.updated_at = new Date().toISOString();
    saveJob(assetsRoot, job);
    return job;
  } catch (err) {
    job.saved_assets = savedAssets.length > 0 ? savedAssets : undefined;
    job.status = 'save_failed';
    job.save_pending = true;
    job.error = err instanceof Error ? err.message : String(err);
    job.updated_at = new Date().toISOString();
    saveJob(assetsRoot, job);
    return job;
  }
}

export interface GenerateMediaInput {
  request_id: string;
  provider: MediaProviderId;
  modality: Modality;
  prompt: string;
  model?: string;
  parameters?: Record<string, unknown>;
  references?: AssetRef[];
  target_asset_id?: string;
  parent_version_id?: string;
  project_root?: string;
  assets_root?: string;
  env?: Record<string, string | undefined>;
  runner?: ProviderRunner;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * 发起一次幂等多模态生成任务：
 * - 相同 request_id + 相同载荷直接返回原任务，绝不二次扣费；
 * - 相同 request_id + 不同载荷抛 REQUEST_ID_CONFLICT；
 * - 下载产物后先写 staging 校验清单（save_pending=true），再原子落入资产库。
 */
export async function generateMedia(input: GenerateMediaInput): Promise<{ job: MediaJob; replayed: boolean }> {
  const reqId = input.request_id.trim();
  if (!reqId) throw new Error('付费生成必须提供稳定的 request_id 以防重复扣费');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('生成提示词不能为空');

  const env = input.env ?? process.env;
  const assetsRoot = input.assets_root ? path.resolve(input.assets_root) : defaultAssetsDir(env);
  const cfgs = loadMediaProviderConfigs(env);
  const providerCfg = cfgs[input.provider];
  if (!providerCfg || !providerCfg.enabled) throw new Error(`供应商未启用：${input.provider}`);
  const model = input.model?.trim() || providerCfg.default_models?.[input.modality] || '';
  if (!model) throw new Error(`供应商 ${input.provider} 未配置 ${input.modality} 默认模型，请显式指定 model`);

  const payloadHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        provider: input.provider,
        modality: input.modality,
        model,
        prompt,
        parameters: input.parameters ?? {},
        references: input.references ?? [],
      }),
    )
    .digest('hex');

  const rFile = jobReceiptFile(assetsRoot, reqId);
  if (fs.existsSync(rFile)) {
    const prev = JSON.parse(fs.readFileSync(rFile, 'utf8')) as { hash: string; job_id: string };
    if (prev.hash !== payloadHash) throw new Error('REQUEST_ID_CONFLICT：同一 request_id 不能用于不同参数的生成请求');
    const existing = getMediaJob(assetsRoot, prev.job_id);
    if (existing) return { job: existing, replayed: true };
  }

  const now = new Date().toISOString();
  const job: MediaJob = {
    schema: 1,
    id: `job-${crypto.randomBytes(6).toString('hex')}`,
    request_id: reqId,
    payload_hash: payloadHash,
    provider: input.provider,
    model,
    modality: input.modality,
    prompt,
    parameters: input.parameters,
    references: input.references,
    target_asset_id: input.target_asset_id,
    parent_version_id: input.parent_version_id,
    project_root: input.project_root ? path.resolve(input.project_root) : undefined,
    status: 'running',
    save_pending: false,
    created_at: now,
    updated_at: now,
  };
  atomicWrite(rFile, marshalIndent({ hash: payloadHash, job_id: job.id }) + '\n', 0o644);
  saveJob(assetsRoot, job);

  const runner = input.runner ?? defaultOpenAICompatibleRunner(input.fetcher ?? fetch);
  try {
    const result = await runner(job, providerCfg, input.signal);
    if (result.remote_id) job.remote_id = result.remote_id;
    job.staged_outputs = stageOutputs(assetsRoot, job.id, result.outputs);
    job.save_pending = true;
    job.updated_at = new Date().toISOString();
    saveJob(assetsRoot, job);
  } catch (err) {
    const e = err as Error & { remoteId?: string; remoteTerminal?: boolean };
    if (e.remoteId) job.remote_id = e.remoteId;
    if (e.remoteTerminal) job.remote_terminal = true;
    job.status = input.signal?.aborted ? 'cancelled' : 'failed';
    job.error = e.message || String(err);
    job.updated_at = new Date().toISOString();
    saveJob(assetsRoot, job);
    return { job, replayed: false };
  }

  return { job: commitStagedOutputs(assetsRoot, job), replayed: false };
}

/** 零付费抢救落库：仅重验已留存在本地的 outputs 字节并重新入库，绝不调用远端模型。 */
export function retrySaveMediaJob(assetsRoot: string, jobId: string): MediaJob {
  const job = getMediaJob(assetsRoot, jobId);
  if (!job) throw new Error(`找不到生成任务：${jobId}`);
  if (!job.save_pending) throw new Error(`任务 ${jobId} 没有待抢救的本地暂存输出（状态：${job.status}）`);
  return commitStagedOutputs(assetsRoot, job);
}

/** 续查已知 remote_id 的中断云端任务（不重新上传、不二次发起付费生成）。 */
export async function resumeMediaJob(
  assetsRoot: string,
  jobId: string,
  poller: (job: MediaJob) => Promise<ProviderGenerationResult>,
): Promise<MediaJob> {
  const job = getMediaJob(assetsRoot, jobId);
  if (!job) throw new Error(`找不到生成任务：${jobId}`);
  if (job.status === 'completed') return job;
  if (job.status === 'cancelled' || job.remote_terminal || !job.remote_id) {
    throw new Error(
      `任务 ${jobId} 不可续查（status=${job.status}, remote_id=${job.remote_id ?? '无'}, remote_terminal=${Boolean(job.remote_terminal)}）`,
    );
  }
  const result = await poller(job);
  job.staged_outputs = stageOutputs(assetsRoot, job.id, result.outputs);
  job.save_pending = true;
  job.updated_at = new Date().toISOString();
  saveJob(assetsRoot, job);
  return commitStagedOutputs(assetsRoot, job);
}
