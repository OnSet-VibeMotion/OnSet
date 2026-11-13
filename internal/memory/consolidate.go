package memory

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

// Cluster 是一组同类失败：同一个校验器（或人工 👎）下的经历。
type Cluster struct {
	Key       string         `json:"key"`
	Count     int            `json:"count"`
	Episodes  []string       `json:"episodes"`
	Renderers map[string]int `json:"renderers"`
	// Models 按「渲染工具/模型」计数，模型未知时只写渲染工具。整理者据此判断
	// 这类失败是通病，还是某个模型特有的毛病。
	Models map[string]int `json:"models"`
	// Features 是这组经历里至少一半都带的镜头特征。
	Features []string `json:"features,omitempty"`
	Examples []string `json:"examples,omitempty"`
	Notes    []string `json:"notes,omitempty"`
	// Recalled 是这组经历失败时已经召回的记忆：它们没帮上忙，可能要修订。
	Recalled []string `json:"recalled,omitempty"`
	// Signals 只对人工组（ClusterKeyHuman）有值：回退、反复提的要求与带说明的 👍 / 👎。
	Signals []Signal `json:"signals,omitempty"`
	// Contrasts 是成败对照：这组里的一次失败，配上一次没犯这个错的通过渲染。
	Contrasts []Contrast `json:"contrasts,omitempty"`
}

// Contrast 是一组成败对照。
//
// 只看失败，整理者只能猜「怎样才对」；ExpeL、ReasoningBank 都从成败对比里提炼经验。
// 最好的对照是同一个镜头后来改对了（SameScene），其次是同一渲染工具、特征最接近的
// 另一个通过的镜头。
type Contrast struct {
	Failed    string `json:"failed"`
	FailedDir string `json:"failed_dir"`
	Passed    string `json:"passed"`
	PassedDir string `json:"passed_dir"`
	// PassedFingerprint 是通过那次的输入指纹：镜头目录里 .am-render.json 的指纹与它相同时，
	// 目录里的合成代码就是那次通过的版本。
	PassedFingerprint string   `json:"passed_fingerprint,omitempty"`
	SameScene         bool     `json:"same_scene,omitempty"`
	Shared            []string `json:"shared_features,omitempty"`
	// PassedCode 是整理工作目录里通过那一版合成代码的副本（相对工作目录）；镜头目录里的
	// 代码已被后来的渲染覆盖、或读不到时为空。整理者可能只被允许读工作目录，所以要拷进来。
	PassedCode string `json:"passed_code,omitempty"`
}

// MaxContrasts 是每组最多附上的成败对照数。
const MaxContrasts = 2

// ClusterKeyHuman 是人工 👎 的聚类键。
const ClusterKeyHuman = "human"

// ClusterFailures 把失败经历按校验器聚类，按出现次数降序；人的反应（回退、
// 反复提的要求、带说明的 👍 / 👎）汇成一组 ClusterKeyHuman。
// 一段经历命中几个校验器就进几组：一次渲染常常同时犯几类错。
func ClusterFailures(episodes []Episode) []Cluster { return clusterSince(episodes, episodes, "") }

// clusterSince 用 fresh 聚类校验失败；偏好信号要看全部历史才认得出「反复」，
// 但只保留含有 since 之后新经历的信号，已经整理过的不再交给整理者。
func clusterSince(fresh, all []Episode, since string) []Cluster {
	episodes := fresh
	groups := map[string]*Cluster{}
	featureCounts := map[string]map[string]int{}
	get := func(key string) *Cluster {
		if groups[key] == nil {
			groups[key] = &Cluster{Key: key, Renderers: map[string]int{}, Models: map[string]int{}}
			featureCounts[key] = map[string]int{}
		}
		return groups[key]
	}
	for _, e := range episodes {
		if !e.Failure() || e.Source == SourceExam || e.Source == SourceFeedback || e.Source == SourceConversation {
			continue
		}
		keys := uniqueSorted(e.Checks)
		for _, key := range keys {
			c := get(key)
			c.Count++
			c.Episodes = append(c.Episodes, e.ID)
			if e.Renderer != "" {
				c.Renderers[e.Renderer]++
				c.Models[rendererModel(e.Renderer, e.Model)]++
			}
			for _, feature := range e.Features {
				featureCounts[key][feature]++
			}
			for i, check := range e.Checks {
				if check == key && i < len(e.Problems) && len(c.Examples) < 4 && !contains(c.Examples, e.Problems[i]) {
					c.Examples = append(c.Examples, e.Problems[i])
				}
			}
			for _, name := range e.Recalled {
				if !contains(c.Recalled, name) {
					c.Recalled = append(c.Recalled, name)
				}
			}
		}
	}
	out := make([]Cluster, 0, len(groups))
	for key, c := range groups {
		for feature, count := range featureCounts[key] {
			if count*2 >= c.Count {
				c.Features = append(c.Features, feature)
			}
		}
		sort.Strings(c.Features)
		sort.Strings(c.Recalled)
		out = append(out, *c)
	}
	byID := map[string]Episode{}
	for _, e := range episodes {
		byID[e.ID] = e
	}
	failedChecks := checkFailures(all)
	for i := range out {
		out[i].Contrasts = contrasts(out[i], byID, all, failedChecks)
	}
	if human, ok := humanCluster(all, since); ok {
		out = append(out, human)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Count != out[j].Count {
			return out[i].Count > out[j].Count
		}
		return out[i].Key < out[j].Key
	})
	return out
}

