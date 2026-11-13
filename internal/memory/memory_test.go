package memory

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

func writeSceneDir(t *testing.T, dir, id, text, prompt string) scene.Scene {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "transcript.srt"), []byte("1\n00:00:00,000 --> 00:00:03,000\n字幕\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "scene.json"), []byte(`{"id":"`+id+`","duration_seconds":3,"output":"out.mp4","transcript":"transcript.srt","text":"`+text+`"}`), 0o644)
	if prompt != "" {
		os.WriteFile(filepath.Join(dir, "prompt.md"), []byte(prompt), 0o644)
	}
	s, err := scene.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func lesson(name string, status Status, features []string, checks ...string) Memory {
	return Memory{Kind: KindLesson, Meta: Meta{Name: name, Description: "描述 " + name, Status: status,
		AppliesWhen: Applies{Features: features}, CheckedBy: checks, FromEpisodes: []string{"ep-x"}},
		Body: "规则正文。\n\n反例：\n    坏写法\n\n正例：\n    好写法"}
}

func newStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	tick := time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	store.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		tick = tick.Add(time.Second)
		return tick
	}
	return store
}

func TestParseFormatRoundTrip(t *testing.T) {
	m := lesson("font-local-block", StatusActive, []string{"cjk_text"}, "determinism.font-display")
	m.AppliesWhen.Keywords = []string{"字体"}
	parsed, err := Parse(KindLesson, Format(m))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Name != m.Name || parsed.Body != m.Body || parsed.CheckedBy[0] != "determinism.font-display" || parsed.AppliesWhen.Keywords[0] != "字体" {
		t.Errorf("往返后不一致：%+v", parsed)
	}
	if _, err := Parse(KindLesson, []byte("---\nname: x\nstats: {}\n---\n正文")); err == nil {
		t.Error("frontmatter 的未知字段应当报错：写错的字段名不能静默丢掉")
	}
}

func TestLintRejectsModelSpecificAndMemorizedLessons(t *testing.T) {
	ok := lesson("font-local-block", StatusTrial, []string{"cjk_text"}, "determinism.font-display")
	if problems := Lint(ok, LintContext{}); len(problems) > 0 {
		t.Fatalf("合格的经验被拒：%v", problems)
	}
	cases := []struct {
		name   string
		mutate func(*Memory)
		want   string
	}{
		{"工具名", func(m *Memory) { m.Body += "\nClaude 渲染时要这样写" }, "渲染工具名"},
		{"模型名", func(m *Memory) { m.Description = "适用于 GPT-5 的写法" }, "渲染工具名"},
		{"未知校验器", func(m *Memory) { m.CheckedBy = []string{"determinism.nope"} }, "不存在的校验器"},
		{"没有校验器", func(m *Memory) { m.CheckedBy = nil }, "checked_by 为空"},
		{"经验用 human", func(m *Memory) { m.CheckedBy = []string{"human"} }, "写成偏好"},
		{"缺反例", func(m *Memory) { m.Body = "只有规则，正例：好写法" }, "反例"},
		{"未知特征", func(m *Memory) { m.AppliesWhen.Features = []string{"neon"} }, "未知特征"},
		{"镜头编号", func(m *Memory) { m.Body += "\n像 scene-003 那样" }, "镜头编号"},
		{"素材名", func(m *Memory) { m.Body += "\n用 hero-shot.png 当背景" }, "素材文件名"},
		{"抄文案", func(m *Memory) { m.Body += "\n标题写成：人工智能正在改变世界" }, "照抄了镜头文案"},
		{"超长", func(m *Memory) { m.Body += strings.Repeat("长", MaxBodyChars) }, "上限"},
		{"坏名字", func(m *Memory) { m.Name = "Font_Block" }, "name 不合法"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := ok
			m.AppliesWhen.Features = slices.Clone(ok.AppliesWhen.Features)
			tc.mutate(&m)
			problems := Lint(m, LintContext{SceneTexts: []string{"人工智能正在改变世界的每一个角落"}})
			if !strings.Contains(strings.Join(problems, "\n"), tc.want) {
				t.Errorf("应当报出 %q，实际：%v", tc.want, problems)
			}
		})
	}
}

