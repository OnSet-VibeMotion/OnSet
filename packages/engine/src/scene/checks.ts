// 移植自 internal/scene/checks.go。
//
// 产物校验的校验器 ID。渲染记忆的经验用它们声明「由谁判定」，经历按它们
// 聚类失败；ID 一经发布就不改名，改名会让已有经验引用失效。
export const CheckOutputMissing = 'output.missing';
export const CheckOutputVideoStream = 'output.video-stream';
export const CheckOutputResolution = 'output.resolution';
export const CheckOutputFPS = 'output.fps';
export const CheckOutputDuration = 'output.duration';
export const CheckOutputFrames = 'output.frames';
export const CheckOutputAudio = 'output.audio';
export const CheckOutputOther = 'output.other';
/** 接 determinism 的规则 ID，如 determinism.raf。 */
export const DeterminismCheckPrefix = 'determinism.';
/** am scene frames --check-blank 发现的空白帧。 */
export const CheckFramesBlank = 'frames.blank';
/** 接 reads 的规则 ID，如 reads.duration。 */
export const ReadsCheckPrefix = 'reads.';
/** am review 判定的约定交接没接上。 */
export const CheckReviewHandoff = 'review.handoff';

/** 全部产物校验器 ID，顺序固定。 */
export function outputCheckIDs(): string[] {
  return [
    CheckOutputMissing,
    CheckOutputVideoStream,
    CheckOutputResolution,
    CheckOutputFPS,
    CheckOutputDuration,
    CheckOutputFrames,
    CheckOutputAudio,
    CheckOutputOther,
  ];
}

/**
 * 把 mediaprobe.checkSpec 的一条问题归到校验器 ID。
 *
 * checkSpec 只返回给人看的文字；按前缀归类而不是改它的返回类型，
 * 是因为 validate video、concat 等调用方都在用那份文字。
 */
export function classifyOutputProblem(problem: string): string {
  if (problem.startsWith('文件没有视频流')) return CheckOutputVideoStream;
  if (problem.startsWith('分辨率不符')) return CheckOutputResolution;
  if (problem.startsWith('帧率不符')) return CheckOutputFPS;
  if (problem.startsWith('时长不符')) return CheckOutputDuration;
  if (problem.startsWith('总帧数不符')) return CheckOutputFrames;
  if (problem.startsWith('应当没有音轨') || problem.startsWith('应当有音轨') || problem.startsWith('音频')) return CheckOutputAudio;
  return CheckOutputOther;
}