// contrasts 为一组失败找成败对照：通过的正式渲染、事后检查也没查出问题、
// 没有被这个校验器判过失败。同一镜头后来改对的优先，其次同渲染工具、共同特征多的。
func contrasts(c Cluster, byID map[string]Episode, all []Episode, failedChecks map[string]bool) []Contrast {
	var out []Contrast
	used := map[string]bool{}
	for _, id := range c.Episodes {
		if len(out) >= MaxContrasts {
			break
		}
		failed, ok := byID[id]
		if !ok {
			continue
		}
		var best *Episode
		bestScore := 0.0
		for i := range all {
			e := all[i]
			if e.Source != SourceRender || !effectivelyPassed(e, failedChecks) || used[e.ID] || contains(e.Checks, c.Key) {
				continue
			}
			shared := intersect(failed.Features, e.Features)
			score := float64(len(shared))
			if e.SceneDir != "" && e.SceneDir == failed.SceneDir {
				score += 100
			}
			if e.Renderer == failed.Renderer {
				score += 0.5
			}
			if score == 0 {
				continue
			}
			if best == nil || score > bestScore || (score == bestScore && e.CreatedAt > best.CreatedAt) {
				best, bestScore = &all[i], score
			}
		}
		if best == nil {
			continue
		}
		used[best.ID] = true
		out = append(out, Contrast{Failed: failed.ID, FailedDir: failed.SceneDir, Passed: best.ID, PassedDir: best.SceneDir,
			PassedFingerprint: best.Fingerprint, SameScene: best.SceneDir != "" && best.SceneDir == failed.SceneDir,
			Shared: intersect(failed.Features, best.Features)})
	}
	return out
}

// 拷进整理工作目录的合成代码：只拷文本源码，单个文件与总量都有上限。
const (
	contrastFileLimit  = 256 << 10
	contrastTotalLimit = 1 << 20
)

var contrastExtensions = map[string]bool{".html": true, ".htm": true, ".js": true, ".mjs": true, ".css": true, ".json": true}

// copyContrastCode 把每组对照里通过那一版的合成代码拷进 workdir/contrasts/。
// 只在镜头目录现在的产物记录与那次的指纹相同时拷：否则目录里已经是别的版本。
func copyContrastCode(workdir string, clusters []Cluster) {
	n := 0
	for ci := range clusters {
		for pi := range clusters[ci].Contrasts {
			pair := &clusters[ci].Contrasts[pi]
			if pair.PassedDir == "" || pair.PassedFingerprint == "" {
				continue
			}
			sc, err := scene.Load(pair.PassedDir)
			if err != nil {
				continue
			}
			if record, ok := scene.LoadRecord(sc); !ok || record.Fingerprint != pair.PassedFingerprint {
				continue
			}
			n++
			rel := filepath.Join("contrasts", fmt.Sprintf("%02d-%s", n, pair.Passed))
			if copySourceTree(pair.PassedDir, filepath.Join(workdir, rel)) > 0 {
				pair.PassedCode = filepath.ToSlash(rel)
			}
		}
	}
}

