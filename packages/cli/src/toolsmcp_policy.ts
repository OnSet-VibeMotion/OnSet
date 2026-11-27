/**
 * onset 工具服务的档位与策略：按项目流程过滤工具、静态紧凑核心白名单、领域分类与 hyperframes 子命令白名单。
 */
import * as flow from '@onset/engine/flow';
import type { ParamValues } from './ops/op';

/** 档位：编排工具使用制作工具，渲染器只拿镜头内的工具。 */
export type Profile = 'orchestrator' | 'renderer';

/** 应急全量开关：设为 1 / true 时编排档位退回全量工具表（默认开启静态紧凑模式）。 */
export const ToolsFullEnv = 'ONSET_TOOLS_FULL';

/** 兼容旧版紧凑开关：设为 0 / false 时同样退回全量模式。 */
export const ToolsCompactEnv = 'ONSET_TOOLS_COMPACT';

/** 顶层统一检索与参数文档入口工具名。 */
export const ToolSearchName = 'tool_search';

/** 旧版帮助工具名：渲染档位继续使用，编排档位调用时永久静默转发至 tool_search。 */
export const LegacyToolHelpName = 'tool_help';

/** 顶层统一扩展工具执行入口名。 */
export const ToolCallName = 'tool_call';

/** 旧版扩展路由别名：编排档位调用时永久静默兼容，等同于 tool_call。 */
export const LegacyOnsetCallName = 'onset_call';

/** 兼容历史导出名。 */
export const OnsetCallToolName = LegacyOnsetCallName;

/** 是否显式要求退出紧凑模式、展开全量工具表。 */
export function fullModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const full = (env[ToolsFullEnv] ?? '').trim().toLowerCase();
  if (full === '1' || full === 'true') return true;
  const compact = (env[ToolsCompactEnv] ?? '').trim().toLowerCase();
  if (compact === '0' || compact === 'false') return true;
  return false;
}

/** 编排档位默认启用静态紧凑模式（省 ~75%-78% 工具 Schema Token 并稳守 agy 32 KB 上限），可通过 ONSET_TOOLS_FULL=1 退回全量。 */
export function compactModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !fullModeEnabled(env);
}

/**
 * 紧凑模式下编排档位直接暴露的核心主链路工具：
 * 覆盖口播/卡点/歌曲三条主流程从配音对齐、时间轴推算、批量渲染、抽帧验收、拼接复查到 Studio 交互的全部核心步骤。
 * 其余扩展/低频/第三方站操作统一通过 tool_search 检索并经 tool_call 调用。
 */
export const CompactCoreOps: ReadonlySet<string> = new Set([
  // 配音、强制对齐、音频校验与时长报告（口播主链路）
  'voice_synthesize',
  'align_text',
  'align_run',
  'align_build',
  'audio_check',
  'audio_mix',
  'timing_report',
  'phrase_frames',
  // 卡点主链路（按 onset.flow.json 动态过滤）
  'beat_import',
  'beat_analyze',
  'beat_regrid',
  'beat_confirm',
  'beat_cues',
  'beat_click',
  'validate_beat',
  // 歌曲主链路（按 onset.flow.json 动态过滤）
  'song_configure',
  'song_generate',
  'song_import',
  'song_select',
  'song_prepare',
  'song_cues',
  'song_mux',
  'song_handoff',
  'song_receive',
  'validate_song',
  // 分镜、并发批量渲染与验收
  'scene_cues',
  'scene_prepare',
  'scene_run',
  'scene_run_all',
  'scene_frames_batch',
  'scene_frames',
  'scene_seams',
  'validate_reads',
  // 成片拼接、解码校验、复查与发布校验
  'concat',
  'validate_video',
  'review',
  'validate_publish',
  // 风格、配置、输入清单、只读检查与客户端交互
  'film_style_list',
  'film_style_use',
  'config_get',
  'flow_guide',
  'inputs_manifest',
  'hyperframes',
  'studio_show',
  'studio_step',
  'studio_confirm',
  'studio_ask',
]);

export interface ToolCategorySpec {
  id: string;
  label: string;
  keywords: readonly string[];
}

