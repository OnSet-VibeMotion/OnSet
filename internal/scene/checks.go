package scene

import "strings"

// 产物校验的校验器 ID。渲染记忆的经验用它们声明「由谁判定」，经历按它们
// 聚类失败；ID 一经发布就不改名，改名会让已有经验引用失效。
const (
	CheckOutputMissing     = "output.missing"
	CheckOutputVideoStream = "output.video-stream"
	CheckOutputResolution  = "output.resolution"
	CheckOutputFPS         = "output.fps"
	CheckOutputDuration    = "output.duration"
	CheckOutputFrames      = "output.frames"
	CheckOutputAudio       = "output.audio"
	CheckOutputOther       = "output.other"
	// DeterminismCheckPrefix 接 internal/determinism 的规则 ID，如 determinism.raf。
	DeterminismCheckPrefix = "determinism."
	// CheckFramesBlank 是 am scene frames --check-blank 发现的空白帧。
	CheckFramesBlank = "frames.blank"
	// ReadsCheckPrefix 接 internal/reads 的规则 ID，如 reads.duration。
	ReadsCheckPrefix = "reads."
	// CheckReviewHandoff 是 am review 判定的约定交接没接上。
	CheckReviewHandoff = "review.handoff"
)

// OutputCheckIDs 返回全部产物校验器 ID，顺序固定。
func OutputCheckIDs() []string {
	return []string{CheckOutputMissing, CheckOutputVideoStream, CheckOutputResolution, CheckOutputFPS,
		CheckOutputDuration, CheckOutputFrames, CheckOutputAudio, CheckOutputOther}
}

// ClassifyOutputProblem 把 mediaprobe.Spec.Check 的一条问题归到校验器 ID。
//
// Spec.Check 只返回给人看的文字；按前缀归类而不是改它的返回类型，
// 是因为 validate video、concat 等调用方都在用那份文字。
func ClassifyOutputProblem(problem string) string {
	switch {
	case strings.HasPrefix(problem, "文件没有视频流"):
		return CheckOutputVideoStream
	case strings.HasPrefix(problem, "分辨率不符"):
		return CheckOutputResolution
	case strings.HasPrefix(problem, "帧率不符"):
		return CheckOutputFPS
	case strings.HasPrefix(problem, "时长不符"):
		return CheckOutputDuration
	case strings.HasPrefix(problem, "总帧数不符"):
		return CheckOutputFrames
	case strings.HasPrefix(problem, "应当没有音轨"), strings.HasPrefix(problem, "应当有音轨"), strings.HasPrefix(problem, "音频"):
		return CheckOutputAudio
	}
	return CheckOutputOther
}
