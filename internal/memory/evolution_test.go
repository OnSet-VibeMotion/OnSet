package memory

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

// TestRecallCapsLessonsButNotPreferences：每个镜头最多注入 DefaultMaxLessons 条经验，
// 排在后面的记为 limit；偏好不占条数。
func TestRecallCapsLessonsButNotPreferences(t *testing.T) {
	var memories []Memory
	for _, name := range []string{"rule-a", "rule-b", "rule-c", "rule-d", "rule-e"} {
		memories = append(memories, lesson(name, StatusActive, []string{"cjk_text"}, "output.frames"))
	}
	memories = append(memories, Memory{Kind: KindPreference, Meta: Meta{Name: "calm-palette", Description: "配色克制", Status: StatusActive, CheckedBy: []string{CheckerHuman}}, Body: "配色克制"})
	result := Recall(RecallInput{Memories: memories, Renderer: "claude", Features: []string{"cjk_text"}, Budget: 100000})
	lessons, preferences := 0, 0
	for _, item := range result.Items {
		if item.Kind == KindLesson {
			lessons++
		} else {
			preferences++
		}
	}
	if lessons != DefaultMaxLessons || preferences != 1 || result.MaxLessons != DefaultMaxLessons {
		t.Fatalf("items=%v", result.Names())
	}
	if len(result.Omitted) != 2 || result.Omitted[0].OmitReason != "limit" {
		t.Fatalf("omitted=%+v", result.Omitted)
	}
	if got := Recall(RecallInput{Memories: memories, Renderer: "claude", Features: []string{"cjk_text"}, Budget: 100000, MaxLessons: 5}); len(got.Items) != 6 {
		t.Fatalf("MaxLessons 可以放宽：%v", got.Names())
	}
	tight := Recall(RecallInput{Memories: memories, Renderer: "claude", Features: []string{"cjk_text"}, Budget: 10})
	if len(tight.Items) != 0 || tight.Omitted[0].OmitReason != "budget" {
		t.Fatalf("预算用完记为 budget：%+v", tight.Omitted)
	}
}

// TestLintRejectsRevisionsThatCollapse：修订不得丢掉旧版的校验器，也不得缩到一半以下。
func TestLintRejectsRevisionsThatCollapse(t *testing.T) {
	old := lesson("font-local", StatusActive, []string{"cjk_text"}, "determinism.remote-font", "determinism.font-display")
	old.Body = "中文字体必须用镜头目录里的本地文件，通过 @font-face 引入，font-display 写 block，否则首帧会用回退字体。" +
		"\n\n反例：\n    @import url('https://fonts.example/css');\n\n正例：\n    @font-face { src: url('./fonts/x.woff2'); font-display: block; }"
	short := lesson("font-local-v2", StatusTrial, []string{"cjk_text"}, "determinism.remote-font")
	short.Revises = "font-local"
	problems := strings.Join(Lint(short, LintContext{Existing: []Memory{old}}), "\n")
	if !strings.Contains(problems, "丢掉了旧版 font-local 的校验器 determinism.font-display") || !strings.Contains(problems, "不到旧版的一半") {
		t.Fatalf("problems=%s", problems)
	}
	good := old
	good.Name, good.Revises, good.Status = "font-local-v3", "font-local", StatusTrial
	good.Body += "\n另外 woff2 要随镜头目录提供。"
	if problems := Lint(good, LintContext{Existing: []Memory{old}}); len(problems) != 0 {
		t.Fatalf("完整的修订应当通过：%v", problems)
	}
}

// TestClustersCarrySuccessContrasts：同一镜头后来改对的优先当对照，其次特征相近的通过渲染；
// 事后检查出问题的、同样犯了这个错的不当对照。整理说明里写出对照。
func TestClustersCarrySuccessContrasts(t *testing.T) {
	episodes := []Episode{
		{ID: "ep-1", CreatedAt: "1", Source: SourceRender, SceneDir: "/p/scenes/a", Renderer: "claude", Outcome: scene.OutcomeVerificationFailed,
			Checks: []string{"output.frames"}, Problems: []string{"多 1 帧"}, Features: []string{"cjk_text", "numbers"}},
		{ID: "ep-2", CreatedAt: "2", Source: SourceRender, SceneDir: "/p/scenes/a", Renderer: "claude", Outcome: scene.OutcomeSucceeded, Retry: true, Fingerprint: "fp-a"},
		{ID: "ep-3", CreatedAt: "3", Source: SourceRender, SceneDir: "/p/scenes/b", Renderer: "claude", Outcome: scene.OutcomeVerificationFailed,
			Checks: []string{"output.frames"}, Problems: []string{"多 2 帧"}, Features: []string{"cjk_text", "numbers"}},
		{ID: "ep-4", CreatedAt: "4", Source: SourceRender, SceneDir: "/p/scenes/c", Renderer: "claude", Outcome: scene.OutcomeSucceeded,
			Features: []string{"cjk_text", "numbers"}, Fingerprint: "fp-c"},
		{ID: "ep-5", CreatedAt: "5", Source: SourceRender, SceneDir: "/p/scenes/d", Renderer: "claude", Outcome: scene.OutcomeSucceeded,
			Features: []string{"cjk_text", "numbers", "chart"}, Fingerprint: "fp-d"},
		{ID: "ep-6", CreatedAt: "6", Source: SourceCheck, SceneDir: "/p/scenes/d", Fingerprint: "fp-d", Checks: []string{"frames.blank"}, Problems: []string{"空白"}},
	}
	clusters := ClusterFailures(episodes)
	if len(clusters) != 1 || len(clusters[0].Contrasts) != 2 {
		t.Fatalf("clusters=%+v", clusters)
	}
	first, second := clusters[0].Contrasts[0], clusters[0].Contrasts[1]
	if first.Failed != "ep-1" || first.Passed != "ep-2" || !first.SameScene {
		t.Fatalf("同一镜头改对的优先：%+v", first)
	}
	if second.Failed != "ep-3" || second.Passed != "ep-4" || second.SameScene || strings.Join(second.Shared, ",") != "cjk_text,numbers" {
		t.Fatalf("事后检查出问题的 ep-5 不当对照：%+v", second)
	}
	brief := consolidationBrief(clusters, nil)
	for _, want := range []string{"成败对照（同一个镜头后来改对了）", "已被后来的渲染覆盖", "修订必须保留旧版的全部 checked_by", "最多注入 3 条经验"} {
		if !strings.Contains(brief, want) {
			t.Errorf("整理说明缺少 %q", want)
		}
	}
}

