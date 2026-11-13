package memory

import (
	"sort"
	"strings"
)

// Stat 是一条记忆在某个「渲染工具/模型」上的效果统计。只计正式渲染的首次尝试：
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

// StatKey 是统计的键：渲染工具/模型，模型未知时只有渲染工具。
// 同一渲染工具换了模型，犯的错可能完全不同，统计不能混在一起。
func StatKey(renderer, model string) string { return rendererModel(renderer, model) }

func checkKey(e Episode) string { return e.SceneDir + "|" + e.Fingerprint }

// checkFailures 是事后检查（阅读时间、交接、空白帧）查出问题的产物。
func checkFailures(episodes []Episode) map[string]bool {
	failed := map[string]bool{}
	for _, e := range episodes {
		if e.Source == SourceCheck && e.Fingerprint != "" {
			failed[checkKey(e)] = true
		}
	}
	return failed
}

// effectivelyPassed：渲染时通过了校验、事后检查又查出问题的产物不算通过。
func effectivelyPassed(e Episode, failed map[string]bool) bool {
	return e.Passed() && !(e.Fingerprint != "" && failed[checkKey(e)])
}

// ComputeStats 由经历聚合出每条记忆按「渲染工具/模型」分开的效果统计。
func ComputeStats(episodes []Episode) map[string]map[string]Stat {
	failed := checkFailures(episodes)
	out := map[string]map[string]Stat{}
	for _, e := range episodes {
		if !countable(e) {
			continue
		}
		key := StatKey(e.Renderer, e.Model)
		for _, name := range e.Recalled {
			if out[name] == nil {
				out[name] = map[string]Stat{}
			}
			stat := out[name][key]
			stat.Recalled++
			if effectivelyPassed(e, failed) {
				stat.PassedFirstTry++
			}
			out[name][key] = stat
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

// smoothedRate 估计一条记忆在当前渲染工具/模型上的一次通过率（拉普拉斯平滑）。
//
// 只用当前模型自己的样本；没有时退到同一渲染工具的其他模型，再退到全部渲染工具，
// 这两档都向 0.5 收缩一半：别的模型上的效果只能当弱证据，模型换了就该重新攒统计。
func smoothedRate(stats map[string]Stat, renderer, model string) float64 {
	laplace := func(s Stat) float64 { return float64(s.PassedFirstTry+1) / float64(s.Recalled+2) }
	if stat, ok := stats[StatKey(renderer, model)]; ok && stat.Recalled > 0 {
		return laplace(stat)
	}
	var sameRenderer, all Stat
	for key, stat := range stats {
		all.Recalled += stat.Recalled
		all.PassedFirstTry += stat.PassedFirstTry
		if key == renderer || strings.HasPrefix(key, renderer+"/") {
			sameRenderer.Recalled += stat.Recalled
			sameRenderer.PassedFirstTry += stat.PassedFirstTry
		}
	}
	pick := all
	if sameRenderer.Recalled > 0 {
		pick = sameRenderer
	}
	return 0.5 + (laplace(pick)-0.5)/2
}

// DormancyMinRecalls 是判定一条记忆「没帮上忙」前至少要有的召回次数（设计里的 K）。
const DormancyMinRecalls = 5

// Weak 是一条在某个渲染工具/模型上没帮上忙的生效记忆：召回后的一次通过率
// 不高于同一渲染工具/模型上没召回它时的基线。
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
	failed := checkFailures(episodes)
	var out []Weak
	for _, name := range active {
		for key, stat := range stats[name] {
			if stat.Recalled < DormancyMinRecalls {
				continue
			}
			var base Stat
			for _, e := range episodes {
				if countable(e) && StatKey(e.Renderer, e.Model) == key && !contains(e.Recalled, name) {
					base.Recalled++
					if effectivelyPassed(e, failed) {
						base.PassedFirstTry++
					}
				}
			}
			if base.Recalled == 0 || stat.Rate() > base.Rate() {
				continue
			}
			out = append(out, Weak{Name: name, Renderer: key, Rate: stat.Rate(), Baseline: base.Rate(), Recalled: stat.Recalled})
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

// SuspectMinHarm 是判定一条生效经验「可疑」至少要有的有害次数。
const SuspectMinHarm = 2

// Suspect 是一条可疑的生效经验：召回了它，它要防的那个校验器却照样判了失败。
//
// 「待沉睡」（Weak）看的是一次通过率有没有比基线高，要攒够样本才判得出；
// 这里看的是更直接的负证据——经验点名要防的错，注入之后还在发生，说明它没写对，
// 或者对这个模型不管用。做法借鉴 ExpeL 对 insight 的增减投票与 ACE 的
// helpful/harmful 计数，但只给出候选、不自动改状态：重考或人来决定。
type Suspect struct {
	Name     string `json:"name"`
	Renderer string `json:"renderer"`
	Recalled int    `json:"recalled"`
	Harmful  int    `json:"harmful"`
	// Checks 是召回后仍然失败的、这条经验的 checked_by 里的校验器。
	Checks []string `json:"checks"`
}

// SuspectMemories 找出可疑的生效经验，按「渲染工具/模型」分开计。
// 有害计入正式渲染的首次尝试与事后检查：事后检查继承了那次渲染召回的记忆。
func SuspectMemories(episodes []Episode, active []Memory) []Suspect {
	type tally struct {
		recalled, harmful int
		checks            []string
	}
	counts := map[string]map[string]*tally{}
	get := func(name, key string) *tally {
		if counts[name] == nil {
			counts[name] = map[string]*tally{}
		}
		if counts[name][key] == nil {
			counts[name][key] = &tally{}
		}
		return counts[name][key]
	}
	lessons := map[string]Memory{}
	for _, m := range active {
		if m.Kind == KindLesson && m.Status == StatusActive {
			lessons[m.Name] = m
		}
	}
	for _, e := range episodes {
		render := countable(e)
		if !render && e.Source != SourceCheck {
			continue
		}
		key := StatKey(e.Renderer, e.Model)
		for _, name := range e.Recalled {
			m, ok := lessons[name]
			if !ok {
				continue
			}
			t := get(name, key)
			if render {
				t.recalled++
			}
			hit := intersect(e.Checks, m.CheckedBy)
			if len(hit) == 0 {
				continue
			}
			t.harmful++
			for _, id := range hit {
				if !contains(t.checks, id) {
					t.checks = append(t.checks, id)
				}
			}
		}
	}
	var out []Suspect
	for name, byKey := range counts {
		for key, t := range byKey {
			if t.harmful < SuspectMinHarm || t.harmful*2 < t.recalled {
				continue
			}
			sort.Strings(t.checks)
			out = append(out, Suspect{Name: name, Renderer: key, Recalled: t.recalled, Harmful: t.harmful, Checks: t.checks})
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
