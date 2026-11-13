package filmstyle

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeSource 是测试用的风格来源：证明通用部分不依赖任何具体来源。
type fakeSource struct {
	id      string
	styles  []Style
	noGuide bool
}

func (f fakeSource) ID() string                                       { return f.id }
func (f fakeSource) Name() string                                     { return "测试来源 " + f.id }
func (f fakeSource) Gallery() string                                  { return "" }
func (f fakeSource) Location(map[string]string) string                { return "/dev/null" }
func (f fakeSource) Check(map[string]string) error                    { return nil }
func (f fakeSource) Prepare(context.Context, PrepareOptions) error    { return nil }
func (f fakeSource) Poster(map[string]string, string) (string, error) { return "", os.ErrNotExist }
func (f fakeSource) EnvKeys() []string {
	return []string{"AM_TEST_" + strings.ToUpper(strings.ReplaceAll(f.id, "-", "_"))}
}
func (f fakeSource) Catalog() []Style { return f.styles }
func (f fakeSource) Fill(dir string, style Style, _ map[string]string) (string, error) {
	if err := os.WriteFile(filepath.Join(dir, StyleFile), []byte("# "+style.Key()), 0o644); err != nil {
		return "", err
	}
	if !f.noGuide {
		if err := os.WriteFile(filepath.Join(dir, GuideFile), []byte("guide"), 0o644); err != nil {
			return "", err
		}
	}
	return "v1", nil
}

func init() {
	Register(fakeSource{id: "alpha", styles: []Style{
		{Source: "alpha", Slug: "ink", CN: "水墨", EN: "Ink", CategoryCN: "绘画"},
		{Source: "alpha", Slug: "pixel", CN: "像素", EN: "Pixel", CategoryCN: "游戏"},
	}})
	Register(fakeSource{id: "beta", styles: []Style{
		{Source: "beta", Slug: "ink", CN: "墨线", EN: "Ink Line", CategoryCN: "线描"},
	}})
	Register(fakeSource{id: "broken", noGuide: true, styles: []Style{{Source: "broken", Slug: "nope", CN: "坏", EN: "Broken"}}})
}

func TestLookupAcrossSources(t *testing.T) {
	if style, err := Lookup("alpha/ink"); err != nil || style.CN != "水墨" {
		t.Fatalf("写全标识应当直接找到：%+v %v", style, err)
	}
	if style, err := Lookup("像素"); err != nil || style.Key() != "alpha/pixel" {
		t.Fatalf("唯一的中文名应当找到：%+v %v", style, err)
	}
	if _, err := Lookup("ink"); err == nil || !strings.Contains(err.Error(), "来源/目录名") {
		t.Fatalf("多个来源里都有的名字应当要求写全：%v", err)
	}
	if _, err := Lookup("nothing"); err == nil || !strings.Contains(err.Error(), "am film-style list") {
		t.Fatalf("找不到时应当指向 list：%v", err)
	}
	if got := Categories("alpha"); len(got) != 2 || got[0] != "绘画" {
		t.Errorf("分类按来源、按首次出现排：%v", got)
	}
	keys := strings.Join(ChildEnvKeys(), ",")
	if !strings.Contains(keys, RootEnv) || !strings.Contains(keys, "AM_TEST_ALPHA") {
		t.Errorf("要传给子进程的环境变量应当包括根目录与各来源的：%s", keys)
	}
}

func TestInstallEnforcesContractAndReplacesLegacyDirectory(t *testing.T) {
	project := t.TempDir()
	broken, _ := Lookup("broken/nope")
	if _, err := Install(InstallOptions{ProjectDir: project, Style: broken}); err == nil || !strings.Contains(err.Error(), GuideFile) {
		t.Fatalf("来源没写出 SKILL.md 时应当拒绝：%v", err)
	}
	if _, err := os.Stat(SkillDir(project)); err == nil {
		t.Fatal("违反契约时不该留下技能目录")
	}

	// 旧版只有 lemo-opuscar 时装出的目录：照样认得，装新风格时被换掉。
	legacy := filepath.Join(project, ".agents", "skills", LegacySkillName)
	if err := os.MkdirAll(legacy, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(legacy, "lemo-upstream.json"), []byte(`{"commit":"abc","slug":"impasto","cn":"油画厚涂","en":"Impasto"}`), 0o644)
	manifest, ok, err := Installed(project)
	if err != nil || !ok || !manifest.Legacy || manifest.Key() != "lemo-opuscar/impasto" || InstalledDir(project) != legacy {
		t.Fatalf("应当认得旧目录：%+v %v %v", manifest, ok, err)
	}
	ink, _ := Lookup("alpha/ink")
	if _, err := Install(InstallOptions{ProjectDir: project, Style: ink}); err == nil || !strings.Contains(err.Error(), "--replace") {
		t.Fatalf("旧目录里是另一种风格，不加 --replace 应当拒绝：%v", err)
	}
	result, err := Install(InstallOptions{ProjectDir: project, Style: ink, Replace: true})
	if err != nil || result.Replaced != "lemo-opuscar/impasto" {
		t.Fatalf("加 --replace 应当换掉：%+v %v", result, err)
	}
	if _, err := os.Stat(legacy); err == nil {
		t.Error("装了新目录以后旧目录应当删掉，免得两份都被当成整片风格")
	}
	manifest, _, _ = Installed(project)
	if manifest.Source != "alpha" || manifest.Version != "v1" || manifest.Digest == "" {
		t.Errorf("来源记录不对：%+v", manifest)
	}
	again, err := Install(InstallOptions{ProjectDir: project, Style: ink})
	if err != nil || !again.Unchanged {
		t.Fatalf("同一种风格重装应当不改动：%+v %v", again, err)
	}
	if _, had, err := Remove(project); err != nil || !had {
		t.Fatalf("Remove：%v %v", had, err)
	}
	if _, ok, _ := Installed(project); ok {
		t.Error("Remove 之后不该还有整片风格")
	}
}