func copySourceTree(src, dst string) int {
	copied, total := 0, 0
	_ = filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case "attempts", "node_modules", ".studio-frames", ".git", "fonts":
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !contrastExtensions[strings.ToLower(filepath.Ext(name))] || strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".attempt.json") {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > contrastFileLimit || total+int(info.Size()) > contrastTotalLimit {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return nil
		}
		target := filepath.Join(dst, rel)
		if os.MkdirAll(filepath.Dir(target), 0o755) != nil || os.WriteFile(target, body, 0o644) != nil {
			return nil
		}
		copied++
		total += len(body)
		return nil
	})
	return copied
}

func intersect(a, b []string) []string {
	var out []string
	for _, x := range a {
		if contains(b, x) && !contains(out, x) {
			out = append(out, x)
		}
	}
	sort.Strings(out)
	return out
}

// LastConsolidation 返回上一次整理的时间（RFC3339），没有时为空。
func (s *Store) LastConsolidation() (string, error) {
	events, err := s.Timeline()
	if err != nil {
		return "", err
	}
	last := ""
	for _, event := range events {
		if event.Type == EventConsolidate {
			last = event.Time
		}
	}
	return last, nil
}

// Drafter 让整理者读 workdir 里的说明，把草稿写进 workdir/drafts/。
// 由调用方接上 ORCHESTRATOR；memory 包不关心是哪个工具。
type Drafter func(ctx context.Context, workdir, prompt string) error

// ConsolidateOptions 是一次整理的设置。
type ConsolidateOptions struct {
	// MinCount 是一组失败至少出现几次才值得提炼。
	MinCount int
	// All 为 true 时不看上次整理时间，把全部经历都算进来。
	All bool
	// Drafter 起草经验；DraftsDir 非空时不调用它，直接收录该目录下现成的草稿
	// （lessons/*.md 与 preferences/*.md）。
	Drafter   Drafter
	DraftsDir string
}

// ConsolidateResult 是一次整理的结果。
type ConsolidateResult struct {
	Run      string              `json:"run"`
	Workdir  string              `json:"workdir"`
	Clusters []Cluster           `json:"clusters"`
	Accepted []string            `json:"accepted"`
	Rejected map[string][]string `json:"rejected"`
}

// Consolidate 整理：失败经历聚类 → 交给整理者起草或修订 → 格式校验 → 合格的进入试用。
func (s *Store) Consolidate(ctx context.Context, opts ConsolidateOptions) (ConsolidateResult, error) {
	if opts.MinCount < 1 {
		opts.MinCount = 1
	}
	episodes, err := s.Episodes()
	if err != nil {
		return ConsolidateResult{}, err
	}
	since := ""
	if !opts.All {
		if since, err = s.LastConsolidation(); err != nil {
			return ConsolidateResult{}, err
		}
	}
	var fresh []Episode
	for _, e := range episodes {
		if e.CreatedAt > since {
			fresh = append(fresh, e)
		}
	}
	var clusters []Cluster
	for _, c := range clusterSince(fresh, episodes, since) {
		if c.Count >= opts.MinCount {
			clusters = append(clusters, c)
		}
	}
	run := "run-" + s.clock().UTC().Format("20060102-150405")
	result := ConsolidateResult{Run: run, Clusters: clusters, Accepted: []string{}, Rejected: map[string][]string{}}
	if result.Clusters == nil {
		result.Clusters = []Cluster{}
	}
	drafts := opts.DraftsDir
	if drafts == "" {
		if len(clusters) == 0 {
			return result, nil
		}
		if opts.Drafter == nil {
			return result, errors.New("没有配置整理者")
		}
		workdir := filepath.Join(s.Dir, "consolidate", run)
		for _, sub := range []string{"drafts/lessons", "drafts/preferences"} {
			if err := os.MkdirAll(filepath.Join(workdir, sub), 0o755); err != nil {
				return result, err
			}
		}
		result.Workdir = workdir
		existing, _, err := s.Memories()
		if err != nil {
			return result, err
		}
		copyContrastCode(workdir, clusters)
		brief := consolidationBrief(clusters, existing)
		if err := os.WriteFile(filepath.Join(workdir, "brief.md"), []byte(brief), 0o644); err != nil {
			return result, err
		}
		if err := writeJSON(filepath.Join(workdir, "clusters.json"), clusters); err != nil {
			return result, err
		}
		if err := opts.Drafter(ctx, workdir, brief); err != nil {
			return result, fmt.Errorf("整理者执行失败：%w", err)
		}
		drafts = filepath.Join(workdir, "drafts")
	}
	allowed := map[string]bool{}
	for _, c := range clusters {
		for _, id := range c.Episodes {
			allowed[id] = true
		}
	}
	// 直接收录现成草稿时没有聚类约束，来源经历只要存在即可。
	if opts.DraftsDir != "" {
		for _, e := range episodes {
			allowed[e.ID] = true
		}
	}
	var texts []string
	for _, e := range episodes {
		texts = append(texts, e.Text)
	}
	if err := s.ingestDrafts(drafts, allowed, texts, &result); err != nil {
		return result, err
	}
	return result, s.Log(Event{Type: EventConsolidate,
		Summary: fmt.Sprintf("整理：%d 组高频失败 → %d 条进入试用，%d 条草稿被拒", len(clusters), len(result.Accepted), len(result.Rejected)),
		Detail:  map[string]any{"run": run, "clusters": clusters, "accepted": result.Accepted, "rejected": result.Rejected}})
}

