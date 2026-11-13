// Package memory 是渲染记忆：把每次渲染写成经历，整理成可检验的经验，
// 渲染前按镜头特征召回相关的几条注入提示词，经回放考试才转为长期记忆。
//
// 记忆属于 am，不属于某个渲染工具：存成纯文本放在用户级目录，召回在 Go 侧
// 完成，所有渲染工具收到逐字相同的一段。设计见
// docs/superpowers/specs/2026-11-02-渲染记忆-design.md。
package memory

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Kind 是记忆的层。经历不是 Memory，见 Episode。
type Kind string

const (
	// KindLesson 是经验：一条可由确定性校验器判定的约束。
	KindLesson Kind = "lesson"
	// KindPreference 是偏好：人工反馈里的审美取向，无法机器判定，不参加考试。
	KindPreference Kind = "preference"
)

// dir 是该层记忆在记忆库里的子目录。
func (k Kind) dir() string {
	if k == KindPreference {
		return "preferences"
	}
	return "lessons"
}

// Status 是记忆的生命周期状态。
type Status string

const (
	// StatusTrial 只在考试里使用，不进入正式渲染。
	StatusTrial Status = "trial"
	// StatusActive 会被正式召回。
	StatusActive Status = "active"
	// StatusRejected 考试未通过，保留原因，不会被召回。
	StatusRejected Status = "rejected"
	// StatusDormant 已淡出或被修订取代，不再召回。
	StatusDormant Status = "dormant"
)

func validStatus(s Status) bool {
	switch s {
	case StatusTrial, StatusActive, StatusRejected, StatusDormant:
		return true
	}
	return false
}

// Applies 是记忆的适用条件。两项都为空表示全局适用。
//
// Renderers 与 Models 是硬性范围，不参与打分之外的匹配：写了就只对这些渲染工具 /
// 模型召回。同一类错误在不同模型上出现的频率差得很远，只在某个模型上成立的经验
// 注入给别的模型，只会白占召回预算，甚至误导。
type Applies struct {
	Features []string `yaml:"features,omitempty" json:"features,omitempty"`
	Keywords []string `yaml:"keywords,omitempty" json:"keywords,omitempty"`
	// Renderers 是渲染工具 ID（codex、claude……），为空表示不限。
	Renderers []string `yaml:"renderers,omitempty" json:"renderers,omitempty"`
	// Models 是模型名，按不区分大小写的前缀匹配（gpt-6 匹配 gpt-6-astra），为空表示不限。
	// 当前模型未知时，限定了模型的记忆不召回。
	Models []string `yaml:"models,omitempty" json:"models,omitempty"`
}

func (a Applies) empty() bool { return len(a.Features) == 0 && len(a.Keywords) == 0 }

// Scoped 报告记忆是否限定了渲染工具或模型。
func (a Applies) Scoped() bool { return len(a.Renderers) > 0 || len(a.Models) > 0 }

// inScope 报告记忆是否适用于这个渲染工具与模型。
func (a Applies) inScope(renderer, model string) bool {
	if len(a.Renderers) > 0 && !contains(a.Renderers, renderer) {
		return false
	}
	if len(a.Models) == 0 {
		return true
	}
	return ModelMatches(model, a.Models)
}

// ModelMatches 报告 model 是否命中 patterns 中任意一个（不区分大小写的前缀匹配）。
func ModelMatches(model string, patterns []string) bool {
	model = strings.ToLower(strings.TrimSpace(model))
	if model == "" {
		return false
	}
	for _, pattern := range patterns {
		if p := strings.ToLower(strings.TrimSpace(pattern)); p != "" && strings.HasPrefix(model, p) {
			return true
		}
	}
	return false
}

