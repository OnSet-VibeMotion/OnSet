package studio

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
)

// 口播稿页：终稿优先于原稿；解析成段落与标记，附估算时长、配音时长与修改记录；
// 标记写错时给出位置并带回原文，不让页面空着。
func TestScriptEndpoint(t *testing.T) {
	root := t.TempDir()
	writeStudioFile(t, filepath.Join(root, "article-to-motion.conf"), "")
	writeStudioFile(t, filepath.Join(root, "SCRIPT.md"), "原稿")
	_, ts := startStudio(t, Config{ProjectPath: root, ConfigPath: filepath.Join(t.TempDir(), "projects.json")})

	status, body := studioRequest(t, http.MethodGet, ts.URL+"/api/script", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if body["path"] != "SCRIPT.md" || body["final"] != false || body["blocks"] != nil {
		t.Fatalf("只有原稿时原样给出：%v", body)
	}

	writeStudioFile(t, filepath.Join(root, "production", "script-final.md"), "# 开场\n\n在<2025年|二零二五年>，@{cost}大模型很贵@{/cost}。\n")
	writeStudioFile(t, filepath.Join(root, "production", "script-change-log.md"), "- 新增开场")
	writeStudioFile(t, filepath.Join(root, "production", "audio", "voice.srt"), "1\n00:00:00,000 --> 00:00:03,500\n在2025年，大模型很贵。\n")
	status, body = studioRequest(t, http.MethodGet, ts.URL+"/api/script", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if body["path"] != "production/script-final.md" || body["final"] != true || body["parse_error"] != nil {
		t.Fatalf("终稿 = %v", body)
	}
	blocks := studioList(t, body["blocks"])
	if len(blocks) != 2 || blocks[0].(map[string]any)["kind"] != "heading" {
		t.Fatalf("blocks = %v", blocks)
	}
	if stats := body["stats"].(map[string]any); stats["phrases"] != float64(1) || stats["units"].(float64) < 10 {
		t.Fatalf("stats = %v", stats)
	}
	if body["estimate_seconds"].(float64) <= 0 {
		t.Fatalf("estimate = %v", body["estimate_seconds"])
	}
	if voice := body["voice"].(map[string]any); voice["seconds"] != 3.5 {
		t.Fatalf("voice = %v", voice)
	}
	if log := body["change_log"].(map[string]any); log["content"] != "- 新增开场" {
		t.Fatalf("change_log = %v", log)
	}

	writeStudioFile(t, filepath.Join(root, "production", "script-final.md"), "@{a}没闭合\n")
	status, body = studioRequest(t, http.MethodGet, ts.URL+"/api/script", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if !strings.Contains(body["parse_error"].(string), "第 1 行") || body["content"] != "@{a}没闭合\n" || body["blocks"] != nil {
		t.Fatalf("标记写错 = %v", body)
	}
}
