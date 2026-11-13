package memory

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/reads"
	"github.com/chouheiwa/articale-to-motion/internal/review"
	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// ImportOptions 是导入历史项目的设置。
type ImportOptions struct {
	// Env 是调用 ffprobe 重新校验归档产物时用的环境。
	Env map[string]string
	// Tolerance 是重新校验时长的容差，同 am scene run 的 --duration-tolerance。
	Tolerance float64
	// Renderer 是归档里读不出渲染工具时的兜底（项目配置的 RENDERER）。
	Renderer string
}

// ImportResult 是一个项目的导入结果。
type ImportResult struct {
	Project  string   `json:"project"`
	Run      string   `json:"run"`
	Scenes   int      `json:"scenes"`
	Attempts int      `json:"attempts"`
	Failures int      `json:"failures"`
	Checks   int      `json:"checks"`
	Skipped  int      `json:"skipped"`
	Notes    []string `json:"notes,omitempty"`
}

// importedAttempt 是一个镜头的一次历史尝试，按时间先后排序后决定谁是首次尝试。
type importedAttempt struct {
	order   string // 排序键：归档编号在前，当前尝试在最后
	source  string // 原始路径，用于去重
	attempt scene.Attempt
}

var (
	archiveNumber = regexp.MustCompile(`attempt-(\d+)`)
	failedPrefix  = regexp.MustCompile(`^(.+?)-attempt-(\d+)`)
)

// ImportProject 把一个已有项目的渲染历史导入为经历，作为种子：
//
//   - 镜头目录里的 render-<id>.attempt.json 与 attempts/attempt-NN/ 下归档的尝试；
//   - 只有产物没有尝试记录的归档（老版本 am 留下的，含 production/failed-attempts/<镜头>-attempt-NN-*）
//     用现在的产物校验重新判一遍，只记失败——通过的归档说不清当时为什么被换掉；
//   - production/review/review.json 里没接上的交接；
//   - production/visible-event-inventory.json（schema 1）的阅读时间问题。
//
// 每个镜头最早的一次尝试算首次尝试，其余算重试，批次编号是 import:<项目名>，
// am memory report 里能看到这些项目当时的一次通过率。冻结的输入是镜头现在的输入，
// 不是当时的——历史输入没有留存。同一个来源重复导入时跳过。
func (s *Store) ImportProject(root string, opts ImportOptions) (ImportResult, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return ImportResult{}, err
	}
	project := filepath.Base(root)
	result := ImportResult{Project: project, Run: "import:" + project}
	existing, err := s.Episodes()
	if err != nil {
		return result, err
	}
	imported := map[string]bool{}
	for _, e := range existing {
		if e.Imported != "" {
			imported[e.Imported] = true
		}
	}
	scenes := discoverScenes(root)
	result.Scenes = len(scenes)
	byID := map[string]scene.Scene{}
	failedDir := filepath.Join(root, "production", "failed-attempts")
	failedArchives := map[string][]string{}
	if entries, err := os.ReadDir(failedDir); err == nil {
		for _, entry := range entries {
			if m := failedPrefix.FindStringSubmatch(entry.Name()); entry.IsDir() && m != nil {
				failedArchives[m[1]] = append(failedArchives[m[1]], filepath.Join(failedDir, entry.Name()))
			}
		}
	}
	for _, sc := range scenes {
		byID[sc.ID] = sc
		var attempts []importedAttempt
		archives, _ := filepath.Glob(filepath.Join(sc.Directory, "attempts", "attempt-*"))
		archives = append(archives, failedArchives[sc.ID]...)
		for _, dir := range archives {
			order := "0"
			if m := archiveNumber.FindStringSubmatch(filepath.Base(dir)); m != nil {
				n, _ := strconv.Atoi(m[1])
				order = fmt.Sprintf("%06d", n)
			}
			if strings.HasPrefix(dir, failedDir) {
				order = "-" + order // 老版本的失败归档早于 attempts/ 里的
			}
			attempt, ok, note := s.loadArchivedAttempt(sc, dir, opts)
			if note != "" {
				result.Notes = append(result.Notes, note)
			}
			if !ok {
				result.Skipped++
				continue
			}
			attempts = append(attempts, importedAttempt{order: order, source: dir, attempt: attempt})
		}
		if current, ok := readAttempt(sc.AttemptLog()); ok {
			attempts = append(attempts, importedAttempt{order: "z", source: sc.AttemptLog(), attempt: current})
		}
		sort.SliceStable(attempts, func(i, j int) bool { return attempts[i].order < attempts[j].order })
		for i, item := range attempts {
			item.attempt.Retry = i > 0
			key := item.source + "#" + item.attempt.StartedAt
			if imported[key] {
				result.Skipped++
				continue
			}
			if item.attempt.Renderer == "" {
				item.attempt.Renderer = firstNonEmpty(sc.Renderer, opts.Renderer)
			}
			if len(item.attempt.Checks) != len(item.attempt.Problems) {
				item.attempt.Checks = classifyProblems(item.attempt.Problems)
			}
			if _, err := s.recordImported(sc, item.attempt, result.Run, key); err != nil {
				return result, err
			}
			imported[key] = true
			result.Attempts++
			if item.attempt.Outcome == scene.OutcomeVerificationFailed {
				result.Failures++
			}
		}
	}
	checks, notes, err := s.importProjectChecks(root, byID)
	result.Checks += checks
	result.Notes = append(result.Notes, notes...)
	if err != nil {
		return result, err
	}
	return result, s.Log(Event{Type: EventEpisode, Summary: fmt.Sprintf("导入项目 %s：%d 个镜头、%d 次尝试（%d 次校验失败）、%d 条事后检查问题",
		project, result.Scenes, result.Attempts, result.Failures, result.Checks), Detail: map[string]any{"import": result}})
}

