package memory

import (
	"sort"
)

// RunSummary 是一次 am scene run / run-all 调用（一个批次）的汇总。
//
// 「第二次比第一次好」要能被机器量出来：一次通过率、重试次数、失败项数、耗时与
// token 都按批次汇总，并按「渲染工具/模型」分开——混在一起的话，换了渲染工具
// 带来的变化会被算成记忆的功劳。
type RunSummary struct {
	Run       string `json:"run"`
	StartedAt string `json:"started_at"`
	Project   string `json:"project,omitempty"`
	RunStats
	// ByModel 按「渲染工具/模型」分开的同一组指标。
	ByModel map[string]RunStats `json:"by_model"`
}

// RunStats 是一组镜头尝试的指标。
type RunStats struct {
	// Scenes 是这一批渲染的镜头数（按首次尝试计）。
	Scenes int `json:"scenes"`
	// PassedFirstTry 是首次尝试就通过全部硬校验、事后检查也没查出问题的镜头数。
	PassedFirstTry int     `json:"passed_first_try"`
	PassRate       float64 `json:"pass_rate"`
	Retries        int     `json:"retries"`
	// Problems 是首次尝试的失败项总数加事后检查查出的问题数。
	Problems int `json:"problems"`
	// CheckProblems 是其中事后检查（阅读时间、交接、空白帧）查出的部分。
	CheckProblems int     `json:"check_problems"`
	Seconds       float64 `json:"seconds"`
	InputTokens   int64   `json:"input_tokens"`
	OutputTokens  int64   `json:"output_tokens"`
	// Recalled 是平均每个镜头召回的记忆条数。
	Recalled float64 `json:"recalled"`
	// Snapshots 是这一批用到的记忆快照号。
	Snapshots []int `json:"snapshots"`
}

type runAccumulator struct {
	stats    RunStats
	recalled int
	snaps    map[int]bool
}

func (a *runAccumulator) add(e Episode, failed map[string]bool) {
	if e.Usage != nil {
		usage := e.Usage.Normalized()
		a.stats.InputTokens += usage.InputTokens
		a.stats.OutputTokens += usage.OutputTokens
	}
	a.stats.Seconds += e.Seconds
	if !e.FirstTry() {
		a.stats.Retries++
		return
	}
	a.stats.Scenes++
	a.recalled += len(e.Recalled)
	if a.snaps == nil {
		a.snaps = map[int]bool{}
	}
	a.snaps[e.Snapshot] = true
	if effectivelyPassed(e, failed) {
		a.stats.PassedFirstTry++
	}
	a.stats.Problems += len(e.Problems)
}

func (a *runAccumulator) finish() RunStats {
	stats := a.stats
	if stats.Scenes > 0 {
		stats.PassRate = float64(stats.PassedFirstTry) / float64(stats.Scenes)
		stats.Recalled = float64(a.recalled) / float64(stats.Scenes)
	}
	stats.Snapshots = []int{}
	for id := range a.snaps {
		stats.Snapshots = append(stats.Snapshots, id)
	}
	sort.Ints(stats.Snapshots)
	return stats
}

// RunReport 按批次汇总正式渲染的经历，按开始时间升序。
// 没有批次编号的经历（引入批次之前的、导入的）不进报告。
func RunReport(episodes []Episode) []RunSummary {
	failed := checkFailures(episodes)
	type group struct {
		summary RunSummary
		total   runAccumulator
		models  map[string]*runAccumulator
	}
	groups := map[string]*group{}
	var order []string
	for _, e := range episodes {
		if e.Source != SourceRender || e.Run == "" || e.Outcome == "interrupted" {
			continue
		}
		g := groups[e.Run]
		if g == nil {
			g = &group{summary: RunSummary{Run: e.Run, StartedAt: e.CreatedAt, Project: e.Project}, models: map[string]*runAccumulator{}}
			groups[e.Run] = g
			order = append(order, e.Run)
		}
		if e.CreatedAt < g.summary.StartedAt {
			g.summary.StartedAt = e.CreatedAt
		}
		key := StatKey(e.Renderer, e.Model)
		if g.models[key] == nil {
			g.models[key] = &runAccumulator{}
		}
		g.total.add(e, failed)
		g.models[key].add(e, failed)
	}
	// 事后检查查出的问题记到出问题的那一批上（检查经历继承了渲染的批次编号）。
	for _, e := range episodes {
		if e.Source != SourceCheck || groups[e.Run] == nil {
			continue
		}
		g := groups[e.Run]
		g.total.stats.Problems += len(e.Problems)
		g.total.stats.CheckProblems += len(e.Problems)
		if m := g.models[StatKey(e.Renderer, e.Model)]; m != nil {
			m.stats.Problems += len(e.Problems)
			m.stats.CheckProblems += len(e.Problems)
		}
	}
	out := make([]RunSummary, 0, len(order))
	for _, run := range order {
		g := groups[run]
		g.summary.RunStats = g.total.finish()
		g.summary.ByModel = map[string]RunStats{}
		for key, acc := range g.models {
			g.summary.ByModel[key] = acc.finish()
		}
		out = append(out, g.summary)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartedAt < out[j].StartedAt })
	return out
}
