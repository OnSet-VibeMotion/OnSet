package filmstyle

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/template"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
)

// SkillsSubdir 是技能在项目里的落点，与 hyperframes.SkillsSubdir 一致。
const SkillsSubdir = ".agents/skills"

// Manifest 是 lemo-upstream.json：这个项目装的是哪一份风格。
type Manifest struct {
	Repo   string `json:"repo"`
	Commit string `json:"commit"`
	Slug   string `json:"slug"`
	CN     string `json:"cn"`
	EN     string `json:"en"`
	// Digest 是技能目录里除本文件外全部文件的内容摘要，用来判断重装是否有变化。
	Digest      string `json:"digest"`
	InstalledAt string `json:"installed_at"`
}

// InstallOptions 描述一次整片风格安装。
type InstallOptions struct {
	ProjectDir string
	Style      Style
	Library    Library
	// Replace 为 true 时允许把已装的另一种风格换掉。换风格会让所有镜头的输入
	// 指纹变化，所以默认拒绝。
	Replace bool
	// Now 用于测试；零值取当前时间。
	Now time.Time
}

// SkillDir 返回项目里整片风格技能目录的路径。
func SkillDir(projectDir string) string {
	return filepath.Join(projectDir, filepath.FromSlash(SkillsSubdir), SkillName)
}

// Installed 读取项目里已装的整片风格；没有时 ok 为 false。
func Installed(projectDir string) (Manifest, bool, error) {
	body, err := os.ReadFile(filepath.Join(SkillDir(projectDir), SkillManifest))
	if errors.Is(err, os.ErrNotExist) {
		return Manifest{}, false, nil
	}
	if err != nil {
		return Manifest{}, false, err
	}
	var manifest Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return Manifest{}, false, fmt.Errorf("%s 损坏：%w", SkillManifest, err)
	}
	return manifest, true, nil
}

// InstallResult 汇报安装结果。
type InstallResult struct {
	Manifest Manifest
	// Unchanged 表示项目里已是同一份内容，没有改动任何文件。
	Unchanged bool
	// Replaced 是被换掉的风格目录名，没有换时为空。
	Replaced string
}

