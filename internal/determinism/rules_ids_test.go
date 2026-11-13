package determinism

import (
	"os"
	"regexp"
	"testing"
)

// TestRuleIDsCoverEveryEmittedRule 防止新增规则后忘了登记：扫描器里每个
// 写死的规则 ID 都必须出现在 RuleIDs 里，否则引用它的记忆过不了格式校验。
func TestRuleIDsCoverEveryEmittedRule(t *testing.T) {
	known := map[string]bool{}
	for _, id := range RuleIDs() {
		known[id] = true
	}
	for _, file := range []string{"scan.go", "rules.go"} {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range regexp.MustCompile(`(?:s\.add\(src, [^,]+, |return )"([a-z-]+)"`).FindAllStringSubmatch(string(body), -1) {
			if !known[m[1]] {
				t.Errorf("规则 %q 没有登记进 RuleIDs", m[1])
			}
		}
	}
}