func (s *Store) ingestDrafts(dir string, allowedEpisodes map[string]bool, sceneTexts []string, result *ConsolidateResult) error {
	for _, kind := range []Kind{KindLesson, KindPreference} {
		entries, err := os.ReadDir(filepath.Join(dir, kind.dir()))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
				continue
			}
			label := kind.dir() + "/" + entry.Name()
			body, err := os.ReadFile(filepath.Join(dir, kind.dir(), entry.Name()))
			if err != nil {
				return err
			}
			m, err := Parse(kind, body)
			if err != nil {
				result.Rejected[label] = []string{err.Error()}
				continue
			}
			m.Status = StatusTrial
			m.VerifiedBy = nil
			m.RejectedReason = ""
			existing, _, err := s.Memories()
			if err != nil {
				return err
			}
			problems := Lint(m, LintContext{Existing: existing, SceneTexts: sceneTexts})
			if m.Name+".md" != entry.Name() {
				problems = append(problems, fmt.Sprintf("name %q 与文件名不一致", m.Name))
			}
			for _, other := range existing {
				if other.Name == m.Name {
					problems = append(problems, fmt.Sprintf("记忆 %s 已存在；修订请换一个新名字并写 revises: %s", m.Name, m.Name))
				}
			}
			if len(m.FromEpisodes) == 0 {
				problems = append(problems, "from_episodes 为空：经验必须说明从哪些经历来")
			}
			for _, id := range m.FromEpisodes {
				if !allowedEpisodes[id] {
					problems = append(problems, fmt.Sprintf("from_episodes 引用了不在本次整理范围内的经历：%s", id))
				}
			}
			if len(problems) > 0 {
				result.Rejected[label] = problems
				if err := s.Log(Event{Type: EventDraftReject, Summary: fmt.Sprintf("草稿 %s 未通过格式校验", label),
					Detail: map[string]any{"draft": label, "problems": problems}}); err != nil {
					return err
				}
				continue
			}
			if err := s.Write(m); err != nil {
				return err
			}
			result.Accepted = append(result.Accepted, m.Name)
			summary := fmt.Sprintf("新%s %s 进入试用：%s", kindLabel(m.Kind), m.Name, m.Description)
			if m.Revises != "" {
				summary = fmt.Sprintf("%s 的修订 %s 进入试用：%s", m.Revises, m.Name, m.Description)
			}
			if err := s.Log(Event{Type: EventTrial, Summary: summary, Detail: map[string]any{"memory": m.Name, "kind": m.Kind, "from_episodes": m.FromEpisodes, "revises": m.Revises}}); err != nil {
				return err
			}
		}
	}
	sort.Strings(result.Accepted)
	return nil
}

func kindLabel(kind Kind) string {
	if kind == KindPreference {
		return "偏好"
	}
	return "经验"
}

