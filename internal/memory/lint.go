package memory

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// 记忆的长度上限（按字符计）。召回有总字数预算，单条太长会挤掉别的记忆。
const (
	MaxDescriptionChars = 80
	MaxBodyChars        = 600
)

// forbiddenTool 匹配渲染工具名与模型名。经验必须与模型无关：写着「Claude 要这样」
// 的记忆换一个渲染工具就不成立，而记忆是所有渲染工具共用的。
var forbiddenTool = regexp.MustCompile(`(?i)(^|[^a-z0-9])(claude|codex|qoder|codebuddy|opencode|chatgpt|gpt-?\d*|gemini|sonnet|opus|haiku|anthropic|openai|deepseek|qwen|kimi|glm)([^a-z0-9]|$)`)

// 具体镜头的痕迹：镜头编号与素材文件名。写进经验等于背题，换一篇文章就没用。
var (
	sceneIDPattern   = regexp.MustCompile(`(?i)\bscene-\d+\b`)
	mediaNamePattern = regexp.MustCompile(`(?i)[\w.-]+\.(mp4|mov|webm|png|jpe?g|webp|gif|wav|mp3|m4a|aac|srt)\b`)
)

// copiedRunLength 是判定「抄了镜头文案」的最短连续字数。
const copiedRunLength = 8

// LintContext 是格式校验需要的上下文。
type LintContext struct {
	// Existing 是记忆库里已有的记忆，用来查重名、修订目标与并列冲突。
	Existing []Memory
	// SceneTexts 是经历里的镜头文本，经验不得照抄其中的连续片段。
	SceneTexts []string
}

// Lint 检查一条记忆能否进入试用，返回全部不合格项。
func Lint(m Memory, ctx LintContext) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	if !ValidName(m.Name) {
		add("name 不合法：%q（小写字母、数字与连字符，3–64 字符）", m.Name)
	}
	if strings.TrimSpace(m.Description) == "" {
		add("description 为空")
	} else if n := utf8.RuneCountInString(m.Description); n > MaxDescriptionChars {
		add("description 有 %d 字，上限 %d", n, MaxDescriptionChars)
	}
	if !validStatus(m.Status) {
		add("status 不合法：%q", m.Status)
	}
	if strings.TrimSpace(m.Body) == "" {
		add("正文为空")
	} else if n := utf8.RuneCountInString(m.Body); n > MaxBodyChars {
		add("正文有 %d 字，上限 %d", n, MaxBodyChars)
	}
	switch m.Kind {
	case KindLesson:
		if len(m.CheckedBy) == 0 {
			add("checked_by 为空：说不清由哪个校验器判定的经验不能进入试用")
		}
		for _, id := range m.CheckedBy {
			if id == CheckerHuman {
				add("经验的 checked_by 不能是 human；只能由人判定的取向请写成偏好")
			} else if !knownChecker(id) {
				add("checked_by 引用了不存在的校验器：%s", id)
			}
		}
		if !strings.Contains(m.Body, "反例") || !strings.Contains(m.Body, "正例") {
			add("经验正文必须同时给出「反例」与「正例」")
		}
		if m.Scope != "" {
			add("scope 只对偏好有意义")
		}
	case KindPreference:
		if len(m.CheckedBy) != 1 || m.CheckedBy[0] != CheckerHuman {
			add("偏好的 checked_by 必须是 [human]")
		}
	default:
		add("未知的记忆层：%q", m.Kind)
	}
	for _, feature := range m.AppliesWhen.Features {
		if !KnownFeature(feature) {
			add("applies_when.features 含未知特征：%s", feature)
		}
	}
	for _, renderer := range m.AppliesWhen.Renderers {
		if !tools.ValidTools[renderer] {
			add("applies_when.renderers 含未知渲染工具：%s", renderer)
		}
	}
	for _, model := range m.AppliesWhen.Models {
		if strings.TrimSpace(model) == "" || strings.ContainsAny(model, " \t\n") {
			add("applies_when.models 含不合法的模型名：%q", model)
		}
	}
	all := strings.Join(append([]string{m.Name, m.Description, m.Body}, m.AppliesWhen.Keywords...), "\n")
	if match := forbiddenTool.FindStringSubmatch(all); match != nil {
		add("正文里出现了渲染工具名或模型名「%s」：只对某个渲染工具或模型成立时，写进 applies_when.renderers / models，正文保持中性", match[2])
	}
	if match := sceneIDPattern.FindString(all); match != "" {
		add("出现了具体镜头编号「%s」", match)
	}
	if match := mediaNamePattern.FindString(all); match != "" {
		add("出现了具体素材文件名「%s」", match)
	}
	if copied := copiedFragment(m.Body+"\n"+m.Description, ctx.SceneTexts); copied != "" {
		add("照抄了镜头文案「%s」：经验要写成可迁移的约束，不能背题", copied)
	}
	problems = append(problems, lintAgainstExisting(m, ctx.Existing)...)
	return problems
}

func lintAgainstExisting(m Memory, existing []Memory) []string {
	var problems []string
	if m.Revises != "" {
		if m.Revises == m.Name {
			problems = append(problems, "revises 不能指向自己")
		} else if !slices.ContainsFunc(existing, func(e Memory) bool { return e.Name == m.Revises }) {
			problems = append(problems, fmt.Sprintf("revises 指向不存在的记忆：%s", m.Revises))
		}
	}
	for _, other := range existing {
		if other.Name == m.Name || other.Name == m.Revises || other.Kind != m.Kind {
			continue
		}
		if other.Status != StatusActive && other.Status != StatusTrial {
			continue
		}
		if m.Kind == KindLesson && sameSet(other.CheckedBy, m.CheckedBy) && sameSet(other.AppliesWhen.Features, m.AppliesWhen.Features) &&
			sameSet(other.AppliesWhen.Renderers, m.AppliesWhen.Renderers) && sameSet(other.AppliesWhen.Models, m.AppliesWhen.Models) {
			problems = append(problems, fmt.Sprintf("与已有记忆 %s 由同一组校验器判定、适用特征与渲染工具/模型范围相同：请写成对它的修订（revises: %s），不要并列新增", other.Name, other.Name))
		}
	}
	return problems
}

func sameSet(a, b []string) bool {
	x := append([]string(nil), a...)
	y := append([]string(nil), b...)
	sort.Strings(x)
	sort.Strings(y)
	return slices.Equal(x, y)
}

// copiedFragment 返回 text 中第一段与某条镜头文本相同、长度至少 copiedRunLength
// 的连续片段（忽略空白与标点）。
func copiedFragment(text string, sceneTexts []string) string {
	body := normalizeRunes(text)
	if len(body) < copiedRunLength {
		return ""
	}
	windows := map[string]bool{}
	for _, sceneText := range sceneTexts {
		runes := normalizeRunes(sceneText)
		for i := 0; i+copiedRunLength <= len(runes); i++ {
			windows[string(runes[i:i+copiedRunLength])] = true
		}
	}
	for i := 0; i+copiedRunLength <= len(body); i++ {
		if window := string(body[i : i+copiedRunLength]); windows[window] {
			return window
		}
	}
	return ""
}

func normalizeRunes(text string) []rune {
	var out []rune
	for _, r := range text {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			out = append(out, unicode.ToLower(r))
		}
	}
	return out
}