func TestLintRequiresRevisionInsteadOfParallelLesson(t *testing.T) {
	existing := lesson("font-local-block", StatusActive, []string{"cjk_text"}, "determinism.font-display")
	parallel := lesson("font-block-again", StatusTrial, []string{"cjk_text"}, "determinism.font-display")
	if problems := Lint(parallel, LintContext{Existing: []Memory{existing}}); !strings.Contains(strings.Join(problems, ""), "revises: font-local-block") {
		t.Errorf("同一件事并列新增应当被拒：%v", problems)
	}
	parallel.Revises = "font-local-block"
	if problems := Lint(parallel, LintContext{Existing: []Memory{existing}}); len(problems) > 0 {
		t.Errorf("写成修订后应当通过：%v", problems)
	}
	parallel.Revises = "missing"
	if problems := Lint(parallel, LintContext{Existing: []Memory{existing}}); !strings.Contains(strings.Join(problems, ""), "不存在的记忆") {
		t.Errorf("修订目标不存在时应当报错：%v", problems)
	}
	pref := Memory{Kind: KindPreference, Meta: Meta{Name: "no-neon", Description: "不要满屏霓虹", Status: StatusTrial, CheckedBy: []string{"determinism.raf"}}, Body: "克制使用霓虹色"}
	if problems := Lint(pref, LintContext{}); !strings.Contains(strings.Join(problems, ""), "[human]") {
		t.Errorf("偏好必须由人判定：%v", problems)
	}
}

func TestFeaturesAreExtractedFromSceneInputs(t *testing.T) {
	s := writeSceneDir(t, t.TempDir(), "scene-001", "人工智能在2026年改变了一切这是很长的一句话再长一些吧凑够密度", "用 Lottie 做一个柱状图表")
	features, err := Features(s)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"cjk_text", "numbers", "dense_text", "portrait", "lottie", "chart"} {
		if !slices.Contains(features, want) {
			t.Errorf("缺少特征 %s：%v", want, features)
		}
	}
	for _, feature := range features {
		if !KnownFeature(feature) {
			t.Errorf("抽出了词表外的特征 %s：整理者写不出能匹配它的经验", feature)
		}
	}
	s.Timing = &scene.Timing{Exit: scene.Handoff{Peer: "scene-002", Device: scene.HandoffCarry, Bridge: "x", CrossChapter: true}}
	features, _ = Features(s)
	for _, want := range []string{"timing", "handoff", "handoff:carry", "cross_chapter"} {
		if !slices.Contains(features, want) || !KnownFeature(want) {
			t.Errorf("交接特征 %s 缺失或不在词表：%v", want, features)
		}
	}
}

func TestRecallMatchesRanksAndRespectsBudget(t *testing.T) {
	global := lesson("global-rule", StatusActive, nil, "output.frames")
	global.AppliesWhen = Applies{}
	cjk := lesson("cjk-rule", StatusActive, []string{"cjk_text"}, "determinism.font-display")
	cast := lesson("cast-rule", StatusActive, []string{"cast"}, "determinism.raf")
	keyword := lesson("keyword-rule", StatusActive, nil, "determinism.clock")
	keyword.AppliesWhen = Applies{Keywords: []string{"倒计时"}}
	other := Memory{Kind: KindPreference, Meta: Meta{Name: "other-project", Description: "别的项目", Status: StatusActive, CheckedBy: []string{"human"}, Scope: "elsewhere"}, Body: "x"}
	in := RecallInput{Memories: []Memory{global, cjk, cast, keyword, other}, Renderer: "claude",
		Features: []string{"cjk_text", "portrait"}, Text: "一个倒计时", Project: "mine", Budget: 10000}
	result := Recall(in)
	names := result.Names()
	if !slices.Equal(names, []string{"cjk-rule", "global-rule", "keyword-rule"}) {
		t.Fatalf("召回结果不对：%v", names)
	}
	if again := Recall(in); !slices.Equal(again.Names(), names) || again.Digest() != result.Digest() || again.Section() != result.Section() {
		t.Error("同样的输入应当得到同样的召回")
	}
	if !strings.Contains(result.Items[0].Reason(), "cjk_text") || result.Items[1].Reason() != "全局适用" {
		t.Errorf("召回理由不对：%q / %q", result.Items[0].Reason(), result.Items[1].Reason())
	}
	// 效果统计改变排序：全局规则在 claude 上屡试屡成，cjk 规则屡试屡败。
	in.Stats = map[string]map[string]Stat{"global-rule": {"claude": {Recalled: 10, PassedFirstTry: 10}}, "cjk-rule": {"claude": {Recalled: 10, PassedFirstTry: 0}}}
	if ranked := Recall(in).Names(); ranked[0] != "global-rule" {
		t.Errorf("效果好的记忆应当排前：%v", ranked)
	}
	in.Stats = nil
	in.Budget = result.Items[0].Chars
	limited := Recall(in)
	if len(limited.Items) != 1 || len(limited.Omitted) != 2 || limited.Used > in.Budget {
		t.Errorf("字数预算没生效：items=%v omitted=%d used=%d", limited.Names(), len(limited.Omitted), limited.Used)
	}
	in.Budget = 0
	if len(Recall(in).Items) != 0 {
		t.Error("预算为 0 时什么也不召回")
	}
}

