package align

import (
	"encoding/json"
	"testing"
)

func TestViewKeepsHeadingsMarkupAndNesting(t *testing.T) {
	script, err := ParseScript("# 开场\n\n在 <2025年|二零二五年>，@{a}大模型@{b}<API|A P I>@{/b}@{/a}很贵<|嗯>。\n第二行\n\n## 正文\n\n@{c}跨\n\n段@{/c}\n")
	if err != nil {
		t.Fatal(err)
	}
	blocks, stats := script.View()
	got, _ := json.Marshal(blocks)
	want := `[{"kind":"heading","level":1,"text":"开场"},` +
		`{"kind":"para","nodes":[{"kind":"text","text":"在 "},{"kind":"alt","text":"2025年","spoken":"二零二五年"},{"kind":"text","text":"，"},` +
		`{"kind":"phrase","id":"a","children":[{"kind":"text","text":"大模型"},{"kind":"phrase","id":"b","children":[{"kind":"alt","text":"API","spoken":"A P I"}]}]},` +
		`{"kind":"text","text":"很贵"},{"kind":"alt","spoken":"嗯"},{"kind":"text","text":"。第二行"}]},` +
		`{"kind":"heading","level":2,"text":"正文"},` +
		`{"kind":"para","nodes":[{"kind":"phrase","id":"c","children":[{"kind":"text","text":"跨"}]}]},` +
		`{"kind":"para","nodes":[{"kind":"phrase","id":"c","children":[{"kind":"text","text":"段"}]}]}]`
	if string(got) != want {
		t.Fatalf("view =\n%s\nwant\n%s", got, want)
	}
	if stats.Paragraphs != 3 || stats.Phrases != 3 || stats.Units == 0 {
		t.Fatalf("stats = %+v", stats)
	}
}
