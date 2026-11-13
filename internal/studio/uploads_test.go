package studio

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func uploadRequest(t *testing.T, url string, files map[string]string) (int, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	for name, content := range files {
		part, _ := form.CreateFormFile("file", name)
		part.Write([]byte(content))
	}
	form.Close()
	resp, err := http.Post(url+"/api/uploads", form.FormDataContentType(), &body)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// TestUploadsLandInStudioStateAndReachThePrompt：上传存进 production/studio/uploads/，
// 不算任何一轮的改动；附进消息后，编排工具收到文件路径与种类。
func TestUploadsLandInStudioStateAndReachThePrompt(t *testing.T) {
	f := newSessionFixture(t)
	status, body := uploadRequest(t, f.url, map[string]string{"我的 文章.md": "# 标题\n正文"})
	if status != http.StatusCreated {
		t.Fatalf("status=%d body=%#v", status, body)
	}
	attachment := studioList(t, body["attachments"])[0].(map[string]any)
	path := attachment["path"].(string)
	if !strings.HasPrefix(path, uploadDir+"/") || attachment["name"] != "我的 文章.md" || attachment["upload"] != true || strings.Contains(path, " ") {
		t.Fatalf("attachment=%#v", attachment)
	}
	if content, err := os.ReadFile(filepath.Join(f.root, filepath.FromSlash(path))); err != nil || !strings.Contains(string(content), "正文") {
		t.Fatalf("content=%q err=%v", content, err)
	}
	if status, _ := uploadRequest(t, f.url, map[string]string{".env": "SECRET=1"}); status != http.StatusBadRequest {
		t.Fatalf(".env 不能上传：%d", status)
	}

	status, body = studioRequest(t, http.MethodPost, f.url+"/api/sessions", `{"title":"上传"}`)
	requireStudioStatus(t, status, http.StatusCreated, body)
	id := body["session_id"].(string)
	payload, _ := json.Marshal(map[string]any{"message": "用这篇文章做视频", "attachments": []any{attachment}})
	status, body = studioRequest(t, http.MethodPost, f.url+"/api/sessions/"+id+"/turns", string(payload))
	requireStudioStatus(t, status, http.StatusAccepted, body)
	detail := f.waitIdle(t, id)
	for _, change := range studioList(t, lastTurn(t, detail)["changes"]) {
		if strings.HasPrefix(change.(map[string]any)["path"].(string), "production/studio") {
			t.Fatalf("上传不该算这一轮的改动：%#v", change)
		}
	}
	args := f.args(t)[0]
	for _, want := range []string{"用户上传的文件", "文档「我的 文章.md」：" + path, "choices", "待办清单"} {
		if !strings.Contains(args, want) {
			t.Errorf("提示词缺少 %q：%s", want, args)
		}
	}
	// 伪造的上传路径被拒。
	bad, _ := json.Marshal(map[string]any{"message": "x", "attachments": []any{map[string]any{"upload": true, "path": "scenes/scene-001/prompt.md"}}})
	status, body = studioRequest(t, http.MethodPost, f.url+"/api/sessions/"+id+"/turns", string(bad))
	requireStudioStatus(t, status, http.StatusBadRequest, body)
}

func TestSafeFileNameAndKind(t *testing.T) {
	for in, want := range map[string]string{"a/b\\c.md": "a_b_c.md", "..hidden": "hidden", "我的 文章.md": "我的-文章.md", "": "file"} {
		if got := safeFileName(in); got != want {
			t.Errorf("safeFileName(%q)=%q want %q", in, got, want)
		}
	}
	if long := safeFileName(strings.Repeat("长", 120) + ".png"); len([]rune(long)) != 80 || !strings.HasSuffix(long, ".png") {
		t.Errorf("long=%q", long)
	}
	for name, kind := range map[string]string{"a.MD": "文档", "b.png": "图片", "c.wav": "音频", "d.mov": "视频", "e.woff2": "字体", "f.bin": "文件"} {
		if uploadKind(name) != kind {
			t.Errorf("%s → %s", name, uploadKind(name))
		}
	}
}
