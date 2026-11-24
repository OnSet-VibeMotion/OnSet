/**
 * 多模态素材生成与跨项目不可变资产库操作（mediagen / asset_library）。
 */
import * as mediagen from '@onset/engine/mediagen';
import { currentEnvironment } from './cli';
import { defineGroup } from './ops/cli';
import { bool, projectRoot, str } from './ops/common';
import { defineOp } from './ops/op';

defineGroup({
  path: ['media-gen'],
  summary: 'BYOK 多模态素材生成与跨项目不可变资产库',
  description:
    '通过用户自有供应商配置（阿里云百炼、fal.ai、OpenAI 兼容或本机 Codex Image）幂等生成视觉/音频底板素材，支持两阶段防重落盘与跨项目不可变多版本资产库管理。',
});

function assetsDir(): string {
  return mediagen.defaultAssetsDir(currentEnvironment());
}

defineOp({
  name: 'media_providers',
  cli: ['media-gen', 'providers'],
  summary: '查看已配置的多模态生成供应商、默认模型与 5 级生成阶梯规范',
  description:
    '检查本机可用的多模态素材生成通道（阿里云百炼、fal.ai、OpenAI 兼容、本机 Codex Image），绝不返回 API Key 原文。',
  examples: ['media_providers({})'],
  params: {
    include_guide: { type: 'boolean', description: '是否附带 5 级生成时机阶梯与跨镜头一致性规程', default: true },
  },
  run: async (p, { out }) => {
    const providers = mediagen.listMediaProviders(currentEnvironment());
    for (const pr of providers) {
      out.write(`- ${pr.id}（${pr.label}）：${pr.configured ? '可用' : '未配置'} · 支持 ${pr.modalities.join('/')}\n`);
    }
    const includeGuide = p.include_guide !== false;
    return { data: { providers, ...(includeGuide ? { guide: mediagen.GenerationLadderGuide } : {}) } };
  },
});

defineOp({
  name: 'media_generate',
  cli: ['media-gen', 'generate'],
  summary: '发起幂等多模态素材生成（带两阶段防重落盘与资产库版本追踪）',
  description: `调用已配置的多模态供应商生成图像/视频/音频底板素材。必须提供稳定 request_id 防止重复扣费；
下载产物后先落本地暂存校验清单再入不可变资产库，传入 project_root 时同步安全拷入项目 assets/generated/。`,
  examples: [
    'media_generate({"request_id": "scene01-bg-v1", "provider": "openai-compatible", "modality": "image", "prompt": "极简暖光建筑摄影底图，无文字", "project_root": "."})',
  ],
  params: {
    request_id: { type: 'string', description: '稳定幂等键（必填，防止重复扣费）', required: true },
    provider: { type: 'string', description: '供应商：dashscope / fal / openai-compatible / codex', required: true },
    modality: { type: 'string', description: '模态：image / video / audio', required: true },
    prompt: { type: 'string', description: '生成描述', required: true },
    model: { type: 'string', description: '可选：覆盖该供应商默认模型' },
    project_root: { type: 'string', description: '可选：同步拷入此项目的 assets/generated/' },
    target_asset_id: { type: 'string', description: '可选：作为已有资产的新版本追加' },
    parent_version_id: { type: 'string', description: '可选：父版本 ID（改图血缘追踪）' },
  },
  run: async (p, { out, signal }) => {
    const res = await mediagen.generateMedia({
      request_id: str(p.request_id),
      provider: str(p.provider) as mediagen.MediaProviderId,
      modality: str(p.modality) as mediagen.Modality,
      prompt: str(p.prompt),
      model: str(p.model) || undefined,
      project_root: str(p.project_root) || undefined,
      target_asset_id: str(p.target_asset_id) || undefined,
      parent_version_id: str(p.parent_version_id) || undefined,
      assets_root: assetsDir(),
      env: currentEnvironment(),
      signal,
    });
    out.write(`生成任务 ${res.job.id}：${res.job.status}${res.replayed ? '（幂等重放）' : ''}\n`);
    if (res.job.project_files?.length) out.write(`已拷入项目：${res.job.project_files.join(', ')}\n`);
    if (res.job.error) out.write(`错误信息：${res.job.error}\n`);
    return { data: res };
  },
});

defineOp({
  name: 'media_job_retry_save',
  cli: ['media-gen', 'retry-save'],
  summary: '零付费抢救本地暂存的生成结果并重做入库',
  description: '仅对 save_pending=true 的任务重验本地留存文件哈希并重新落库，绝不发起任何远端模型请求。',
  examples: ['media_job_retry_save({"job_id": "job-1a2b3c4d5e6f"})'],
  params: {
    job_id: { type: 'string', description: '生成任务 ID', required: true, positional: 0 },
  },
  run: async (p, { out }) => {
    const job = mediagen.retrySaveMediaJob(assetsDir(), str(p.job_id));
    out.write(`抢救落库结果：${job.id} → ${job.status}\n`);
    return { data: job };
  },
});

defineOp({
  name: 'asset_library_list',
  cli: ['media-gen', 'assets'],
  summary: '列出跨项目不可变资产库中的可复用图片/视频/音频',
  description: '检索用户级跨项目资产库，支持按模态与关键词过滤。',
  examples: ['asset_library_list({"modality": "image"})'],
  params: {
    modality: { type: 'string', description: '可选：image / video / audio' },
    query: { type: 'string', description: '可选：名称或 ID 关键词' },
    include_trashed: { type: 'boolean', description: '是否包含回收站条目' },
  },
  run: async (p, { out }) => {
    const modRaw = str(p.modality);
    const modality = modRaw === 'image' || modRaw === 'video' || modRaw === 'audio' ? modRaw : undefined;
    const assets = mediagen.listAssets(assetsDir(), {
      modality,
      query: str(p.query) || undefined,
      includeTrashed: bool(p.include_trashed),
    });
    for (const a of assets) {
      out.write(
        `- ${a.id}（${a.name}）[${a.modality}] 当前版本=${a.current_version_id}（共 ${a.versions.length} 版）\n`,
      );
    }
    out.write(`共 ${assets.length} 项资产。\n`);
    return { data: { count: assets.length, assets } };
  },
});

defineOp({
  name: 'asset_library_import',
  cli: ['media-gen', 'import-to-project'],
  summary: '按精确资产版本将跨项目资产安全拷入当前项目',
  description:
    '按固定 { asset_id, version_id } 校验 SHA-256 后拷入项目 assets/generated/，拒绝覆盖不同内容的同名文件。',
  examples: ['asset_library_import({"asset_id": "ast-123456", "version_id": "v-abcdef", "project_root": "."})'],
  params: {
    asset_id: { type: 'string', description: '资产 ID', required: true },
    version_id: { type: 'string', description: '固定版本 ID', required: true },
    project_root: projectRoot,
    target_name: { type: 'string', description: '可选：项目内的目标文件名' },
  },
  run: async (p, { out }) => {
    const res = mediagen.importAssetToProject(
      assetsDir(),
      { asset_id: str(p.asset_id), version_id: str(p.version_id) },
      str(p.project_root) || '.',
      str(p.target_name) || undefined,
    );
    out.write(`已导入项目：${res.project_path}${res.reused ? '（同摘要复用）' : ''}\n`);
    return { data: res };
  },
});
