package memory

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/chouheiwa/articale-to-motion/internal/determinism"
	"github.com/chouheiwa/articale-to-motion/internal/reads"
	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

// FeatureDescriptions 是镜头特征词表：召回按它匹配，整理时交给整理者，
// 格式校验要求经验的 applies_when.features 只能取这里的值。
// 新增特征要同时改 Features 的抽取逻辑。
var FeatureDescriptions = map[string]string{
	"cjk_text":      "镜头文本含中文",
	"numbers":       "镜头文本含数字",
	"dense_text":    "文本密度高（每秒超过 6.5 个阅读单位）",
	"short_scene":   "镜头短于 2 秒",
	"long_scene":    "镜头长于 10 秒",
	"portrait":      "竖屏画布",
	"landscape":     "横屏画布",
	"square":        "方形画布",
	"cast":          "有角色（cast 块）",
	"song":          "歌曲模式",
	"beat":          "卡点模式",
	"timing":        "有口播时间合同（timing 块）",
	"handoff":       "与相邻镜头有交接约定",
	"cross_chapter": "交接跨章节",
	"lottie":        "创意方向提到 Lottie",
	"chart":         "创意方向提到图表",
	"three_d":       "创意方向提到 3D / three.js / WebGL",
}

// handoffFeaturePrefix 接交接手法名，如 handoff:carry。
const handoffFeaturePrefix = "handoff:"

// KnownFeature 报告 name 是不是词表里的特征（含 handoff:<手法>）。
func KnownFeature(name string) bool {
	if _, ok := FeatureDescriptions[name]; ok {
		return true
	}
	if device, ok := strings.CutPrefix(name, handoffFeaturePrefix); ok {
		return scene.HandoffGuide(device) != ""
	}
	return false
}

// Features 从镜头输入里抽取特征，结果有序、确定。
func Features(s scene.Scene) ([]string, error) {
	set := map[string]bool{}
	readable := 0
	inWord := false
	for _, r := range s.Text {
		switch {
		case unicode.Is(unicode.Han, r):
			set["cjk_text"] = true
			readable++
			inWord = false
		case unicode.IsDigit(r):
			set["numbers"] = true
			if !inWord {
				readable++
			}
			inWord = true
		case unicode.IsLetter(r):
			if !inWord {
				readable++
			}
			inWord = true
		default:
			inWord = false
		}
	}
	if s.DurationSeconds > 0 && float64(readable)/s.DurationSeconds > 6.5 {
		set["dense_text"] = true
	}
	if s.DurationSeconds < 2 {
		set["short_scene"] = true
	}
	if s.DurationSeconds > 10 {
		set["long_scene"] = true
	}
	canvas, err := scene.CanvasOf(s.Directory, s.StyleGuide)
	if err != nil {
		return nil, err
	}
	switch {
	case canvas.HeightPx > canvas.WidthPx:
		set["portrait"] = true
	case canvas.WidthPx > canvas.HeightPx:
		set["landscape"] = true
	default:
		set["square"] = true
	}
	if s.Cast != nil {
		set["cast"] = true
	}
	if s.Song != nil {
		set["song"] = true
	}
	if s.Beat != nil {
		set["beat"] = true
	}
	if s.Timing != nil {
		set["timing"] = true
		for _, side := range []scene.Handoff{s.Timing.Enter, s.Timing.Exit} {
			if side == (scene.Handoff{}) {
				continue
			}
			set["handoff"] = true
			set[handoffFeaturePrefix+side.Device] = true
			if side.CrossChapter {
				set["cross_chapter"] = true
			}
		}
	}
	prompt := strings.ToLower(promptText(s))
	for feature, words := range map[string][]string{
		"lottie":  {"lottie"},
		"chart":   {"图表", "柱状", "折线", "饼图", "chart"},
		"three_d": {"three.js", "threejs", "webgl", "3d"},
	} {
		for _, word := range words {
			if strings.Contains(prompt, word) {
				set[feature] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for feature := range set {
		out = append(out, feature)
	}
	sort.Strings(out)
	return out, nil
}

// promptText 是镜头的创意方向（prompt.md），没有时为空。
func promptText(s scene.Scene) string {
	body, err := os.ReadFile(filepath.Join(s.Directory, "prompt.md"))
	if err != nil {
		return ""
	}
	return string(body)
}

// CheckerHuman 只能出现在偏好的 checked_by 里：偏好由人判定。
const CheckerHuman = "human"

// KnownCheckers 返回经验可以引用的全部校验器 ID。
func KnownCheckers() []string {
	ids := scene.OutputCheckIDs()
	for _, rule := range determinism.RuleIDs() {
		ids = append(ids, scene.DeterminismCheckPrefix+rule)
	}
	ids = append(ids, scene.CheckFramesBlank)
	for _, rule := range reads.RuleIDs() {
		ids = append(ids, scene.ReadsCheckPrefix+rule)
	}
	return append(ids, scene.CheckReviewHandoff)
}

// Examinable 报告校验器能否在单镜头回放考试里判定。
//
// 产物校验、确定性扫描在渲染后自动跑；空白帧由考试在作答后补查首帧。
// 阅读时间要读整片的可读元素清单与短语时间轴，交接要看相邻镜头，单镜头重放
// 判不了——只靠它们判定的经验不进考试，由人确认后生效，标为未经考试。
func Examinable(id string) bool {
	return !strings.HasPrefix(id, scene.ReadsCheckPrefix) && id != scene.CheckReviewHandoff
}

// ExaminableLesson 报告经验是否至少有一个校验器能在考试里判定。
func ExaminableLesson(m Memory) bool {
	for _, id := range m.CheckedBy {
		if Examinable(id) {
			return true
		}
	}
	return false
}

func knownChecker(id string) bool {
	for _, known := range KnownCheckers() {
		if id == known {
			return true
		}
	}
	return false
}
