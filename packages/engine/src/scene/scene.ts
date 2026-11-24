import path from 'node:path';
import type { Attempt } from './attempt';
import type { Continuation } from './resume';
import type { ExemplarRecall, MemoryRecall } from './scene_prompt_sections';
import type { SeamRequest } from './seam';
import type { Timing } from './timing';

export {
  type AudioTargets,
  audioTargetsOf,
  type Canvas,
  canvasLabel,
  canvasOf,
  FrameFile,
  type FrameSource,
  frameSource,
  readFrameFrontmatter,
  renderPromptVersion,
  sceneCanvas,
} from './scene_frame';
export { load, newScene, optionalFields, requiredFields, sceneToJSON } from './scene_load';
export {
  contained,
  delimiterMatch,
  delimiterMatchAll,
  evalSymlinks,
  findProjectRoot,
  relPath,
  TextClose,
  TextOpen,
  verifySceneText,
} from './scene_paths';
export { buildPrompt, designPrompt } from './scene_prompt';
export {
  DesignFile,
  determinismSection,
  type ExemplarRecall,
  type MemoryRecall,
  memoryActive,
  selfReviewSection,
} from './scene_prompt_sections';

/**
 * 镜头。JSON 字段照 scene.json 的键名（snake_case）；Go 里 `json:"-"` 的字段（不来自 scene.json）
 * 用 camelCase。Go 的 nil 指针写成 null。
 */
export interface Scene {
  directory: string;
  id: string;
  duration_seconds: number;
  output: string;
  transcript: string;
  text: string;
  renderer: string;
  /**
   * 本镜头的整片风格：空表示项目的默认风格，「来源/目录名」表示项目里装的另一种风格，
   * none 表示不用整片风格、自主定视觉。口播项目由 onset scene cues 从分镜计划抄进来。
   */
  film_style: string;
  /**
   * 本镜头点名要用的第三方插件技能（「站 id/技能名」），只对清单里 scenes 为 opt-in 的技能有意义；
   * scenes 为 all 的技能所有镜头都带上。没有这个字段的镜头指纹不变。
   */
  plugin_skills: string[];
  /**
   * 本镜头要用的共用组件（components.ts）：项目 production/shared/<名字>/ 里登记过的组件，渲染前挂进镜头的
   * shared/<名字>/，提示词要求直接引用、不要重画。没有这个字段的镜头提示词与指纹都不变。
   */
  components: string[];
  // 镜头扩展块由 scene/blocks/ 下各自的模块用 declare module 并进这个接口，
  // 值为 null 表示 scene.json 里没有这个块。
  /**
   * 口播镜头在全片时间轴上的帧区间，由 onset scene cues 写入。
   * 老镜头没有这个字段，timing 为 null，提示词与校验都与引入之前一致。
   */
  timing: Timing | null;
  /**
   * 调度器在重试前填入的上一次失败说明，不来自 scene.json。
   * 同一提示词重跑大概率重蹈覆辙，把失败原因和归档日志位置交给渲染器，
   * 它才有机会换一种做法。
   */
  retryNote: string;
  /**
   * 记忆考试给本次作答加的要求（例如交出镜头的可读元素清单），不来自 scene.json。
   * 对照组与试用组拿到逐字相同的一段；正式渲染时为空，提示词与指纹都不变。
   */
  examNote: string;
  /**
   * 修接缝（scene_seams）时给本次渲染的要求：只改开头几帧、从前一镜的末帧接过来，不来自 scene.json。
   * 指纹不含它（fingerprint 清掉），修完的镜头照旧按本来的输入判断要不要重渲染。
   */
  seam: SeamRequest | null;
  /**
   * 中途异常退出后开新会话接着做（resume.ts 的第三层）：上次留下的文件与最后几步，不来自 scene.json，指纹清掉。
   */
  continuation: Continuation | null;
  /** 不接着上一次做，一律从头渲染（scene_run 的 fresh），不来自 scene.json。 */
  fresh: boolean;
  /** 试镜执行边界，不来自 scene.json、不参与输入指纹。 */
  audition?: boolean;
  /**
   * 调度器按并发数分给本镜头的帧捕获 worker 数，不来自 scene.json；
   * 0 表示沿用 HyperFrames 的 auto。
   */
  renderWorkers: number;
  /**
   * 本次渲染从记忆库召回的条目，由调用方（memory 经 cli）在渲染前填入，
   * 不来自 scene.json；null 或没有条目时提示词与指纹都与引入记忆之前一致。
   */
  memory: MemoryRecall | null;
  /**
   * 在每次渲染尝试写完尝试记录后调用，用来把这次尝试写成记忆经历。
   * 它不是镜头的输入，不参与指纹。
   */
  afterAttempt: ((attempt: Attempt) => void) | null;
  /**
   * 只写设计稿、不制作（两段式的第一段，scene.runDesign 的调用方填）：提示词换成设计稿的任务，
   * 渲染器只在镜头目录写 design.md。不来自 scene.json，指纹清掉。
   */
  designOnly?: boolean;
  /**
   * 本次渲染带上的参考范例（人在试镜里选中的同类镜头的合成代码，audition 包按学习关系挑），
   * 不来自 scene.json；没有时提示词与指纹都与引入之前一致。
   */
  exemplars?: ExemplarRecall | null;
}

/** 返回带上一次失败说明的副本，不修改原镜头。 */
export function withRetryNote(s: Scene, note: string): Scene {
  return { ...s, retryNote: note };
}

/** 返回指定渲染 worker 数的副本，不修改原镜头。 */
export function withRenderWorkers(s: Scene, workers: number): Scene {
  return { ...s, renderWorkers: workers };
}

export function outputPath(s: Scene): string {
  return path.join(s.directory, s.output);
}
export function streamLog(s: Scene): string {
  return path.join(s.directory, 'render-' + s.id + '.stream.jsonl');
}
export function stderrLog(s: Scene): string {
  return path.join(s.directory, 'render-' + s.id + '.stderr.log');
}
export function userLog(s: Scene): string {
  return path.join(s.directory, 'render-' + s.id + '.user.log');
}