/** tool_search 领域分类目录（同时用于 category 筛选、中文关键词召回与 "*" 分组索引）。 */
export const ToolCategories: readonly ToolCategorySpec[] = [
  { id: 'voice', label: '配音与音色', keywords: ['配音', '音色', '声音', '朗读', '语音', 'tts', 'voice'] },
  { id: 'align', label: '对齐与时间轴', keywords: ['对齐', '字幕', '时间轴', '短语', '时长', 'srt', 'align'] },
  { id: 'audio', label: '音频与混音', keywords: ['音频', '混音', 'bgm', '响度', 'audio'] },
  { id: 'beat', label: '卡点与节拍', keywords: ['卡点', '节拍', '小节', 'bpm', 'beat'] },
  { id: 'song', label: '歌曲讲解', keywords: ['歌曲', '唱词', '歌词', '翻唱', 'song'] },
  { id: 'scene', label: '分镜与渲染', keywords: ['镜头', '分镜', '渲染', '抽帧', '接缝', 'scene'] },
  {
    id: 'validate',
    label: '校验与复查',
    keywords: ['校验', '复查', '验收', '阅读时长', '发布', '规格', 'validate', 'review'],
  },
  {
    id: 'delivery',
    label: '拼接与导出',
    keywords: ['拼接', '导出', '导入', '归档', '成片', 'concat', 'export'],
  },
  { id: 'film_style', label: '整片风格', keywords: ['风格', '整片风格', '画风', '参考图', 'style'] },
  { id: 'motion_effect', label: '动效目录', keywords: ['动效', '动画', '转场', '特效', 'motion'] },
  { id: 'asset', label: '素材采集与图库', keywords: ['素材', '采集', '网页', '截图', 'logo', '图库', 'asset'] },
  { id: 'media', label: 'AI 生成与媒体质检', keywords: ['生图', '生视频', '多模态', '质检', '帧检', 'media'] },
  { id: 'sfx', label: '音效', keywords: ['音效', 'freesound', '声音素材', 'sfx'] },
  { id: 'font', label: '字体', keywords: ['字体', '免费商用字体', 'font'] },
  { id: 'brand_kit', label: '品牌包', keywords: ['品牌包', '品牌', '配色', '视觉规范', 'brand'] },
  { id: 'series', label: '专栏与系列', keywords: ['系列', '专栏', '合集', '同步素材', '模版', 'series'] },
  { id: 'cast', label: '多角色对话', keywords: ['多角色', '对白', '对话', '角色', 'cast', 'dialogue'] },
  { id: 'review_comments', label: '审片批注', keywords: ['批注', '审片', '评论', '反馈', 'comment'] },
  { id: 'presenter', label: '数字人与出镜', keywords: ['数字人', '出镜', '字幕修补', 'presenter'] },
  { id: 'recreate', label: '复刻分析', keywords: ['复刻', '扒片', '拆解', '对比', 'recreate'] },
  { id: 'memory', label: '渲染记忆', keywords: ['记忆', '经验', '偏好', '沉淀', '复盘', 'memory'] },
  { id: 'studio', label: '客户端交互', keywords: ['界面', '页面', '确认', '提问', '关卡', '步骤', '弹窗', 'studio'] },
  { id: 'config', label: '配置与用量', keywords: ['配置', '阶段', '清单', '用量', 'token', '费用', 'config', 'usage'] },
  { id: 'plugin', label: '第三方站插件', keywords: ['插件', '第三方', '扩展站', 'plugin', 'station'] },
];

const categoryById = new Map(ToolCategories.map((c) => [c.id, c]));

/** 把工具名映射到所属领域分类（用于 tool_search 分组与检索）。 */
export function toolCategory(name: string, external?: boolean): ToolCategorySpec {
  if (external) return categoryById.get('plugin')!;
  if (name.startsWith('voice_')) return categoryById.get('voice')!;
  if (name.startsWith('align_') || name === 'timing_report' || name === 'phrase_frames')
    return categoryById.get('align')!;
  if (name.startsWith('audio_')) return categoryById.get('audio')!;
  if (name.startsWith('beat_') || name === 'validate_beat') return categoryById.get('beat')!;
  if (name.startsWith('song_') || name === 'validate_song') return categoryById.get('song')!;
  if (name.startsWith('scene_') || name === 'shared_component_promote' || name === 'hyperframes')
    return categoryById.get('scene')!;
  if (name.startsWith('review_comments_')) return categoryById.get('review_comments')!;
  if (name.startsWith('cast_') || name.startsWith('dialogue_') || name === 'validate_cast')
    return categoryById.get('cast')!;
  if (name.startsWith('validate_') || name === 'review') return categoryById.get('validate')!;
  if (
    name === 'concat' ||
    name === 'archive' ||
    name.startsWith('project_export_') ||
    name.startsWith('project_import_')
  ) {
    return categoryById.get('delivery')!;
  }
  if (name.startsWith('film_style_')) return categoryById.get('film_style')!;
  if (name.startsWith('motion_effect_')) return categoryById.get('motion_effect')!;
  if (name.startsWith('asset_') || name.startsWith('assets_')) return categoryById.get('asset')!;
  if (name.startsWith('media_')) return categoryById.get('media')!;
  if (name.startsWith('sfx_')) return categoryById.get('sfx')!;
  if (name.startsWith('font_')) return categoryById.get('font')!;
  if (name.startsWith('brand_kit_')) return categoryById.get('brand_kit')!;
  if (name.startsWith('series_')) return categoryById.get('series')!;
  if (name.startsWith('presenter_')) return categoryById.get('presenter')!;
  if (name.startsWith('recreate_')) return categoryById.get('recreate')!;
  if (name.startsWith('memory_')) return categoryById.get('memory')!;
  if (name.startsWith('studio_')) return categoryById.get('studio')!;
  return categoryById.get('config')!;
}

