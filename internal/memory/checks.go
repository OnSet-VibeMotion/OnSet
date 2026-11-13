package memory

import (
	"slices"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

// SourceCheck 是渲染之后的质量检查（阅读时间、交接、空白帧）发现的问题。
// 它们决定观感，却不在产物校验里：渲染当时判了通过，事后才查出来。
const SourceCheck = "check"

// Finding 是一条检查发现：校验器 ID 加给人看的说明。
type Finding struct {
	Check   string
	Problem string
}

// RecordCheck 把一个镜头的事后检查问题写成经历。
//
// 渲染工具、模型、召回的记忆取自这个镜头最近一次正式渲染的经历——问题出在
// 那次渲染的产物上。同一份产物（输入指纹相同）重复检查出同一组问题时不再重复
// 记录，否则多跑几遍检查命令就把一类失败的次数刷高了。没有可记的发现时返回 ok=false。
func (s *Store) RecordCheck(sc scene.Scene, findings []Finding) (Episode, bool, error) {
	if len(findings) == 0 {
		return Episode{}, false, nil
	}
	episodes, err := s.Episodes()
	if err != nil {
		return Episode{}, false, err
	}
	episode := Episode{Source: SourceCheck, SceneID: sc.ID, Text: sc.Text, Outcome: scene.OutcomeVerificationFailed}
	for _, f := range findings {
		episode.Checks = append(episode.Checks, f.Check)
		episode.Problems = append(episode.Problems, f.Problem)
	}
	for i := len(episodes) - 1; i >= 0; i-- {
		e := episodes[i]
		if e.Source == SourceRender && e.SceneDir == sc.Directory {
			episode.Renderer, episode.Model, episode.Fingerprint = e.Renderer, e.Model, e.Fingerprint
			episode.Recalled, episode.Snapshot, episode.Run = e.Recalled, e.Snapshot, e.Run
			break
		}
	}
	if record, ok := scene.LoadRecord(sc); ok {
		episode.Fingerprint = record.Fingerprint
	}
	if episode.Renderer == "" {
		episode.Renderer = sc.Renderer
	}
	checks := uniqueSorted(episode.Checks)
	for _, e := range episodes {
		if e.Source == SourceCheck && e.SceneDir == sc.Directory && e.Fingerprint == episode.Fingerprint &&
			slices.Equal(uniqueSorted(e.Checks), checks) {
			return e, false, nil
		}
	}
	features, _ := Features(sc)
	episode.Features = features
	saved, err := s.saveEpisode(sc, episode)
	return saved, err == nil, err
}
