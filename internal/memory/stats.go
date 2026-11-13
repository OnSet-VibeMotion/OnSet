package memory

import "sort"

// Stat 是一条记忆在某个渲染工具上的效果统计。只计正式渲染的首次尝试：
// 调度层的重试带着上一次的失败说明，不是记忆的功劳；考试是人为安排的，也不算。
type Stat struct {
	Recalled       int `json:"recalled"`
	PassedFirstTry int `json:"passed_first_try"`
}

// Rate 是一次通过率；没有样本时返回 -1。
func (s Stat) Rate() float64 {
	if s.Recalled == 0 {
		return -1
	}
	return float64(s.PassedFirstTry) / float64(s.Recalled)
}

func countable(e Episode) bool {
	return e.Source == SourceRender && e.FirstTry() && e.Outcome != "interrupted"
}

// ComputeStats 由经历聚合出每条记忆按渲染工具分开的效果统计。
func ComputeStats(episodes []Episode) map[string]map[string]Stat {
	out := map[string]map[string]Stat{}
	for _, e := range episodes {
		if !countable(e) {
			continue
		}
		for _, name := range e.Recalled {
			if out[name] == nil {
				out[name] = map[string]Stat{}
			}
			stat := out[name][e.Renderer]
			stat.Recalled++
			if e.Passed() {
				stat.PassedFirstTry++
			}
			out[name][e.Renderer] = stat
		}
	}
	return out
}

// Stats 读出全部经历并聚合效果统计。
func (s *Store) Stats() (map[string]map[string]Stat, error) {
	episodes, err := s.Episodes()
	if err != nil {
		return nil, err
	}
	return ComputeStats(episodes), nil
}

// DormancyMinRecalls 是判定一条记忆「没帮上忙」前至少要有的召回次数（设计里的 K）。
const DormancyMinRecalls = 5

// Weak 是一条在某个渲染工具上没帮上忙的生效记忆：召回后的一次通过率
// 不高于没召回它时的基线。
type Weak struct {
	Name     string  `json:"name"`
	Renderer string  `json:"renderer"`
	Rate     float64 `json:"rate"`
	Baseline float64 `json:"baseline"`
	Recalled int     `json:"recalled"`
}

// WeakMemories 找出待沉睡的记忆。它只给出候选，不改状态：
// 淘汰同样要经过考试确认，或由人决定。
func WeakMemories(episodes []Episode, active []string) []Weak {
	stats := ComputeStats(episodes)
	var out []Weak
	for _, name := range active {
		for renderer, stat := range stats[name] {
			if stat.Recalled < DormancyMinRecalls {
				continue
			}
			var base Stat
			for _, e := range episodes {
				if countable(e) && e.Renderer == renderer && !contains(e.Recalled, name) {
					base.Recalled++
					if e.Passed() {
						base.PassedFirstTry++
					}
				}
			}
			if base.Recalled == 0 || stat.Rate() > base.Rate() {
				continue
			}
			out = append(out, Weak{Name: name, Renderer: renderer, Rate: stat.Rate(), Baseline: base.Rate(), Recalled: stat.Recalled})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Renderer < out[j].Renderer
	})
	return out
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
