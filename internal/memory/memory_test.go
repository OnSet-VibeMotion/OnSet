package memory

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
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
	report, err := store.Status(true, nil)
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
	ep, err := store.RecordAttempt(s, failingAttempt("claude", "determinism.raf", "output.frames"), AttemptSource{Source: SourceRender})
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
	store.RecordAttempt(s, failingAttempt("codex", "determinism.raf"), AttemptSource{Source: SourceRender})
	store.RecordAttempt(s, scene.Attempt{Renderer: "codex", Outcome: scene.OutcomeSucceeded}, AttemptSource{Source: SourceRender})
	store.RecordAttempt(s, scene.Attempt{Renderer: "codex", Outcome: scene.OutcomeSucceeded, Retry: true}, AttemptSource{Source: SourceRender})
	store.RecordAttempt(s, failingAttempt("codex", "determinism.raf"), AttemptSource{Source: SourceExam, Exam: "exam-0001"})
	store.RecordAttempt(s, scene.Attempt{Renderer: "codex", Outcome: scene.OutcomeFailed, Error: "退出码 1"}, AttemptSource{Source: SourceRender})
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
	if !slices.ContainsFunc(clusters, func(c Cluster) bool { return c.Key == ClusterKeyHuman && c.Notes[0] == "（👎）霓虹太多" }) {
		t.Errorf("人工 👎 应当单独成组：%+v", clusters)
	}
}

