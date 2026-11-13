package filmstyle

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 目录清单是从固定 commit 生成的；条数对不上说明升级时只改了 PinnedCommit 没重跑生成器。
func TestCatalogMatchesPinnedCommit(t *testing.T) {
	catalog := Catalog()
	if len(catalog) != PinnedStyleCount {
		t.Fatalf("catalog.json 有 %d 种风格，PinnedStyleCount 是 %d：用新 commit 的检出重跑 go run ./internal/filmstyle/gen", len(catalog), PinnedStyleCount)
	}
	seen := map[string]bool{}
	for _, style := range catalog {
		if style.Slug == "" || style.CN == "" || style.EN == "" || style.CategoryCN == "" {
			t.Errorf("风格条目缺字段：%+v", style)
		}
		if strings.HasPrefix(style.Slug, "_") {
			t.Errorf("上游样板 %s 混进了目录", style.Slug)
		}
		if seen[style.Slug] {
			t.Errorf("目录名重复：%s", style.Slug)
		}
		seen[style.Slug] = true
	}
	if len(Categories()) < 2 {
		t.Errorf("分类太少：%v", Categories())
	}
}

func TestFindAcceptsSlugChineseAndEnglishNames(t *testing.T) {
	for _, name := range []string{"impasto", "油画厚涂", "impasto oil painting", " Impasto "} {
		style, ok := Find(name)
		if !ok || style.Slug != "impasto" {
			t.Errorf("Find(%q) = %+v, %v", name, style, ok)
		}
	}
	if _, err := Lookup("油画"); err == nil || !strings.Contains(err.Error(), "impasto") {
		t.Errorf("找不到时应当给出相近的候选：%v", err)
	}
	if _, err := Lookup("no-such-style"); err == nil || !strings.Contains(err.Error(), "am film-style list") {
		t.Errorf("找不到时应当指向 list：%v", err)
	}
}