// TestSuspectMemoriesFlagLessonsWhoseCheckerStillFails：召回后它要防的校验器照样失败，
// 按渲染工具/模型分开计；别的校验器失败不算它的错。
func TestSuspectMemoriesFlagLessonsWhoseCheckerStillFails(t *testing.T) {
	rule := lesson("frame-count", StatusActive, nil, "output.frames")
	var episodes []Episode
	add := func(model string, outcome string, checks ...string) {
		episodes = append(episodes, Episode{ID: "ep", Source: SourceRender, Renderer: "codex", Model: model, Outcome: outcome, Checks: checks, Recalled: []string{"frame-count"}})
	}
	add("gpt-a", scene.OutcomeVerificationFailed, "output.frames")
	add("gpt-a", scene.OutcomeVerificationFailed, "output.frames")
	add("gpt-a", scene.OutcomeSucceeded)
	add("gpt-b", scene.OutcomeVerificationFailed, "output.resolution")
	add("gpt-b", scene.OutcomeVerificationFailed, "output.resolution")
	episodes = append(episodes, Episode{ID: "ep-check", Source: SourceCheck, Renderer: "codex", Model: "gpt-b", Checks: []string{"output.frames"}, Recalled: []string{"frame-count"}})
	got := SuspectMemories(episodes, []Memory{rule})
	if len(got) != 1 || got[0].Renderer != "codex/gpt-a" || got[0].Harmful != 2 || got[0].Recalled != 3 || got[0].Checks[0] != "output.frames" {
		t.Fatalf("suspect=%+v", got)
	}
}

// TestInferredPreferenceWaitsForConfirmation：编排工具推测的偏好进入试用、不进召回，
// 出现在偏好段的待确认里；确认后才生效。
func TestInferredPreferenceWaitsForConfirmation(t *testing.T) {
	store := newStore(t)
	m, snapshot, err := store.Remember(RememberInput{Name: "slower-pacing", Body: "用户几次把节奏改慢", Project: "demo", Inferred: true})
	if err != nil || m.Status != StatusTrial || snapshot.ID != 0 {
		t.Fatalf("m=%+v snapshot=%+v err=%v", m, snapshot, err)
	}
	brief, _, _ := store.PreferenceBrief("demo", 0)
	if !strings.Contains(brief, "待确认的偏好") || !strings.Contains(brief, "【slower-pacing】") || !strings.Contains(brief, "--inferred") {
		t.Fatalf("brief=%s", brief)
	}
	if _, err := store.Promote("slower-pacing"); err != nil {
		t.Fatal(err)
	}
	if found, _, _ := store.Find("slower-pacing"); found.Status != StatusActive {
		t.Fatalf("确认后生效：%+v", found)
	}
}

// TestContrastCodeIsCopiedOnlyWhenStillCurrent：通过那一版的源码拷进整理工作目录，
// 只拷文本源码；镜头目录后来又渲染过（指纹不同）时不拷。
func TestContrastCodeIsCopiedOnlyWhenStillCurrent(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "scene-001")
	sc := writeSceneDir(t, dir, "scene-001", "文本", "")
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>通过的写法</html>"), 0o644)
	os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=1"), 0o644)
	os.WriteFile(filepath.Join(dir, "out.mp4"), []byte("video"), 0o644)
	if err := scene.WriteRecord(sc, scene.Inputs{Fingerprint: "fp-now"}); err != nil {
		t.Fatal(err)
	}
	workdir := t.TempDir()
	clusters := []Cluster{{Key: "output.frames", Contrasts: []Contrast{
		{Failed: "ep-1", Passed: "ep-2", PassedDir: dir, PassedFingerprint: "fp-now"},
		{Failed: "ep-3", Passed: "ep-4", PassedDir: dir, PassedFingerprint: "fp-old"},
	}}}
	copyContrastCode(workdir, clusters)
	current, stale := clusters[0].Contrasts[0], clusters[0].Contrasts[1]
	if current.PassedCode == "" || stale.PassedCode != "" {
		t.Fatalf("contrasts=%+v", clusters[0].Contrasts)
	}
	if body, err := os.ReadFile(filepath.Join(workdir, current.PassedCode, "index.html")); err != nil || !strings.Contains(string(body), "通过的写法") {
		t.Fatalf("index.html=%q err=%v", body, err)
	}
	for _, name := range []string{".env", "out.mp4"} {
		if _, err := os.Stat(filepath.Join(workdir, current.PassedCode, name)); !os.IsNotExist(err) {
			t.Errorf("%s 不该被拷贝", name)
		}
	}
	if line := contrastLine(current); !strings.Contains(line, current.PassedCode) {
		t.Errorf("line=%s", line)
	}
}