func (s *Store) recordImported(sc scene.Scene, attempt scene.Attempt, run, key string) (Episode, error) {
	features, _ := Features(sc)
	episode := Episode{Source: SourceRender, SceneID: sc.ID, Text: sc.Text, Renderer: attempt.Renderer, Model: attempt.Model,
		Fingerprint: attempt.Fingerprint, Outcome: attempt.Outcome, Retry: attempt.Retry, Seconds: attempt.Seconds, Usage: attempt.Usage,
		Error: attempt.Error, Problems: attempt.Problems, Checks: attempt.Checks, Features: features, Run: run, Imported: key}
	return s.saveEpisode(sc, episode)
}

func readAttempt(path string) (scene.Attempt, bool) {
	body, err := os.ReadFile(path)
	if err != nil {
		return scene.Attempt{}, false
	}
	var attempt scene.Attempt
	if json.Unmarshal(body, &attempt) != nil || attempt.Outcome == "" {
		return scene.Attempt{}, false
	}
	return attempt, true
}

// loadArchivedAttempt 读出一个归档目录里的尝试：有尝试记录就用记录；
// 只有产物时用现在的校验重判，通过的不算（返回 ok=false）。
func (s *Store) loadArchivedAttempt(sc scene.Scene, dir string, opts ImportOptions) (scene.Attempt, bool, string) {
	if attempt, ok := readAttempt(filepath.Join(dir, "render-"+sc.ID+".attempt.json")); ok {
		return attempt, attempt.Outcome != "interrupted", ""
	}
	output := findOutput(dir, sc)
	if output == "" {
		return scene.Attempt{}, false, ""
	}
	attempt := scene.Attempt{SceneID: sc.ID, Model: modelFromStream(dir, sc.ID), StartedAt: "archive"}
	if attempt.Model != "" {
		attempt.Renderer = rendererFromStream(dir, sc.ID)
	}
	problems, checks, err := reverify(sc, dir, output, opts)
	if err != nil {
		return scene.Attempt{}, false, fmt.Sprintf("%s：无法重新校验（%v）", dir, err)
	}
	note := ""
	if problems, checks, note = dropRetimed(dir, problems, checks); len(problems) == 0 {
		return scene.Attempt{}, false, note
	}
	attempt.Outcome, attempt.Problems, attempt.Checks = scene.OutcomeVerificationFailed, problems, checks
	return attempt, true, note
}

// retimedFrames 是重判归档时「镜头定义后来改过」的判据：归档只能按镜头现在的
// scene.json 重判，差出几十帧多半是后来重新分镜改了时长，不是渲染器多渲了几帧。
// 渲染器自己出的错是差一两帧（实测见 c-language 项目的 extra-frame 归档）。
const retimedFrames = 3