/** hyperframes 工具放行的子命令：本机渲染与只读检查。远端渲染、改动已装技能、交互与遥测命令一律不给。 */
export const HyperFramesSubcommands = [
  'lint',
  'check',
  'validate',
  'inspect',
  'snapshot',
  'keyframes',
  'render',
  'timeline',
  'compositions',
  'info',
  'docs',
] as const;

export const orchestratorHyperFramesSubcommands = HyperFramesSubcommands.filter((sub) => sub !== 'render');

export const sceneDispatchNote =
  '镜头实现与 MP4 渲染交给渲染工具。单镜头用 scene_run({"scene": "<镜头目录>"})，整批用 scene_run_all({"scenes": "scenes/"})；本工具在制作端只用于检查。';

/** 编排端按项目流程（onset.flow.json）过滤掉本项目完全用不到的工具，减少每轮请求携带的 schema token。 */
export function allowedForProjectFlow(opName: string, root: string): boolean {
  if (root === '') return true;
  const rec = flow.flowRecord(root);
  if (!rec) return true;
  const id = rec.id;
  if (id === 'speech') {
    // 保留 song_init（已有项目转歌曲讲解入口）与 cast_*/dialogue_*（同一会话里 cast_new 后可立即使用）。
    if (
      opName.startsWith('beat_') ||
      (opName.startsWith('song_') && opName !== 'song_init') ||
      opName === 'validate_beat' ||
      opName === 'validate_song'
    )
      return false;
    return true;
  }
  if (id === 'beat') {
    if (
      opName.startsWith('voice_') ||
      opName.startsWith('align_') ||
      opName.startsWith('song_') ||
      opName.startsWith('cast_') ||
      opName.startsWith('dialogue_') ||
      opName === 'validate_song' ||
      opName === 'validate_cast' ||
      opName === 'phrase_frames' ||
      opName === 'timing_report'
    )
      return false;
    return true;
  }
  if (id === 'song') {
    if (
      opName.startsWith('beat_') ||
      opName.startsWith('voice_') ||
      opName.startsWith('align_') ||
      opName.startsWith('cast_') ||
      opName.startsWith('dialogue_') ||
      opName === 'validate_beat' ||
      opName === 'validate_cast' ||
      opName === 'phrase_frames' ||
      opName === 'timing_report'
    )
      return false;
    return true;
  }
  return true;
}

/** 毫秒级纯查询/轻写操作不暴露 wait_seconds 参数，减少工具 schema 重复文字；调用时若传入仍由 prepareCall 兼容剥离。 */
export const instantOps: ReadonlySet<string> = new Set([
  'config_get',
  'flow_guide',
  'usage',
  'scene_usage',
  'scene_lint',
  'film_style_list',
  'film_style_show',
  'film_style_use',
  'film_style_add',
  'film_style_remove',
  'film_style_refs',
  'motion_effect_list',
  'motion_effect_show',
  'studio_show',
  'studio_step',
  'studio_confirm',
  'voice_catalog',
  'voice_list',
  'voice_get',
  'voice_default',
  'voice_save',
  'memory_remember',
  'memory_feedback',
  'inputs_manifest',
  'shared_component_promote',
  'timing_report',
]);

/** 校验并归一化 hyperframes 参数：与渲染提示词禁令同一份。 */
export function normalizeHyperFramesParams(profile: Profile | undefined, params: ParamValues): void {
  const sub = String(params.subcommand ?? '');
  if (profile === 'orchestrator' && sub === 'render') throw new Error(sceneDispatchNote);
  const allowed: readonly string[] =
    profile === 'orchestrator' ? orchestratorHyperFramesSubcommands : HyperFramesSubcommands;
  if (!allowed.includes(sub)) {
    throw new Error(`hyperframes 不放行子命令 ${sub || '（空）'}；只能用：${allowed.join('、')}`);
  }
  const args = (params.args as string[]).slice();
  if (sub === 'timeline' && (!args.includes('--json') || args.some((a) => !a.startsWith('-')))) {
    throw new Error('timeline 只放行只读的 --json（不能用 move、trim、split 等改写子命令）');
  }
  // 不把画面发给外部视觉服务。
  if (sub === 'snapshot' && !args.includes('--describe')) args.push('--describe', 'false');
  params.args = args;
}
