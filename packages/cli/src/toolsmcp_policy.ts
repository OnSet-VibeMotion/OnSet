/**
 * onset 工具服务的档位与策略：按项目流程过滤工具、瞬间操作清单与 hyperframes 子命令白名单。
 */
import * as flow from '@onset/engine/flow';
import type { ParamValues } from './ops/op';

/** 档位：编排工具使用制作工具，渲染器只拿镜头内的工具。 */
export type Profile = 'orchestrator' | 'renderer';

/** 环境变量开关：开启后编排档位进入紧凑模式（直出核心主链路 + onset_call 泛化路由），适配 agy ACP 约 32 KB 的 MCP 声明预算。 */
export const ToolsCompactEnv = 'ONSET_TOOLS_COMPACT';

/** 紧凑模式下的通用路由工具名：用于调用未直出的扩展/低频/第三方站操作。 */
export const OnsetCallToolName = 'onset_call';

/** 读取环境变量判断是否开启紧凑模式。 */
export function compactModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[ToolsCompactEnv] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * 紧凑模式下编排档位直接暴露的核心主链路工具：
 * 覆盖口播/卡点/歌曲三条主流程从配音对齐、时间轴推算、批量渲染、抽帧验收、拼接复查到 Studio 交互的全部核心步骤。
 * 其余扩展/低频/第三方站操作统一通过 onset_call 路由调用，tool_help 对全量工具均可用。
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