var (
	frameNumbers    = regexp.MustCompile(`期望 (\d+) 帧.*实测 (\d+) 帧`)
	durationNumbers = regexp.MustCompile(`期望 ([\d.]+) 秒.*实测 ([\d.]+) 秒`)
)

// dropRetimed 去掉看起来是镜头后来改过时长导致的时长、帧数问题。
func dropRetimed(dir string, problems, checks []string) ([]string, []string, string) {
	retimed := false
	for i, check := range checks {
		switch check {
		case scene.CheckOutputFrames:
			if m := frameNumbers.FindStringSubmatch(problems[i]); m != nil {
				a, _ := strconv.Atoi(m[1])
				b, _ := strconv.Atoi(m[2])
				retimed = retimed || abs(a-b) > retimedFrames
			}
		case scene.CheckOutputDuration:
			if m := durationNumbers.FindStringSubmatch(problems[i]); m != nil {
				a, _ := strconv.ParseFloat(m[1], 64)
				b, _ := strconv.ParseFloat(m[2], 64)
				// 按 30fps 估帧数差；画幅帧率在这里拿不到，30 是项目里最常见的。
				retimed = retimed || abs(int((a-b)*30)) > retimedFrames
			}
		}
	}
	if !retimed {
		return problems, checks, ""
	}
	var keptProblems, keptChecks []string
	for i, check := range checks {
		if check != scene.CheckOutputFrames && check != scene.CheckOutputDuration {
			keptProblems, keptChecks = append(keptProblems, problems[i]), append(keptChecks, check)
		}
	}
	return keptProblems, keptChecks, fmt.Sprintf("%s：时长差出 %d 帧以上，多半是镜头后来改过时长，不记这条", dir, retimedFrames)
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// findOutput 在归档目录里找这个镜头的产物：同名优先，否则取唯一的 mp4。
func findOutput(dir string, sc scene.Scene) string {
	if _, err := os.Stat(filepath.Join(dir, filepath.Base(sc.Output))); err == nil {
		return filepath.Base(sc.Output)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "*.mp4"))
	if len(matches) == 1 {
		return filepath.Base(matches[0])
	}
	return ""
}

// reverify 在临时目录里还原当时的镜头目录再用现在的产物校验重判：先铺上镜头目录
// 现在的文件（字体、素材、视觉规范——归档里通常只有合成代码和产物），再用归档覆盖。
// 不这样做的话，合成里引用的本地字体在临时目录里找不到，全被误判成 font-missing。
func reverify(sc scene.Scene, dir, output string, opts ImportOptions) ([]string, []string, error) {
	tmp, err := os.MkdirTemp("", "am-import-")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(tmp)
	skipScene := func(rel string, entry fs.DirEntry) bool {
		name := entry.Name()
		if entry.IsDir() {
			return name == "attempts" || name == "node_modules" || name == "visual-qc" || name == "renders"
		}
		return strings.HasSuffix(name, ".mp4") || strings.HasPrefix(name, "render-") || name == scene.RecordFile
	}
	if err := linkTree(sc.Directory, tmp, skipScene); err != nil {
		return nil, nil, err
	}
	if err := linkTree(dir, tmp, func(rel string, entry fs.DirEntry) bool {
		return entry.IsDir() && (entry.Name() == "node_modules" || entry.Name() == "attempts")
	}); err != nil {
		return nil, nil, err
	}
	probe := sc
	probe.Directory, probe.Output = tmp, output
	verr := scene.VerifyOutput(probe, opts.Env, opts.Tolerance)
	var verification *scene.VerificationError
	switch {
	case verr == nil:
		return nil, nil, nil
	case errors.As(verr, &verification):
		return verification.Problems, verification.Checks, nil
	}
	return nil, nil, verr
}

// linkTree 把 source 下的普通文件硬链接（跨文件系统时拷贝）到 target 的同一相对路径，
// 已存在的文件被覆盖。skip 返回 true 的条目跳过（目录则整棵跳过）。
func linkTree(source, target string, skip func(rel string, entry fs.DirEntry) bool) error {
	return filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(source, path)
		if rel != "." && skip(rel, entry) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		destination := filepath.Join(target, rel)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o755)
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		_ = os.Remove(destination)
		if os.Link(path, destination) == nil {
			return nil
		}
		return copyFile(path, destination)
	})
}

