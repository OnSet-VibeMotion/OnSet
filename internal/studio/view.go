package studio

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 编排工具与 Studio 网页之间的两条通道：
//
//   - 编排工具 → 网页：一轮对话里编排工具运行 am studio show <页面> [对象]，把一份请求写进
//     这一轮的收件目录（ViewInboxEnv）；Studio 在这一轮进行中轮询收件目录，译成 view
//     事件推给网页，网页切到那一页。写文件而不是发 HTTP：codex 的沙箱默认断网，连本机
//     端口也连不上，项目目录却总是可写的。
//   - 网页 → 编排工具：网页发消息时带上用户此刻在看的页面（ViewState），Studio 把它写进
//     这一轮的提示词，编排工具就知道「这个镜头」「这段」指的是什么。
const (
	// ViewInboxEnv 是这一轮的收件目录；不在 Studio 里运行时没有它，am studio show 什么都不做。
	ViewInboxEnv = "AM_STUDIO_INBOX"
	// ViewProjectEnv 是 Studio 打开的项目根目录，am studio show 据此校验镜头与文件。
	ViewProjectEnv = "AM_STUDIO_PROJECT"
	// kindView 是会话事件里的切页请求。
	kindView = "view"
	// viewPollInterval 是一轮进行中查看收件目录的间隔。
	viewPollInterval = 300 * time.Millisecond
)

// ViewPage 是网页上能被切到的一页。
type ViewPage struct {
	ID    string
	Label string
	// Target 说明这一页要不要带对象：scene 要镜头编号，file 要项目里的相对路径。
	Target string
}

// ViewPages 与网页 Preview.tsx 的标签一一对应。
var ViewPages = []ViewPage{
	{ID: "script", Label: "口播稿"},
	{ID: "scene", Label: "镜头", Target: "scene"},
	{ID: "compose", Label: "合成", Target: "scene?"},
	{ID: "final", Label: "成片"},
	{ID: "style", Label: "风格"},
	{ID: "review", Label: "复查"},
	{ID: "publish", Label: "发布"},
	{ID: "memory", Label: "记忆"},
	{ID: "file", Label: "文件", Target: "file"},
}

func viewPage(id string) (ViewPage, bool) {
	for _, page := range ViewPages {
		if page.ID == id {
			return page, true
		}
	}
	return ViewPage{}, false
}

// ViewRequest 是一次切页请求：编排工具写，网页执行。
type ViewRequest struct {
	Page   string `json:"page"`
	Target string `json:"target,omitempty"`
	// Note 是给用户的一句话，显示在对话里，说明为什么要看这一页。
	Note string `json:"note,omitempty"`
}

// ViewState 是用户此刻在网页上看的位置，随消息发来。
type ViewState struct {
	Page  string `json:"page,omitempty"`
	Scene string `json:"scene,omitempty"`
	File  string `json:"file,omitempty"`
}

// Describe 把用户在看的位置写成一句话，附在发给编排工具的消息后面。
func (v *ViewState) Describe() string {
	if v == nil || v.Page == "" {
		return ""
	}
	page, ok := viewPage(v.Page)
	if !ok {
		return ""
	}
	where := "「" + page.Label + "」页"
	switch {
	case v.Page == "file" && v.File != "":
		where += "，文件 " + v.File
	case (v.Page == "scene" || v.Page == "compose" || v.Page == "memory") && v.Scene != "":
		where += "，镜头 " + v.Scene
	}
	return "（用户发这条消息时，Studio 网页上开着" + where + "。）"
}

