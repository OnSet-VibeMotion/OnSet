// gen 从固定 commit 的 lemo-opuscar 检出生成 internal/filmstyle/lemo/catalog.json。
//
//	go run ./internal/filmstyle/lemo/gen -src <lemo-opuscar 检出目录>
//
// 检出的 HEAD 必须等于 lemo.PinnedCommit：目录清单与 commit 不一致的话，
// am film-style list 列出的风格与 am film-style use 实际装到的会对不上。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle/lemo"
	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
)

type rawStyle struct {
	Slug       string   `json:"slug"`
	Num        string   `json:"num"`
	EN         string   `json:"en"`
	CN         string   `json:"cn"`
	CategoryEN string   `json:"category_en"`
	CategoryCN string   `json:"category_cn"`
	Film       string   `json:"film"`
	Line       string   `json:"line"`
	LineCN     string   `json:"line_cn"`
	Uses       []string `json:"uses"`
	Duration   float64  `json:"dur"`
}

func main() {
	src := flag.String("src", "", "lemo-opuscar 检出目录")
	out := flag.String("out", filepath.Join("internal", "filmstyle", "lemo", "catalog.json"), "输出文件")
	flag.Parse()
	if err := run(*src, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(src, out string) error {
	if src == "" {
		return fmt.Errorf("必须用 -src 指定 lemo-opuscar 检出目录")
	}
	head, err := exec.Command("git", "-C", src, "rev-parse", "HEAD").Output()
	if err != nil {
		return fmt.Errorf("读取 %s 的 HEAD：%w", src, err)
	}
	if got := strings.TrimSpace(string(head)); got != lemo.PinnedCommit {
		return fmt.Errorf("%s 的 HEAD 是 %s，与 lemo.PinnedCommit %s 不符", src, got, lemo.PinnedCommit)
	}
	matches, err := filepath.Glob(filepath.Join(src, "styles", "*", "style.json"))
	if err != nil {
		return err
	}
	var catalog []lemo.Entry
	for _, path := range matches {
		slug := filepath.Base(filepath.Dir(path))
		if strings.HasPrefix(slug, "_") {
			continue // _template 是上游加新风格用的样板
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var raw rawStyle
		if err := json.Unmarshal(body, &raw); err != nil {
			return fmt.Errorf("%s：%w", path, err)
		}
		if raw.Slug != slug {
			return fmt.Errorf("%s 的 slug 是 %q，与目录名不符", path, raw.Slug)
		}
		if _, err := os.Stat(filepath.Join(src, "styles", slug, "STYLE.md")); err != nil {
			return fmt.Errorf("风格 %s 缺少 STYLE.md", slug)
		}
		catalog = append(catalog, lemo.Entry{
			Slug: raw.Slug, Num: raw.Num, EN: raw.EN, CN: raw.CN,
			CategoryEN: raw.CategoryEN, CategoryCN: raw.CategoryCN,
			Film: raw.Film, Line: raw.Line, LineCN: raw.LineCN, Uses: raw.Uses,
			DemoSeconds: raw.Duration, ThreeJS: usesThree(filepath.Join(src, "styles", slug, "demo")),
		})
	}
	sort.Slice(catalog, func(i, j int) bool {
		if catalog[i].Num != catalog[j].Num {
			return catalog[i].Num < catalog[j].Num
		}
		return catalog[i].Slug < catalog[j].Slug
	})
	body, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		return err
	}
	if err := fsutil.AtomicWrite(out, append(body, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("写出 %s：%d 种风格\n", out, len(catalog))
	return nil
}

// usesThree 判断 demo 是否通过 importmap 引用 three.js。用到的风格安装时要把
// three 一起带进技能目录，渲染器才能把它拷进镜头目录。
func usesThree(demo string) bool {
	found := false
	_ = filepath.WalkDir(demo, func(path string, entry os.DirEntry, err error) error {
		if err != nil || found || entry.IsDir() || filepath.Ext(path) != ".html" {
			return nil
		}
		if body, readErr := os.ReadFile(path); readErr == nil && strings.Contains(string(body), "node_modules/three") {
			found = true
		}
		return nil
	})
	return found
}