func TestRecallReadsSnapshotNotFilesAndRollbackRestores(t *testing.T) {
	store := newStore(t)
	s := writeSceneDir(t, t.TempDir(), "scene-001", "中文标题", "")
	if result, err := store.RecallScene(s, RecallOptions{Budget: 1500}); err != nil || len(result.Items) != 0 {
		t.Fatalf("没有快照时不召回：%v %v", result.Names(), err)
	}
	first := lesson("cjk-rule", StatusActive, []string{"cjk_text"}, "determinism.font-display")
	if err := store.Write(first); err != nil {
		t.Fatal(err)
	}
	if result, _ := store.RecallScene(s, RecallOptions{Budget: 1500}); len(result.Items) != 0 {
		t.Fatal("手写的记忆未记快照前不该被召回")
	}
	report, err := store.Status(true)
	if err != nil || report.Recorded != 1 || !slices.Equal(report.Drift, []string{"cjk-rule"}) {
		t.Fatalf("status 应当把人工编辑记成快照 #1：%+v %v", report, err)
	}
	snap1, _ := store.LoadSnapshot(1)
	if !snap1.Unverified {
		t.Error("人工编辑的快照应当标为未经考试")
	}
	r1, _ := store.RecallScene(s, RecallOptions{Budget: 1500})
	if !slices.Equal(r1.Names(), []string{"cjk-rule"}) || r1.Snapshot != 1 {
		t.Fatalf("应当按快照 #1 召回：%+v", r1)
	}
	harmful := lesson("loop-forever", StatusActive, nil, "determinism.infinite-repeat")
	harmful.AppliesWhen = Applies{}
	store.Write(harmful)
	if _, err := store.TakeSnapshot(EventPromote, "塞入有害记忆", true); err != nil {
		t.Fatal(err)
	}
	r2, _ := store.RecallScene(s, RecallOptions{Budget: 1500})
	if len(r2.Items) != 2 || r2.Digest() == r1.Digest() {
		t.Fatalf("快照 #2 应当召回两条：%v", r2.Names())
	}
	pinned, _ := store.RecallScene(s, RecallOptions{Snapshot: 1, Budget: 1500})
	if pinned.Digest() != r1.Digest() {
		t.Error("钉住快照 #1 时召回应当与当时一致")
	}
	rolled, err := store.Rollback(0)
	if err != nil {
		t.Fatal(err)
	}
	if rolled.ID != 3 || rolled.RestoredFrom != 1 {
		t.Errorf("回退应当生成新快照 #3、来源 #1：%+v", rolled)
	}
	r3, _ := store.RecallScene(s, RecallOptions{Budget: 1500})
	if r3.Digest() != r1.Digest() || r3.Section() != r1.Section() {
		t.Error("回退后召回段应当与快照 #1 逐字相同（镜头不会因此 Stale）")
	}
	if m, _, _ := store.Find("loop-forever"); m.Status != StatusDormant {
		t.Errorf("不在目标快照里的生效记忆应当转为沉睡，实际 %s", m.Status)
	}
	if ids, _ := store.SnapshotIDs(); !slices.Equal(ids, []int{1, 2, 3}) {
		t.Errorf("回退不删除历史：%v", ids)
	}
	index, _ := os.ReadFile(filepath.Join(store.Dir, "MEMORY.md"))
	if !strings.Contains(string(index), "cjk-rule") || strings.Contains(string(index), "loop-forever") {
		t.Errorf("索引只列生效记忆：\n%s", index)
	}
}

func failingAttempt(renderer string, checks ...string) scene.Attempt {
	problems := make([]string, len(checks))
	for i, c := range checks {
		problems[i] = "问题 " + c
	}
	return scene.Attempt{Renderer: renderer, Outcome: scene.OutcomeVerificationFailed, Problems: problems, Checks: checks}
}

