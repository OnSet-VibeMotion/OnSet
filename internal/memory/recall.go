package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

// RecallItem 是一条被考虑的记忆及其召回理由。
type RecallItem struct {
	Name            string   `json:"name"`
	Kind            Kind     `json:"kind"`
	Status          Status   `json:"status"`
	Description     string   `json:"description"`
	Score           float64  `json:"score"`
	Global          bool     `json:"global,omitempty"`
	Renderers       []string `json:"renderers,omitempty"`
	Models          []string `json:"models,omitempty"`
	MatchedFeatures []string `json:"matched_features,omitempty"`
	MatchedKeywords []string `json:"matched_keywords,omitempty"`
	// Rate 是排序时用的一次通过率估计（拉普拉斯平滑，无样本时为 0.5）。
	Rate  float64 `json:"rate"`
	Chars int     `json:"chars"`
	// Text 是这条记忆注入提示词的原文。
	Text   string `json:"text"`
	digest string
}

// Reason 用一句话说明为什么想起这条记忆。
func (i RecallItem) Reason() string {
	var parts []string
	if i.Global {
		parts = append(parts, "全局适用")
	} else {
		var matched []string
		if len(i.MatchedFeatures) > 0 {
			matched = append(matched, "特征 "+strings.Join(i.MatchedFeatures, "、"))
		}
		if len(i.MatchedKeywords) > 0 {
			matched = append(matched, "关键词 "+strings.Join(i.MatchedKeywords, "、"))
		}
		parts = append(parts, "匹配"+strings.Join(matched, "，"))
	}
	if scope := append(append([]string{}, i.Renderers...), i.Models...); len(scope) > 0 {
		parts = append(parts, "专为 "+strings.Join(scope, "、"))
	}
	return strings.Join(parts, "；")
}

// RecallResult 是一个镜头的召回结果。
type RecallResult struct {
	Snapshot int          `json:"snapshot"`
	Renderer string       `json:"renderer"`
	Model    string       `json:"model,omitempty"`
	Features []string     `json:"features"`
	Budget   int          `json:"budget"`
	Used     int          `json:"used"`
	Items    []RecallItem `json:"items"`
	// Omitted 是匹配上但超出字数预算的记忆。
	Omitted []RecallItem `json:"omitted,omitempty"`
}

// Names 返回召回的记忆名，按注入顺序。
func (r RecallResult) Names() []string {
	names := make([]string, 0, len(r.Items))
	for _, item := range r.Items {
		names = append(names, item.Name)
	}
	return names
}

// Section 是注入提示词的记忆段；没有召回时为空。
//
// 文本里刻意不写快照号：回退到内容相同的快照、或快照只多了与本镜头无关的
// 记忆时，召回段逐字不变，镜头不该因此变成 Stale。
func (r RecallResult) Section() string {
	if len(r.Items) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n记忆（召回，来自以往渲染的经验，按本镜头特征选取；与上面的强制要求冲突时以上面为准）：\n")
	for _, item := range r.Items {
		b.WriteString(item.Text)
	}
	return b.String()
}

