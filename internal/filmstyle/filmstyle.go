// Package filmstyle 把 lemo-opuscar 风格库里的一种风格装进用户项目，作为整片风格。
//
// am 自身不锁定视觉风格（见制作提示词「视觉方向」）。整片风格是可选项：用户或
// 编排工具从风格库里挑一种，am 按固定 commit 把它装成项目里的一个技能
// （.agents/skills/lemo-film-style/），镜头提示词据此把「视觉自由度」换成
// 「遵守整片风格」。故事、分镜、配音仍走 am 自己的流程，风格库只提供画面的
// 不变量（STYLE.md）与可借用的技法（demo 源码、core/ 工具）。
//
// 风格库本体（指南、core/、全部风格的 STYLE.md，以及按需补的 demo 源码与 three.js）
// 放在用户级目录，所有项目共用一份，按 commit 分目录。项目里只放选中那一种风格
// 要用的文件，项目自包含、可以整体拷走。
//
// 只接画面。风格库的配乐工具（core/audio/ 的采样乐器、拨弦建模）是 Python 写的，
// 要一套 Python 环境和约 1.4 GB 采样库，刻意没有接：配乐仍按制作流程选授权素材，
// STYLE.md 的 Sound palette 只作为配乐方向的参考。
package filmstyle

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// RepoURL 是风格库的上游仓库。
const RepoURL = "https://github.com/lemomo-ai/lemo-opuscar.git"

// PinnedCommit 是 am 安装的风格库版本。
//
// 固定 commit 而不跟随 main：STYLE.md 与 demo 引擎的变化会直接改变成片画面，
// 跟随 main 的话同一个项目两次安装可能拿到不同的风格。升级时更新这里、
// 用新 commit 的检出重跑 `go run ./internal/filmstyle/gen -src <检出>`，
// 并对比新旧 core/lib.js 与页面契约（core/README.md「The page contract」）。
const PinnedCommit = "bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00"

// PinnedStyleCount 是该 commit 上的风格数（不含 _template）。
const PinnedStyleCount = 66

// SkillName 是整片风格在项目 .agents/skills/ 下的目录名。
//
// 不叫 film-style 这类通用名：技能解析会从镜头目录逐级向上找 .agents/skills，
// 名字太通用容易撞上用户自己装的别的技能。
const SkillName = "lemo-film-style"

// SkillManifest 是整片风格技能目录里的来源记录。
const SkillManifest = "lemo-upstream.json"

// LibraryEnv 指定风格库目录，覆盖默认的用户级目录。指向一份已有检出时直接使用，
// 不联网；commit 与 PinnedCommit 不符时照样可用，但来源记录会如实写下。
const LibraryEnv = "AM_FILM_STYLE_LIBRARY"

// Style 是风格目录里的一项，字段取自上游 styles/<slug>/style.json。
type Style struct {
	Slug        string   `json:"slug"`
	Num         string   `json:"num"`
	EN          string   `json:"en"`
	CN          string   `json:"cn"`
	CategoryEN  string   `json:"category_en"`
	CategoryCN  string   `json:"category_cn"`
	Film        string   `json:"film"`
	Line        string   `json:"line"`
	LineCN      string   `json:"line_cn"`
	Uses        []string `json:"uses"`
	DemoSeconds float64  `json:"demo_seconds"`
	// ThreeJS 表示 demo 用 three.js：安装时要把 three 一起带进技能目录。
	ThreeJS bool `json:"three_js"`
}

// Label 是一行中文说明：中文名、英文名与目录名。
func (s Style) Label() string {
	return fmt.Sprintf("%s %s（%s）", s.CN, s.EN, s.Slug)
}

//go:embed catalog.json
var catalogJSON []byte

var catalog []Style

func init() {
	if err := json.Unmarshal(catalogJSON, &catalog); err != nil {
		panic(fmt.Sprintf("filmstyle: catalog.json 损坏：%v", err))
	}
}

// Catalog 返回固定 commit 上的全部风格，按上游编号排序。返回副本。
func Catalog() []Style {
	return append([]Style(nil), catalog...)
}

// Categories 按首次出现的顺序返回风格分类（中文名）。
func Categories() []string {
	var out []string
	seen := map[string]bool{}
	for _, style := range catalog {
		if !seen[style.CategoryCN] {
			seen[style.CategoryCN] = true
			out = append(out, style.CategoryCN)
		}
	}
	return out
}

// Find 按目录名、中文名或英文名（不区分大小写）查找风格。
func Find(name string) (Style, bool) {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" {
		return Style{}, false
	}
	for _, style := range catalog {
		if strings.ToLower(style.Slug) == key || strings.ToLower(style.EN) == key || style.CN == strings.TrimSpace(name) {
			return style, true
		}
	}
	return Style{}, false
}

// Suggest 返回名字里含 name 的风格，供找不到时提示。
func Suggest(name string) []Style {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" {
		return nil
	}
	var out []Style
	for _, style := range catalog {
		if strings.Contains(strings.ToLower(style.Slug), key) || strings.Contains(strings.ToLower(style.EN), key) || strings.Contains(style.CN, strings.TrimSpace(name)) {
			out = append(out, style)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Num < out[j].Num })
	if len(out) > 5 {
		out = out[:5]
	}
	return out
}

// Lookup 与 Find 相同，找不到时返回带候选的错误。
func Lookup(name string) (Style, error) {
	if style, ok := Find(name); ok {
		return style, nil
	}
	message := fmt.Sprintf("风格库里没有 %q", name)
	if candidates := Suggest(name); len(candidates) > 0 {
		labels := make([]string, len(candidates))
		for i, style := range candidates {
			labels[i] = style.Label()
		}
		message += "，相近的有：" + strings.Join(labels, "、")
	}
	return Style{}, fmt.Errorf("%s。用 am film-style list 查看全部风格", message)
}