func TestEpisodesFreezeInputsAndFeedStatsAndClusters(t *testing.T) {
	store := newStore(t)
	s := writeSceneDir(t, t.TempDir(), "scene-001", "中文标题", "创意方向")
	s.Memory = &scene.MemoryRecall{Snapshot: 1, Names: []string{"cjk-rule"}}
	ep, err := store.RecordAttempt(s, failingAttempt("claude", "determinism.raf", "output.frames"), SourceRender, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"scene.json", "transcript.srt", "prompt.md"} {
		if _, err := os.Stat(filepath.Join(ep.Dir, "input", rel)); err != nil {
			t.Errorf("冻结输入缺少 %s", rel)
		}
	}
	if _, err := scene.Load(filepath.Join(ep.Dir, "input")); err != nil {
		t.Errorf("冻结输入应当能原样加载：%v", err)
	}
	store.RecordAttempt(s, failingAttempt("codex", "determinism.raf"), SourceRender, "")
	store.RecordAttempt(s, scene.Attempt{Renderer: "codex", Outcome: scene.OutcomeSucceeded}, SourceRender, "")
	store.RecordAttempt(s, scene.Attempt{Renderer: "codex", Outcome: scene.OutcomeSucceeded, Retry: true}, SourceRender, "")
	store.RecordAttempt(s, failingAttempt("codex", "determinism.raf"), SourceExam, "exam-0001")
	store.RecordAttempt(s, scene.Attempt{Renderer: "codex", Outcome: scene.OutcomeFailed, Error: "退出码 1"}, SourceRender, "")
	store.RecordFeedback(s, Feedback{Verdict: "down", Note: "霓虹太多", Seconds: -1})
	episodes, err := store.Episodes()
	if err != nil || len(episodes) != 7 {
		t.Fatalf("应当有 7 段经历：%d %v", len(episodes), err)
	}
	stats := ComputeStats(episodes)
	if got := stats["cjk-rule"]["codex"]; got.Recalled != 3 || got.PassedFirstTry != 1 {
		t.Errorf("统计只计正式渲染的首次尝试：%+v", got)
	}
	clusters := ClusterFailures(episodes)
	if len(clusters) != 3 || clusters[0].Key != "determinism.raf" || clusters[0].Count != 2 {
		t.Fatalf("聚类不对（考试与渲染器崩溃都不算）：%+v", clusters)
	}
	if clusters[0].Renderers["claude"] != 1 || clusters[0].Renderers["codex"] != 1 || !slices.Contains(clusters[0].Recalled, "cjk-rule") {
		t.Errorf("聚类应当记下渲染工具分布与失败时已召回的记忆：%+v", clusters[0])
	}
	if !slices.ContainsFunc(clusters, func(c Cluster) bool { return c.Key == ClusterKeyHuman && c.Notes[0] == "霓虹太多" }) {
		t.Errorf("人工 👎 应当单独成组：%+v", clusters)
	}
}

func TestConsolidateIngestsOnlyValidDrafts(t *testing.T) {
	store := newStore(t)
	s := writeSceneDir(t, t.TempDir(), "scene-001", "人工智能正在改变世界", "")
	a, _ := store.RecordAttempt(s, failingAttempt("claude", "determinism.raf"), SourceRender, "")
	b, _ := store.RecordAttempt(s, failingAttempt("codex", "determinism.raf"), SourceRender, "")
	store.RecordAttempt(s, failingAttempt("codex", "output.audio"), SourceRender, "")
	var brief string
	drafter := func(ctx context.Context, workdir, prompt string) error {
		brief = prompt
		good := lesson("timeline-not-raf", StatusActive, nil, "determinism.raf")
		good.AppliesWhen = Applies{}
		good.FromEpisodes = []string{a.ID, b.ID}
		os.WriteFile(filepath.Join(workdir, "drafts", "lessons", "timeline-not-raf.md"), Format(good), 0o644)
		bad := lesson("claude-tip", StatusTrial, nil, "determinism.raf")
		bad.Body += "\nClaude 特别容易犯"
		bad.FromEpisodes = []string{a.ID}
		os.WriteFile(filepath.Join(workdir, "drafts", "lessons", "claude-tip.md"), Format(bad), 0o644)
		stray := lesson("stray-source", StatusTrial, []string{"cast"}, "output.frames")
		stray.FromEpisodes = []string{"ep-made-up"}
		os.WriteFile(filepath.Join(workdir, "drafts", "lessons", "stray-source.md"), Format(stray), 0o644)
		return nil
	}
	result, err := store.Consolidate(context.Background(), ConsolidateOptions{MinCount: 2, Drafter: drafter})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Clusters) != 1 || result.Clusters[0].Key != "determinism.raf" {
		t.Errorf("只有出现 2 次的组交给整理者：%+v", result.Clusters)
	}
	if !strings.Contains(brief, a.ID) || strings.Contains(brief, "output.audio ×") || !strings.Contains(brief, "determinism.raf") {
		t.Errorf("说明里应当有高频组与经历编号：\n%s", brief)
	}
	if !slices.Equal(result.Accepted, []string{"timeline-not-raf"}) || len(result.Rejected) != 2 {
		t.Fatalf("应当收 1 拒 2：accepted=%v rejected=%v", result.Accepted, result.Rejected)
	}
	m, _, _ := store.Find("timeline-not-raf")
	if m.Status != StatusTrial {
		t.Errorf("草稿一律进入试用，不论它自己写了什么状态：%s", m.Status)
	}
	again, err := store.Consolidate(context.Background(), ConsolidateOptions{MinCount: 1, Drafter: func(context.Context, string, string) error {
		t.Error("上次整理之后没有新失败，不该再调用整理者")
		return nil
	}})
	if err != nil || len(again.Clusters) != 0 {
		t.Errorf("整理只看上次之后的经历：%+v %v", again.Clusters, err)
	}
}

