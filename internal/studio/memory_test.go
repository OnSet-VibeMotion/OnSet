package studio

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/memory"
)

// TestMemoryPanelReadsStoreAndRecallsForScene：面板的读接口只读记忆库，
// 「本镜头想起了什么」给出召回条目与理由；考场里的镜头副本不出现在镜头列表里。
func TestMemoryPanelReadsStoreAndRecallsForScene(t *testing.T) {
	root := t.TempDir()
	memoryDir := t.TempDir()
	t.Setenv("AM_MEMORY_DIR", memoryDir)
	writeStudioFile(t, filepath.Join(root, "article-to-motion.conf"), "ORCHESTRATOR=codex\nRENDERER=claude\nMEMORY=on\n")
	scene := filepath.Join(root, "scenes", "scene-001")
	writeStudioFile(t, filepath.Join(scene, "transcript.srt"), "1\n00:00:00,000 --> 00:00:01,000\nx\n")
	writeStudioFile(t, filepath.Join(scene, "scene.json"), `{"id":"scene-001","duration_seconds":2,"output":"out.mp4","transcript":"transcript.srt","text":"中文标题"}`)
	exam := filepath.Join(root, "production", "memory-exams", "exam-0001", "q1", "claude-trial-1")
	writeStudioFile(t, filepath.Join(exam, "scene.json"), `{"id":"scene-001","duration_seconds":2,"output":"out.mp4"}`)

	store, err := memory.Open(memoryDir)
	if err != nil {
		t.Fatal(err)
	}
	rule := memory.Memory{Kind: memory.KindLesson, Meta: memory.Meta{Name: "cjk-font-local", Description: "中文字体用本地文件", Status: memory.StatusActive,
		AppliesWhen: memory.Applies{Features: []string{"cjk_text"}}, CheckedBy: []string{"determinism.remote-font"}}, Body: "反例：x\n正例：y"}
	store.Write(rule)
	store.TakeSnapshot(memory.EventManualEdit, "初始", true)

	_, ts := startStudio(t, Config{ProjectPath: root, ConfigPath: filepath.Join(t.TempDir(), "projects.json")})
	status, body := studioRequest(t, http.MethodGet, ts.URL+"/api/scenes", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if scenes := studioList(t, body["scenes"]); len(scenes) != 1 {
		t.Fatalf("考场里的镜头副本不该算作项目镜头：%#v", scenes)
	}
	status, body = studioRequest(t, http.MethodGet, ts.URL+"/api/memory", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if body["enabled"] != true || len(studioList(t, body["memories"])) != 1 || len(studioList(t, body["snapshots"])) != 1 {
		t.Fatalf("记忆面板数据不对：%#v", body)
	}
	status, body = studioRequest(t, http.MethodGet, ts.URL+"/api/memory/recall?scene=scene-001", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	reasons := studioList(t, body["reasons"])
	if len(reasons) != 1 || !strings.Contains(reasons[0].(string), "cjk_text") || !strings.Contains(body["section"].(string), "cjk-font-local") {
		t.Fatalf("召回结果不对：%#v", body)
	}
	status, body = studioRequest(t, http.MethodPost, ts.URL+"/api/memory/actions/promote", `{"name":"../x"}`)
	requireStudioStatus(t, status, http.StatusBadRequest, body)
	status, body = studioRequest(t, http.MethodPost, ts.URL+"/api/memory/actions/exam", `{"renderers":["rm -rf"]}`)
	requireStudioStatus(t, status, http.StatusBadRequest, body)
	status, body = studioRequest(t, http.MethodPost, ts.URL+"/api/memory/actions/shell", `{}`)
	requireStudioStatus(t, status, http.StatusNotFound, body)
}

// TestChatTurnsCarryUserPreferences：用户偏好交给编排工具，让它能按偏好理解
// 简短的要求；偏好没变时续接的会话不重复发送，偏好变了下一轮就带上新版本。
func TestChatTurnsCarryUserPreferences(t *testing.T) {
	f := newSessionFixture(t)
	memoryDir := t.TempDir()
	t.Setenv("AM_MEMORY_DIR", memoryDir)
	store, err := memory.Open(memoryDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Remember(memory.RememberInput{Name: "calm-palette", Body: "配色克制，不要满屏霓虹", Global: true}); err != nil {
		t.Fatal(err)
	}
	status, body := studioRequest(t, http.MethodPost, f.url+"/api/sessions", `{"title":"偏好"}`)
	requireStudioStatus(t, status, http.StatusCreated, body)
	id := body["session_id"].(string)
	turn := func(message string) string {
		status, body := studioRequest(t, http.MethodPost, f.url+"/api/sessions/"+id+"/turns", `{"message":"`+message+`"}`)
		requireStudioStatus(t, status, http.StatusAccepted, body)
		f.waitIdle(t, id)
		args := f.args(t)
		return args[len(args)-1]
	}
	if first := turn("来个科普的"); !strings.Contains(first, "【calm-palette】") || !strings.Contains(first, "am memory remember") {
		t.Fatalf("第一轮应当带上用户偏好：%s", first)
	}
	if second := turn("再快一点"); strings.Contains(second, "用户偏好") {
		t.Errorf("偏好没变时续接的会话不重复发送：%s", second)
	}
	store.Remember(memory.RememberInput{Name: "no-emoji", Body: "画面里不要 emoji", Global: true})
	if third := turn("换个开头"); !strings.Contains(third, "【no-emoji】") {
		t.Errorf("偏好变了下一轮要带上新版本：%s", third)
	}
}

// TestChatTurnsAndRevertsBecomeConversationEpisodes：每轮说的话和回退都留下信号，
// 整理时据此归纳偏好。
func TestChatTurnsAndRevertsBecomeConversationEpisodes(t *testing.T) {
	f := newSessionFixture(t)
	memoryDir := t.TempDir()
	t.Setenv("AM_MEMORY_DIR", memoryDir)
	status, body := studioRequest(t, http.MethodPost, f.url+"/api/sessions", `{"title":"信号"}`)
	requireStudioStatus(t, status, http.StatusCreated, body)
	id := body["session_id"].(string)
	status, body = studioRequest(t, http.MethodPost, f.url+"/api/sessions/"+id+"/turns", `{"message":"节奏再慢一点"}`)
	requireStudioStatus(t, status, http.StatusAccepted, body)
	turnID := body["turn_id"].(string)
	f.waitIdle(t, id)
	status, body = studioRequest(t, http.MethodPost, f.url+"/api/turns/"+turnID+"/revert", `{}`)
	requireStudioStatus(t, status, http.StatusOK, body)
	store, _ := memory.Open(memoryDir)
	episodes, _ := store.Episodes()
	if len(episodes) != 2 || episodes[0].Feedback.Verdict != "said" || episodes[1].Feedback.Verdict != "down" || episodes[1].Text != "节奏再慢一点" || episodes[0].Turn != turnID {
		t.Fatalf("应当记下说的话与回退：%+v", episodes)
	}
}

// TestScenesReportRenderUsageAndKeepAttemptRecordsOnRevert：镜头列表带全部尝试的
// 用量合计；尝试记录只记 stat，回退一轮不会把已经花掉的 token 从账上抹掉。
func TestScenesReportRenderUsageAndKeepAttemptRecordsOnRevert(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "scenes", "scene-001")
	writeStudioFile(t, filepath.Join(dir, "scene.json"), `{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}`)
	writeStudioFile(t, filepath.Join(dir, "attempts", "attempt-01", "render-scene-001.attempt.json"),
		`{"renderer":"claude","outcome":"failed","started_at":"1","usage":{"input_tokens":4,"cached_input_tokens":40,"output_tokens":1,"source":"claude result"}}`)
	writeStudioFile(t, filepath.Join(dir, "render-scene-001.attempt.json"),
		`{"renderer":"codex","outcome":"succeeded","started_at":"2","usage":{"input_tokens":100,"cached_input_tokens":60,"output_tokens":5,"source":"codex turn.completed","basis":"total-input"}}`)
	_, ts := startStudio(t, Config{ProjectPath: root, ConfigPath: filepath.Join(t.TempDir(), "projects.json")})
	status, body := studioRequest(t, http.MethodGet, ts.URL+"/api/scenes", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	first := studioList(t, body["scenes"])[0].(map[string]any)
	usage := first["usage"].(map[string]any)
	// 老 claude 记录的输入要加回缓存：44 + 100。
	if first["attempts"].(float64) != 2 || usage["input_tokens"].(float64) != 144 || usage["output_tokens"].(float64) != 6 {
		t.Fatalf("用量合计不对：%#v", first)
	}
	if !renderRecord(filepath.Join(dir, "render-scene-001.attempt.json")) || renderRecord(filepath.Join(dir, "scene.json")) {
		t.Error("只有尝试记录按 stat 处理")
	}
}
