package memory

import "fmt"

// StatusReport 是记忆库的现状。
type StatusReport struct {
	Dir      string `json:"dir"`
	Snapshot int    `json:"snapshot"`
	// Counts 按「层/状态」计数，如 lesson/active。
	Counts map[string]int `json:"counts"`
	// Drift 是相对最新快照被人工改动过的生效记忆；Recorded 为 true 时已记成新快照。
	Drift    []string `json:"drift"`
	Recorded int      `json:"recorded_snapshot,omitempty"`
	// Broken 是解析失败的记忆文件及原因。
	Broken map[string]string `json:"broken,omitempty"`
	// Weak 是待沉睡候选。
	Weak             []Weak `json:"weak"`
	Episodes         int    `json:"episodes"`
	PendingFailures  int    `json:"pending_failures"`
	LastConsolidated string `json:"last_consolidated,omitempty"`
}

// Status 汇总记忆库现状。record 为 true 时，把人工编辑记成新快照
// （标为「人工编辑，未经考试」）。
func (s *Store) Status(record bool) (StatusReport, error) {
	report := StatusReport{Dir: s.Dir, Counts: map[string]int{}, Broken: map[string]string{}, Weak: []Weak{}, Drift: []string{}}
	all, broken, err := s.Memories()
	if err != nil {
		return report, err
	}
	for path, problem := range broken {
		report.Broken[path] = problem.Error()
	}
	var active []string
	for _, m := range all {
		report.Counts[fmt.Sprintf("%s/%s", m.Kind, m.Status)]++
		if m.Status == StatusActive {
			active = append(active, m.Name)
		}
	}
	drift, err := s.Drift()
	if err != nil {
		return report, err
	}
	if drift != nil {
		report.Drift = drift
	}
	if len(drift) > 0 && record {
		snapshot, err := s.TakeSnapshot(EventManualEdit, "人工编辑，未经考试："+joinNames(drift), true)
		if err != nil {
			return report, err
		}
		report.Recorded = snapshot.ID
		if err := s.Log(Event{Type: EventManualEdit, Snapshot: snapshot.ID, Summary: "发现人工编辑，记为快照 #" + fmt.Sprint(snapshot.ID) + "（未经考试）",
			Detail: map[string]any{"memories": drift}}); err != nil {
			return report, err
		}
	}
	if latest, ok, err := s.LatestSnapshot(); err != nil {
		return report, err
	} else if ok {
		report.Snapshot = latest.ID
	}
	episodes, err := s.Episodes()
	if err != nil {
		return report, err
	}
	report.Episodes = len(episodes)
	if report.LastConsolidated, err = s.LastConsolidation(); err != nil {
		return report, err
	}
	for _, e := range episodes {
		if e.CreatedAt > report.LastConsolidated && e.Failure() && e.Source != SourceExam {
			report.PendingFailures++
		}
	}
	if weak := WeakMemories(episodes, active); weak != nil {
		report.Weak = weak
	}
	return report, nil
}

func joinNames(names []string) string {
	out := ""
	for i, name := range names {
		if i > 0 {
			out += "、"
		}
		out += name
	}
	return out
}