// consolidationBrief 是交给整理者的说明。
func consolidationBrief(clusters []Cluster, existing []Memory) string {
	var b strings.Builder
	b.WriteString(`# 整理渲染经验

你要把下面几组反复出现的渲染失败，提炼成可检验的经验，或修订已经被召回却仍然失败的旧经验。
这些经验会在以后每个镜头开工前按镜头特征召回，注入给负责渲染的 AI。记忆库由多种渲染工具与模型共用，
不同模型犯的错并不一样：通病写成通用经验，某个模型特有的毛病限定范围。

只在当前目录的 drafts/ 下写文件：经验写进 drafts/lessons/<name>.md，人工反馈里的审美取向写进 drafts/preferences/<name>.md。
不要改动其他任何文件，不要渲染，不要运行其他命令。写完即结束。

## 文件格式

` + "```markdown" + `
---
name: font-local-block
description: 中文字体用镜头目录内的本地文件，font-display 写 block，否则会静默回退
status: trial
applies_when:
  features: [cjk_text]
  keywords: [字体, font]
  # 只对某些渲染工具或模型成立时才写，下面两项都可省略：
  # renderers: [codex]
  # models: [gpt-6]
checked_by: [determinism.font-display, determinism.remote-font]
from_episodes: [ep-20261102-101500-a1b2c3]
---

中文字体必须用镜头目录内的本地文件，通过 @font-face 引入，font-display 写 block。

反例：
    @import url('https://fonts.googleapis.com/...');

正例：
    @font-face { font-family: 'X'; src: url('./fonts/x.woff2'); font-display: block; }
` + "```" + `

## 硬性要求（不满足的草稿会被直接拒收）

- name 用小写字母、数字与连字符，与文件名一致，不得与已有记忆重名。
- 经验必须写成一条可检验的约束，正文同时给出「反例」与「正例」代码片段，正文不超过 600 字，description 不超过 80 字。
- checked_by 优先用能在单镜头里判定的校验器（output.*、determinism.*、frames.blank）：只由 reads.* 或
  review.handoff 判定的经验要看整片，考试考不了，只能等人确认。
- checked_by 只能取下面「校验器」里的 ID，写明这条经验由哪个校验器判定；偏好的 checked_by 写 [human]。
- applies_when.features 只能取下面「镜头特征」里的值；适用于所有镜头时省略 applies_when。
- from_episodes 列出这条经验来自哪些经历编号，只能取下面各组里出现的编号。
- 正文、description 与 keywords 里不得出现渲染工具名、模型名或厂商名。
- 先看每组的「渲染工具/模型分布」判断范围：几种渲染工具或模型都出现的是通病，不写范围；
  集中在某个渲染工具或模型上的，用 applies_when.renderers（渲染工具 ID）或 applies_when.models
  （模型名，按前缀匹配，如 gpt-6 匹配 gpt-6-astra）限定，只对它们召回。只有一个样本时不要凭它下结论说是通病。
- 不得包含具体镜头的文案、镜头编号或素材文件名：经验要能迁移到别的文章。
- 已有记忆说的是同一件事时，写成修订：换一个新名字，加 revises: <旧名>，正文写完整的新版本。不要并列新增。
  修订必须保留旧版的全部 checked_by，正文不得短于旧版的一半：只改错的地方、补漏掉的情况，
  不要为了简洁删掉旧版里仍然成立的细节、数值和反例正例。
- 每个镜头最多注入 3 条经验：宁可一条写准，不要拆成几条泛泛的。
- 只为确有共性的失败写经验；拿不准的组宁可不写。
- 有「成败对照」的组，先读 contrasts/ 下通过那一版的合成代码：失败的一次犯了这个错，通过的一次没犯。
  经验写成「通过的那一边是怎么做的」，正例尽量取自通过的写法，不要只是把报错改写成禁令。
- 「用户的反应」一组写成偏好：从回退、反复提的要求与 👍 / 👎 里归纳用户长期的取向（节奏、配色、
  信息密度、语气……），不是复述某一次的修改要求。只在一个项目里出现的写 scope: <项目名>，
  几个项目都出现的不写 scope。偏好要用户确认后才生效，宁可少写。

`)
	b.WriteString("## 镜头特征\n\n")
	names := make([]string, 0, len(FeatureDescriptions))
	for name := range FeatureDescriptions {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(&b, "- `%s`：%s\n", name, FeatureDescriptions[name])
	}
	b.WriteString("- `handoff:<手法>`：交接用了某种手法（carry、match、push_in、flood、pan、settle）\n\n## 校验器\n\n")
	for _, id := range KnownCheckers() {
		fmt.Fprintf(&b, "- `%s`\n", id)
	}
	b.WriteString("\n## 已有记忆\n\n")
	count := 0
	for _, m := range existing {
		if m.Status != StatusActive && m.Status != StatusTrial {
			continue
		}
		count++
		scope := "不限"
		if m.AppliesWhen.Scoped() {
			scope = strings.Join(append(append([]string{}, m.AppliesWhen.Renderers...), m.AppliesWhen.Models...), ", ")
		}
		fmt.Fprintf(&b, "### %s（%s，%s）\n\n%s\n\nchecked_by: %s；features: %s；渲染工具/模型：%s\n\n%s\n\n", m.Name, kindLabel(m.Kind), m.Status,
			m.Description, strings.Join(m.CheckedBy, ", "), strings.Join(m.AppliesWhen.Features, ", "), scope, m.Body)
	}
	if count == 0 {
		b.WriteString("（暂无）\n\n")
	}
	b.WriteString("## 高频失败\n\n")
	for _, c := range clusters {
		title := "校验器 `" + c.Key + "`"
		if c.Key == ClusterKeyHuman {
			title = "用户的反应（回退、反复提的要求、👍 / 👎）"
		}
		fmt.Fprintf(&b, "### %s：%d 次\n\n", title, c.Count)
		fmt.Fprintf(&b, "- 经历：%s\n", strings.Join(c.Episodes, ", "))
		if len(c.Models) > 0 {
			fmt.Fprintf(&b, "- 渲染工具/模型分布：%s\n", distribution(c.Models))
		}
		if len(c.Features) > 0 {
			fmt.Fprintf(&b, "- 共同特征：%s\n", strings.Join(c.Features, ", "))
		}
		if len(c.Recalled) > 0 {
			fmt.Fprintf(&b, "- 失败时已召回的记忆（没帮上忙，考虑修订）：%s\n", strings.Join(c.Recalled, ", "))
		}
		for _, example := range c.Examples {
			fmt.Fprintf(&b, "- 报错示例：%s\n", example)
		}
		for _, note := range c.Notes {
			fmt.Fprintf(&b, "- %s\n", note)
		}
		for _, pair := range c.Contrasts {
			b.WriteString(contrastLine(pair))
		}
		b.WriteString("\n")
	}
	return b.String()
}