// Install 把 opts.Style 装进项目的 .agents/skills/lemo-film-style/。
//
// 先在同级临时目录拼好整棵技能树再整体换位：中途失败时项目里要么是旧风格、
// 要么是新风格，不会半新半旧。风格库里需要的 demo 源码由调用方先 EnsureDemo。
func Install(opts InstallOptions) (InstallResult, error) {
	style, lib := opts.Style, opts.Library
	source := filepath.Join(lib.Dir, "styles", style.Slug)
	if _, err := os.Stat(filepath.Join(source, "STYLE.md")); err != nil {
		return InstallResult{}, fmt.Errorf("风格库 %s 里没有 %s/STYLE.md", lib.Dir, style.Slug)
	}
	previous, had, err := Installed(opts.ProjectDir)
	if err != nil {
		return InstallResult{}, err
	}
	if had && previous.Slug != style.Slug && !opts.Replace {
		return InstallResult{}, fmt.Errorf(
			"项目已使用整片风格 %s %s（%s）。换成 %s 会让全部镜头需要重渲染；确认要换就加 --replace",
			previous.CN, previous.EN, previous.Slug, style.Label())
	}
	parent := filepath.Dir(SkillDir(opts.ProjectDir))
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return InstallResult{}, err
	}
	staging, err := os.MkdirTemp(parent, "."+SkillName+"-")
	if err != nil {
		return InstallResult{}, err
	}
	defer os.RemoveAll(staging)

	// am 管理的风格库里的文件内容固定（钉在 commit 上），硬链接进项目即可，不占第二份
	// 磁盘；用户自己的检出照旧复制，不去改它文件的权限。
	place := func(from, to string) error { return copyPath(from, to, lib.Managed) }
	copies := []struct{ from, to string }{
		{filepath.Join(source, "STYLE.md"), "STYLE.md"},
		{filepath.Join(source, "style.json"), "style.json"},
		{filepath.Join(source, "DEMO.md"), "DEMO.md"},
		{filepath.Join(source, "poster.jpg"), "poster.jpg"},
		{filepath.Join(lib.Dir, "LICENSE"), "LICENSE"},
		{filepath.Join(source, "demo"), "demo"},
		{filepath.Join(lib.Dir, "core", "lib.js"), "core/lib.js"},
		{filepath.Join(lib.Dir, "core", "three"), "core/three"},
		{filepath.Join(lib.Dir, "core", "post"), "core/post"},
		{filepath.Join(lib.Dir, "core", "fonts"), "core/fonts"},
	}
	for _, item := range copies {
		if _, statErr := os.Stat(item.from); errors.Is(statErr, os.ErrNotExist) {
			if item.to == "STYLE.md" || item.to == "core/lib.js" {
				return InstallResult{}, fmt.Errorf("风格库缺少 %s", item.from)
			}
			continue // DEMO.md、海报、demo 等在个别风格上可能没有
		}
		if err := place(item.from, filepath.Join(staging, filepath.FromSlash(item.to))); err != nil {
			return InstallResult{}, err
		}
	}
	// 下面两类按 demo 实际引用挑文件，不整棵带：three 的 examples/jsm 有 14 MB，
	// core/assets 有 12 MB 模型，一种风格只用其中几个文件。
	sources, err := sourceTexts(staging)
	if err != nil {
		return InstallResult{}, err
	}
	if DemoUsesCoreAssets(filepath.Join(source, "demo")) {
		assets := filepath.Join(lib.Dir, "core", "assets")
		if _, statErr := os.Stat(assets); statErr != nil {
			return InstallResult{}, fmt.Errorf("%s 的 demo 要用风格库的 core/assets/，风格库里还没有：重新运行 am film-style use", style.Label())
		}
		picked, err := referencedAssets(assets, sources)
		if err != nil {
			return InstallResult{}, err
		}
		for _, rel := range picked {
			if err := place(filepath.Join(assets, filepath.FromSlash(rel)), filepath.Join(staging, "core", "assets", filepath.FromSlash(rel))); err != nil {
				return InstallResult{}, err
			}
		}
	}
	if style.ThreeJS {
		three := filepath.Join(lib.Dir, "node_modules", "three")
		if _, statErr := os.Stat(filepath.Join(three, "build", "three.module.js")); statErr != nil {
			return InstallResult{}, fmt.Errorf("%s 用 three.js，风格库里还没有装 Node 依赖（node_modules/three）：重新运行 am film-style use，它会在风格库里执行 npm ci", style.Label())
		}
		picked, err := threeClosure(three, sources)
		if err != nil {
			return InstallResult{}, err
		}
		for _, rel := range append([]string{"LICENSE", "package.json"}, picked...) {
			from := filepath.Join(three, filepath.FromSlash(rel))
			if _, statErr := os.Stat(from); statErr != nil {
				continue
			}
			if err := place(from, filepath.Join(staging, "node_modules", "three", filepath.FromSlash(rel))); err != nil {
				return InstallResult{}, err
			}
		}
	}
	commit := lib.Commit
	if commit == "" {
		commit = "unknown"
	}
	if err := renderSkill(staging, style, commit); err != nil {
		return InstallResult{}, err
	}
	digest, err := treeDigest(staging)
	if err != nil {
		return InstallResult{}, err
	}
	if had && previous.Slug == style.Slug && previous.Digest == digest && previous.Commit == commit {
		return InstallResult{Manifest: previous, Unchanged: true}, nil
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	manifest := Manifest{
		Repo: strings.TrimSuffix(RepoURL, ".git"), Commit: commit, Slug: style.Slug,
		CN: style.CN, EN: style.EN, Digest: digest, InstalledAt: now.UTC().Format(time.RFC3339),
	}
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return InstallResult{}, err
	}
	if err := fsutil.AtomicWrite(filepath.Join(staging, SkillManifest), append(body, '\n'), 0o644); err != nil {
		return InstallResult{}, err
	}
	target := SkillDir(opts.ProjectDir)
	backup := ""
	if _, statErr := os.Stat(target); statErr == nil {
		backup = staging + ".old"
		if err := os.Rename(target, backup); err != nil {
			return InstallResult{}, fmt.Errorf("移开旧的整片风格：%w", err)
		}
	}
	if err := os.Rename(staging, target); err != nil {
		if backup != "" {
			_ = os.Rename(backup, target)
		}
		return InstallResult{}, fmt.Errorf("放置整片风格：%w", err)
	}
	if backup != "" {
		os.RemoveAll(backup)
	}
	result := InstallResult{Manifest: manifest}
	if had && previous.Slug != style.Slug {
		result.Replaced = previous.Slug
	}
	return result, nil
}

