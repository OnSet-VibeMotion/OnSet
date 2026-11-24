/**
 * 轻量 BYOK 多模态素材生成与跨项目不可变资产库（mediagen）数据模型与生成阶梯规范。
 */
export type Modality = 'image' | 'video' | 'audio';

export type MediaProviderId = 'openai-compatible' | 'dashscope' | 'fal' | 'codex';

export interface AssetRef {
  asset_id: string;
  version_id: string;
}

export interface AssetVersion {
  version_id: string;
  parent_version_id?: string;
  file: string;
  original_name: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  origin: 'upload' | 'generated' | 'derived';
  provider?: MediaProviderId;
  model?: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
  references?: AssetRef[];
  job_id?: string;
  created_at: string;
}

export interface LibraryAsset {
  schema: 1;
  id: string;
  name: string;
  modality: Modality;
  current_version_id: string;
  versions: AssetVersion[];
  trashed_at?: string;
  created_at: string;
  updated_at: string;
}

export type MediaJobStatus =
  | 'queued'
  | 'running'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'save_failed'
  | 'save_unavailable'
  | 'cancelled';

export interface StagedJobOutput {
  index: number;
  local_file: string;
  original_name: string;
  mime_type: string;
  bytes: number;
  sha256: string;
}

export interface MediaJob {
  schema: 1;
  id: string;
  request_id: string;
  payload_hash: string;
  provider: MediaProviderId;
  model: string;
  modality: Modality;
  prompt: string;
  parameters?: Record<string, unknown>;
  references?: AssetRef[];
  target_asset_id?: string;
  parent_version_id?: string;
  project_root?: string;
  status: MediaJobStatus;
  /** 下载完成后置 true，表示已有本地留存字节可通过 retry_save 零付费抢救落库。 */
  save_pending: boolean;
  /** 云端任务 ID；中断后可通过 resume 续查原任务而不重复扣费。 */
  remote_id?: string;
  /** 远端已明确返回终态失败，禁止 resume。 */
  remote_terminal?: boolean;
  staged_outputs?: StagedJobOutput[];
  saved_assets?: AssetRef[];
  project_files?: string[];
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface MediaProviderConfig {
  id: MediaProviderId;
  enabled: boolean;
  base_url?: string;
  api_key?: string;
  default_models?: Partial<Record<Modality, string>>;
}

/**
 * 5 级生成时机阶梯与跨镜头主体一致性规范（供编排与渲染查阅）。
 */
export const GenerationLadderGuide = [
  '## 多模态素材生成时机阶梯（优先最低复杂度、最高可控性）',
  '1. 复用与真实检索优先：保留用户自带和项目已确认素材；涉及真实事件、知名作品或具体商品时，先获取真实原始资料，禁止用生成像素编造事实证据。',
  '2. 可编辑图形一律原生代码：文字排版、UI、图表、Logo、字幕与图形转场必须用 HTML/SVG/CSS/GSAP/Canvas 实现，严禁把可编辑文字与 UI 烤死进生成图。',
  '3. 静图 + 原生运镜优先于生成视频：只需摄影质感、人物/产品静物或背景氛围且运动可由推拉、视差、遮罩完成时，优先生成高清静图叠加原生运镜，更稳更省更一致。',
  '4. 仅连续物理运动使用视频生成：只有画面需要手部操作、人物表演、流体/烟雾/布料等连续物理运动时才生成视频，且优先以已验收首帧驱动图生视频（I2V）。',
  '5. 音频按职责分流：配音走片场配音对齐体系，配乐与音效（SFX）分别调用对应通道。',
  '',
  '## 跨镜头主体一致性规程',
  '- 锁定单一视觉锚点：先确定一张清晰锚点静图（轮廓、材质、配色、光向），严禁对同一主体并发多条无参考文生视频。',
  '- 同场景连镜（Continuation Cut）：直接抽取上一条已验证视频的干净尾帧作为下一条 I2V 的首帧，零额外生图花费且保持空间与姿态连续。',
  '- 换机位/换景别：从锚点图经参考改图派生新首帧，并核对主体处于动作起始态、留足运动余量后再提交 I2V。',
].join('\n');