func contrastLine(pair Contrast) string {
	kind := "特征相近的另一个镜头通过了"
	if pair.SameScene {
		kind = "同一个镜头后来改对了"
	}
	line := fmt.Sprintf("- 成败对照（%s）：失败 %s，通过 %s", kind, pair.Failed, pair.Passed)
	if pair.PassedCode != "" {
		line += "；通过那一版的合成代码拷在当前目录的 " + pair.PassedCode + "/"
	} else {
		line += "；通过那一版的代码已被后来的渲染覆盖，只能对照报错与特征"
	}
	if len(pair.Shared) > 0 {
		line += "；共同特征 " + strings.Join(pair.Shared, ", ")
	}
	return line + "\n"
}

func rendererModel(renderer, model string) string {
	if model == "" {
		return renderer
	}
	return renderer + "/" + model
}

// distribution 把计数写成「a × 3、b × 1」，按次数降序。
func distribution(counts map[string]int) string {
	keys := make([]string, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if counts[keys[i]] != counts[keys[j]] {
			return counts[keys[i]] > counts[keys[j]]
		}
		return keys[i] < keys[j]
	})
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf("%s × %d", key, counts[key]))
	}
	return strings.Join(parts, "、")
}

var signalLabels = map[string]string{"reverted": "回退了这一轮", "repeated": "反复提到", "liked": "👍", "disliked": "👎"}

func humanCluster(all []Episode, since string) (Cluster, bool) {
	created := map[string]string{}
	for _, e := range all {
		created[e.ID] = e.CreatedAt
	}
	c := Cluster{Key: ClusterKeyHuman, Renderers: map[string]int{}, Models: map[string]int{}}
	for _, signal := range PreferenceSignals(all) {
		fresh := false
		for _, id := range signal.Episodes {
			if created[id] > since {
				fresh = true
			}
		}
		if !fresh {
			continue
		}
		c.Signals = append(c.Signals, signal)
		c.Count += signal.Count
		c.Episodes = append(c.Episodes, signal.Episodes...)
		note := fmt.Sprintf("（%s）%s", signalLabels[signal.Kind], signal.Text)
		if signal.Kind == "repeated" {
			note = fmt.Sprintf("（在 %d 轮对话里反复提到）%s", signal.Count, signal.Text)
		}
		if signal.Project != "" {
			note += "　〔项目 " + signal.Project + "〕"
		}
		c.Notes = append(c.Notes, note)
	}
	return c, len(c.Signals) > 0
}