func TestJudgeGates(t *testing.T) {
	questions := []Question{{ID: "q1"}, {ID: "h1", Holdout: true}}
	renderers := []string{"claude", "codex"}
	cell := func(q, r string, arm Arm, passed bool) Cell {
		c := Cell{Question: q, Renderer: r, Arm: arm, Passed: passed, Outcome: scene.OutcomeSucceeded}
		if !passed {
			c.Outcome, c.Problems = scene.OutcomeVerificationFailed, 2
		}
		return c
	}
	matrix := func(override func(*Cell)) []Cell {
		var cells []Cell
		for _, q := range []string{"q1", "h1"} {
			for _, r := range renderers {
				cells = append(cells, cell(q, r, ArmControl, q == "h1"), cell(q, r, ArmTrial, true))
			}
		}
		if override != nil {
			for i := range cells {
				override(&cells[i])
			}
		}
		return cells
	}
	if v := Judge(questions, renderers, matrix(nil), false); !v.Pass || v.TrialScore <= v.ControlScore {
		t.Fatalf("试用组严格更好时应当通过：%+v", v)
	}
	regress := matrix(func(c *Cell) {
		if c.Question == "h1" && c.Renderer == "codex" && c.Arm == ArmTrial {
			c.Passed, c.Outcome, c.Problems = false, scene.OutcomeVerificationFailed, 1
		}
	})
	if v := Judge(questions, renderers, regress, false); v.Pass || !strings.Contains(strings.Join(v.Reasons, ""), "codex") {
		t.Errorf("任意一个渲染工具上退步都不能通过：%+v", v)
	}
	same := matrix(func(c *Cell) {
		if c.Question == "q1" && c.Arm == ArmTrial {
			c.Passed, c.Outcome, c.Problems = false, scene.OutcomeVerificationFailed, 2
		}
	})
	if v := Judge(questions, renderers, same, false); v.Pass || !strings.Contains(strings.Join(v.Reasons, ""), "总分没有提高") {
		t.Errorf("总分持平不能通过：%+v", v)
	}
	broken := matrix(func(c *Cell) {
		if c.Renderer == "claude" && c.Arm == ArmControl && c.Question == "q1" {
			c.Invalid, c.Outcome, c.Error = true, scene.OutcomeFailed, "Not logged in"
		}
	})
	if v := Judge(questions, renderers, broken, false); v.Pass || !v.Invalid {
		t.Errorf("渲染工具自身故障使考试无效，而不是按 0 分处理：%+v", v)
	}
	if v := Judge(questions, renderers, matrix(nil)[1:], false); !v.Invalid {
		t.Errorf("缺格的考试无效：%+v", v)
	}
	if v := Judge(questions, renderers, matrix(nil), true); v.Pass || !v.NeedsHuman {
		t.Errorf("考试期间生效记忆变过要转人工确认：%+v", v)
	}
	repeated := append(matrix(nil), cell("h1", "claude", ArmTrial, false), cell("h1", "claude", ArmTrial, false))
	if v := Judge(questions, renderers, repeated, false); v.Pass || !strings.Contains(strings.Join(v.Reasons, ""), "退步") {
		t.Errorf("重复格按多数结果判定：%+v", v)
	}
}