func TestConsolidateIngestsOnlyValidDrafts(t *testing.T) {
	store := newStore(t)
	s := writeSceneDir(t, t.TempDir(), "scene-001", "人工智能正在改变世界", "")
	a, _ := store.RecordAttempt(s, failingAttempt("claude", "determinism.raf"), AttemptSource{Source: SourceRender})
	b, _ := store.RecordAttempt(s, failingAttempt("codex", "determinism.raf"), AttemptSource{Source: SourceRender})
	store.RecordAttempt(s, failingAttempt("codex", "output.audio"), AttemptSource{Source: SourceRender})
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
	failed, _ := store.RecordAttempt(s, failingAttempt("claude", "determinism.raf"), AttemptSource{Source: SourceRender})
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
	store.RecordAttempt(s, a, AttemptSource{Source: SourceRender})
	b := failingAttempt("codex", "determinism.raf")
	b.Model = "gpt-6-astra"
	store.RecordAttempt(s, b, AttemptSource{Source: SourceRender})
	store.RecordAttempt(s, b, AttemptSource{Source: SourceRender})
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

// TestCheckEpisodesInheritRenderAndDemoteStats：事后检查查出的问题记到最近一次
// 渲染上，同一份产物重复检查不重复计数，渲染时「通过」的产物在统计里不再算通过。
func TestCheckEpisodesInheritRenderAndDemoteStats(t *testing.T) {
	store := newStore(t)
	s := writeSceneDir(t, t.TempDir(), "scene-001", "中文", "")
	s.Memory = &scene.MemoryRecall{Snapshot: 1, Names: []string{"cjk-rule"}}
	render := scene.Attempt{Renderer: "codex", Model: "gpt-6-astra", Outcome: scene.OutcomeSucceeded, Fingerprint: "fp1"}
	store.RecordAttempt(s, render, AttemptSource{Source: SourceRender, Run: "run-1"})
	if stats, _ := store.Stats(); stats["cjk-rule"]["codex/gpt-6-astra"].PassedFirstTry != 1 {
		t.Fatalf("检查前算通过：%v", stats)
	}
	s.Memory = nil
	finding := []Finding{{Check: "reads.duration", Problem: "e1 可读 5 帧，还差 20 帧"}}
	ep, recorded, err := store.RecordCheck(s, finding)
	if err != nil || !recorded {
		t.Fatalf("应当记下：%v", err)
	}
	if ep.Renderer != "codex" || ep.Model != "gpt-6-astra" || ep.Fingerprint != "fp1" || ep.Run != "run-1" || !slices.Equal(ep.Recalled, []string{"cjk-rule"}) {
		t.Errorf("检查经历要继承最近一次渲染：%+v", ep)
	}
	if _, again, _ := store.RecordCheck(s, finding); again {
		t.Error("同一份产物同一组问题不重复记录")
	}
	stats, _ := store.Stats()
	if got := stats["cjk-rule"]["codex/gpt-6-astra"]; got.Recalled != 1 || got.PassedFirstTry != 0 {
		t.Errorf("事后查出问题的产物不算一次通过：%+v", got)
	}
	episodes, _ := store.Episodes()
	clusters := ClusterFailures(episodes)
	if len(clusters) != 1 || clusters[0].Key != "reads.duration" {
		t.Errorf("检查问题进入聚类：%+v", clusters)
	}
}

// TestExamSkipsWholeFilmLessonsAndPostChecksBlankFrames：只由整片检查判定的经验
// 考不了，转人工确认；引用空白帧的经验在考试里补查首帧。
func TestExamSkipsWholeFilmLessonsAndPostChecksBlankFrames(t *testing.T) {
	store := newStore(t)
	project := t.TempDir()
	s := writeSceneDir(t, filepath.Join(project, "scenes", "scene-001"), "scene-001", "中文标题", "")
	failed, _, _ := store.RecordCheck(s, []Finding{{Check: "frames.blank", Problem: "第 0 帧是空白帧"}})
	reads := lesson("reads-pacing", StatusTrial, nil, "reads.duration")
	reads.AppliesWhen, reads.FromEpisodes = Applies{}, []string{failed.ID}
	store.Write(reads)
	run := func(ctx context.Context, sc scene.Scene, renderer string) scene.Attempt {
		return scene.Attempt{Renderer: renderer, Outcome: scene.OutcomeSucceeded}
	}
	opts := ExamOptions{Renderers: []string{"codex"}, Budget: 1500, Workspace: filepath.Join(project, "production", "memory-exams"), Run: run}
	if _, err := store.Exam(context.Background(), opts); err == nil || !strings.Contains(err.Error(), "promote") {
		t.Fatalf("只有整片检查的经验考不了，要提示人工确认：%v", err)
	}
	opts.Trial = []string{"reads-pacing"}
	if _, err := store.Exam(context.Background(), opts); err == nil || !strings.Contains(err.Error(), "单镜头回放考不了") {
		t.Fatalf("点名考整片经验时要说明原因：%v", err)
	}
	cover := lesson("paint-first-frame", StatusTrial, nil, "frames.blank")
	cover.AppliesWhen, cover.FromEpisodes = Applies{}, []string{failed.ID}
	store.Write(cover)
	opts.Trial = nil
	opts.PostCheck = func(ctx context.Context, sc scene.Scene, checks []string) []Finding {
		if !slices.Equal(checks, []string{"frames.blank"}) {
			t.Errorf("只补查试用经验引用的校验器：%v", checks)
		}
		if sc.Memory != nil && slices.Contains(sc.Memory.Names, "paint-first-frame") {
			return nil
		}
		return []Finding{{Check: "frames.blank", Problem: "第 0 帧是空白帧"}}
	}
	result, err := store.Exam(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Verdict.Pass || !slices.Equal(result.Trials, []string{"paint-first-frame"}) {
		t.Fatalf("补查首帧后试用组应当胜出：%+v trials=%v", result.Verdict, result.Trials)
	}
	for _, c := range result.Cells {
		if c.Arm == ArmControl && (c.Passed || !slices.Contains(c.Checks, "frames.blank")) {
			t.Errorf("对照组的空白首帧要被补查出来：%+v", c)
		}
	}
	if m, _, _ := store.Find("reads-pacing"); m.Status != StatusTrial {
		t.Errorf("考不了的经验保持试用，等人确认：%s", m.Status)
	}
}

// TestConversationSignalsBecomePreferenceCluster：单独一句话不算信号；
// 在不同轮次反复提的要求、被回退的一轮才交给整理者。
func TestConversationSignalsBecomePreferenceCluster(t *testing.T) {
	store := newStore(t)
	project := filepath.Join(t.TempDir(), "demo")
	os.MkdirAll(project, 0o755)
	os.WriteFile(filepath.Join(project, "article-to-motion.conf"), nil, 0o644)
	say := func(turn, message string, reverted bool) {
		t.Helper()
		if _, err := store.RecordUtterance(Utterance{ProjectDir: project, Session: "s1", Turn: turn, Message: message, Reverted: reverted}); err != nil {
			t.Fatal(err)
		}
	}
	say("t1", "节奏再慢一点", false)
	say("t2", "把标题换成蓝色", false)
	say("t3", "再慢一点吧", false)
	say("t3", "再慢一点吧", false) // 同一轮重复记录不算
	say("t4", "开头加个爆炸特效", false)
	say("t4", "开头加个爆炸特效", true)
	say("t5", "慢一点，节奏慢一点", false)
	episodes, _ := store.Episodes()
	if len(episodes) != 6 {
		t.Fatalf("同一轮只记一次说话、一次回退：%d", len(episodes))
	}
	signals := PreferenceSignals(episodes)
	if len(signals) != 2 || signals[0].Kind != "repeated" || signals[0].Count != 3 || signals[1].Kind != "reverted" || signals[0].Project != "demo" {
		t.Fatalf("应当认出反复 3 次的要求与 1 次回退：%+v", signals)
	}
	result, err := store.Consolidate(context.Background(), ConsolidateOptions{MinCount: 2, Drafter: func(ctx context.Context, workdir, brief string) error {
		if !strings.Contains(brief, "在 3 轮对话里反复提到") || !strings.Contains(brief, "回退了这一轮") || !strings.Contains(brief, "〔项目 demo〕") {
			t.Errorf("说明里要列出偏好信号：\n%s", brief)
		}
		return nil
	}})
	if err != nil || len(result.Clusters) != 1 || result.Clusters[0].Key != ClusterKeyHuman || result.Clusters[0].Count != 4 {
		t.Fatalf("人的反应汇成一组：%+v %v", result.Clusters, err)
	}
	again, _ := store.Consolidate(context.Background(), ConsolidateOptions{MinCount: 1, Drafter: func(context.Context, string, string) error {
		t.Error("已经整理过的信号不再交给整理者")
		return nil
	}})
	if len(again.Clusters) != 0 {
		t.Errorf("没有新信号：%+v", again.Clusters)
	}
	say("t6", "还是太快了，再慢一点", false)
	fresh, _ := store.Consolidate(context.Background(), ConsolidateOptions{MinCount: 1, DraftsDir: t.TempDir()})
	if len(fresh.Clusters) != 1 || fresh.Clusters[0].Signals[0].Count != 4 {
		t.Errorf("新的一次提起让整组重新成为信号，次数按全部历史算：%+v", fresh.Clusters)
	}
}

func TestSimilarRequests(t *testing.T) {
	for _, pair := range [][2]string{{"节奏再慢一点", "慢一点，节奏慢一点"}, {"再慢一点吧", "节奏再慢一点"}, {"字幕大一点", "字幕再大一点"}} {
		if !similar(pair[0], pair[1]) {
			t.Errorf("%q 与 %q 应当算同一个要求", pair[0], pair[1])
		}
	}
	for _, pair := range [][2]string{{"慢一点", "把背景亮一点"}, {"把标题换成蓝色", "开头加个爆炸特效"}, {"字幕大一点", "字幕小一点"}} {
		if similar(pair[0], pair[1]) {
			t.Errorf("%q 与 %q 不是同一个要求", pair[0], pair[1])
		}
	}
}

func TestPreferenceBriefAsksToConfirmDraftedPreferences(t *testing.T) {
	store := newStore(t)
	draft := Memory{Kind: KindPreference, Meta: Meta{Name: "slow-pacing", Description: "节奏偏慢，每个画面多停一会", Status: StatusTrial, CheckedBy: []string{"human"}}, Body: "节奏偏慢"}
	store.Write(draft)
	brief, _, _ := store.PreferenceBrief("demo", 0)
	if !strings.Contains(brief, "待确认的偏好") || !strings.Contains(brief, "【slow-pacing】") || !strings.Contains(brief, "am memory promote") {
		t.Errorf("待确认的偏好要交给编排工具去问：\n%s", brief)
	}
	store.Promote("slow-pacing")
	if brief, _, _ := store.PreferenceBrief("demo", 0); strings.Contains(brief, "待确认") || !strings.Contains(brief, "【slow-pacing】（全局）") {
		t.Errorf("确认后转入生效偏好：\n%s", brief)
	}
}

// TestRunReportComparesBatchesPerModel：按批次汇总一次通过率、重试、问题数（含事后
// 检查）、耗时与 token，并按渲染工具/模型分开。
func TestRunReportComparesBatchesPerModel(t *testing.T) {
	ep := func(run, renderer, model, outcome string, retry bool, problems int, recalled ...string) Episode {
		e := Episode{Source: SourceRender, Run: run, Renderer: renderer, Model: model, Outcome: outcome, Retry: retry,
			Seconds: 60, Usage: &tools.Usage{InputTokens: 100, OutputTokens: 10}, Recalled: recalled, Project: "demo",
			SceneDir: "/p/" + run + renderer + strconv.Itoa(problems), Fingerprint: "fp", CreatedAt: run}
		for i := 0; i < problems; i++ {
			e.Problems = append(e.Problems, "x")
		}
		return e
	}
	episodes := []Episode{
		ep("run-1", "codex", "gpt-6", scene.OutcomeVerificationFailed, false, 2),
		ep("run-1", "codex", "gpt-6", scene.OutcomeSucceeded, true, 0),
		ep("run-1", "claude", "opus", scene.OutcomeSucceeded, false, 0),
		ep("run-2", "codex", "gpt-6", scene.OutcomeSucceeded, false, 0, "a", "b"),
		ep("run-2", "claude", "opus", scene.OutcomeSucceeded, false, 1, "a"),
		{Source: SourceExam, Run: "", Renderer: "codex", Outcome: scene.OutcomeSucceeded},
	}
	check := episodes[4]
	check.Source, check.Problems, check.CreatedAt = SourceCheck, []string{"读不完", "剧透"}, "run-2z"
	episodes = append(episodes, check)
	runs := RunReport(episodes)
	if len(runs) != 2 {
		t.Fatalf("应当有两批：%+v", runs)
	}
	first, second := runs[0], runs[1]
	if first.Scenes != 2 || first.PassedFirstTry != 1 || first.Retries != 1 || first.Problems != 2 || first.Seconds != 180 || first.InputTokens != 300 {
		t.Errorf("第一批不对：%+v", first.RunStats)
	}
	if second.Scenes != 2 || second.PassedFirstTry != 1 || second.CheckProblems != 2 || second.Problems != 3 || second.Recalled != 1.5 {
		t.Errorf("事后检查查出问题的镜头不算通过、问题计入：%+v", second.RunStats)
	}
	if got := second.ByModel["codex/gpt-6"]; got.Scenes != 1 || got.PassRate != 1 {
		t.Errorf("按渲染工具/模型分开：%+v", second.ByModel)
	}
	if got := first.ByModel["codex/gpt-6"]; got.PassRate != 0 || got.Retries != 1 {
		t.Errorf("第一批 codex：%+v", got)
	}
}

// TestModelChangeDownweightsStatsAndAsksForRetest：统计按模型分开，换了模型以后
// 旧模型的效果只当弱证据；考试时用的模型与现在不同时提示重考，重考对照组去掉它。
func TestModelChangeDownweightsStatsAndAsksForRetest(t *testing.T) {
	stats := map[string]Stat{"codex/gpt-6": {Recalled: 10, PassedFirstTry: 10}}
	same := smoothedRate(stats, "codex", "gpt-6")
	other := smoothedRate(stats, "codex", "gpt-7")
	if !(same > other && other > 0.5) {
		t.Errorf("同模型 %.2f 应当高于换了模型的 %.2f，后者仍略高于 0.5", same, other)
	}

	store := newStore(t)
	project := t.TempDir()
	s := writeSceneDir(t, filepath.Join(project, "scenes", "scene-001"), "scene-001", "中文标题", "")
	failed, _ := store.RecordAttempt(s, failingAttempt("codex", "determinism.raf"), AttemptSource{Source: SourceRender})
	rule := lesson("timeline-not-raf", StatusTrial, nil, "determinism.raf")
	rule.AppliesWhen, rule.FromEpisodes = Applies{}, []string{failed.ID}
	store.Write(rule)
	model := "gpt-6"
	run := func(ctx context.Context, sc scene.Scene, renderer string) scene.Attempt {
		if sc.Memory != nil && slices.Contains(sc.Memory.Names, "timeline-not-raf") {
			return scene.Attempt{Renderer: renderer, Model: model, Outcome: scene.OutcomeSucceeded}
		}
		a := failingAttempt(renderer, "determinism.raf")
		a.Model = model
		return a
	}
	opts := ExamOptions{Renderers: []string{"codex"}, Budget: 1500, Workspace: filepath.Join(project, "production", "memory-exams"), Run: run}
	if result, err := store.Exam(context.Background(), opts); err != nil || result.Applied != "promoted" {
		t.Fatalf("先在 gpt-6 上考过：%+v %v", result.Verdict, err)
	}
	current := func(string) string { return "gpt-6" }
	if report, _ := store.Status(false, current); len(report.Retest) != 0 {
		t.Errorf("模型没变不用重考：%+v", report.Retest)
	}
	model = "gpt-7"
	current = func(string) string { return "gpt-7" }
	report, _ := store.Status(false, current)
	if len(report.Retest) != 1 || report.Retest[0].Current != "gpt-7" || report.Retest[0].Examined[0] != "gpt-6" {
		t.Fatalf("换了模型要提示重考：%+v", report.Retest)
	}
	opts.Retest = []string{"timeline-not-raf"}
	opts.ModelOf = current
	result, err := store.Exam(context.Background(), opts)
	if err != nil || result.Applied != "retest-passed" {
		t.Fatalf("对照组去掉它后应当显出提升：%+v %v", result.Verdict, err)
	}
	for _, c := range result.Cells {
		if c.Arm == ArmControl && slices.Contains(c.Recalled, "timeline-not-raf") {
			t.Errorf("重考的对照组不该召回它：%+v", c)
		}
	}
	if report, _ := store.Status(false, current); len(report.Retest) != 0 {
		t.Errorf("在新模型上考过就不用再重考：%+v", report.Retest)
	}
	opts.Retest = []string{"missing"}
	if _, err := store.Exam(context.Background(), opts); err == nil {
		t.Error("只能重考生效经验")
	}
}
