package cli

import (
	"bytes"
	"strings"
	"testing"
)

// 不是终端时不重画：每次状态或阶段变化打一行，同样的一行不重复打；列按显示宽度对齐。
func TestSetupViewPlainOutput(t *testing.T) {
	var out bytes.Buffer
	view := newSetupView(&out, []string{"HyperFrames 技能", "整片风格 lemo-opuscar"}, []string{"0.8.225", ""})
	view.Set(0, viewReady, "")
	view.Set(1, viewRunning, "准备中")
	view.Detail(1, "(1/3) 下载基础部分")
	view.Detail(1, "(1/3) 下载基础部分")
	view.Set(1, viewDone, "")
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("应当打 4 行（重复的阶段不重打）：\n%s", out.String())
	}
	if strings.Contains(out.String(), "\033[") {
		t.Error("不是终端时不该有转义序列")
	}
	if !strings.Contains(lines[0], "✓") || !strings.Contains(lines[0], "已就绪") || !strings.Contains(lines[3], "完成") {
		t.Errorf("状态不对：\n%s", out.String())
	}
	// 两行的名字列宽度一样：版本列从同一列开始。
	if displayWidth(lines[1][:strings.Index(lines[1], "准备中")]) != displayWidth(lines[2][:strings.Index(lines[2], "(1/3)")]) {
		t.Errorf("列没对齐：\n%s", out.String())
	}
}

func TestDisplayWidthCountsCJKAsTwoColumns(t *testing.T) {
	if got := displayWidth("整片风格 ab"); got != 11 {
		t.Errorf("displayWidth = %d，期望 11", got)
	}
}
