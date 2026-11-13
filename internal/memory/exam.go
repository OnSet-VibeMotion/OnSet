package memory

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// Arm 是考试的一组：对照组只带当前生效记忆，试用组再加上试用记忆。
type Arm string

const (
	ArmControl Arm = "control"
	ArmTrial   Arm = "trial"
)

// Question 是一道考题。
type Question struct {
	ID string `json:"id"`
	// Episode 是错题的来源经历；留出题为空。
	Episode string `json:"episode,omitempty"`
	Holdout bool   `json:"holdout"`
	SceneID string `json:"scene_id"`
	// Input 是重放用的镜头输入目录。
	Input string `json:"input"`
}

// Cell 是考试矩阵的一格：一道题 × 一个渲染工具 × 一组 × 第几次重复。
type Cell struct {
	Question string       `json:"question"`
	Holdout  bool         `json:"holdout"`
	Renderer string       `json:"renderer"`
	Model    string       `json:"model,omitempty"`
	Arm      Arm          `json:"arm"`
	Repeat   int          `json:"repeat"`
	Outcome  string       `json:"outcome"`
	Passed   bool         `json:"passed"`
	Problems int          `json:"problems"`
	Checks   []string     `json:"checks,omitempty"`
	Seconds  float64      `json:"seconds"`
	Usage    *tools.Usage `json:"usage,omitempty"`
	Error    string       `json:"error,omitempty"`
	// Invalid 表示渲染工具自身故障（认证失效、崩溃、被中断），这一格没有有效结果。
	Invalid  bool     `json:"invalid,omitempty"`
	Recalled []string `json:"recalled,omitempty"`
	Episode  string   `json:"episode,omitempty"`
	Workdir  string   `json:"workdir"`
}

// Score 是一格的确定性得分：一次通过全部硬校验得 10 分，否则每个失败项扣 1 分。
// 耗时与 token 只记录，不计分。
func (c Cell) Score() float64 {
	if c.Invalid {
		return 0
	}
	if c.Passed {
		return 10
	}
	return -float64(c.Problems)
}

// Verdict 是考试门槛的判定结果。
type Verdict struct {
	// Pass 为 true 时试用记忆转为生效。
	Pass bool `json:"pass"`
	// Invalid 为 true 时整场考试无效：既不生效也不拒绝。
	Invalid bool `json:"invalid"`
	// NeedsHuman 为 true 时考试期间生效记忆变过，结果交给人确认。
	NeedsHuman   bool     `json:"needs_human"`
	ControlScore float64  `json:"control_score"`
	TrialScore   float64  `json:"trial_score"`
	Reasons      []string `json:"reasons"`
}

type cellKey struct {
	question, renderer string
	arm                Arm
}

// Judge 是考试门槛，纯函数：
//
//  1. 矩阵总分严格高于对照；
//  2. 任意一个渲染工具上，对照组答对的题，试用组都没有答错；
//  3. 留出题上任意一个渲染工具的一次通过数都不下降；
//  4. 所有格子都有有效结果，渲染工具自身故障使整场考试无效；
//  5. 考试期间生效记忆没有被改动过，否则转为待人工确认。
//
// 重复多次的格子按多数结果判定通过，得分取平均。
func Judge(questions []Question, renderers []string, cells []Cell, activeChanged bool) Verdict {
	v := Verdict{Reasons: []string{}}
	grouped := map[cellKey][]Cell{}
	for _, c := range cells {
		k := cellKey{c.Question, c.Renderer, c.Arm}
		grouped[k] = append(grouped[k], c)
		if c.Invalid {
			v.Invalid = true
			v.Reasons = append(v.Reasons, fmt.Sprintf("%s × %s × %s 渲染工具自身故障：%s", c.Question, c.Renderer, c.Arm, c.Error))
		}
	}
	passed := func(k cellKey) bool {
		n := 0
		for _, c := range grouped[k] {
			if c.Passed {
				n++
			}
		}
		return n*2 > len(grouped[k])
	}
	score := func(k cellKey) float64 {
		total := 0.0
		for _, c := range grouped[k] {
			total += c.Score()
		}
		return total / float64(len(grouped[k]))
	}
	for _, q := range questions {
		for _, r := range renderers {
			for _, arm := range []Arm{ArmControl, ArmTrial} {
				if len(grouped[cellKey{q.ID, r, arm}]) == 0 {
					v.Invalid = true
					v.Reasons = append(v.Reasons, fmt.Sprintf("%s × %s × %s 没有结果", q.ID, r, arm))
				}
			}
		}
	}
	if v.Invalid {
		return v
	}
	for _, q := range questions {
		for _, r := range renderers {
			control, trial := cellKey{q.ID, r, ArmControl}, cellKey{q.ID, r, ArmTrial}
			v.ControlScore += score(control)
			v.TrialScore += score(trial)
			if passed(control) && !passed(trial) {
				v.Reasons = append(v.Reasons, fmt.Sprintf("退步：%s 在 %s 上对照组通过、试用组失败", q.ID, r))
			}
		}
	}
	for _, r := range renderers {
		controlPass, trialPass := 0, 0
		for _, q := range questions {
			if !q.Holdout {
				continue
			}
			if passed(cellKey{q.ID, r, ArmControl}) {
				controlPass++
			}
			if passed(cellKey{q.ID, r, ArmTrial}) {
				trialPass++
			}
		}
		if trialPass < controlPass {
			v.Reasons = append(v.Reasons, fmt.Sprintf("留出题退步：%s 上一次通过数 %d → %d", r, controlPass, trialPass))
		}
	}
	if v.TrialScore <= v.ControlScore {
		v.Reasons = append(v.Reasons, fmt.Sprintf("总分没有提高：对照 %.1f，试用 %.1f", v.ControlScore, v.TrialScore))
	}
	if activeChanged {
		v.NeedsHuman = true
		v.Reasons = append(v.Reasons, "考试期间生效记忆被改动过，结果转为待人工确认")
	}
	v.Pass = len(v.Reasons) == 0
	return v
}

