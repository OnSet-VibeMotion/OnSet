package memory

import (
	"fmt"
	"sort"
	"strings"
	"unicode"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

// SourceConversation 是 Studio 对话里用户说的话。单独一句不说明什么，
// 反复提到的要求、被回退的一轮才是偏好信号，见 PreferenceSignals。
const SourceConversation = "conversation"

// Utterance 是对话里的一句话。
type Utterance struct {
	ProjectDir string
	Session    string
	Turn       string
	Message    string
	// Reverted 为 true 表示用户回退了这一轮的改动。
	Reverted bool
}

// RecordUtterance 把对话里用户的一句话（或一次回退）写成经历。
// 同一轮只记一次说话、一次回退。
func (s *Store) RecordUtterance(u Utterance) (Episode, error) {
	message := strings.TrimSpace(u.Message)
	if message == "" || u.Turn == "" {
		return Episode{}, fmt.Errorf("对话内容或轮次为空")
	}
	verdict := "said"
	if u.Reverted {
		verdict = "down"
	}
	episodes, err := s.Episodes()
	if err != nil {
		return Episode{}, err
	}
	for _, e := range episodes {
		if e.Source == SourceConversation && e.Turn == u.Turn && e.Feedback != nil && e.Feedback.Verdict == verdict {
			return e, nil
		}
	}
	episode := Episode{Source: SourceConversation, Text: message, Outcome: OutcomeFeedback, Session: u.Session, Turn: u.Turn,
		Feedback: &Feedback{Verdict: verdict, Note: message, Seconds: -1}}
	return s.saveEpisode(scene.Scene{Directory: u.ProjectDir}, episode)
}

// Signal 是一条偏好信号：值得交给整理者看的用户反应。
type Signal struct {
	Kind     string   `json:"kind"` // reverted | repeated | liked | disliked
	Text     string   `json:"text"`
	Count    int      `json:"count"`
	Project  string   `json:"project,omitempty"`
	Episodes []string `json:"episodes"`
}

// 两句话按字二元组的 Jaccard 相似度不低于它，算同一个要求换了说法。
// 或者重合的二元组占较短一句的比例不低于 repeatOverlap。
const (
	repeatSimilarity = 0.5
	repeatOverlap    = 0.6
)

// PreferenceSignals 从经历里找出偏好信号：
//
//   - 被回退的一轮：用户不要这样改；
//   - 在不同轮次里反复提的同一个要求（「再慢一点」说了三次）：说明默认做法不合用户心意；
//   - 带说明的 👍 / 👎。
//
// 单独一句话不算信号：用户随口的要求大多只对这一次成立。
func PreferenceSignals(episodes []Episode) []Signal {
	var out []Signal
	var said []Episode
	for _, e := range episodes {
		switch {
		case e.Source == SourceConversation && e.Feedback != nil && e.Feedback.Verdict == "down":
			out = append(out, Signal{Kind: "reverted", Text: e.Text, Count: 1, Project: e.Project, Episodes: []string{e.ID}})
		case e.Source == SourceConversation:
			said = append(said, e)
		case e.Source == SourceFeedback && e.Feedback != nil && strings.TrimSpace(e.Feedback.Note) != "":
			kind := "liked"
			if e.Feedback.Verdict == "down" {
				kind = "disliked"
			}
			out = append(out, Signal{Kind: kind, Text: e.Feedback.Note, Count: 1, Project: e.Project, Episodes: []string{e.ID}})
		}
	}
	used := make([]bool, len(said))
	for i := range said {
		if used[i] {
			continue
		}
		group := []Episode{said[i]}
		turns := map[string]bool{said[i].Turn: true}
		for j := i + 1; j < len(said); j++ {
			if !used[j] && !turns[said[j].Turn] && similar(said[i].Text, said[j].Text) {
				used[j] = true
				turns[said[j].Turn] = true
				group = append(group, said[j])
			}
		}
		if len(group) < 2 {
			continue
		}
		signal := Signal{Kind: "repeated", Text: said[i].Text, Count: len(group), Project: said[i].Project}
		for _, e := range group {
			signal.Episodes = append(signal.Episodes, e.ID)
		}
		out = append(out, signal)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	return out
}

func bigrams(text string) map[string]bool {
	var runes []rune
	for _, r := range strings.ToLower(text) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			runes = append(runes, r)
		}
	}
	out := map[string]bool{}
	if len(runes) == 1 {
		out[string(runes)] = true
	}
	for i := 0; i+1 < len(runes); i++ {
		out[string(runes[i:i+2])] = true
	}
	return out
}

func similar(a, b string) bool {
	x, y := bigrams(a), bigrams(b)
	if len(x) == 0 || len(y) == 0 {
		return false
	}
	shared := 0
	for k := range x {
		if y[k] {
			shared++
		}
	}
	// 短要求常被换个说法再说一遍（「再慢一点」「慢一点，节奏慢一点」），只看 Jaccard
	// 会被多出来的字拉低；再看重合部分占较短一句的比例。
	shorter := min(len(x), len(y))
	return float64(shared)/float64(len(x)+len(y)-shared) >= repeatSimilarity ||
		float64(shared)/float64(shorter) >= repeatOverlap
}