func gitRun(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t",
		"GIT_COMMITTER_EMAIL=t@t", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// fixtureLibrary 造一个本地风格库仓库：两种风格、core/ 与各种不该进项目的产物。
// 用 file:// 走与真实下载相同的代码路径，完全离线。
func fixtureLibrary(t *testing.T) (url, commit string) {
	t.Helper()
	repo := t.TempDir()
	gitRun(t, repo, "init", "-q", "-b", "main")
	gitRun(t, repo, "config", "uploadpack.allowAnySHA1InWant", "true")
	gitRun(t, repo, "config", "uploadpack.allowFilter", "true")
	files := map[string]string{
		"LICENSE":                             "MIT\n",
		"AGENTS.md":                           "agents\n",
		"core/lib.js":                         "export const mulberry = () => 0;\n",
		"core/three/post.js":                  "// post\n",
		"core/post/crt.js":                    "// crt\n",
		"core/fonts/fonts.css":                "/* fonts */\n",
		"core/render/video.mjs":               "// render\n",
		"docs/cover.jpg":                      "jpg",
		"styleboard/index.html":               "<html>",
		"styles/_template/STYLE.md":           "# template\n",
		"styles/impasto/STYLE.md":             "# Impasto\n## 7. Sound palette\n",
		"styles/impasto/style.json":           `{"slug":"impasto"}`,
		"styles/impasto/DEMO.md":              "# demo\n",
		"styles/impasto/poster.jpg":           "poster",
		"styles/impasto/demo/index.html":      `<script type="module" src="main.js"></script>`,
		"styles/impasto/demo/main.js":         "import '/core/lib.js';\n",
		"styles/impasto/demo/engine/paint.js": "// engine\n",
		"styles/impasto/demo/stills/t_1.jpg":  "still",
		"styles/impasto/demo/out/video.mp4":   "video",
		"styles/impasto/demo/music/score.py":  "# score\n",
		"styles/impasto/demo/music/score.wav": "wav",
		"styles/swiss-motion/STYLE.md":        "# Swiss\n",
		"styles/swiss-motion/style.json":      `{"slug":"swiss-motion"}`,
		"styles/swiss-motion/demo/index.html": "<html>",
		"styles/swiss-motion/demo/film.js":    "// film\n",
	}
	writeFiles(t, repo, files)
	gitRun(t, repo, "add", "-A")
	gitRun(t, repo, "commit", "-qm", "fixture")
	return "file://" + repo, gitRun(t, repo, "rev-parse", "HEAD")
}

func fixtureOptions(t *testing.T, url, commit string) LibraryOptions {
	return LibraryOptions{
		Env:     map[string]string{"PATH": os.Getenv("PATH"), "XDG_DATA_HOME": t.TempDir(), "HOME": t.TempDir()},
		RepoURL: url,
		Commit:  commit,
	}
}

func TestEnsureLibraryClonesPinnedCommitSparsely(t *testing.T) {
	url, commit := fixtureLibrary(t)
	opts := fixtureOptions(t, url, commit)
	lib, err := EnsureLibrary(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if !lib.Managed || lib.Commit != commit {
		t.Fatalf("应当是 am 管理的、钉在 %s 的风格库：%+v", commit, lib)
	}
	if lib.Dir != DefaultLibraryDir(opts.Env, commit) {
		t.Errorf("风格库应当按 commit 落在用户级目录：%s", lib.Dir)
	}
	for _, rel := range []string{"core/lib.js", "styles/impasto/STYLE.md", "LICENSE"} {
		if _, err := os.Stat(filepath.Join(lib.Dir, rel)); err != nil {
			t.Errorf("风格库缺少 %s", rel)
		}
	}
	// 与上游 setup.sh 同一套稀疏规则：demo、海报、图鉴不在首次检出里。
	for _, rel := range []string{"styles/impasto/demo", "styles/impasto/poster.jpg", "docs", "styleboard"} {
		if _, err := os.Stat(filepath.Join(lib.Dir, rel)); err == nil {
			t.Errorf("首次检出不该有 %s", rel)
		}
	}
	again, err := EnsureLibrary(context.Background(), opts)
	if err != nil || again.Dir != lib.Dir {
		t.Fatalf("已有风格库时应当直接复用：%+v %v", again, err)
	}
}

func TestInstallBuildsProjectSkillAndIsIdempotent(t *testing.T) {
	url, commit := fixtureLibrary(t)
	opts := fixtureOptions(t, url, commit)
	project := t.TempDir()
	impasto := Style{Slug: "impasto", CN: "油画厚涂", EN: "Impasto Oil Painting"}
	result, err := EnsureForProject(context.Background(), project, impasto, false, opts)
	if err != nil {
		t.Fatal(err)
	}
	skill := SkillDir(project)
	for _, rel := range []string{
		"SKILL.md", "STYLE.md", "DEMO.md", "poster.jpg", "LICENSE", "ATTRIBUTION.md", SkillManifest,
		"demo/index.html", "demo/engine/paint.js", "demo/music/score.py",
		"core/lib.js", "core/three/post.js", "core/post/crt.js", "core/fonts/fonts.css",
	} {
		if _, err := os.Stat(filepath.Join(skill, rel)); err != nil {
			t.Errorf("技能目录缺少 %s", rel)
		}
	}
	// 审片截图、渲染产物、音频与渲染工具不是技法，不进项目。
	for _, rel := range []string{"demo/stills", "demo/out", "demo/music/score.wav", "core/render"} {
		if _, err := os.Stat(filepath.Join(skill, rel)); err == nil {
			t.Errorf("技能目录不该有 %s", rel)
		}
	}
	manifest, ok, err := Installed(project)
	if err != nil || !ok || manifest.Slug != "impasto" || manifest.Commit != commit || manifest != result.Manifest {
		t.Fatalf("来源记录不对：%+v %v %v", manifest, ok, err)
	}
	skillText, _ := os.ReadFile(filepath.Join(skill, "SKILL.md"))
	for _, want := range []string{"油画厚涂", "Impasto Oil Painting", "STYLE.md", "hf-seek", "/core/lib.js", "不照搬 demo", "无音轨"} {
		if !strings.Contains(string(skillText), want) {
			t.Errorf("SKILL.md 缺少 %q", want)
		}
	}
	if strings.Contains(string(skillText), "node_modules/three") {
		t.Error("不用 three.js 的风格不该在 SKILL.md 里提 three")
	}

	again, err := EnsureForProject(context.Background(), project, impasto, false, opts)
	if err != nil || !again.Unchanged {
		t.Fatalf("同一种风格重装应当不改动：%+v %v", again, err)
	}

	swiss := Style{Slug: "swiss-motion", CN: "瑞士动态排版", EN: "Swiss Motion Graphics"}
	if _, err := EnsureForProject(context.Background(), project, swiss, false, opts); err == nil || !strings.Contains(err.Error(), "--replace") {
		t.Fatalf("换风格不加 --replace 应当拒绝：%v", err)
	}
	if _, err := os.Stat(filepath.Join(skill, "STYLE.md")); err != nil {
		t.Fatal("拒绝换风格时不得动原来的技能目录")
	}
	replaced, err := EnsureForProject(context.Background(), project, swiss, true, opts)
	if err != nil || replaced.Replaced != "impasto" {
		t.Fatalf("加 --replace 应当换掉：%+v %v", replaced, err)
	}
	if _, err := os.Stat(filepath.Join(skill, "DEMO.md")); err == nil {
		t.Error("换风格后旧风格的文件不该残留")
	}
	if _, had, err := Remove(project); err != nil || !had {
		t.Fatalf("Remove：%v %v", had, err)
	}
	if _, ok, _ := Installed(project); ok {
		t.Error("Remove 之后不该还有整片风格")
	}
}

func TestInstallRequiresThreeForThreeStyles(t *testing.T) {
	url, commit := fixtureLibrary(t)
	opts := fixtureOptions(t, url, commit)
	lib, err := EnsureLibrary(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := EnsureDemo(context.Background(), lib, "impasto", opts); err != nil {
		t.Fatal(err)
	}
	style := Style{Slug: "impasto", CN: "油画厚涂", EN: "Impasto", ThreeJS: true}
	if _, err := Install(InstallOptions{ProjectDir: t.TempDir(), Style: style, Library: lib}); err == nil || !strings.Contains(err.Error(), "npm ci") {
		t.Fatalf("没有 three 时应当指向 setup：%v", err)
	}
	writeFiles(t, filepath.Join(lib.Dir, "node_modules", "three"), map[string]string{
		"build/three.module.js": "// three\n", "examples/jsm/controls/x.js": "// x\n", "LICENSE": "MIT\n", "src/huge.js": "// src\n",
	})
	project := t.TempDir()
	if _, err := Install(InstallOptions{ProjectDir: project, Style: style, Library: lib}); err != nil {
		t.Fatal(err)
	}
	skill := SkillDir(project)
	if _, err := os.Stat(filepath.Join(skill, "node_modules", "three", "build", "three.module.js")); err != nil {
		t.Error("three.js 风格应当带上 three 的 build/")
	}
	if _, err := os.Stat(filepath.Join(skill, "node_modules", "three", "src")); err == nil {
		t.Error("three 的 src/ 用不上，不该进项目")
	}
	body, _ := os.ReadFile(filepath.Join(skill, "SKILL.md"))
	if !strings.Contains(string(body), "node_modules/three") {
		t.Error("three.js 风格的 SKILL.md 应当说明怎么拷 three")
	}
}

// 用户自己的检出（没有 am 的标记）只读不改：缺 demo 时报错，不去改它的稀疏规则。
func TestUserLibraryIsNotModified(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{"core/lib.js": "//", "styles/impasto/STYLE.md": "# x"})
	opts := LibraryOptions{Env: map[string]string{"PATH": os.Getenv("PATH"), LibraryEnv: dir}}
	lib, err := EnsureLibrary(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if lib.Managed {
		t.Fatal("用户的检出不该被当成 am 管理的")
	}
	if err := EnsureDemo(context.Background(), lib, "impasto", opts); err == nil {
		t.Fatal("用户的检出缺 demo 时应当报错")
	}
	bad := t.TempDir()
	writeFiles(t, bad, map[string]string{"README.md": "not a library"})
	if _, err := EnsureLibrary(context.Background(), LibraryOptions{Env: map[string]string{LibraryEnv: bad}}); err == nil {
		t.Fatal("指向一个不是风格库的非空目录时应当报错，而不是往里克隆")
	}
}

// 下载中途断开后，<目录>.partial 里已经取到的东西要沿用：这里造一份只做完 fetch、
// 还没检出的半成品，在 .git 里放一个记号，完成后记号还在就说明没有从头再来。
func TestEnsureLibraryResumesPartialDownload(t *testing.T) {
	url, commit := fixtureLibrary(t)
	opts := fixtureOptions(t, url, commit)
	dir := LibraryDir(opts)
	partial := dir + ".partial"
	if err := os.MkdirAll(partial, 0o755); err != nil {
		t.Fatal(err)
	}
	gitRun(t, partial, "init", "-q")
	gitRun(t, partial, "remote", "add", "origin", url)
	gitRun(t, partial, "fetch", "-q", "--depth", "1", "origin", commit)
	writeFiles(t, partial, map[string]string{".git/resume-sentinel": "x"})
	lib, err := EnsureLibrary(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(lib.Dir, ".git", "resume-sentinel")); err != nil {
		t.Fatal("应当在已有的半成品上接着下载，而不是删掉重来")
	}
	if _, err := os.Stat(partial); err == nil {
		t.Error("完成后不该留下 .partial")
	}
	if _, err := os.Stat(filepath.Join(lib.Dir, "styles", "impasto", "STYLE.md")); err != nil {
		t.Error("续传后的风格库不完整")
	}
}

// demo 取到一半（index.html 在、完成记录不在）时要接着取完。
func TestEnsureDemoFinishesInterruptedDownload(t *testing.T) {
	url, commit := fixtureLibrary(t)
	opts := fixtureOptions(t, url, commit)
	lib, err := EnsureLibrary(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	writeFiles(t, lib.Dir, map[string]string{"styles/impasto/demo/index.html": "<partial>"})
	if err := EnsureDemo(context.Background(), lib, "impasto", opts); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(lib.Dir, "styles", "impasto", "demo", "engine", "paint.js")); err != nil {
		t.Fatal("只有 index.html 时应当把 demo 其余文件取完")
	}
	body, _ := os.ReadFile(filepath.Join(lib.Dir, "styles", "impasto", "demo", "index.html"))
	if string(body) == "<partial>" {
		t.Error("中断留下的文件应当按 HEAD 恢复")
	}
}
