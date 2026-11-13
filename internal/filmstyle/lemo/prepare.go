package lemo

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	"github.com/chouheiwa/articale-to-motion/internal/prereq"
)

// 风格库是前置资源：只由 am setup 经 PrepareLibrary 一次下全（全部风格的说明、
// demo 源码、海报、core/assets 模型，以及 three.js 风格要的 Node 依赖），其余地方只用
// RequireLibrary / RequireStyle 检查，缺了返回 prereq.MissingError，不联网。

// completeMarker 记录风格库已完整下载（am 管理的风格库才有）。
const completeMarker = "am-complete"

// fullSparse 是完整检出的稀疏规则：除图鉴与文档图片以外的全部内容。
var fullSparse = []string{"/*", "!/styleboard/", "!/docs/"}

// demoBatch 是每批检出的 demo 数。demo 合计约 73 MB，一批里断一次整批白下，
// 分批后已取回的留在本地。
const demoBatch = 10

// PrepareProgress 是 PrepareLibrary 的进度，与 filmstyle 的通用进度相同。
type PrepareProgress = filmstyle.PrepareProgress

// PrepareOptions 描述一次完整准备。
type PrepareOptions struct {
	LibraryOptions
	// Progress 非空时每进一步汇报一次。
	Progress func(PrepareProgress)
}

// LibraryComplete 表示风格库已完整可用：am 管理的看完成记录；用户自己的检出
// 看第一种风格的 demo 与海报在不在（它的 git 状态 am 不碰）。
func LibraryComplete(lib Library) bool {
	if lib.Managed {
		_, err := os.Stat(filepath.Join(lib.Dir, ".git", completeMarker))
		return err == nil
	}
	catalog := Catalog()
	if len(catalog) == 0 {
		return false
	}
	_, demoErr := os.Stat(filepath.Join(lib.Dir, "styles", catalog[0].Slug, "demo", "index.html"))
	_, posterErr := os.Stat(PosterPath(lib, catalog[0].Slug))
	return demoErr == nil && posterErr == nil
}

// RequireLibrary 返回完整可用的风格库，否则返回 prereq.MissingError。
func RequireLibrary(opts LibraryOptions) (Library, error) {
	lib, err := OpenLibrary(opts)
	if err != nil {
		return Library{}, prereq.Missing("lemo-opuscar 风格库", "没有下载到 "+LibraryDir(opts))
	}
	if !LibraryComplete(lib) {
		return Library{}, prereq.Missing("lemo-opuscar 风格库", lib.Dir+" 还没下载完整")
	}
	return lib, nil
}

// RequireStyle 检查装 style 要用的东西都在风格库里：demo 源码，以及 three.js 风格的 three。
func RequireStyle(lib Library, style Entry) error {
	if _, err := os.Stat(filepath.Join(lib.Dir, "styles", style.Slug, "demo", "index.html")); err != nil {
		return prereq.Missing("风格 "+style.Label()+" 的 demo 源码", "风格库 "+lib.Dir+" 里没有")
	}
	if style.ThreeJS {
		if _, err := os.Stat(filepath.Join(lib.Dir, "node_modules", "three", "build", "three.module.js")); err != nil {
			return prereq.Missing("风格库的 three.js 依赖", style.Label()+" 要用，风格库里还没有 node_modules/three")
		}
	}
	return nil
}