// ValidateViewRequest 检查页面与对象：镜头要存在，文件要在项目里且不是 .env。
func ValidateViewRequest(project string, req ViewRequest) (ViewRequest, error) {
	page, ok := viewPage(req.Page)
	if !ok {
		var ids []string
		for _, p := range ViewPages {
			ids = append(ids, p.ID)
		}
		return req, fmt.Errorf("没有页面 %q（可选：%s）", req.Page, strings.Join(ids, "、"))
	}
	req.Target = strings.TrimSpace(req.Target)
	switch page.Target {
	case "scene", "scene?":
		if req.Target == "" {
			if page.Target == "scene" {
				return req, fmt.Errorf("%s 页要给镜头编号：am studio show %s <镜头编号>", page.Label, page.ID)
			}
			break
		}
		if project == "" {
			break
		}
		found := false
		var ids []string
		for _, sc := range discoverScenes(project) {
			found = found || sc.ID == req.Target
			ids = append(ids, sc.ID)
		}
		if !found {
			return req, fmt.Errorf("项目里没有镜头 %q（有：%s）", req.Target, strings.Join(ids, "、"))
		}
	case "file":
		if req.Target == "" {
			return req, fmt.Errorf("文件页要给项目里的相对路径：am studio show file <路径>")
		}
		if project != "" {
			path := req.Target
			if filepath.IsAbs(path) {
				rel, err := filepath.Rel(project, path)
				if err != nil {
					return req, err
				}
				path = rel
			}
			path = filepath.ToSlash(filepath.Clean(path))
			if path == ".." || strings.HasPrefix(path, "../") || filepath.Base(path) == ".env" {
				return req, fmt.Errorf("只能打开项目里的文件：%s", req.Target)
			}
			if _, err := os.Stat(filepath.Join(project, filepath.FromSlash(path))); err != nil {
				return req, fmt.Errorf("项目里没有文件 %s", path)
			}
			req.Target = path
		}
	default:
		if req.Target != "" {
			return req, fmt.Errorf("%s 页不带对象", page.Label)
		}
	}
	return req, nil
}

// WriteViewRequest 把请求放进这一轮的收件目录。不在 Studio 里（没有收件目录）时返回 false。
func WriteViewRequest(env map[string]string, req ViewRequest) (bool, error) {
	inbox := env[ViewInboxEnv]
	// 页面写错要报出来，即使不在 Studio 里：编排工具在 am run 里也会照着提示词调用。
	req, err := ValidateViewRequest(env[ViewProjectEnv], req)
	if err != nil {
		return inbox != "", err
	}
	if inbox == "" {
		return false, nil
	}
	if err := os.MkdirAll(inbox, 0o755); err != nil {
		return true, err
	}
	body, err := json.Marshal(req)
	if err != nil {
		return true, err
	}
	// 先写临时名再改名，Studio 轮询时不会读到写了一半的文件。
	name := fmt.Sprintf("%020d", time.Now().UnixNano())
	tmp := filepath.Join(inbox, "."+name+".tmp")
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return true, err
	}
	return true, os.Rename(tmp, filepath.Join(inbox, name+".json"))
}

// viewInbox 是一轮对话的收件目录，在 Studio 状态目录里（不进快照）。
func viewInbox(project, turnID string) string {
	return filepath.Join(studioRoot(project), "inbox", turnID)
}

// drainViewInbox 按写入顺序读出并删除收件目录里的请求；读不懂的直接丢掉。
func drainViewInbox(dir string) []ViewRequest {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	var out []ViewRequest
	for _, name := range names {
		path := filepath.Join(dir, name)
		body, err := os.ReadFile(path)
		_ = os.Remove(path)
		var req ViewRequest
		if err != nil || json.Unmarshal(body, &req) != nil {
			continue
		}
		if _, ok := viewPage(req.Page); ok {
			out = append(out, req)
		}
	}
	return out
}

// viewInteraction 是写进 studioInteraction 的一条：怎样把用户带到某一页。
func viewInteraction() string {
	var pages []string
	for _, page := range ViewPages {
		item := page.ID + "（" + page.Label
		switch page.Target {
		case "scene":
			item += "，后面跟镜头编号"
		case "scene?":
			item += "，可以跟镜头编号"
		case "file":
			item += "，后面跟项目里的相对路径"
		}
		pages = append(pages, item+"）")
	}
	return `- 要用户看某样东西时，运行 am studio show <页面> [对象] [--note "一句说明"]，网页会直接切到那一页，比在回复里贴大段内容或让用户自己去找好。页面：` +
		strings.Join(pages, "、") + `。例如口播稿写好、请用户审稿时运行 am studio show script --note "口播稿写好了，请看一遍"；某个镜头渲染完请用户看效果时运行 am studio show scene scene-003。不要连续切来切去，一次只把用户带到眼下最该看的那一页。
- 用户的消息后面可能附一句「用户发这条消息时，Studio 网页上开着……」，说的是用户正在看的页面；用户说「这个镜头」「这段」时指的就是那里。`
}
