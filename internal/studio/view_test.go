package studio

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 编排工具经收件目录请网页切页：Studio 译成 view 事件；用户在看的页面写进提示词、不进对话显示。
func TestTurnCarriesViewBothWays(t *testing.T) {
	f := newSessionFixture(t)
	t.Setenv("FAKE_VIEW", `{"page":"script","note":"口播稿写好了"}`)
	status, body := studioRequest(t, http.MethodPost, f.url+"/api/sessions", `{"title":"审稿"}`)
	requireStudioStatus(t, status, http.StatusCreated, body)
	id := body["session_id"].(string)
	status, body = studioRequest(t, http.MethodPost, f.url+"/api/sessions/"+id+"/turns",
		`{"message":"这个镜头太快了","view":{"page":"scene","scene":"scene-001"}}`)
	requireStudioStatus(t, status, http.StatusAccepted, body)
	detail := f.waitIdle(t, id)
	if turn := lastTurn(t, detail); turn["status"] != "succeeded" {
		t.Fatalf("turn = %v", turn)
	}
	args := f.args(t)
	if !strings.Contains(args[0], "Studio 网页上开着「镜头」页，镜头 scene-001") || !strings.Contains(args[0], "am studio show") || !strings.Contains(args[0], "film-styles") {
		t.Fatalf("提示词应当带上用户在看的页面与 am studio show 的约定：%s", args[0])
	}
	_, raw := rawStudioGet(t, f.url+"/api/sessions/"+id+"/events?follow=0")
	if !strings.Contains(raw, "event: view") || !strings.Contains(raw, `"page":"script"`) || !strings.Contains(raw, "口播稿写好了") {
		t.Fatalf("缺少 view 事件：%s", raw)
	}
	if strings.Contains(raw, "Studio 网页上开着") {
		t.Fatal("用户在看的页面只进提示词，不显示在对话里")
	}
	if entries, _ := os.ReadDir(filepath.Join(studioRoot(f.root), "inbox")); len(entries) != 0 {
		t.Fatalf("一轮结束后收件目录应当清掉：%v", entries)
	}
}

func TestValidateViewRequest(t *testing.T) {
	root := t.TempDir()
	writeTree(t, root, map[string]string{
		"scenes/scene-001/scene.json": `{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}`,
		"production/treatment.md":     "x",
		".env":                        "A=1",
	})
	ok := []ViewRequest{
		{Page: "script"}, {Page: "scene", Target: "scene-001"}, {Page: "compose"},
		{Page: "file", Target: "production/treatment.md"}, {Page: "file", Target: filepath.Join(root, "production", "treatment.md")},
	}
	for _, req := range ok {
		got, err := ValidateViewRequest(root, req)
		if err != nil {
			t.Fatalf("%+v: %v", req, err)
		}
		if req.Page == "file" && got.Target != "production/treatment.md" {
			t.Fatalf("文件路径应当规范成相对路径：%q", got.Target)
		}
	}
	bad := []ViewRequest{
		{Page: "nope"}, {Page: "scene"}, {Page: "scene", Target: "scene-009"}, {Page: "script", Target: "x"},
		{Page: "file"}, {Page: "file", Target: ".env"}, {Page: "file", Target: "../outside"}, {Page: "file", Target: "missing.md"},
	}
	for _, req := range bad {
		if _, err := ValidateViewRequest(root, req); err == nil {
			t.Fatalf("%+v 应当被拒绝", req)
		}
	}
	// 不在 Studio 里：页面对就静默跳过，页面错照样报。
	if inStudio, err := WriteViewRequest(map[string]string{}, ViewRequest{Page: "script"}); inStudio || err != nil {
		t.Fatalf("不在 Studio 里应当跳过：%v %v", inStudio, err)
	}
	if _, err := WriteViewRequest(map[string]string{}, ViewRequest{Page: "nope"}); err == nil {
		t.Fatal("页面写错应当报错")
	}
	inbox := filepath.Join(t.TempDir(), "inbox")
	env := map[string]string{ViewInboxEnv: inbox, ViewProjectEnv: root}
	for _, page := range []string{"script", "final"} {
		if inStudio, err := WriteViewRequest(env, ViewRequest{Page: page}); !inStudio || err != nil {
			t.Fatalf("%s: %v %v", page, inStudio, err)
		}
	}
	got := drainViewInbox(inbox)
	if len(got) != 2 || got[0].Page != "script" || got[1].Page != "final" {
		t.Fatalf("应当按写入顺序读出：%+v", got)
	}
	if again := drainViewInbox(inbox); len(again) != 0 {
		t.Fatalf("读过的请求应当删掉：%+v", again)
	}
}

func TestViewStateDescribe(t *testing.T) {
	var none *ViewState
	if none.Describe() != "" || (&ViewState{Page: "bogus"}).Describe() != "" {
		t.Fatal("没有或不认识的页面不描述")
	}
	if got := (&ViewState{Page: "file", File: "a.md"}).Describe(); !strings.Contains(got, "「文件」页，文件 a.md") {
		t.Fatal(got)
	}
}
