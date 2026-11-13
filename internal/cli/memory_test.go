//go:build darwin || linux

package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/memory"
)

// TestMemoryRecallReachesRendererAndEpisodesAreRecorded 串起记忆的主链路：
// 召回段真的进了渲染工具收到的提示词、每次尝试都写成经历、记忆一变镜头被判
// Stale 且说明原因，以及整理、反馈、状态这几条命令在真实项目里能跑通。
func TestMemoryRecallReachesRendererAndEpisodesAreRecorded(t *testing.T) {
	requireFFmpeg(t)
	project := t.TempDir()
	binDir := t.TempDir()
	memoryDir := t.TempDir()
	source := filepath.Join(t.TempDir(), "source.mp4")
	makeClip(t, source, "testsrc=size=320x240:rate=30:duration=1")
	script := "#!/bin/sh\nset -eu\nprintf '%s' \"$*\" > prompt.txt\n/bin/cp '" + source + "' out.mp4\n"
	if err := os.WriteFile(filepath.Join(binDir, "codex"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(project, "article-to-motion.conf"), []byte("ORCHESTRATOR=codex\nRENDERER=codex\nMEMORY=on\n"), 0o644)
	dir := filepath.Join(project, "scenes", "scene-001")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "transcription.srt"), []byte("1\n00:00:00,000 --> 00:00:01,000\nx\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "frame.md"), []byte("---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "scene.json"), []byte(`{"id":"scene-001","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文内容","style_guide":"frame.md"}`), 0o644)

	store, err := memory.Open(memoryDir)
	if err != nil {
		t.Fatal(err)
	}
	rule := memory.Memory{Kind: memory.KindLesson, Meta: memory.Meta{Name: "cjk-font-local", Description: "中文字体用本地文件", Status: memory.StatusActive,
		AppliesWhen: memory.Applies{Features: []string{"cjk_text"}}, CheckedBy: []string{"determinism.remote-font"}},
		Body: "字体随镜头目录提供。\n\n反例：\n    在线字体\n\n正例：\n    本地 woff2"}
	store.Write(rule)
	if _, err := store.TakeSnapshot(memory.EventManualEdit, "初始", true); err != nil {
		t.Fatal(err)
	}

	t.Chdir(project)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+filepath.Dir(mustLookPath(t, "ffmpeg")))
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AM_MEMORY_DIR", memoryDir)

	run := func(args ...string) string {
		t.Helper()
		var out, errOut bytes.Buffer
		if code := Execute(args, &out, &errOut); code != 0 {
			t.Fatalf("am %s 退出 %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), code, out.String(), errOut.String())
		}
		return out.String()
	}
	reportPath := filepath.Join(project, "report.json")
	run("scene", "run-all", "scenes/", "--retries", "0")
	prompt, _ := os.ReadFile(filepath.Join(dir, "prompt.txt"))
	if !strings.Contains(string(prompt), "【cjk-font-local】") {
		t.Fatalf("召回段没有进渲染提示词：\n%s", prompt)
	}
	episodes, _ := store.Episodes()
	if len(episodes) != 1 || !episodes[0].Passed() || episodes[0].Recalled[0] != "cjk-font-local" || episodes[0].Snapshot != 1 {
		t.Fatalf("渲染应当写下一段通过的经历并记下召回：%+v", episodes)
	}

	// 记忆没变：已有合格产物直接跳过。
	run("scene", "run-all", "scenes/", "--report-json", reportPath)
	if body, _ := os.ReadFile(reportPath); !strings.Contains(string(body), "输入指纹一致") {
		t.Errorf("记忆未变时应当复用产物：%s", body)
	}
	// 记忆变了：Stale，原因点名召回的记忆。
	extra := rule
	extra.Name, extra.Description, extra.CheckedBy = "cjk-numbers", "中文里的数字用等宽字体", []string{"output.resolution"}
	store.Write(extra)
	store.TakeSnapshot(memory.EventManualEdit, "加一条", true)
	var out, errOut bytes.Buffer
	Execute([]string{"scene", "run-all", "scenes/", "--report-json", reportPath}, &out, &errOut)
	if body, _ := os.ReadFile(reportPath); !strings.Contains(string(body), "召回的记忆变了") {
		t.Errorf("召回的记忆变化应当让镜头 Stale 并说明原因：%s", body)
	}

	if text := run("memory", "report"); !strings.Contains(text, "run-") || !strings.Contains(text, "1（100%）") {
		t.Errorf("批次报告应当列出第一批：\n%s", text)
	}
	if text := run("memory", "recall", "scenes/scene-001"); !strings.Contains(text, "cjk-font-local") || !strings.Contains(text, "cjk_text") {
		t.Errorf("recall 预览应当列出记忆与匹配的特征：\n%s", text)
	}
	run("memory", "feedback", "scenes/scene-001", "--down", "--note", "颜色太刺眼", "--region", "0.1,0.1,0.5,0.5")
	if episodes, _ := store.Episodes(); len(episodes) != 2 || episodes[1].Feedback == nil || episodes[1].Feedback.Verdict != "down" {
		t.Errorf("反馈应当写成经历：%+v", episodes)
	}
	drafts := t.TempDir()
	os.MkdirAll(filepath.Join(drafts, "preferences"), 0o755)
	feedbackID := func() string { e, _ := store.Episodes(); return e[1].ID }()
	pref := memory.Memory{Kind: memory.KindPreference, Meta: memory.Meta{Name: "calm-palette", Description: "配色克制，避免高饱和撞色", Status: memory.StatusTrial,
		CheckedBy: []string{"human"}, FromEpisodes: []string{feedbackID}}, Body: "主色不超过两种高饱和色。"}
	os.WriteFile(filepath.Join(drafts, "preferences", "calm-palette.md"), memory.Format(pref), 0o644)
	if text := run("memory", "consolidate", "--drafts", drafts); !strings.Contains(text, "calm-palette") {
		t.Errorf("现成草稿应当被收录：\n%s", text)
	}
	run("memory", "promote", "calm-palette")
	statusPath := filepath.Join(project, "status.json")
	run("memory", "status", "--report-json", statusPath)
	var status memory.StatusReport
	body, _ := os.ReadFile(statusPath)
	if err := json.Unmarshal(body, &status); err != nil || status.Counts["preference/active"] != 1 || status.Snapshot != 3 {
		t.Errorf("状态报告不对：%s", body)
	}
	if text := run("memory", "list"); !strings.Contains(text, "未经机器验证") || !strings.Contains(text, "codex：召回 1 次，一次通过 1 次") {
		t.Errorf("列表应当标出偏好并给出效果统计：\n%s", text)
	}
	if text := run("memory", "timeline"); !strings.Contains(text, "promote") || !strings.Contains(text, "episode") {
		t.Errorf("时间线不完整：\n%s", text)
	}
	run("memory", "rollback", "--to", "1")
	if text := run("memory", "recall", "scenes/scene-001", "--json"); strings.Contains(text, "cjk-numbers") {
		t.Errorf("回退到快照 #1 后不该再召回后加的记忆：\n%s", text)
	}
	if text := run("memory", "remember", "--name", "slow-pacing", "节奏慢一点，每个画面多停一秒"); !strings.Contains(text, "本项目") {
		t.Errorf("remember 默认只对本项目成立：\n%s", text)
	}
	if text := run("memory", "recall", "scenes/scene-001"); !strings.Contains(text, "slow-pacing") || !strings.Contains(text, "模型 ") {
		t.Errorf("亲口说的偏好应当立刻被召回，且预览写明模型：\n%s", text)
	}
}