// Digest 是召回条目规则内容的摘要，写进输入指纹的 memory 项。
func (r RecallResult) Digest() string {
	h := sha256.New()
	for _, item := range r.Items {
		fmt.Fprintf(h, "%s=%s\n", item.Name, item.digest)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Attach 把召回结果挂到镜头上，供 BuildPrompt 注入、Fingerprint 记录。
func (r RecallResult) Attach(s scene.Scene) scene.Scene {
	if len(r.Items) == 0 {
		s.Memory = nil
		return s
	}
	s.Memory = &scene.MemoryRecall{Snapshot: r.Snapshot, Names: r.Names(), Section: r.Section(), Digest: r.Digest()}
	return s
}

// RecallInput 是一次召回的全部输入。同样的输入永远得到同样的结果。
type RecallInput struct {
	Memories []Memory
	Stats    map[string]map[string]Stat
	Renderer string
	// Model 是当前渲染工具的模型，未知时为空。
	Model    string
	Features []string
	// Text 是参与关键词匹配的文本（镜头文本与创意方向）。
	Text    string
	Project string
	Budget  int
}

// Recall 选出要注入的记忆：按适用条件匹配，按匹配度 × 效果排序，取到字数预算用完。
//
// 只用特征加关键词，不用向量检索：召回要可解释（能说出为什么想起它）、
// 可复现（同一快照同一结果）、零依赖。
func Recall(in RecallInput) RecallResult {
	result := RecallResult{Renderer: in.Renderer, Model: in.Model, Features: append([]string{}, in.Features...), Budget: in.Budget, Items: []RecallItem{}}
	features := map[string]bool{}
	for _, feature := range in.Features {
		features[feature] = true
	}
	text := strings.ToLower(in.Text)
	var candidates []RecallItem
	for _, m := range in.Memories {
		if m.Kind == KindPreference && m.Scope != "" && m.Scope != in.Project {
			continue
		}
		if !m.AppliesWhen.inScope(in.Renderer, in.Model) {
			continue
		}
		item := RecallItem{Name: m.Name, Kind: m.Kind, Status: m.Status, Description: m.Description, digest: m.RuleDigest(),
			Renderers: m.AppliesWhen.Renderers, Models: m.AppliesWhen.Models}
		var match float64
		if m.AppliesWhen.empty() {
			item.Global = true
			match = 0.5
		} else {
			for _, feature := range m.AppliesWhen.Features {
				if features[feature] {
					item.MatchedFeatures = append(item.MatchedFeatures, feature)
					match++
				}
			}
			for _, keyword := range m.AppliesWhen.Keywords {
				if keyword != "" && strings.Contains(text, strings.ToLower(keyword)) {
					item.MatchedKeywords = append(item.MatchedKeywords, keyword)
					match += 0.5
				}
			}
			if match == 0 {
				continue
			}
		}
		// 专为当前渲染工具 / 模型写的经验更可能对症，排在通用经验前面。
		if len(m.AppliesWhen.Renderers) > 0 {
			match += 0.5
		}
		if len(m.AppliesWhen.Models) > 0 {
			match++
		}
		item.Rate = smoothedRate(in.Stats[m.Name], in.Renderer)
		item.Score = match * (0.5 + item.Rate)
		item.Text = renderItem(m)
		item.Chars = utf8.RuneCountInString(item.Text)
		candidates = append(candidates, item)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Score != candidates[j].Score {
			return candidates[i].Score > candidates[j].Score
		}
		return candidates[i].Name < candidates[j].Name
	})
	for _, item := range candidates {
		if result.Used+item.Chars > in.Budget {
			result.Omitted = append(result.Omitted, item)
			continue
		}
		result.Used += item.Chars
		result.Items = append(result.Items, item)
	}
	return result
}

// smoothedRate 用该渲染工具的统计；它没有样本时用全部渲染工具的合计。
func smoothedRate(stats map[string]Stat, renderer string) float64 {
	stat, ok := stats[renderer]
	if !ok || stat.Recalled == 0 {
		stat = Stat{}
		for _, s := range stats {
			stat.Recalled += s.Recalled
			stat.PassedFirstTry += s.PassedFirstTry
		}
	}
	return float64(stat.PassedFirstTry+1) / float64(stat.Recalled+2)
}

func renderItem(m Memory) string {
	var b strings.Builder
	label := ""
	if m.Kind == KindPreference {
		label = "（偏好，未经机器验证）"
	}
	fmt.Fprintf(&b, "- 【%s】%s%s\n", m.Name, label, m.Description)
	for _, line := range strings.Split(strings.TrimSpace(m.Body), "\n") {
		if strings.TrimSpace(line) == "" {
			b.WriteString("\n")
			continue
		}
		b.WriteString("  " + line + "\n")
	}
	return b.String()
}

// RecallOptions 是对一个镜头做召回时的设置。
type RecallOptions struct {
	// Snapshot 为 0 时跟随最新快照。
	Snapshot int
	Budget   int
	Renderer string
	// Model 是当前渲染工具的模型，见 Store.CurrentModel；未知时为空。
	Model string
	// Extra 是额外参与召回的记忆（考试里的试用记忆）。
	Extra []Memory
}

// RecallScene 对一个镜头做召回。记忆库还没有快照且没有 Extra 时什么也不召回。
func (s *Store) RecallScene(sc scene.Scene, opts RecallOptions) (RecallResult, error) {
	features, err := Features(sc)
	if err != nil {
		return RecallResult{}, err
	}
	var memories []Memory
	stats := map[string]map[string]Stat{}
	snapshotID := 0
	snapshot, ok, err := s.ResolveSnapshot(opts.Snapshot)
	if err != nil {
		return RecallResult{}, err
	}
	if ok {
		snapshotID = snapshot.ID
		memories, err = snapshot.Memories()
		if err != nil {
			return RecallResult{}, err
		}
		if snapshot.Stats != nil {
			stats = snapshot.Stats
		}
	}
	memories = withExtra(memories, opts.Extra)
	result := Recall(RecallInput{Memories: memories, Stats: stats, Renderer: opts.Renderer, Model: opts.Model, Features: features,
		Text: sc.Text + "\n" + promptText(sc), Project: projectOf(sc.Directory), Budget: opts.Budget})
	result.Snapshot = snapshotID
	return result, nil
}

// withExtra 把试用记忆加进召回池；试用记忆是某条生效记忆的修订时，
// 被修订的旧版本退出召回池——两版同时注入就等于并列新增。
func withExtra(memories, extra []Memory) []Memory {
	replaced := map[string]bool{}
	for _, m := range extra {
		if m.Revises != "" {
			replaced[m.Revises] = true
		}
	}
	out := make([]Memory, 0, len(memories)+len(extra))
	for _, m := range memories {
		if !replaced[m.Name] {
			out = append(out, m)
		}
	}
	return append(out, extra...)
}
