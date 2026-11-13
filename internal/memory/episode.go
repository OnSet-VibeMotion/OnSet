package memory

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// 经历来源。
const (
	// SourceRender 是正式渲染（am scene run / run-all）。
	SourceRender = "render"
	// SourceExam 是考试里的作答。不进入整理，也不计入效果统计：
	// 考试是人为安排的对照实验，混进来会让统计偏向考题。
	SourceExam = "exam"
	// SourceFeedback 是人工反馈。
	SourceFeedback = "feedback"
)

// OutcomeFeedback 是人工反馈经历的 Outcome。
const OutcomeFeedback = "feedback"

// Feedback 是一条人工反馈。
type Feedback struct {
	// Verdict 是 up 或 down。
	Verdict string `json:"verdict"`
	Note    string `json:"note,omitempty"`
	// Seconds 是被评价的画面在镜头内的时间点，负数表示未指定。
	Seconds float64 `json:"seconds"`
	// Region 是框选区域，归一化坐标 x,y,w,h；空表示整帧。
	Region []float64 `json:"region,omitempty"`
	// Element 是点选的元素描述（选择器或文字）。
	Element string `json:"element,omitempty"`
}

// Episode 是一段经历：一次渲染尝试或一条人工反馈的完整记录。只增不改。
type Episode struct {
	Schema    int    `json:"schema"`
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`
	Source    string `json:"source"`
	// Project 是镜头所在项目根的目录名；偏好的作用范围按它划分。
	Project     string       `json:"project,omitempty"`
	SceneDir    string       `json:"scene_dir"`
	SceneID     string       `json:"scene_id"`
	Text        string       `json:"text"`
	Renderer    string       `json:"renderer,omitempty"`
	Model       string       `json:"model,omitempty"`
	Fingerprint string       `json:"fingerprint,omitempty"`
	Outcome     string       `json:"outcome"`
	Retry       bool         `json:"retry"`
	Seconds     float64      `json:"seconds,omitempty"`
	Usage       *tools.Usage `json:"usage,omitempty"`
	Error       string       `json:"error,omitempty"`
	Problems    []string     `json:"problems,omitempty"`
	Checks      []string     `json:"checks,omitempty"`
	Features    []string     `json:"features"`
	// Recalled 是这次渲染召回的记忆名，Snapshot 是召回依据的快照号。
	Recalled []string `json:"recalled,omitempty"`
	Snapshot int      `json:"snapshot,omitempty"`
	// Explored 非空表示这次召回做了探索，Recalled 是探索后真正注入的。
	Explored *Exploration `json:"explored,omitempty"`
	// Run 是这次渲染所属的批次（一次 am scene run / run-all 调用），用于按批次对比。
	Run string `json:"run,omitempty"`
	// Session 与 Turn 是 Studio 对话的会话与轮次，只对 SourceConversation 有值。
	Session string `json:"session,omitempty"`
	Turn    string `json:"turn,omitempty"`
	// Exam 是考试编号，只对 SourceExam 有值。
	Exam     string    `json:"exam,omitempty"`
	Feedback *Feedback `json:"feedback,omitempty"`
	// Imported 是导入来源（原始路径加开始时间），只对 am memory import 导入的经历有值，用于去重。
	Imported string `json:"imported,omitempty"`
	// Input 是冻结输入相对经历目录的路径；考试从这里原样重放。
	Input string `json:"input,omitempty"`
	// Dir 是经历目录，读出时填入，不落盘。
	Dir string `json:"-"`
}

// FirstTry 报告这是不是镜头的首次尝试（调度层重试不算）。
func (e Episode) FirstTry() bool { return !e.Retry }

// Passed 报告这次尝试是否通过全部硬校验。
func (e Episode) Passed() bool { return e.Outcome == scene.OutcomeSucceeded }

// Failure 报告这段经历是不是整理的原料：校验失败，或人工 👎。
// 渲染器崩溃、被中断不算——那不是渲染写法的问题，记忆帮不上忙。
func (e Episode) Failure() bool {
	if e.Source == SourceFeedback {
		return e.Feedback != nil && e.Feedback.Verdict == "down"
	}
	return e.Outcome == scene.OutcomeVerificationFailed && len(e.Checks) > 0
}

func newEpisodeID(now time.Time) string {
	var suffix [3]byte
	_, _ = rand.Read(suffix[:])
	return "ep-" + now.UTC().Format("20060102-150405") + "-" + hex.EncodeToString(suffix[:])
}

// projectOf 从镜头目录向上找项目根（含 article-to-motion.conf 的目录），返回目录名。
// ProjectName 是 dir 所在项目的名字（项目根目录名），不在项目里时为空。
func ProjectName(dir string) string { return projectOf(dir) }

func projectOf(dir string) string {
	for current := dir; ; {
		if _, err := os.Stat(filepath.Join(current, "article-to-motion.conf")); err == nil {
			return filepath.Base(current)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}

// AttemptSource 说明一次渲染尝试从哪来。
type AttemptSource struct {
	// Source 是 SourceRender 或 SourceExam。
	Source string
	// Run 是批次编号，见 Episode.Run。
	Run string
	// Exam 是考试编号，只对 SourceExam 有值。
	Exam string
	// Explored 是这次召回的探索，见 RecallResult.Explored。
	Explored *Exploration
}

// RecordAttempt 把一次渲染尝试写成经历，冻结镜头输入，并写进时间线。
func (s *Store) RecordAttempt(sc scene.Scene, attempt scene.Attempt, from AttemptSource) (Episode, error) {
	source, exam := from.Source, from.Exam
	features, err := Features(sc)
	if err != nil {
		features = nil
	}
	episode := Episode{
		Source: source, SceneID: sc.ID, Text: sc.Text, Renderer: attempt.Renderer, Model: attempt.Model, Fingerprint: attempt.Fingerprint,
		Outcome: attempt.Outcome, Retry: attempt.Retry, Seconds: attempt.Seconds, Usage: attempt.Usage,
		Error: attempt.Error, Problems: attempt.Problems, Checks: attempt.Checks, Features: features, Exam: exam, Run: from.Run,
	}
	if sc.Memory != nil {
		episode.Recalled = append([]string(nil), sc.Memory.Names...)
		episode.Snapshot = sc.Memory.Snapshot
		episode.Explored = from.Explored
	}
	if err := s.ObserveModel(attempt.Renderer, attempt.Model); err != nil {
		return Episode{}, err
	}
	return s.saveEpisode(sc, episode)
}

// RecordFeedback 把一条人工反馈写成经历。
func (s *Store) RecordFeedback(sc scene.Scene, feedback Feedback) (Episode, error) {
	if feedback.Verdict != "up" && feedback.Verdict != "down" {
		return Episode{}, fmt.Errorf("反馈只能是 up 或 down，收到 %q", feedback.Verdict)
	}
	features, _ := Features(sc)
	return s.saveEpisode(sc, Episode{Source: SourceFeedback, SceneID: sc.ID, Text: sc.Text, Renderer: sc.Renderer,
		Outcome: OutcomeFeedback, Features: features, Feedback: &feedback})
}

func (s *Store) saveEpisode(sc scene.Scene, episode Episode) (Episode, error) {
	now := s.clock()
	episode.Schema = 1
	episode.ID = newEpisodeID(now)
	episode.CreatedAt = now.UTC().Format(time.RFC3339Nano)
	episode.SceneDir = sc.Directory
	episode.Project = projectOf(sc.Directory)
	if episode.Features == nil {
		episode.Features = []string{}
	}
	dir := filepath.Join(s.Dir, "episodes", now.UTC().Format("2006-01"), episode.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Episode{}, err
	}
	// 对话信号不属于某个镜头，没有输入可冻结。
	if sc.ID != "" {
		if err := freezeInput(sc, filepath.Join(dir, "input")); err == nil {
			episode.Input = "input"
		}
	}
	if err := writeJSON(filepath.Join(dir, "episode.json"), episode); err != nil {
		return Episode{}, err
	}
	episode.Dir = dir
	return episode, s.Log(Event{Type: EventEpisode, Summary: episodeSummary(episode), Project: episode.Project,
		Detail: map[string]any{"episode": episode.ID, "scene": episode.SceneID, "renderer": episode.Renderer, "model": episode.Model,
			"outcome": episode.Outcome, "checks": episode.Checks, "recalled": episode.Recalled, "source": episode.Source, "exam": episode.Exam}})
}

func episodeSummary(e Episode) string {
	prefix := ""
	if e.Source == SourceExam {
		prefix = "考试 " + e.Exam + "："
	}
	return prefix + episodeOutcome(e)
}

func episodeOutcome(e Episode) string {
	switch {
	case e.Source == SourceConversation:
		if e.Feedback != nil && e.Feedback.Verdict == "down" {
			return "用户回退了一轮对话：" + e.Text
		}
		return "用户说：" + e.Text
	case e.Source == SourceFeedback:
		verdict := "👍"
		if e.Feedback.Verdict == "down" {
			verdict = "👎"
		}
		return fmt.Sprintf("镜头 %s 收到人工反馈 %s %s", e.SceneID, verdict, e.Feedback.Note)
	case e.Passed():
		return fmt.Sprintf("镜头 %s（%s）通过校验，召回 %d 条记忆", e.SceneID, rendererModel(e.Renderer, e.Model), len(e.Recalled))
	case len(e.Checks) > 0:
		return fmt.Sprintf("镜头 %s（%s）校验失败：%s", e.SceneID, rendererModel(e.Renderer, e.Model), strings.Join(uniqueSorted(e.Checks), "、"))
	}
	return fmt.Sprintf("镜头 %s（%s）%s", e.SceneID, e.Renderer, e.Outcome)
}

// freezeInput 把镜头声明过的输入原样拷进 target，供考试重放。
// 清单与输入指纹同源（scene.InputFiles），另加角色包目录。
func freezeInput(sc scene.Scene, target string) error {
	for _, rel := range scene.InputFiles(sc) {
		if err := copyFile(filepath.Join(sc.Directory, rel), filepath.Join(target, rel)); err != nil {
			return err
		}
	}
	if sc.Cast != nil && sc.Cast.PackDir != "" {
		root := filepath.Join(sc.Directory, sc.Cast.PackDir)
		return filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || !entry.Type().IsRegular() {
				return err
			}
			rel, _ := filepath.Rel(sc.Directory, path)
			return copyFile(path, filepath.Join(target, rel))
		})
	}
	return nil
}

func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(source, path)
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(target, rel), 0o755)
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		return copyFile(path, filepath.Join(target, rel))
	})
}

// Episodes 读出全部经历，按时间升序。
func (s *Store) Episodes() ([]Episode, error) {
	var out []Episode
	root := filepath.Join(s.Dir, "episodes")
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return filepath.SkipDir
			}
			return err
		}
		if entry.IsDir() && entry.Name() == "input" {
			return filepath.SkipDir
		}
		if entry.IsDir() || entry.Name() != "episode.json" {
			return nil
		}
		var episode Episode
		if readJSON(path, &episode) != nil || episode.ID == "" {
			return nil
		}
		episode.Dir = filepath.Dir(path)
		out = append(out, episode)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt < out[j].CreatedAt
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// EpisodeByID 按编号找经历。
func (s *Store) EpisodeByID(id string) (Episode, error) {
	all, err := s.Episodes()
	if err != nil {
		return Episode{}, err
	}
	for _, episode := range all {
		if episode.ID == id {
			return episode, nil
		}
	}
	return Episode{}, fmt.Errorf("经历 %s 不存在", id)
}

func uniqueSorted(values []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, value := range values {
		if value != "" && !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}
