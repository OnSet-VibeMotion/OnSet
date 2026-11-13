package studio

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/align"
	"github.com/chouheiwa/articale-to-motion/internal/srt"
)

// 口播稿页读的文件。终稿由制作提示词第二阶段写出；没有终稿时退回用户放进项目的原稿。
const (
	scriptFinalPath     = "production/script-final.md"
	scriptChangeLogPath = "production/script-change-log.md"
	scriptVoicePath     = "production/audio/voice.srt"
	// scriptUnitsPerSecond 是估算朗读时长用的语速：中文播音约每分钟 250–280 字。
	scriptUnitsPerSecond = 4.5
)

var scriptFallbacks = []string{"SCRIPT.md", "script.md", "transcription.srt"}

type scriptDoc struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type scriptVoice struct {
	Path    string  `json:"path"`
	Seconds float64 `json:"seconds"`
}

type scriptResponse struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// Final 表示这是口播终稿（带显示/朗读与短语标记）；否则是原稿，原样显示。
	Final      bool              `json:"final"`
	UpdatedAt  string            `json:"updated_at,omitempty"`
	Blocks     []align.ViewBlock `json:"blocks,omitempty"`
	Stats      *align.ViewStats  `json:"stats,omitempty"`
	ParseError string            `json:"parse_error,omitempty"`
	// EstimateSeconds 按 scriptUnitsPerSecond 估算的朗读时长。
	EstimateSeconds float64      `json:"estimate_seconds,omitempty"`
	Voice           *scriptVoice `json:"voice,omitempty"`
	ChangeLog       *scriptDoc   `json:"change_log,omitempty"`
}

// scriptAPI 给口播稿页：终稿解析成段落、标题与标记，附估算时长、实际配音时长与修改记录。
func (s *Server) scriptAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.error(w, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET")
		return
	}
	p, err := s.currentProject()
	if err != nil {
		s.error(w, 404, "no_project", err.Error())
		return
	}
	s.write(w, 200, readScript(p.Path))
}

func readScript(root string) scriptResponse {
	var out scriptResponse
	for _, name := range append([]string{scriptFinalPath}, scriptFallbacks...) {
		full := filepath.Join(root, filepath.FromSlash(name))
		body, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		out.Path, out.Content, out.Final = name, string(body), name == scriptFinalPath
		if info, statErr := os.Stat(full); statErr == nil {
			out.UpdatedAt = info.ModTime().Format(time.RFC3339)
		}
		break
	}
	if out.Final {
		script, err := align.ParseScript(out.Content)
		var parseErr *align.ParseError
		switch {
		case errors.As(err, &parseErr):
			out.ParseError = parseErr.Error()
		case err != nil:
			out.ParseError = err.Error()
		default:
			blocks, stats := script.View()
			out.Blocks, out.Stats = blocks, &stats
			out.EstimateSeconds = float64(stats.Units) / scriptUnitsPerSecond
		}
		if body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(scriptChangeLogPath))); err == nil {
			out.ChangeLog = &scriptDoc{Path: scriptChangeLogPath, Content: string(body)}
		}
	}
	if span, err := srt.ReadSpan(filepath.Join(root, filepath.FromSlash(scriptVoicePath))); err == nil {
		out.Voice = &scriptVoice{Path: scriptVoicePath, Seconds: span.EndSeconds}
	}
	return out
}
