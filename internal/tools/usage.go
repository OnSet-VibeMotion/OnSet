package tools

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// Usage 是从渲染工具输出流里读到的用量。字段缺失就保持零值或 nil，
// 不做估算：报出一个编出来的数比不报更误导。
//
// 各家的口径不同，这里统一成一种，跨工具才能比、才能相加：
//   - InputTokens 是全部输入，含缓存命中与缓存写入。codex 原样就是这个口径；
//     claude 系与 opencode 的 input 不含缓存，要把缓存读写加回来——不加的话
//     claude 一次渲染显示「输入 4、缓存 40437」，缓存比输入还大。
//   - CachedInputTokens 是输入里命中缓存的部分，恒不大于 InputTokens。
//   - OutputTokens 含推理 / 思考 token。opencode 单列 reasoning，要加回来。
type Usage struct {
	InputTokens       int64    `json:"input_tokens,omitempty"`
	OutputTokens      int64    `json:"output_tokens,omitempty"`
	CachedInputTokens int64    `json:"cached_input_tokens,omitempty"`
	CostUSD           *float64 `json:"cost_usd,omitempty"`
	Turns             int      `json:"turns,omitempty"`
	// Partial 表示汇总里有的部分没读到用量或费用，数字只是下限。
	Partial bool `json:"partial,omitempty"`
	// Basis 标明口径。新记录都是 BasisTotalInput；没有这个字段的是统一口径之前
	// 写下的老记录，读的时候用 Normalized 换算。
	Basis string `json:"basis,omitempty"`
	// Source 记下数字来自哪种事件，方便日后核对格式是否变了。
	Source string `json:"source,omitempty"`
}

// BasisTotalInput 是统一后的口径：输入含缓存。
const BasisTotalInput = "total-input"

// Normalized 把老记录换成统一口径。claude 系与 opencode 的老记录输入里不含缓存
// 命中，加回去；opencode 老记录没记缓存写入与推理 token，补不回来，只能偏低。
func (u Usage) Normalized() Usage {
	if u.Basis != "" || u.Empty() {
		return u
	}
	switch u.Source {
	case "claude result", "qoder result", "codebuddy result", "opencode step_finish":
		u.InputTokens += u.CachedInputTokens
	}
	u.Basis = BasisTotalInput
	return u
}

// Empty 表示一个用量事件都没读到。
func (u Usage) Empty() bool { return u.Source == "" }

// Total 是输入加输出的总 token 数。
func (u Usage) Total() int64 { return u.InputTokens + u.OutputTokens }

// Add 把 other 并进 u，用于跨尝试、跨镜头汇总。费用只在双方都有时相加，
// 一方缺失时保留已知部分并标出不完整（Partial）。
func (u *Usage) Add(other Usage) {
	other = other.Normalized()
	if other.Empty() {
		// 没读到用量的一次也要留下痕迹：之后读到的数字就只是下限了。
		u.Partial = true
		return
	}
	if u.Empty() {
		partial := u.Partial
		cost := other.CostUSD
		if cost != nil {
			c := *cost
			cost = &c
		}
		*u = Usage{InputTokens: other.InputTokens, OutputTokens: other.OutputTokens, CachedInputTokens: other.CachedInputTokens,
			CostUSD: cost, Turns: other.Turns, Source: other.Source, Partial: other.Partial || partial, Basis: BasisTotalInput}
		return
	}
	u.InputTokens += other.InputTokens
	u.OutputTokens += other.OutputTokens
	u.CachedInputTokens += other.CachedInputTokens
	u.Turns += other.Turns
	u.Partial = u.Partial || other.Partial
	switch {
	case u.CostUSD != nil && other.CostUSD != nil:
		total := *u.CostUSD + *other.CostUSD
		u.CostUSD = &total
	case u.CostUSD != nil || other.CostUSD != nil:
		u.Partial = true
	}
	if u.Source != other.Source {
		u.Source = "mixed"
	}
}

