//go:build darwin || linux

package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRenderUsageIsReportedAndTotalled：每次渲染打印用量，run-all 报告带每个镜头
// 与整批的合计，am scene usage 把归档的尝试也算进去。
func TestRenderUsageIsReportedAndTotalled(t *testing.T) {
	requireFFmpeg(t)
	project := t.TempDir()
	binDir := t.TempDir()
	source := filepath.Join(t.TempDir(), "source.mp4")
	makeClip(t, source, "testsrc=size=320x240:rate=30:duration=1")
	script := "#!/bin/sh\nset -eu\n" +
		"printf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1000,\"cached_input_tokens\":600,\"output_tokens\":50}}'\n" +
		"/bin/cp '" + source + "' out.mp4\n"
	os.WriteFile(filepath.Join(binDir, "codex"), []byte(script), 0o755)
	os.WriteFile(filepath.Join(project, "article-to-motion.conf"), []byte("ORCHESTRATOR=codex\nRENDERER=codex\n"), 0o644)
	for _, id := range []string{"scene-001", "scene-002"} {
		dir := filepath.Join(project, "scenes", id)
		os.MkdirAll(dir, 0o755)
		os.WriteFile(filepath.Join(dir, "transcription.srt"), []byte("1\n00:00:00,000 --> 00:00:01,000\nx\n"), 0o644)
		os.WriteFile(filepath.Join(dir, "frame.md"), []byte("---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n"), 0o644)
		os.WriteFile(filepath.Join(dir, "scene.json"), []byte(`{"id":"`+id+`","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文","style_guide":"frame.md"}`), 0o644)
	}
	t.Chdir(project)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+filepath.Dir(mustLookPath(t, "ffmpeg")))
	t.Setenv("HOME", t.TempDir())

	var out, errOut bytes.Buffer
	if code := Execute([]string{"scene", "run", "scenes/scene-001"}, &out, &errOut); code != 0 {
		t.Fatalf("渲染失败：%s", errOut.String())
	}
	if !strings.Contains(out.String(), "[scene-001] 用量：输入 1,000（其中缓存 600）· 输出 50 · 合计 1,050 token") {
		t.Errorf("每次渲染要打印用量：%s", out.String())
	}
	out.Reset()
	reportPath := filepath.Join(project, "report.json")
	if code := Execute([]string{"scene", "run-all", "scenes/", "--force", "--retries", "0", "--report-json", reportPath}, &out, &errOut); code != 0 {
		t.Fatalf("run-all 失败：%s", errOut.String())
	}
	if !strings.Contains(out.String(), "用量合计：输入 2,000") {
		t.Errorf("汇总要有整批合计：%s", out.String())
	}
	var report struct {
		Usage struct {
			InputTokens int64 `json:"input_tokens"`
		} `json:"usage"`
		Scenes []struct {
			SceneID string `json:"scene_id"`
			Usage   *struct {
				OutputTokens int64 `json:"output_tokens"`
			} `json:"usage"`
		} `json:"scenes"`
	}
	body, _ := os.ReadFile(reportPath)
	if err := json.Unmarshal(body, &report); err != nil || report.Usage.InputTokens != 2000 || report.Scenes[0].Usage == nil || report.Scenes[0].Usage.OutputTokens != 50 {
		t.Fatalf("报告要带每个镜头与整批的用量：%s", body)
	}
	out.Reset()
	if code := Execute([]string{"scene", "usage", "scenes/"}, &out, &errOut); code != 0 {
		t.Fatalf("usage 失败：%s", errOut.String())
	}
	// scene-001 渲染过两次（第一次被 run-all 归档进 attempts/），都要算进去。
	if !strings.Contains(out.String(), "scene-001：2 次尝试（2 次成功）· 输入 2,000") || !strings.Contains(out.String(), "合计：输入 3,000") {
		t.Errorf("归档的尝试也要计入：%s", out.String())
	}
}
