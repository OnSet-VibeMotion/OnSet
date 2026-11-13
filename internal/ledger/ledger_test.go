package ledger

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

func TestAppendReadAndSummarize(t *testing.T) {
	path := ProjectFile(t.TempDir())
	if entries, err := Read(path); err != nil || entries != nil {
		t.Fatalf("不存在的账本读出空：%v %v", entries, err)
	}
	cost := 0.5
	claude := tools.Usage{InputTokens: 100, CachedInputTokens: 80, OutputTokens: 10, CostUSD: &cost, Source: "claude result", Basis: tools.BasisTotalInput}
	codex := tools.Usage{InputTokens: 200, OutputTokens: 20, Source: "codex turn.completed", Basis: tools.BasisTotalInput}
	for _, entry := range []Entry{
		FromResult(SourceRun, "claude", "claude-opus", "s1", claude, nil, false),
		FromResult(SourceStudio, "codex", "", "s2", codex, errors.New("boom"), false),
		FromResult(SourceStudio, "codex", "", "s3", tools.Usage{}, nil, true),
	} {
		if err := Append(path, entry); err != nil {
			t.Fatal(err)
		}
	}
	// 坏行跳过，不拖垮整本账。
	file, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	file.WriteString("not json\n")
	file.Close()

	entries, err := Read(path)
	if err != nil || len(entries) != 3 {
		t.Fatalf("entries=%+v err=%v", entries, err)
	}
	if entries[0].Time == "" || entries[1].Status != "failed" || entries[2].Status != "cancelled" || entries[2].Usage != nil {
		t.Fatalf("entries=%+v", entries)
	}
	summary := Summarize(entries)
	if summary.Calls != 3 || summary.Total.InputTokens != 300 || summary.Total.OutputTokens != 30 {
		t.Fatalf("total=%+v", summary.Total)
	}
	// 有一次没读到用量、codex 不报费用：合计只是下限。
	if !summary.Total.Partial || !summary.BySource[SourceStudio].Partial || summary.BySource[SourceRun].Partial {
		t.Fatalf("partial: total=%+v by_source=%+v", summary.Total, summary.BySource)
	}
	if _, ok := summary.ByModel["claude/claude-opus"]; !ok {
		t.Fatalf("by_model=%v", summary.ByModel)
	}
	if keys := SortedKeys(summary.ByModel); len(keys) != 2 || keys[0] != "claude/claude-opus" || keys[1] != "codex" {
		t.Fatalf("keys=%v", keys)
	}
	if MemoryFile("/m") != filepath.Join("/m", "orchestrator-usage.jsonl") {
		t.Fatal(MemoryFile("/m"))
	}
}
