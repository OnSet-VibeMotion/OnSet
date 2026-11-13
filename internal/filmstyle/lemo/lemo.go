// Package lemo 是风格来源 lemo-opuscar（LemoLab 的风格库，MIT + demo CC BY 4.0）。
//
// 它实现 filmstyle.Source：风格目录随二进制下发（catalog.json），风格库本体由 am setup
// 下载到 <风格根目录>/lemo-opuscar/<commit>（PrepareLibrary），装风格时把 STYLE.md、demo
// 源码、core/ 工具与 demo 实际用到的 three.js 模块、模型写进项目（Fill），SKILL.md 说明
// lemo 的页面契约（window.render(t)）怎么换成 HyperFrames 的 hf-seek。
//
// 只接画面。风格库的配乐工具（core/audio/ 的采样乐器、拨弦建模）是 Python 写的，
// 要一套 Python 环境和约 1.4 GB 采样库，刻意没有接：配乐仍按制作流程选授权素材，
// STYLE.md 的 Sound palette 只作为配乐方向的参考。
package lemo

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	"github.com/chouheiwa/articale-to-motion/internal/prereq"
)

// SourceID 是这个来源的标识。
const SourceID = "lemo-opuscar"

// RepoURL 是风格库的上游仓库。
const RepoURL = "https://github.com/lemomo-ai/lemo-opuscar.git"

// Gallery 是上游图鉴，每种风格都有 demo 片可看。
const Gallery = "https://lemomo-ai.github.io/lemo-opuscar/"

// PinnedCommit 是 am 安装的风格库版本。
//
// 固定 commit 而不跟随 main：STYLE.md 与 demo 引擎的变化会直接改变成片画面，
// 跟随 main 的话同一个项目两次安装可能拿到不同的风格。升级时更新这里、
// 用新 commit 的检出重跑 `go run ./internal/filmstyle/lemo/gen -src <检出>`，
// 并对比新旧 core/lib.js 与页面契约（core/README.md「The page contract」）。
const PinnedCommit = "bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00"

// PinnedStyleCount 是该 commit 上的风格数（不含 _template）。
const PinnedStyleCount = 66

// LibraryEnv 指定风格库目录，覆盖默认位置。指向一份已有检出时直接使用；
// 那是用户自己的检出，am 不改它的 git 状态。
const LibraryEnv = "AM_LEMO_OPUSCAR_LIBRARY"

// Entry 是 catalog.json 里的一项，字段取自上游 styles/<slug>/style.json。
type Entry struct {
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

// Label 是一行中文说明。
func (e Entry) Label() string { return fmt.Sprintf("%s %s（%s/%s）", e.CN, e.EN, SourceID, e.Slug) }

// Style 转成通用的风格条目。
func (e Entry) Style() filmstyle.Style {
	style := filmstyle.Style{Source: SourceID, Slug: e.Slug, Order: e.Num, CN: e.CN, EN: e.EN,
		CategoryCN: e.CategoryCN, CategoryEN: e.CategoryEN, Uses: e.Uses, Summary: "demo：" + e.LineCN}
	if e.ThreeJS {
		style.Tags = []string{"three.js"}
	}
	return style
}

//go:embed catalog.json
var catalogJSON []byte

var catalog []Entry

func init() {
	if err := json.Unmarshal(catalogJSON, &catalog); err != nil {
		panic(fmt.Sprintf("lemo: catalog.json 损坏：%v", err))
	}
	filmstyle.Register(source{})
}

// Catalog 返回固定 commit 上的全部风格，按上游编号排序。返回副本。
func Catalog() []Entry { return append([]Entry(nil), catalog...) }

// Find 按目录名找条目。
func Find(slug string) (Entry, bool) {
	for _, entry := range catalog {
		if entry.Slug == slug {
			return entry, true
		}
	}
	return Entry{}, false
}

// source 实现 filmstyle.Source。
type source struct{}

func (source) ID() string { return SourceID }
func (source) Name() string {
	return fmt.Sprintf("lemo-opuscar 风格库（LemoLab，%d 种）", PinnedStyleCount)
}
func (source) Gallery() string { return Gallery }
func (source) EnvKeys() []string {
	return []string{LibraryEnv}
}

func (source) Catalog() []filmstyle.Style {
	out := make([]filmstyle.Style, len(catalog))
	for i, entry := range catalog {
		out[i] = entry.Style()
	}
	return out
}

func (source) Location(env map[string]string) string { return LibraryDir(LibraryOptions{Env: env}) }

func (source) Check(env map[string]string) error {
	_, err := RequireLibrary(LibraryOptions{Env: env})
	return err
}

func (source) Prepare(ctx context.Context, opts filmstyle.PrepareOptions) error {
	_, err := PrepareLibrary(ctx, PrepareOptions{LibraryOptions: LibraryOptions{Env: opts.Env, Output: opts.Output}, Progress: opts.Progress})
	return err
}

func (source) Poster(env map[string]string, slug string) (string, error) {
	lib, err := OpenLibrary(LibraryOptions{Env: env})
	if err != nil {
		return "", err
	}
	path := PosterPath(lib, slug)
	if _, err := os.Stat(path); err != nil {
		return "", prereq.Missing("风格海报", path+" 不存在")
	}
	return path, nil
}

func (source) Fill(dir string, style filmstyle.Style, env map[string]string) (string, error) {
	entry, ok := Find(style.Slug)
	if !ok {
		return "", fmt.Errorf("lemo-opuscar 风格库里没有 %q", style.Slug)
	}
	lib, err := RequireLibrary(LibraryOptions{Env: env})
	if err != nil {
		return "", err
	}
	if err := RequireStyle(lib, entry); err != nil {
		return "", err
	}
	if err := fill(dir, entry, lib); err != nil {
		return "", err
	}
	commit := lib.Commit
	if commit == "" {
		commit = "unknown"
	}
	return commit, nil
}