// TestExamPromotesHelpfulAndRejectsHarmfulLessons 用假作答者跑完整条链：
// 作答者只在召回了「有用」记忆时通过、召回了「有害」记忆时失败，
// 有用的转为生效并生成快照，有害的被拒且不会被召回。
func TestExamPromotesHelpfulAndRejectsHarmfulLessons(t *testing.T) {
	store := newStore(t)
	project := t.TempDir()
	s := writeSceneDir(t, filepath.Join(project, "scenes", "scene-001"), "scene-001", "中文标题", "")
	failed, _ := store.RecordAttempt(s, failingAttempt("claude", "determinism.raf"), SourceRender, "")
	holdout := writeSceneDir(t, filepath.Join(project, "scenes", "scene-009"), "scene-009", "另一个镜头", "")

	helpful := lesson("timeline-not-raf", StatusTrial, nil, "determinism.raf")
	helpful.AppliesWhen, helpful.FromEpisodes = Applies{}, []string{failed.ID}
	harmful := lesson("loop-forever", StatusTrial, nil, "determinism.infinite-repeat")
	harmful.AppliesWhen, harmful.FromEpisodes = Applies{}, []string{failed.ID}
	store.Write(helpful)
	store.Write(harmful)

	run := func(ctx context.Context, sc scene.Scene, renderer string) scene.Attempt {
		var names []string
		if sc.Memory != nil {
			names = sc.Memory.Names
		}
		switch {
		case slices.Contains(names, "loop-forever"):
			return failingAttempt(renderer, "determinism.infinite-repeat")
		case slices.Contains(names, "timeline-not-raf") || sc.ID == "scene-009":
			return scene.Attempt{Renderer: renderer, Outcome: scene.OutcomeSucceeded}
		}
		return failingAttempt(renderer, "determinism.raf")
	}
	opts := ExamOptions{Renderers: []string{"claude", "codex"}, Holdout: []string{holdout.Directory}, Budget: 1500,
		Workspace: filepath.Join(project, "production", "memory-exams"), Run: run, Jobs: 3}

	opts.Trial = []string{"loop-forever"}
	bad, err := store.Exam(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if bad.Verdict.Pass || bad.Applied != "rejected" {
		t.Fatalf("有害记忆应当被拒：%+v", bad.Verdict)
	}
	if m, _, _ := store.Find("loop-forever"); m.Status != StatusRejected || !strings.Contains(m.RejectedReason, bad.ID) {
		t.Errorf("被拒记忆要保留原因：%+v", m.Meta)
	}

	opts.Trial = []string{"timeline-not-raf"}
	good, err := store.Exam(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if !good.Verdict.Pass || good.Applied != "promoted" || good.Snapshot != 1 {
		t.Fatalf("有用的记忆应当生效并生成快照 #1：%+v applied=%s", good.Verdict, good.Applied)
	}
	if len(good.Cells) != 2*2*2 || len(good.Questions) != 2 {
		t.Errorf("矩阵应当是 2 题 × 2 工具 × 2 组：%d 格", len(good.Cells))
	}
	m, _, _ := store.Find("timeline-not-raf")
	if m.Status != StatusActive || !slices.Contains(m.VerifiedBy, good.ID) {
		t.Errorf("生效记忆要记下考试编号：%+v", m.Meta)
	}
	result, _ := store.RecallScene(s, RecallOptions{Budget: 1500})
	if !slices.Equal(result.Names(), []string{"timeline-not-raf"}) {
		t.Errorf("正式召回只有生效记忆：%v", result.Names())
	}
	for _, c := range good.Cells {
		if !strings.HasPrefix(c.Workdir, opts.Workspace) {
			t.Errorf("考场应当建在项目里：%s", c.Workdir)
		}
	}
	stats, _ := store.Stats()
	if len(stats) != 0 {
		t.Errorf("考试不计入效果统计：%v", stats)
	}
	exams, _ := store.Exams()
	if len(exams) != 2 {
		t.Errorf("两场考试都要留下记录：%d", len(exams))
	}
	events, _ := store.Timeline()
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, e.Type)
	}
	for _, want := range []string{EventReject, EventExam, EventSnapshot, EventPromote} {
		if !slices.Contains(kinds, want) {
			t.Errorf("时间线缺少 %s：%v", want, kinds)
		}
	}
}

func TestPromoteRevisionRetiresPredecessor(t *testing.T) {
	store := newStore(t)
	old := lesson("font-old", StatusActive, []string{"cjk_text"}, "determinism.font-display")
	store.Write(old)
	store.TakeSnapshot(EventManualEdit, "初始", true)
	revision := lesson("font-new", StatusTrial, []string{"cjk_text"}, "determinism.font-display")
	revision.Revises = "font-old"
	store.Write(revision)
	s := writeSceneDir(t, t.TempDir(), "scene-001", "中文", "")
	trial, _ := store.RecallScene(s, RecallOptions{Budget: 1500, Extra: []Memory{revision}})
	if !slices.Equal(trial.Names(), []string{"font-new"}) {
		t.Errorf("试用组里修订取代旧版本，不能两版同时注入：%v", trial.Names())
	}
	if _, err := store.Promote("font-new"); err != nil {
		t.Fatal(err)
	}
	if m, _, _ := store.Find("font-old"); m.Status != StatusDormant {
		t.Errorf("修订生效后旧版本转为沉睡：%s", m.Status)
	}
}