// AccumulateUsage 把输出流的一行并进 u。认不出的行原样忽略。
//
// 格式按各工具的流式 JSON 约定读取，没有逐个版本实测，所以这里只是尽力而为：
//   - claude 系（stream-json）：收尾的 {"type":"result"} 事件带整次调用的
//     usage、total_cost_usd 与 num_turns，是累计值，以最后一条为准。
//   - codex（exec --json）：每轮结束的 {"type":"turn.completed"} 带该轮 usage，逐轮相加。
//   - opencode（run --format json）：每步结束的 {"type":"step_finish"} 在 part 里带
//     该步的 tokens 与 cost，逐步相加（2026-11 用 v2.1.0 实测）。
//
// 其他工具读不到就留空，尝试记录里照常写耗时。
func AccumulateUsage(tool, line string, u *Usage) {
	if tool == "opencode" {
		accumulateOpencodeUsage(line, u)
		return
	}
	var event struct {
		Type  string   `json:"type"`
		Cost  *float64 `json:"total_cost_usd"`
		Turns int      `json:"num_turns"`
		Usage *struct {
			Input       int64 `json:"input_tokens"`
			Output      int64 `json:"output_tokens"`
			Cached      int64 `json:"cached_input_tokens"`
			CacheRead   int64 `json:"cache_read_input_tokens"`
			CacheCreate int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal([]byte(line), &event) != nil || event.Usage == nil {
		return
	}
	switch {
	case tool == "codex" && event.Type == "turn.completed":
		u.InputTokens += event.Usage.Input
		u.OutputTokens += event.Usage.Output
		u.CachedInputTokens += event.Usage.Cached
		u.Turns++
		u.Source = "codex turn.completed"
		u.Basis = BasisTotalInput
	case (tool == "claude" || tool == "qoder" || tool == "codebuddy") && event.Type == "result":
		u.InputTokens = event.Usage.Input + event.Usage.CacheCreate + event.Usage.CacheRead
		u.OutputTokens = event.Usage.Output
		u.CachedInputTokens = event.Usage.CacheRead
		u.CostUSD = event.Cost
		u.Turns = event.Turns
		u.Source = tool + " result"
		u.Basis = BasisTotalInput
	}
}

func accumulateOpencodeUsage(line string, u *Usage) {
	var event struct {
		Type string `json:"type"`
		Part struct {
			Cost   *float64 `json:"cost"`
			Tokens *struct {
				Input     int64 `json:"input"`
				Output    int64 `json:"output"`
				Reasoning int64 `json:"reasoning"`
				Cache     struct {
					Read  int64 `json:"read"`
					Write int64 `json:"write"`
				} `json:"cache"`
			} `json:"tokens"`
		} `json:"part"`
	}
	if json.Unmarshal([]byte(line), &event) != nil || event.Type != "step_finish" || event.Part.Tokens == nil {
		return
	}
	u.InputTokens += event.Part.Tokens.Input + event.Part.Tokens.Cache.Read + event.Part.Tokens.Cache.Write
	u.OutputTokens += event.Part.Tokens.Output + event.Part.Tokens.Reasoning
	u.CachedInputTokens += event.Part.Tokens.Cache.Read
	if event.Part.Cost != nil {
		total := *event.Part.Cost
		if u.CostUSD != nil {
			total += *u.CostUSD
		}
		u.CostUSD = &total
	}
	u.Turns++
	u.Source = "opencode step_finish"
	u.Basis = BasisTotalInput
}

// FormatUsage 把用量写成一行给人看的文字；没读到时如实说没读到。
func FormatUsage(u Usage) string {
	u = u.Normalized()
	if u.Empty() {
		return "未读到用量"
	}
	text := fmt.Sprintf("输入 %s（其中缓存 %s）· 输出 %s · 合计 %s token", groupDigits(u.InputTokens), groupDigits(u.CachedInputTokens),
		groupDigits(u.OutputTokens), groupDigits(u.Total()))
	if u.CostUSD != nil {
		text += fmt.Sprintf(" · $%.4f", *u.CostUSD)
	}
	if u.Partial {
		text += "（有的尝试没读到用量，这是下限）"
	}
	return text
}

func groupDigits(n int64) string {
	s := strconv.FormatInt(n, 10)
	if n < 0 {
		return "-" + groupDigits(-n)
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