// TestMemoryOffLeavesStoreUntouched：显式 MEMORY=off 时不召回、不写经历，也不建记忆库目录。
func TestMemoryOffLeavesStoreUntouched(t *testing.T) {
	requireFFmpeg(t)
	project := t.TempDir()
	binDir := t.TempDir()
	memoryDir := filepath.Join(t.TempDir(), "memory")
	source := filepath.Join(t.TempDir(), "source.mp4")
	makeClip(t, source, "testsrc=size=320x240:rate=30:duration=1")
	fakeRenderer(t, binDir, source)
	os.WriteFile(filepath.Join(project, "article-to-motion.conf"), []byte("ORCHESTRATOR=codex\nRENDERER=codex\nMEMORY=off\n"), 0o644)
	dir := filepath.Join(project, "scenes", "scene-001")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "transcription.srt"), []byte("1\n00:00:00,000 --> 00:00:01,000\nx\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "frame.md"), []byte("---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "scene.json"), []byte(`{"id":"scene-001","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文","style_guide":"frame.md"}`), 0o644)
	t.Chdir(project)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+filepath.Dir(mustLookPath(t, "ffmpeg")))
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AM_MEMORY_DIR", memoryDir)
	var out, errOut bytes.Buffer
	if code := Execute([]string{"scene", "run", "scenes/scene-001"}, &out, &errOut); code != 0 {
		t.Fatalf("渲染失败：%s", errOut.String())
	}
	if _, err := os.Stat(memoryDir); !os.IsNotExist(err) {
		t.Errorf("MEMORY=off 时不该建记忆库：%v", err)
	}
}

// TestValidateReadsRecordsFindingsPerScene：阅读时间问题按 scene_id 记到对应镜头，
// 不改变检查命令本身的退出码。
func TestValidateReadsRecordsFindingsPerScene(t *testing.T) {
	project := t.TempDir()
	memoryDir := t.TempDir()
	os.WriteFile(filepath.Join(project, "article-to-motion.conf"), []byte("ORCHESTRATOR=codex\nRENDERER=codex\n"), 0o644)
	for _, id := range []string{"scene-001", "scene-002"} {
		dir := filepath.Join(project, "scenes", id)
		os.MkdirAll(dir, 0o755)
		os.WriteFile(filepath.Join(dir, "transcript.srt"), []byte("1\n00:00:00,000 --> 00:00:01,000\nx\n"), 0o644)
		os.WriteFile(filepath.Join(dir, "scene.json"), []byte(`{"id":"`+id+`","duration_seconds":2,"output":"out.mp4","transcript":"transcript.srt","text":"中文"}`), 0o644)
	}
	os.MkdirAll(filepath.Join(project, "production"), 0o755)
	os.WriteFile(filepath.Join(project, "production", "visible-event-inventory.json"), []byte(`{"schema":1,"fps":30,"events":[
		{"event_id":"e1","scene_id":"scene-002","text":"一句很长很长很长很长的标题","role":"title","enter_frame":0,"readable_start_frame":0,"readable_end_frame_exclusive":6,"exit_end_frame":6}]}`), 0o644)
	t.Chdir(project)
	t.Setenv("AM_MEMORY_DIR", memoryDir)
	var out bytes.Buffer
	if code := Execute([]string{"validate", "reads"}, &out, &out); code == 0 {
		t.Fatalf("阅读时间不够应当失败：%s", out.String())
	}
	store, _ := memory.Open(memoryDir)
	episodes, _ := store.Episodes()
	if len(episodes) != 1 || episodes[0].SceneID != "scene-002" || episodes[0].Source != memory.SourceCheck || episodes[0].Checks[0] != "reads.duration" {
		t.Fatalf("问题应当记到 scene-002：%+v", episodes)
	}
}
