package lemo

import (
	"bytes"
	_ "embed"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"text/template"

	"github.com/chouheiwa/articale-to-motion/internal/prereq"
)

// fill 把 entry 这种风格写进 dir（空的临时目录）：STYLE.md、demo 源码、core/ 工具、
// demo 实际用到的 three.js 模块与模型，以及生成的 SKILL.md 与 ATTRIBUTION.md。
// 通用部分（来源记录、换位、新旧目录）由 filmstyle.Install 负责。
func fill(dir string, entry Entry, lib Library) error {
	source := filepath.Join(lib.Dir, "styles", entry.Slug)
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
				return fmt.Errorf("风格库缺少 %s", item.from)
			}
			continue // DEMO.md、海报、demo 等在个别风格上可能没有
		}
		if err := place(item.from, filepath.Join(dir, filepath.FromSlash(item.to))); err != nil {
			return err
		}
	}
	// 下面两类按 demo 实际引用挑文件，不整棵带：three 的 examples/jsm 有 14 MB，
	// core/assets 有 12 MB 模型，一种风格只用其中几个文件。
	sources, err := sourceTexts(dir)
	if err != nil {
		return err
	}
	if DemoUsesCoreAssets(filepath.Join(source, "demo")) {
		assets := filepath.Join(lib.Dir, "core", "assets")
		if _, statErr := os.Stat(assets); statErr != nil {
			return prereq.Missing("风格库的 core/assets", entry.Label()+" 的 demo 要用")
		}
		picked, err := referencedAssets(assets, sources)
		if err != nil {
			return err
		}
		for _, rel := range picked {
			if err := place(filepath.Join(assets, filepath.FromSlash(rel)), filepath.Join(dir, "core", "assets", filepath.FromSlash(rel))); err != nil {
				return err
			}
		}
	}
	if entry.ThreeJS {
		three := filepath.Join(lib.Dir, "node_modules", "three")
		if _, statErr := os.Stat(filepath.Join(three, "build", "three.module.js")); statErr != nil {
			return prereq.Missing("风格库的 three.js 依赖", entry.Label()+" 要用")
		}
		picked, err := threeClosure(three, sources)
		if err != nil {
			return err
		}
		for _, rel := range append([]string{"LICENSE", "package.json"}, picked...) {
			from := filepath.Join(three, filepath.FromSlash(rel))
			if _, statErr := os.Stat(from); statErr != nil {
				continue
			}
			if err := place(from, filepath.Join(dir, "node_modules", "three", filepath.FromSlash(rel))); err != nil {
				return err
			}
		}
	}
	commit := lib.Commit
	if commit == "" {
		commit = "unknown"
	}
	return renderSkill(dir, entry, commit)
}

// skipInDemo 是 demo 里不带进项目的东西：审片截图、渲染产物与本地依赖。
// 它们不是技法，带进来只会让技能目录变大、让输入指纹随无关文件变化。
var skipInDemo = map[string]bool{"stills": true, "out": true, "chk": true, "node_modules": true}

var skipExtensions = map[string]bool{".mp4": true, ".wav": true, ".mp3": true, ".npy": true, ".log": true}

// copyPath 把文件或目录放进项目：link 为 true 时先试硬链接，跨磁盘等失败时退回复制。
//
// 不设只读。试过：渲染器用 cp 把引擎拷进镜头目录时副本继承了只读，它要改副本就得
// chmod，而安全模式不放行 chmod（实测一次渲染在这上面绕了好几轮）。硬链接被就地
// 改写的风险由 SKILL.md 的「不要改本目录的文件」与项目里只有 am 写这个目录来兜。
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
				// 0644 而不是保留原权限：早先的版本把这些文件设过只读，硬链接共用
				// 同一个 inode，这里顺手改回来。
				return os.Chmod(target, 0o644)
			}
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, body, 0o644)
	})
}

//go:embed skill.md.tmpl
var skillTemplate string

//go:embed attribution.md.tmpl
var attributionTemplate string

type skillData struct {
	Style  Entry
	Commit string
	Short  string
	Repo   string
}

func renderSkill(dir string, style Entry, commit string) error {
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