func TestWeakMemoriesComparesAgainstBaseline(t *testing.T) {
	var episodes []Episode
	for i := 0; i < 6; i++ {
		episodes = append(episodes, Episode{Source: SourceRender, Renderer: "codex", Recalled: []string{"useless"}, Outcome: scene.OutcomeVerificationFailed})
		episodes = append(episodes, Episode{Source: SourceRender, Renderer: "codex", Outcome: scene.OutcomeSucceeded})
		episodes = append(episodes, Episode{Source: SourceRender, Renderer: "claude", Recalled: []string{"useful"}, Outcome: scene.OutcomeSucceeded})
		episodes = append(episodes, Episode{Source: SourceRender, Renderer: "claude", Outcome: scene.OutcomeVerificationFailed})
	}
	weak := WeakMemories(episodes, []string{"useless", "useful"})
	if len(weak) != 1 || weak[0].Name != "useless" || weak[0].Renderer != "codex" {
		t.Errorf("只有不如基线的记忆是待沉睡候选：%+v", weak)
	}
}

func TestManualStatusChangesGuardTheirPreconditions(t *testing.T) {
	store := newStore(t)
	store.Write(lesson("trial-one", StatusTrial, nil, "output.frames"))
	store.Write(lesson("active-one", StatusActive, []string{"cast"}, "determinism.raf"))
	if _, err := store.Retire("trial-one", ""); err == nil {
		t.Error("只有生效记忆能转为沉睡")
	}
	if err := store.Reject("active-one", ""); err == nil {
		t.Error("只有试用记忆能被拒")
	}
	if _, err := store.Promote("missing"); err == nil {
		t.Error("不存在的记忆不能确认生效")
	}
	if err := store.Reject("trial-one", ""); err != nil {
		t.Fatal(err)
	}
	if m, _, _ := store.Find("trial-one"); m.Status != StatusRejected || m.RejectedReason != "人工拒绝" {
		t.Errorf("人工拒绝要留下原因：%+v", m.Meta)
	}
	snapshot, err := store.Retire("active-one", "没帮上忙")
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Entries) != 0 {
		t.Errorf("沉睡后快照里不该再有它：%+v", snapshot.Entries)
	}
}

// TestRecallRespectsRendererAndModelScope：不同模型犯的错不一样，
// 限定了渲染工具或模型的经验只召回给它们；模型未知时不召回限定了模型的经验。
func TestRecallRespectsRendererAndModelScope(t *testing.T) {
	general := lesson("general-rule", StatusActive, nil, "output.frames")
	general.AppliesWhen = Applies{}
	codexOnly := lesson("codex-rule", StatusActive, nil, "determinism.raf")
	codexOnly.AppliesWhen = Applies{Renderers: []string{"codex"}}
	gpt6 := lesson("gpt6-rule", StatusActive, nil, "determinism.clock")
	gpt6.AppliesWhen = Applies{Models: []string{"GPT-6"}}
	in := RecallInput{Memories: []Memory{general, codexOnly, gpt6}, Budget: 10000}
	cases := []struct {
		renderer, model string
		want            []string
	}{
		{"codex", "gpt-6-astra", []string{"gpt6-rule", "codex-rule", "general-rule"}},
		{"codex", "", []string{"codex-rule", "general-rule"}},
		{"claude", "claude-opus-5-5", []string{"general-rule"}},
		{"opencode", "gpt-6-mini", []string{"gpt6-rule", "general-rule"}},
	}
	for _, tc := range cases {
		in.Renderer, in.Model = tc.renderer, tc.model
		result := Recall(in)
		if got := result.Names(); !slices.Equal(got, tc.want) {
			t.Errorf("%s/%s 召回 %v，期望 %v（专属经验排在通用经验前）", tc.renderer, tc.model, got, tc.want)
		}
	}
	in.Renderer, in.Model = "codex", "gpt-6-astra"
	if reason := Recall(in).Items[0].Reason(); !strings.Contains(reason, "专为 GPT-6") {
		t.Errorf("召回理由要说明是专为哪个模型：%q", reason)
	}
	scoped := codexOnly
	scoped.AppliesWhen.Renderers = []string{"vim"}
	if problems := Lint(scoped, LintContext{}); !strings.Contains(strings.Join(problems, ""), "未知渲染工具") {
		t.Errorf("范围里的渲染工具要校验：%v", problems)
	}
	named := general
	named.Body += "\ncodex 常犯这个错"
	if problems := Lint(named, LintContext{}); !strings.Contains(strings.Join(problems, ""), "applies_when.renderers") {
		t.Errorf("正文写模型名时要提示改用范围字段：%v", problems)
	}
	if general.RuleDigest() == "" || codexOnly.RuleDigest() == general.RuleDigest() {
		t.Error("范围是规则内容的一部分")
	}
}