// Remove 删除项目里的整片风格，回到镜头自主定视觉。
func Remove(projectDir string) (Manifest, bool, error) {
	manifest, had, err := Installed(projectDir)
	if err != nil || !had {
		return manifest, had, err
	}
	return manifest, true, os.RemoveAll(SkillDir(projectDir))
}

// skipInDemo 是 demo 里不带进项目的东西：审片截图、渲染产物与本地依赖。
// 它们不是技法，带进来只会让技能目录变大、让输入指纹随无关文件变化。
var skipInDemo = map[string]bool{"stills": true, "out": true, "chk": true, "node_modules": true}

var skipExtensions = map[string]bool{".mp4": true, ".wav": true, ".mp3": true, ".npy": true, ".log": true}

// copyPath 把文件或目录放进项目：link 为 true 时先试硬链接，跨磁盘等失败时退回复制。
// 放进来的文件一律只读：硬链接与风格库共用同一份内容，在项目里改它就是改了所有
// 项目共用的风格库；复制来的也设只读，与硬链接的行为一致，免得「有的能改有的不能」。
//
// 符号链接一律拒绝：指向风格库的链接搬进项目后，项目换一台机器就成了静默失效的空文件。
// 硬链接没有这个问题——它就是文件本身，项目整体拷走时拷的是真实内容。
func copyPath(from, to string, link bool) error {
	return filepath.WalkDir(from, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(from, path)
		if err != nil {
			return err
		}
		name := entry.Name()
		if entry.IsDir() {
			if rel != "." && (skipInDemo[name] || strings.HasPrefix(name, "out_") || name == "__pycache__") {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(to, rel), 0o755)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("风格库里有符号链接，无法安全搬进项目：%s", path)
		}
		if !entry.Type().IsRegular() || name == ".DS_Store" || skipExtensions[strings.ToLower(filepath.Ext(name))] {
			return nil
		}
		target := filepath.Join(to, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if link {
			if err := os.Link(path, target); err == nil {
				return os.Chmod(target, 0o444)
			}
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, body, 0o644); err != nil {
			return err
		}
		return os.Chmod(target, 0o444)
	})
}

// treeDigest 是目录下全部文件（按相对路径排序）的内容摘要。
func treeDigest(root string) (string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() && entry.Name() != SkillManifest {
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				return relErr
			}
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	hash := sha256.New()
	for _, rel := range files {
		body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return "", err
		}
		sum := sha256.Sum256(body)
		fmt.Fprintf(hash, "%s %x\n", rel, sum)
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

//go:embed skill.md.tmpl
var skillTemplate string

//go:embed attribution.md.tmpl
var attributionTemplate string

type skillData struct {
	Style  Style
	Commit string
	Short  string
	Repo   string
}

func renderSkill(dir string, style Style, commit string) error {
	short := commit
	if len(short) > 12 {
		short = short[:12]
	}
	data := skillData{Style: style, Commit: commit, Short: short, Repo: strings.TrimSuffix(RepoURL, ".git")}
	for name, text := range map[string]string{"SKILL.md": skillTemplate, "ATTRIBUTION.md": attributionTemplate} {
		tmpl, err := template.New(name).Option("missingkey=error").Parse(text)
		if err != nil {
			return fmt.Errorf("解析 %s 模板：%w", name, err)
		}
		var out bytes.Buffer
		if err := tmpl.Execute(&out, data); err != nil {
			return fmt.Errorf("生成 %s：%w", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), out.Bytes(), 0o644); err != nil {
			return err
		}
	}
	return nil
}

// EnsureForProject 是 am init / am film-style use 的完整流程：准备风格库、补 demo、
// 用到 three.js 时装 Node 依赖，再装进项目。
func EnsureForProject(ctx context.Context, projectDir string, style Style, replace bool, opts LibraryOptions) (InstallResult, error) {
	lib, err := EnsureLibrary(ctx, opts)
	if err != nil {
		return InstallResult{}, err
	}
	if err := EnsureDemo(ctx, lib, style.Slug, opts); err != nil {
		return InstallResult{}, err
	}
	if style.ThreeJS {
		if err := SetupNode(ctx, lib, SetupOptions{Env: opts.Env, Output: opts.Output}); err != nil {
			return InstallResult{}, err
		}
	}
	return Install(InstallOptions{ProjectDir: projectDir, Style: style, Library: lib, Replace: replace})
}