// ExamRunner 渲染一格考题并返回这次尝试的记录。s 已挂好召回结果。
// 渲染工具自身故障时返回的 Attempt.Outcome 为 failed 或 interrupted。
type ExamRunner func(ctx context.Context, s scene.Scene, renderer string) scene.Attempt

// ExamOptions 是一场考试的设置。
type ExamOptions struct {
	Renderers []string
	// Trial 是参加考试的试用记忆名；为空时取全部试用经验。
	Trial []string
	// Episodes 是错题来源经历；为空时取试用记忆的 from_episodes。
	Episodes []string
	// Holdout 是留出题的镜头目录。
	Holdout      []string
	MaxQuestions int
	Repeat       int
	Jobs         int
	Budget       int
	// Workspace 是放考场目录的位置，必须在项目里，渲染器才找得到项目的技能。
	Workspace string
	Run       ExamRunner
	// ModelOf 返回渲染工具当前的模型，召回按它筛选限定了模型的经验；为 nil 时视为未知。
	ModelOf func(renderer string) string
	// DryRun 为 true 时只出结果，不改记忆状态。
	DryRun bool
}

// ExamResult 是一场考试的完整记录，写进 exams/<id>/result.json。
type ExamResult struct {
	ID             string     `json:"id"`
	CreatedAt      string     `json:"created_at"`
	Trials         []string   `json:"trials"`
	Renderers      []string   `json:"renderers"`
	Questions      []Question `json:"questions"`
	Cells          []Cell     `json:"cells"`
	Verdict        Verdict    `json:"verdict"`
	SnapshotBefore int        `json:"snapshot_before"`
	// Applied 说明考试结果怎样落到记忆状态上：promoted、rejected 或 none。
	Applied  string `json:"applied"`
	Snapshot int    `json:"snapshot,omitempty"`
}

func (s *Store) nextExamID() (string, error) {
	entries, err := os.ReadDir(filepath.Join(s.Dir, "exams"))
	if err != nil && !os.IsNotExist(err) {
		return "", err
	}
	number := len(entries) + 1
	for {
		id := fmt.Sprintf("exam-%04d", number)
		if _, err := os.Stat(filepath.Join(s.Dir, "exams", id)); os.IsNotExist(err) {
			return id, os.MkdirAll(filepath.Join(s.Dir, "exams", id), 0o755)
		}
		number++
	}
}