func TestModelIsObservedPerRendererAndClustered(t *testing.T) {
	store := newStore(t)
	s := writeSceneDir(t, t.TempDir(), "scene-001", "中文", "")
	if model := store.CurrentModel("claude", map[string]string{}); model != "" {
		t.Fatalf("没观测过时模型未知：%q", model)
	}
	a := failingAttempt("claude", "determinism.raf")
	a.Model = "claude-opus-5-5"
	store.RecordAttempt(s, a, SourceRender, "")
	b := failingAttempt("codex", "determinism.raf")
	b.Model = "gpt-6-astra"
	store.RecordAttempt(s, b, SourceRender, "")
	store.RecordAttempt(s, b, SourceRender, "")
	if model := store.CurrentModel("claude", map[string]string{}); model != "claude-opus-5-5" {
		t.Errorf("应当记住最近实测到的模型：%q", model)
	}
	episodes, _ := store.Episodes()
	clusters := ClusterFailures(episodes)
	if clusters[0].Models["codex/gpt-6-astra"] != 2 || clusters[0].Models["claude/claude-opus-5-5"] != 1 {
		t.Errorf("聚类要按渲染工具/模型计数：%v", clusters[0].Models)
	}
	if brief := consolidationBrief(clusters, nil); !strings.Contains(brief, "codex/gpt-6-astra × 2") || !strings.Contains(brief, "applies_when.models") {
		t.Errorf("整理说明里要有模型分布与范围写法：\n%s", brief)
	}
}

// TestRememberFeedsPreferenceBrief：用户亲口说的偏好当场生效，
// 进入编排工具的偏好段；只对本项目成立的偏好不出现在别的项目里。
func TestRememberFeedsPreferenceBrief(t *testing.T) {
	store := newStore(t)
	empty, emptyDigest, err := store.PreferenceBrief("demo", 0)
	if err != nil || !strings.Contains(empty, "还没有记下任何偏好") || !strings.Contains(empty, "am memory remember") {
		t.Fatalf("空库也要告诉编排工具怎样记偏好：%q %v", empty, err)
	}
	if _, _, err := store.Remember(RememberInput{Body: "字幕用黄色"}); err == nil {
		t.Error("不在项目里又没加 --global 时应当报错")
	}
	m, snap, err := store.Remember(RememberInput{Name: "yellow-captions", Body: "字幕一律用黄色。底色深一些。", Project: "demo"})
	if err != nil {
		t.Fatal(err)
	}
	if m.Status != StatusActive || m.Scope != "demo" || m.Description != "字幕一律用黄色" || snap.ID != 1 {
		t.Errorf("偏好应当当场生效、限本项目、描述取第一句：%+v 快照 #%d", m.Meta, snap.ID)
	}
	store.Remember(RememberInput{Name: "no-emoji", Body: "画面里不要 emoji", Global: true})
	brief, digest, _ := store.PreferenceBrief("demo", 0)
	if !strings.Contains(brief, "【yellow-captions】（本项目）") || !strings.Contains(brief, "【no-emoji】（全局）") || digest == emptyDigest {
		t.Errorf("偏好段不对：\n%s", brief)
	}
	if other, _, _ := store.PreferenceBrief("other", 0); strings.Contains(other, "yellow-captions") || !strings.Contains(other, "no-emoji") {
		t.Errorf("本项目的偏好不该出现在别的项目：\n%s", other)
	}
	if _, _, err := store.Remember(RememberInput{Name: "yellow-captions", Body: "x", Project: "demo"}); err == nil {
		t.Error("重名应当报错")
	}
	if _, _, err := store.Remember(RememberInput{Name: "white-captions", Body: "字幕改用白色", Project: "demo", Revises: "yellow-captions"}); err != nil {
		t.Fatal(err)
	}
	if old, _, _ := store.Find("yellow-captions"); old.Status != StatusDormant {
		t.Errorf("被替换的偏好转为沉睡：%s", old.Status)
	}
	s := writeSceneDir(t, filepath.Join(t.TempDir(), "demo", "scenes", "scene-001"), "scene-001", "标题", "")
	os.WriteFile(filepath.Join(filepath.Dir(filepath.Dir(s.Directory)), "article-to-motion.conf"), []byte(""), 0o644)
	result, _ := store.RecallScene(s, RecallOptions{Budget: 1500, Renderer: "claude"})
	if !slices.Contains(result.Names(), "white-captions") || !slices.Contains(result.Names(), "no-emoji") {
		t.Errorf("偏好也召回给渲染工具：%v", result.Names())
	}
}
