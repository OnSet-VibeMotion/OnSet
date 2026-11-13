package tools

import (
	"strings"
	"testing"
)

func TestAccumulateUsageReadsClaudeResultEvent(t *testing.T) {
	var u Usage
	AccumulateUsage("claude", `{"type":"assistant","message":{"content":[]}}`, &u)
	if !u.Empty() {
		t.Fatalf("assistant 事件不该产生用量：%+v", u)
	}
	AccumulateUsage("claude", `{"type":"result","num_turns":7,"total_cost_usd":0.42,"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":300,"output_tokens":50}}`, &u)
	// 输入含缓存读写：100 + 20 + 300。
	if u.InputTokens != 420 || u.OutputTokens != 50 || u.CachedInputTokens != 300 || u.Turns != 7 || u.CostUSD == nil || *u.CostUSD != 0.42 {
		t.Fatalf("claude result 解析不对：%+v", u)
	}
}

func TestAccumulateUsageSumsCodexTurns(t *testing.T) {
	var u Usage
	for range 2 {
		AccumulateUsage("codex", `{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3}}`, &u)
	}
	AccumulateUsage("codex", `not json`, &u)
	if u.InputTokens != 20 || u.OutputTokens != 6 || u.CachedInputTokens != 8 || u.Turns != 2 || u.CostUSD != nil {
		t.Fatalf("codex 逐轮累加不对：%+v", u)
	}
}

// TestUsageIsComparableAcrossTools：三家的口径统一成「输入含缓存、缓存不大于输入、
// 输出含推理」，数字取自真实录制的流。
func TestUsageIsComparableAcrossTools(t *testing.T) {
	cases := []struct {
		tool, line            string
		input, cached, output int64
	}{
		{"claude", `{"type":"result","usage":{"input_tokens":4,"cache_creation_input_tokens":18803,"cache_read_input_tokens":40437,"output_tokens":207}}`, 59244, 40437, 207},
		{"codex", `{"type":"turn.completed","usage":{"input_tokens":41579,"cached_input_tokens":32768,"output_tokens":55}}`, 41579, 32768, 55},
		{"opencode", `{"type":"step_finish","part":{"tokens":{"input":3410,"output":36,"reasoning":16,"cache":{"read":16976,"write":0}}}}`, 20386, 16976, 52},
	}
	for _, tc := range cases {
		var u Usage
		AccumulateUsage(tc.tool, tc.line, &u)
		if u.InputTokens != tc.input || u.CachedInputTokens != tc.cached || u.OutputTokens != tc.output || u.CachedInputTokens > u.InputTokens {
			t.Errorf("%s：%+v", tc.tool, u)
		}
	}
}

func TestUsageAddMarksPartialTotals(t *testing.T) {
	cost := 0.5
	var total Usage
	total.Add(Usage{InputTokens: 10, OutputTokens: 2, CostUSD: &cost, Source: "claude result"})
	total.Add(Usage{InputTokens: 5, OutputTokens: 1, CostUSD: &cost, Source: "claude result"})
	if total.Total() != 18 || *total.CostUSD != 1 || total.Partial {
		t.Fatalf("相加不对：%+v", total)
	}
	total.Add(Usage{})
	if !total.Partial {
		t.Error("有一次没读到用量时总数只是下限")
	}
	var mixed Usage
	mixed.Add(Usage{InputTokens: 1, Source: "codex turn.completed"})
	mixed.Add(Usage{InputTokens: 1, CostUSD: &cost, Source: "claude result"})
	if !mixed.Partial || mixed.Source != "mixed" {
		t.Errorf("费用只有一部分知道时要标出：%+v", mixed)
	}
}

func TestUsageAddRemembersMissingFirstAttempt(t *testing.T) {
	var total Usage
	total.Add(Usage{})
	total.Add(Usage{InputTokens: 3, Source: "codex turn.completed"})
	if !total.Partial || total.InputTokens != 3 {
		t.Errorf("第一次没读到用量，合计只是下限：%+v", total)
	}
	if FormatUsage(Usage{}) != "未读到用量" || !strings.Contains(FormatUsage(Usage{InputTokens: 1234567, Source: "x"}), "1,234,567") {
		t.Errorf("格式不对：%q", FormatUsage(Usage{InputTokens: 1234567, Source: "x"}))
	}
}

// TestNormalizedConvertsOldRecords：统一口径之前写下的 claude 记录输入不含缓存，
// 读的时候加回去；新记录不动。
func TestNormalizedConvertsOldRecords(t *testing.T) {
	old := Usage{InputTokens: 191925, CachedInputTokens: 6368426, OutputTokens: 47697, Source: "claude result"}
	if got := old.Normalized(); got.InputTokens != 6560351 || got.Basis != BasisTotalInput {
		t.Errorf("老 claude 记录要加回缓存：%+v", got)
	}
	codex := Usage{InputTokens: 100, CachedInputTokens: 60, Source: "codex turn.completed"}
	if got := codex.Normalized(); got.InputTokens != 100 {
		t.Errorf("codex 本来就含缓存：%+v", got)
	}
	var fresh Usage
	AccumulateUsage("claude", `{"type":"result","usage":{"input_tokens":4,"cache_read_input_tokens":40,"output_tokens":1}}`, &fresh)
	if again := fresh.Normalized(); again.InputTokens != 44 {
		t.Errorf("新记录不能再加一次：%+v", again)
	}
}