// Meta 是记忆文件的 frontmatter。
//
// 效果统计不写在这里：它由经历聚合得出（见 stats.go），并在生成快照时冻结进
// 快照。写进记忆文件的话，并发渲染的镜头会同时改同一个文件，而且每次统计一变
// 记忆内容摘要就变，所有召回它的镜头都会被判成 Stale。
type Meta struct {
	Name        string   `yaml:"name" json:"name"`
	Description string   `yaml:"description" json:"description"`
	Status      Status   `yaml:"status" json:"status"`
	AppliesWhen Applies  `yaml:"applies_when,omitempty" json:"applies_when"`
	CheckedBy   []string `yaml:"checked_by" json:"checked_by"`
	// Scope 只对偏好有意义：空表示全局，否则是项目目录名。
	Scope        string   `yaml:"scope,omitempty" json:"scope,omitempty"`
	FromEpisodes []string `yaml:"from_episodes,omitempty" json:"from_episodes,omitempty"`
	VerifiedBy   []string `yaml:"verified_by,omitempty" json:"verified_by,omitempty"`
	// Revises 是被本条修订的旧记忆名。本条生效时旧记忆转为沉睡。
	Revises        string `yaml:"revises,omitempty" json:"revises,omitempty"`
	RejectedReason string `yaml:"rejected_reason,omitempty" json:"rejected_reason,omitempty"`
}

// Memory 是一条经验或偏好。
type Memory struct {
	Meta
	Kind Kind   `json:"kind"`
	Body string `json:"body"`
}

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`)

// ValidName 报告 name 能否作为记忆名（同时是文件名）。
func ValidName(name string) bool { return namePattern.MatchString(name) }

// Parse 解析一个记忆文件。kind 由所在目录决定，不写在文件里。
func Parse(kind Kind, content []byte) (Memory, error) {
	text := strings.ReplaceAll(string(content), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return Memory{}, fmt.Errorf("缺少 frontmatter（文件必须以 --- 开头）")
	}
	rest := text[len("---\n"):]
	end := strings.Index(rest, "\n---\n")
	var front, body string
	switch {
	case end >= 0:
		front, body = rest[:end], rest[end+len("\n---\n"):]
	case strings.HasSuffix(rest, "\n---"):
		front = strings.TrimSuffix(rest, "\n---")
	default:
		return Memory{}, fmt.Errorf("frontmatter 没有以 --- 结束")
	}
	var meta Meta
	decoder := yaml.NewDecoder(strings.NewReader(front))
	decoder.KnownFields(true)
	if err := decoder.Decode(&meta); err != nil {
		return Memory{}, fmt.Errorf("frontmatter 不合法：%w", err)
	}
	return Memory{Meta: meta, Kind: kind, Body: strings.TrimSpace(body)}, nil
}

// Format 把记忆写回文件内容。Parse(Format(m)) 与 m 等价。
func Format(m Memory) []byte {
	var front bytes.Buffer
	encoder := yaml.NewEncoder(&front)
	encoder.SetIndent(2)
	_ = encoder.Encode(m.Meta)
	_ = encoder.Close()
	return []byte("---\n" + front.String() + "---\n\n" + strings.TrimSpace(m.Body) + "\n")
}

// RuleDigest 是记忆「规则内容」的摘要：只含会进入提示词的部分（名字、描述、
// 正文、适用条件与判定校验器），不含状态、来源与考试记录。
//
// 镜头的输入指纹用它：一条记忆从试用转为生效、补上一条来源经历，都不改变
// 渲染器收到的文字，不该让召回它的镜头变成 Stale。
func (m Memory) RuleDigest() string {
	h := sha256.New()
	fmt.Fprintf(h, "kind=%s\nname=%s\ndescription=%s\nfeatures=%s\nkeywords=%s\nchecked_by=%s\nscope=%s\n",
		m.Kind, m.Name, m.Description, strings.Join(m.AppliesWhen.Features, ","), strings.Join(m.AppliesWhen.Keywords, ","),
		strings.Join(m.CheckedBy, ","), m.Scope)
	// 范围字段只在写了时计入，没写范围的老记忆摘要不变。
	if m.AppliesWhen.Scoped() {
		fmt.Fprintf(h, "renderers=%s\nmodels=%s\n", strings.Join(m.AppliesWhen.Renderers, ","), strings.Join(m.AppliesWhen.Models, ","))
	}
	fmt.Fprintf(h, "\n%s", m.Body)
	return hex.EncodeToString(h.Sum(nil))
}

func digestBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
