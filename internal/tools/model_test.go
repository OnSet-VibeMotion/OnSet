package tools

import (
	"bufio"
	"os"
	"path/filepath"
	"testing"
)

// TestDetectModelFromRecordedStreams 用真实录制的流核对模型名的读取位置。
func TestDetectModelFromRecordedStreams(t *testing.T) {
	cases := map[string]string{"claude": "claude-opus-5-5", "qoder": "DeepSeek-Flash", "codebuddy": "hy3", "codex": "", "opencode": ""}
	for tool, want := range cases {
		file, err := os.Open(filepath.Join("..", "agentrun", "testdata", tool+"-1.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		got := ""
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 1<<20), 1<<22)
		for scanner.Scan() {
			if model := DetectModel(tool, scanner.Text()); model != "" && got == "" {
				got = model
			}
		}
		file.Close()
		if got != want {
			t.Errorf("%s：读出 %q，期望 %q", tool, got, want)
		}
	}
}

func TestConfiguredModelReadsCodexTopLevelOnly(t *testing.T) {
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "config.toml"), []byte("# 注释\nmodel = \"gpt-6-astra\"  # 默认\nmodel_reasoning_effort = \"medium\"\n[profiles.fast]\nmodel = \"other\"\n"), 0o644)
	if got := ConfiguredModel("codex", map[string]string{"CODEX_HOME": home}); got != "gpt-6-astra" {
		t.Errorf("读出 %q", got)
	}
	os.WriteFile(filepath.Join(home, "config.toml"), []byte("[profiles.fast]\nmodel = \"other\"\n"), 0o644)
	if got := ConfiguredModel("codex", map[string]string{"CODEX_HOME": home}); got != "" {
		t.Errorf("表里的 model 不是默认模型：%q", got)
	}
	if got := ConfiguredModel("claude", map[string]string{"HOME": home}); got != "" {
		t.Errorf("只有 codex 读配置：%q", got)
	}
}
