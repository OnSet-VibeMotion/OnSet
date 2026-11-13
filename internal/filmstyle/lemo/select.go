package lemo

import (
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// sourceTexts 读出技能目录里 demo/ 与 core/ 下的脚本和页面（相对路径 → 内容），
// 作为挑 three.js 模块与 core/assets 文件的依据。
func sourceTexts(skillDir string) (map[string]string, error) {
	out := map[string]string{}
	for _, sub := range []string{"demo", "core"} {
		root := filepath.Join(skillDir, sub)
		if _, err := os.Stat(root); err != nil {
			continue
		}
		err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				if entry.Name() == "node_modules" || entry.Name() == "assets" && filepath.Dir(file) == filepath.Join(skillDir, "core") {
					return filepath.SkipDir
				}
				return nil
			}
			switch strings.ToLower(filepath.Ext(file)) {
			case ".js", ".mjs", ".html", ".json":
			default:
				return nil
			}
			body, err := os.ReadFile(file)
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(skillDir, file)
			if err != nil {
				return err
			}
			out[filepath.ToSlash(rel)] = string(body)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// specifierPattern 匹配 ES 模块的导入说明符：import … from '…'、export … from '…'、
// import '…' 与 import('…')。
var specifierPattern = regexp.MustCompile(`(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]`)

// threeClosure 返回 sources 用到的 three.js 文件（相对 three 包根），连同它们
// 自己相对引用的文件。说明符按 demo 的 importmap 解析：`three` → build/three.module.js，
// `three/addons/…` 与 `three/examples/jsm/…` → examples/jsm/…，`/node_modules/three/…`
// 原样取包内路径。至少带上 build/three.module.js。
func threeClosure(threeRoot string, sources map[string]string) ([]string, error) {
	picked := map[string]bool{}
	var queue []string
	add := func(rel string) {
		rel = path.Clean(rel)
		if rel == "." || strings.HasPrefix(rel, "../") || picked[rel] {
			return
		}
		if info, err := os.Stat(filepath.Join(threeRoot, filepath.FromSlash(rel))); err != nil || !info.Mode().IsRegular() {
			return
		}
		picked[rel] = true
		queue = append(queue, rel)
	}
	resolve := func(spec, from string) {
		switch {
		case spec == "three":
			add("build/three.module.js")
		case spec == "three/webgpu":
			add("build/three.webgpu.js")
		case strings.HasPrefix(spec, "three/addons/"):
			add("examples/jsm/" + strings.TrimPrefix(spec, "three/addons/"))
		case strings.HasPrefix(spec, "three/examples/jsm/"):
			add(strings.TrimPrefix(spec, "three/"))
		case strings.HasPrefix(spec, "/node_modules/three/"):
			add(strings.TrimPrefix(spec, "/node_modules/three/"))
		case from != "" && (strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../")):
			add(path.Join(path.Dir(from), spec))
		}
	}
	add("build/three.module.js")
	for _, text := range sources {
		for _, match := range specifierPattern.FindAllStringSubmatch(text, -1) {
			resolve(match[1], "")
		}
	}
	for len(queue) > 0 {
		rel := queue[0]
		queue = queue[1:]
		body, err := os.ReadFile(filepath.Join(threeRoot, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		for _, match := range specifierPattern.FindAllStringSubmatch(string(body), -1) {
			resolve(match[1], rel)
		}
	}
	out := make([]string, 0, len(picked))
	for rel := range picked {
		out = append(out, rel)
	}
	sort.Strings(out)
	return out, nil
}

// referencedAssets 返回 sources 引用到的 core/assets 文件（相对 assets 根）。
//
// 不能只认完整路径：demo 常把目录前缀放进变量再拼文件名（`PH + 'tea_set_01/…'`）。
// 所以按名字认：一个模型目录（assets 下第二层的目录，如 polyhaven/tea_set_01）的
// 目录名出现在源码里就整个带上；其余文件的文件名或去掉扩展名的名字出现就带上。
// 各来源目录的 SOURCES.md（许可与出处）总是带上。
func referencedAssets(assetsRoot string, sources map[string]string) ([]string, error) {
	var corpus strings.Builder
	for _, text := range sources {
		corpus.WriteString(text)
		corpus.WriteByte('\n')
	}
	text := corpus.String()
	var out []string
	err := filepath.WalkDir(assetsRoot, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(assetsRoot, file)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if entry.IsDir() {
			if rel == "." {
				return nil
			}
			if strings.Count(rel, "/") == 1 && strings.Contains(text, entry.Name()) {
				return addTree(file, rel, &out)
			}
			return nil
		}
		name := entry.Name()
		stem := strings.TrimSuffix(name, filepath.Ext(name))
		if name == "SOURCES.md" || strings.Contains(text, name) || (len(stem) >= 4 && strings.Contains(text, stem)) {
			if entry.Type().IsRegular() {
				out = append(out, rel)
			}
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}

// addTree 把目录下全部普通文件加进 out，并让 WalkDir 跳过它。
func addTree(dir, rel string, out *[]string) error {
	err := filepath.WalkDir(dir, func(file string, entry fs.DirEntry, err error) error {
		if err != nil || !entry.Type().IsRegular() || entry.Name() == ".DS_Store" {
			return err
		}
		sub, err := filepath.Rel(dir, file)
		if err != nil {
			return err
		}
		*out = append(*out, rel+"/"+filepath.ToSlash(sub))
		return nil
	})
	if err != nil {
		return err
	}
	return filepath.SkipDir
}
