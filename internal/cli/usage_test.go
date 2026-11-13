//go:build darwin || linux

package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/ledger"
	"github.com/chouheiwa/articale-to-motion/internal/memory"
	"github.com/chouheiwa/articale-to-motion/internal/scene"
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

func TestRunRecordsOrchestratorUsageAndUsageCommandTotalsIt(t *testing.T) {
	root := t.TempDir()
	bin := t.TempDir()
	codexHome := t.TempDir()
	os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte("model = \"gpt-test\"\n"), 0o644)
	os.WriteFile(filepath.Join(root, "article-to-motion.conf"), []byte("ORCHESTRATOR=codex\nRENDERER=claude\n"), 0o644)
	os.WriteFile(filepath.Join(root, "PROMPT.md"), []byte("hello"), 0o644)
	script := "#!/bin/sh\ncat > /dev/null\n" +
		"echo '{\"type\":\"thread.started\",\"thread_id\":\"th-1\"}'\n" +
		"echo '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1000,\"cached_input_tokens\":600,\"output_tokens\":50}}'\n"
	os.WriteFile(filepath.Join(bin, "codex"), []byte(script), 0o755)
	old, _ := os.Getwd()
	os.Chdir(root)
	defer os.Chdir(old)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORCHESTRATOR", "codex")
	t.Setenv("RENDERER", "claude")
	t.Setenv("CODEX_HOME", codexHome)
	var out bytes.Buffer
	for i := 0; i < 2; i++ {
		if code := Execute([]string{"run"}, &out, &out); code != 0 {
			t.Fatalf("code=%d output=%s", code, out.String())
		}
	}
	entries, err := ledger.Read(ledger.ProjectFile(root))
	if err != nil || len(entries) != 2 {
		t.Fatalf("entries=%+v err=%v", entries, err)
	}
	e := entries[0]
	if e.Source != ledger.SourceRun || e.Tool != "codex" || e.Model != "gpt-test" || e.Session != "th-1" || e.Status != "succeeded" || e.Usage == nil || e.Usage.InputTokens != 1000 {
		t.Fatalf("entry=%+v", e)
	}

	// 一个镜头有一次渲染尝试，也计入合计。
	dir := filepath.Join(root, "scenes", "s1")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "transcription.srt"), []byte("1\n00:00:00,000 --> 00:00:01,000\nx\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "frame.md"), []byte("---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "scene.json"), []byte(`{"id":"s1","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文","style_guide":"frame.md"}`), 0o644)
	attempt := `{"scene_id":"s1","renderer":"claude","outcome":"succeeded","usage":{"input_tokens":300,"output_tokens":20,"basis":"total-input","source":"claude result"}}`
	os.WriteFile(filepath.Join(dir, "render-s1.attempt.json"), []byte(attempt), 0o644)

	out.Reset()
	if code := Execute([]string{"usage", "--json"}, &out, &out); code != 0 {
		t.Fatalf("usage code=%d output=%s", code, out.String())
	}
	var report ProjectUsage
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	if report.Orchestrator.Calls != 2 || report.Orchestrator.Total.InputTokens != 2000 || report.Total.Total() != 2*1050+320 {
		t.Fatalf("report=%+v", report)
	}
	if _, ok := report.Orchestrator.ByModel["codex/gpt-test"]; !ok {
		t.Fatalf("by model=%v", report.Orchestrator.ByModel)
	}
	out.Reset()
	if code := Execute([]string{"usage"}, &out, &out); code != 0 {
		t.Fatalf("usage code=%d output=%s", code, out.String())
	}
	for _, want := range []string{"渲染：1 个镜头、1 次尝试", "编排：2 次调用", "am run：", "本项目合计：输入 2,300"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in:\n%s", want, out.String())
		}
	}
}

func TestRunDoesNotRecordUsageWhenOrchestratorNeverStarted(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "article-to-motion.conf"), []byte("ORCHESTRATOR=codex\nRENDERER=claude\n"), 0o644)
	os.WriteFile(filepath.Join(root, "PROMPT.md"), []byte("hello"), 0o644)
	old, _ := os.Getwd()
	os.Chdir(root)
	defer os.Chdir(old)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("ORCHESTRATOR", "codex")
	var out bytes.Buffer
	if code := Execute([]string{"run"}, &out, &out); code == 0 {
		t.Fatalf("expected failure: %s", out.String())
	}
	if _, err := os.Stat(ledger.ProjectFile(root)); !os.IsNotExist(err) {
		t.Fatalf("ledger should not exist: %v", err)
	}
}

// TestConsolidateRecordsDrafterUsageInMemoryStore：整理者不属于哪个项目，用量记在记忆库的账本里。
func TestConsolidateRecordsDrafterUsageInMemoryStore(t *testing.T) {
	memoryDir := t.TempDir()
	store, err := memory.Open(memoryDir)
	if err != nil {
		t.Fatal(err)
	}
	sceneDir := filepath.Join(t.TempDir(), "scene-001")
	os.MkdirAll(sceneDir, 0o755)
	_, err = store.RecordAttempt(scene.Scene{ID: "scene-001", Directory: sceneDir, Renderer: "codex"}, scene.Attempt{
		SceneID: "scene-001", Renderer: "codex", Outcome: scene.OutcomeVerificationFailed,
		Problems: []string{"多出 1 帧"}, Checks: []string{scene.CheckOutputFrames},
	}, memory.AttemptSource{Source: memory.SourceRender, Run: "run-1"})
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	script := "#!/bin/sh\ncat > /dev/null\n" +
		"echo '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":70,\"output_tokens\":7}}'\n"
	os.WriteFile(filepath.Join(bin, "codex"), []byte(script), 0o755)
	t.Chdir(t.TempDir())
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("ORCHESTRATOR", "codex")
	t.Setenv("AM_MEMORY_DIR", memoryDir)
	var out bytes.Buffer
	if code := Execute([]string{"memory", "consolidate", "--min-count", "1", "--all"}, &out, &out); code != 0 {
		t.Fatalf("code=%d output=%s", code, out.String())
	}
	entries, err := ledger.Read(ledger.MemoryFile(memoryDir))
	if err != nil || len(entries) != 1 || entries[0].Source != ledger.SourceConsolidate || entries[0].Usage == nil || entries[0].Usage.InputTokens != 70 {
		t.Fatalf("entries=%+v err=%v output=%s", entries, err, out.String())
	}
}
