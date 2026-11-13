package project

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunPromptReadsDefaultAndOverride(t *testing.T) {
	root := t.TempDir()
	if _, _, err := RunPrompt(root, ""); err == nil || !strings.Contains(err.Error(), "PROMPT.md") {
		t.Fatalf("缺 PROMPT.md 应报出路径：%v", err)
	}
	os.WriteFile(filepath.Join(root, "PROMPT.md"), []byte("default"), 0o644)
	prompt, path, err := RunPrompt(root, "")
	if err != nil || string(prompt) != "default" || path != filepath.Join(root, "PROMPT.md") {
		t.Fatalf("prompt=%q path=%s err=%v", prompt, path, err)
	}
	custom := filepath.Join(root, "custom.md")
	os.WriteFile(custom, []byte("custom"), 0o644)
	prompt, path, err = RunPrompt(root, custom)
	if err != nil || string(prompt) != "custom" || path != custom {
		t.Fatalf("prompt=%q path=%s err=%v", prompt, path, err)
	}
}

// TestRunPromptStartsFromArticleWithoutTranscript：还没有定稿字幕时默认走完整制作。
func TestRunPromptStartsFromArticleWithoutTranscript(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "PROMPT.md"), []byte("from-srt"), 0o644)
	os.WriteFile(filepath.Join(root, ProductionPrompt), []byte("from-article"), 0o644)
	if prompt, path, err := RunPrompt(root, ""); err != nil || string(prompt) != "from-article" || filepath.Base(path) != ProductionPrompt {
		t.Fatalf("prompt=%q path=%s err=%v", prompt, path, err)
	}
	os.WriteFile(filepath.Join(root, "transcription.srt"), []byte("1\n"), 0o644)
	if prompt, _, err := RunPrompt(root, ""); err != nil || string(prompt) != "from-srt" {
		t.Fatalf("已有定稿字幕时读 PROMPT.md：%q %v", prompt, err)
	}
}