// PrepareLibrary 把风格库完整下载好（am setup 用）：先按 EnsureLibrary 的几段取基础部分，
// 再取海报、按批取 demo、取 core/assets，最后装 three.js 依赖。每段各自重试、断了重跑
// 接着下；已完整的直接返回。用户自己的检出只检查不下载。
func PrepareLibrary(ctx context.Context, opts PrepareOptions) (Library, error) {
	report := opts.Progress
	if report == nil {
		report = func(PrepareProgress) {}
	}
	if lib, err := OpenLibrary(opts.LibraryOptions); err == nil && LibraryComplete(lib) {
		return lib, nil
	}
	catalog := Catalog()
	batches := (len(catalog) + demoBatch - 1) / demoBatch
	steps := 1 + 1 + batches + 1 + 1 // 基础、海报、demo 各批、core/assets、Node 依赖
	step := 0
	next := func(stage string) {
		step++
		report(PrepareProgress{Step: step, Steps: steps, Stage: stage})
	}
	next("下载风格库基础部分（指南、core/、全部风格说明）")
	lib, err := EnsureLibrary(ctx, opts.LibraryOptions)
	if err != nil {
		return Library{}, err
	}
	if !lib.Managed {
		if !LibraryComplete(lib) {
			return Library{}, fmt.Errorf("%s 是你自己的检出，am 不改它：请在里面检出全部 demo 与海报（styles/*/demo、styles/*/poster.jpg）", lib.Dir)
		}
		return lib, nil
	}
	git, err := envutil.LookPath("git", opts.Env["PATH"])
	if err != nil {
		return Library{}, fmt.Errorf("找不到 git，无法下载风格库：%w", err)
	}
	unlock, err := lock(ctx, lib.Dir+".lock")
	if err != nil {
		return Library{}, err
	}
	defer unlock()
	patterns, err := readSparse(lib.Dir)
	if err != nil {
		return Library{}, fmt.Errorf("读取风格库稀疏规则：%w", err)
	}
	stage := func(what string, add ...string) error {
		for _, pattern := range add {
			if !contains(patterns, pattern) {
				patterns = append(patterns, pattern) // 非 cone 规则后写的生效，盖过前面的排除
			}
		}
		if err := writeSparse(lib.Dir, patterns); err != nil {
			return err
		}
		var readErr error
		for attempt := 1; attempt <= stageAttempts; attempt++ {
			if _, readErr = gitCommand(ctx, git, lib.Dir, opts.Env, opts.Output, "read-tree", "--reset", "-u", "HEAD"); readErr == nil || ctx.Err() != nil {
				break
			}
			if opts.Output != nil && attempt < stageAttempts {
				fmt.Fprintf(opts.Output, "%s失败，重试（%d/%d）…\n", what, attempt+1, stageAttempts)
			}
		}
		if readErr != nil {
			return fmt.Errorf("%s失败（再运行一次会接着下载）：%w", what, readErr)
		}
		return nil
	}
	next("下载风格海报")
	if err := stage("下载风格海报", "/styles/*/poster.jpg"); err != nil {
		return Library{}, err
	}
	for i := 0; i < len(catalog); i += demoBatch {
		end := min(i+demoBatch, len(catalog))
		next(fmt.Sprintf("下载 demo 源码（第 %d/%d 批）", i/demoBatch+1, batches))
		var add []string
		for _, style := range catalog[i:end] {
			add = append(add, "/styles/"+style.Slug+"/demo/")
		}
		if err := stage(fmt.Sprintf("下载 demo 源码（第 %d/%d 批）", i/demoBatch+1, batches), add...); err != nil {
			return Library{}, err
		}
	}
	next("下载 core/assets 模型与贴图")
	if err := stage("下载 core/assets", "/core/assets/"); err != nil {
		return Library{}, err
	}
	// 收尾时换成完整规则，之后读稀疏规则的人看到的就是最终状态。
	patterns = append([]string(nil), fullSparse...)
	if err := stage("整理风格库"); err != nil {
		return Library{}, err
	}
	next("安装 three.js 依赖（npm ci）")
	if err := SetupNode(ctx, lib, SetupOptions{Env: opts.Env, Output: opts.Output}); err != nil {
		return Library{}, err
	}
	if err := os.WriteFile(filepath.Join(lib.Dir, ".git", completeMarker), []byte(lib.Commit+"\n"), 0o644); err != nil {
		return Library{}, err
	}
	return lib, nil
}