func streamLines(dir, id string, fn func(line string) bool) {
	file, err := os.Open(filepath.Join(dir, "render-"+id+".stream.jsonl"))
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for n := 0; scanner.Scan() && n < 50; n++ {
		if fn(scanner.Text()) {
			return
		}
	}
}

func modelFromStream(dir, id string) string {
	model := ""
	streamLines(dir, id, func(line string) bool {
		for _, tool := range []string{"claude", "qoder", "codebuddy"} {
			if m := tools.DetectModel(tool, line); m != "" {
				model = m
				return true
			}
		}
		return false
	})
	return model
}

// rendererFromStream 只在读得出模型时调用：claude 系三家的 init 事件格式相同，
// 按模型名前缀粗分，分不清时留空交给兜底。
func rendererFromStream(dir, id string) string {
	model := strings.ToLower(modelFromStream(dir, id))
	if strings.HasPrefix(model, "claude") {
		return "claude"
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

var determinismProblem = regexp.MustCompile(`\[([a-z-]+)\]`)

// classifyProblems 给没有记录校验器 ID 的老尝试补上 ID。
func classifyProblems(problems []string) []string {
	out := make([]string, 0, len(problems))
	for _, problem := range problems {
		if strings.HasPrefix(problem, "源码不确定") {
			if m := determinismProblem.FindStringSubmatch(problem); m != nil {
				out = append(out, scene.DeterminismCheckPrefix+m[1])
				continue
			}
		}
		out = append(out, scene.ClassifyOutputProblem(problem))
	}
	return out
}

// discoverScenes 找出项目里的全部镜头，跳过归档与考场。
func discoverScenes(root string) []scene.Scene {
	var out []scene.Scene
	skip := map[string]bool{"attempts": true, "node_modules": true, "memory-exams": true, "failed-attempts": true, "_archive": true, ".git": true}
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() && skip[entry.Name()] {
			return filepath.SkipDir
		}
		if entry.IsDir() || entry.Name() != "scene.json" {
			return nil
		}
		if sc, err := scene.Load(filepath.Dir(path)); err == nil {
			out = append(out, sc)
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Directory < out[j].Directory })
	return out
}

// importProjectChecks 导入整片检查的结果：没接上的交接与阅读时间问题。
func (s *Store) importProjectChecks(root string, byID map[string]scene.Scene) (int, []string, error) {
	findings := map[string][]Finding{}
	var notes []string
	if body, err := os.ReadFile(filepath.Join(root, "production", "review", "review.json")); err == nil {
		var report review.Report
		if json.Unmarshal(body, &report) == nil {
			for _, cut := range report.Cuts {
				if review.HandoffBroken(cut) {
					problem := fmt.Sprintf("%s → %s 约定了 %s 交接，但交界两帧差异 %.1f，没接上", cut.From, cut.To, cut.Handoff, *cut.Difference)
					for _, id := range []string{cut.From, cut.To} {
						findings[id] = append(findings[id], Finding{Check: scene.CheckReviewHandoff, Problem: problem})
					}
				}
			}
		}
	}
	inventoryPath := filepath.Join(root, "production", "visible-event-inventory.json")
	if inventory, err := reads.LoadInventory(inventoryPath); err == nil {
		if inventory.Schema != 1 {
			notes = append(notes, inventoryPath+"：不是 schema 1 的清单（老字段名），不导入阅读时间问题")
		} else {
			var timeline *reads.Timeline
			if loaded, err := reads.LoadTimeline(filepath.Join(root, "production", "phrase-timeline.json")); err == nil {
				timeline = &loaded
			}
			for _, f := range reads.Check(inventory, timeline, reads.Defaults).Findings {
				if f.SceneID != "" {
					findings[f.SceneID] = append(findings[f.SceneID], Finding{Check: scene.ReadsCheckPrefix + f.Rule, Problem: f.Message})
				}
			}
		}
	}
	count := 0
	ids := make([]string, 0, len(findings))
	for id := range findings {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		sc, ok := byID[id]
		if !ok {
			continue
		}
		if _, recorded, err := s.RecordCheck(sc, findings[id]); err != nil {
			return count, notes, err
		} else if recorded {
			count += len(findings[id])
		}
	}
	return count, notes, nil
}