// Exams 读出全部考试记录，按编号升序。
func (s *Store) Exams() ([]ExamResult, error) {
	entries, err := os.ReadDir(filepath.Join(s.Dir, "exams"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var out []ExamResult
	for _, entry := range entries {
		var result ExamResult
		if readJSON(filepath.Join(s.Dir, "exams", entry.Name(), "result.json"), &result) == nil {
			out = append(out, result)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// Exam 调度考试矩阵：考题 × 渲染工具 × {对照, 试用} × 重复次数，按门槛判定，
// 通过则试用记忆转为生效并生成快照，不通过则记为被拒。
func (s *Store) Exam(ctx context.Context, opts ExamOptions) (ExamResult, error) {
	if len(opts.Renderers) == 0 {
		return ExamResult{}, errors.New("至少要有一个渲染工具")
	}
	if opts.Run == nil {
		return ExamResult{}, errors.New("没有配置作答者")
	}
	if opts.Repeat < 1 {
		opts.Repeat = 1
	}
	if opts.Jobs < 1 {
		opts.Jobs = 1
	}
	if opts.MaxQuestions < 1 {
		opts.MaxQuestions = 4
	}
	all, _, err := s.Memories()
	if err != nil {
		return ExamResult{}, err
	}
	var trials []Memory
	for _, m := range all {
		if m.Status != StatusTrial || m.Kind != KindLesson {
			continue
		}
		if len(opts.Trial) == 0 || contains(opts.Trial, m.Name) {
			trials = append(trials, m)
		}
	}
	for _, name := range opts.Trial {
		if !slicesContainsName(trials, name) {
			return ExamResult{}, fmt.Errorf("%s 不是试用中的经验（偏好不参加考试，由人工确认）", name)
		}
	}
	if len(trials) == 0 {
		return ExamResult{}, errors.New("没有试用中的经验可考；先运行 am memory consolidate")
	}
	questions, err := s.examQuestions(trials, opts)
	if err != nil {
		return ExamResult{}, err
	}
	if len(questions) == 0 {
		return ExamResult{}, errors.New("没有考题：试用记忆的来源经历都没有冻结输入，也没有给 --holdout")
	}
	before, _, err := s.LatestSnapshot()
	if err != nil {
		return ExamResult{}, err
	}
	driftBefore, err := s.Drift()
	if err != nil {
		return ExamResult{}, err
	}
	id, err := s.nextExamID()
	if err != nil {
		return ExamResult{}, err
	}
	result := ExamResult{ID: id, CreatedAt: s.clock().UTC().Format(time.RFC3339), Renderers: opts.Renderers,
		Questions: questions, SnapshotBefore: before.ID, Applied: "none"}
	for _, m := range trials {
		result.Trials = append(result.Trials, m.Name)
	}
	type job struct {
		q        Question
		renderer string
		arm      Arm
		repeat   int
	}
	var jobs []job
	for _, q := range questions {
		for _, r := range opts.Renderers {
			for _, arm := range []Arm{ArmControl, ArmTrial} {
				for rep := 1; rep <= opts.Repeat; rep++ {
					jobs = append(jobs, job{q, r, arm, rep})
				}
			}
		}
	}
	cells := make([]Cell, len(jobs))
	var wg sync.WaitGroup
	slots := make(chan struct{}, opts.Jobs)
	for i, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			workdir := filepath.Join(opts.Workspace, id, j.q.ID, fmt.Sprintf("%s-%s-%d", j.renderer, j.arm, j.repeat))
			cells[i] = s.examCell(ctx, j.q, j.renderer, j.arm, j.repeat, workdir, trials, before.ID, opts, id)
		}()
	}
	wg.Wait()
	result.Cells = cells
	after, _, err := s.LatestSnapshot()
	if err != nil {
		return result, err
	}
	driftAfter, err := s.Drift()
	if err != nil {
		return result, err
	}
	changed := after.ID != before.ID || strings.Join(driftAfter, ",") != strings.Join(driftBefore, ",")
	result.Verdict = Judge(questions, opts.Renderers, cells, changed)
	if !opts.DryRun && !result.Verdict.Invalid && !result.Verdict.NeedsHuman {
		if result.Verdict.Pass {
			snapshot, err := s.promote(trials, id)
			if err != nil {
				return result, err
			}
			result.Applied, result.Snapshot = "promoted", snapshot.ID
		} else {
			reason := fmt.Sprintf("%s 未通过：%s", id, strings.Join(result.Verdict.Reasons, "；"))
			for _, m := range trials {
				if err := s.setStatus(m, StatusRejected, reason, ""); err != nil {
					return result, err
				}
			}
			result.Applied = "rejected"
		}
	}
	if err := writeJSON(filepath.Join(s.Dir, "exams", id, "result.json"), result); err != nil {
		return result, err
	}
	state := "通过"
	switch {
	case result.Verdict.Invalid:
		state = "无效"
	case result.Verdict.NeedsHuman:
		state = "待人工确认"
	case !result.Verdict.Pass:
		state = "未通过"
	}
	return result, s.Log(Event{Type: EventExam, Snapshot: result.Snapshot,
		Summary: fmt.Sprintf("考试 %s %s：%d 道题 × %d 个渲染工具，对照 %.1f 分，试用 %.1f 分", id, state, len(questions), len(opts.Renderers), result.Verdict.ControlScore, result.Verdict.TrialScore),
		Detail:  map[string]any{"exam": id, "trials": result.Trials, "verdict": result.Verdict, "applied": result.Applied}})
}

func slicesContainsName(list []Memory, name string) bool {
	for _, m := range list {
		if m.Name == name {
			return true
		}
	}
	return false
}

func (s *Store) examQuestions(trials []Memory, opts ExamOptions) ([]Question, error) {
	ids := opts.Episodes
	if len(ids) == 0 {
		for _, m := range trials {
			for _, id := range m.FromEpisodes {
				if !contains(ids, id) {
					ids = append(ids, id)
				}
			}
		}
	}
	var questions []Question
	for _, id := range ids {
		if len(questions) >= opts.MaxQuestions {
			break
		}
		episode, err := s.EpisodeByID(id)
		if err != nil {
			return nil, err
		}
		if episode.Input == "" {
			continue
		}
		questions = append(questions, Question{ID: fmt.Sprintf("q%d", len(questions)+1), Episode: id, SceneID: episode.SceneID,
			Input: filepath.Join(episode.Dir, episode.Input)})
	}
	for i, dir := range opts.Holdout {
		sc, err := scene.Load(dir)
		if err != nil {
			return nil, fmt.Errorf("留出题 %s：%w", dir, err)
		}
		questions = append(questions, Question{ID: fmt.Sprintf("h%d", i+1), Holdout: true, SceneID: sc.ID, Input: sc.Directory})
	}
	return questions, nil
}

func (s *Store) examCell(ctx context.Context, q Question, renderer string, arm Arm, repeat int, workdir string, trials []Memory, snapshot int, opts ExamOptions, examID string) Cell {
	cell := Cell{Question: q.ID, Holdout: q.Holdout, Renderer: renderer, Arm: arm, Repeat: repeat, Workdir: workdir}
	fail := func(err error) Cell {
		cell.Invalid, cell.Outcome, cell.Error = true, scene.OutcomeFailed, err.Error()
		return cell
	}
	if err := os.RemoveAll(workdir); err != nil {
		return fail(err)
	}
	if q.Holdout {
		source, err := scene.Load(q.Input)
		if err != nil {
			return fail(err)
		}
		if err := freezeInput(source, workdir); err != nil {
			return fail(err)
		}
	} else if err := copyTree(q.Input, workdir); err != nil {
		return fail(err)
	}
	sc, err := scene.Load(workdir)
	if err != nil {
		return fail(err)
	}
	sc.Renderer = renderer
	recallOpts := RecallOptions{Snapshot: snapshot, Budget: opts.Budget, Renderer: renderer}
	if opts.ModelOf != nil {
		recallOpts.Model = opts.ModelOf(renderer)
	}
	if snapshot == 0 {
		recallOpts.Snapshot = -1
	}
	if arm == ArmTrial {
		recallOpts.Extra = trials
	}
	recall, err := s.recallForExam(sc, recallOpts)
	if err != nil {
		return fail(err)
	}
	sc = recall.Attach(sc)
	cell.Recalled = recall.Names()
	attempt := opts.Run(ctx, sc, renderer)
	cell.Outcome, cell.Seconds, cell.Usage, cell.Error, cell.Model = attempt.Outcome, attempt.Seconds, attempt.Usage, attempt.Error, attempt.Model
	cell.Problems, cell.Checks = len(attempt.Problems), attempt.Checks
	switch attempt.Outcome {
	case scene.OutcomeSucceeded:
		cell.Passed = true
	case scene.OutcomeVerificationFailed:
	default:
		cell.Invalid = true
	}
	if episode, err := s.RecordAttempt(sc, attempt, SourceExam, examID); err == nil {
		cell.Episode = episode.ID
	}
	return cell
}

// recallForExam 与 RecallScene 相同，只是 Snapshot 为 -1 时表示「没有快照」，
// 不回落到最新快照：考试开始时还没有快照，考试期间生成的快照不能混进对照组。
func (s *Store) recallForExam(sc scene.Scene, opts RecallOptions) (RecallResult, error) {
	if opts.Snapshot >= 0 {
		return s.RecallScene(sc, opts)
	}
	features, err := Features(sc)
	if err != nil {
		return RecallResult{}, err
	}
	return Recall(RecallInput{Memories: opts.Extra, Stats: map[string]map[string]Stat{}, Renderer: opts.Renderer, Model: opts.Model, Features: features,
		Text: sc.Text + "\n" + promptText(sc), Project: projectOf(sc.Directory), Budget: opts.Budget}), nil
}

// promote 把试用记忆转为生效并生成快照；修订生效时被修订的旧记忆转为沉睡。
func (s *Store) promote(list []Memory, examID string) (Snapshot, error) {
	var names []string
	for _, m := range list {
		if err := s.setStatus(m, StatusActive, "", examID); err != nil {
			return Snapshot{}, err
		}
		names = append(names, m.Name)
		if m.Revises != "" {
			if old, ok, err := s.Find(m.Revises); err != nil {
				return Snapshot{}, err
			} else if ok && old.Status == StatusActive {
				if err := s.setStatus(old, StatusDormant, "", ""); err != nil {
					return Snapshot{}, err
				}
				if err := s.Log(Event{Type: EventDormant, Summary: fmt.Sprintf("%s 被修订 %s 取代，转为沉睡", old.Name, m.Name),
					Detail: map[string]any{"memory": old.Name, "replaced_by": m.Name}}); err != nil {
					return Snapshot{}, err
				}
			}
		}
	}
	unverified := examID == ""
	summary := "生效：" + strings.Join(names, "、")
	if examID != "" {
		summary += "（" + examID + " 通过）"
	} else {
		summary += "（人工确认，未经考试）"
	}
	snapshot, err := s.TakeSnapshot(EventPromote, summary, unverified)
	if err != nil {
		return Snapshot{}, err
	}
	return snapshot, s.Log(Event{Type: EventPromote, Snapshot: snapshot.ID, Summary: summary, Detail: map[string]any{"memories": names, "exam": examID}})
}

func (s *Store) setStatus(m Memory, status Status, reason, examID string) error {
	m.Status = status
	if status == StatusRejected {
		m.RejectedReason = reason
	}
	if examID != "" && !contains(m.VerifiedBy, examID) {
		m.VerifiedBy = append(m.VerifiedBy, examID)
	}
	if err := s.Write(m); err != nil {
		return err
	}
	if status == StatusRejected {
		return s.Log(Event{Type: EventReject, Summary: fmt.Sprintf("%s 被拒：%s", m.Name, reason), Detail: map[string]any{"memory": m.Name}})
	}
	return nil
}

// Promote 人工确认一条试用记忆生效（偏好只能走这里；经验通常由考试转为生效，
// 人工确认的快照会标为未经考试）。
func (s *Store) Promote(name string) (Snapshot, error) {
	m, ok, err := s.Find(name)
	if err != nil {
		return Snapshot{}, err
	}
	if !ok {
		return Snapshot{}, fmt.Errorf("记忆 %s 不存在", name)
	}
	if m.Status != StatusTrial {
		return Snapshot{}, fmt.Errorf("%s 的状态是 %s，只有试用中的记忆能确认生效", name, m.Status)
	}
	return s.promote([]Memory{m}, "")
}

// Reject 人工拒绝一条试用记忆。
func (s *Store) Reject(name, reason string) error {
	m, ok, err := s.Find(name)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("记忆 %s 不存在", name)
	}
	if m.Status != StatusTrial {
		return fmt.Errorf("%s 的状态是 %s，只有试用中的记忆能拒绝", name, m.Status)
	}
	if reason == "" {
		reason = "人工拒绝"
	}
	return s.setStatus(m, StatusRejected, reason, "")
}

// Retire 让一条生效记忆转为沉睡，并生成快照。
func (s *Store) Retire(name, reason string) (Snapshot, error) {
	m, ok, err := s.Find(name)
	if err != nil {
		return Snapshot{}, err
	}
	if !ok {
		return Snapshot{}, fmt.Errorf("记忆 %s 不存在", name)
	}
	if m.Status != StatusActive {
		return Snapshot{}, fmt.Errorf("%s 的状态是 %s，只有生效记忆能转为沉睡", name, m.Status)
	}
	if err := s.setStatus(m, StatusDormant, "", ""); err != nil {
		return Snapshot{}, err
	}
	if reason == "" {
		reason = "人工确认"
	}
	if err := s.Log(Event{Type: EventDormant, Summary: fmt.Sprintf("%s 转为沉睡：%s", name, reason), Detail: map[string]any{"memory": name}}); err != nil {
		return Snapshot{}, err
	}
	return s.TakeSnapshot(EventDormant, name+" 转为沉睡", false)
}
