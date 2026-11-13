package memory

import "testing"

func TestEveryCheckerHasLabel(t *testing.T) {
	for _, id := range append(KnownCheckers(), CheckerHuman) {
		if CheckerLabels[id] == "" {
			t.Errorf("校验器 %s 没有说法：记忆面板会直接显示原始 ID", id)
		}
	}
	known := map[string]bool{CheckerHuman: true}
	for _, id := range KnownCheckers() {
		known[id] = true
	}
	for id := range CheckerLabels {
		if !known[id] {
			t.Errorf("说法表里的 %s 不是已知校验器", id)
		}
	}
}
