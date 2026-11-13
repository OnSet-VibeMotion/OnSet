package scene

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
)

// 整片风格只从项目里找：装在项目根的 .agents/skills 下就能被镜头目录发现，
// 进 resolved（指纹、安全模式读取），提示词把「视觉自由度」换成「整片风格」。
func TestFilmStyleReplacesVisualFreedom(t *testing.T) {
	root := t.TempDir()
	sceneDir := filepath.Join(root, "scenes", "scene-001")
	if err := os.MkdirAll(sceneDir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(sceneDir, "transcript.srt"), []byte("1\n00:00:00,000 --> 00:00:01,000\ntest\n"), 0o644)
	os.WriteFile(filepath.Join(sceneDir, "scene.json"), []byte(`{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}`), 0o644)
	s, err := Load(sceneDir)
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"HOME": t.TempDir()}

	plainSkills, err := ResolveAllSkills("claude", sceneDir, env)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := plainSkills[filmstyle.SkillName]; ok {
		t.Fatal("没装整片风格时不该解析到它")
	}
	plain, err := BuildPrompt(s, plainSkills)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plain, "视觉自由度（强制）") || strings.Contains(plain, "整片风格（强制）") {
		t.Fatal("没装整片风格时应当保持视觉自由度，提示词不变")
	}
	base, err := Fingerprint(s, "claude", plainSkills)
	if err != nil {
		t.Fatal(err)
	}

	// 家目录里的一份不算：整片风格是一个项目的选择。
	homeSkill := filepath.Join(env["HOME"], ".agents", "skills", filmstyle.SkillName)
	os.MkdirAll(homeSkill, 0o755)
	os.WriteFile(filepath.Join(homeSkill, "SKILL.md"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(homeSkill, "STYLE.md"), []byte("x"), 0o644)
	if again, _ := ResolveAllSkills("claude", sceneDir, env); again[filmstyle.SkillName] != "" {
		t.Fatal("不该从家目录解析整片风格")
	}

	skill := filepath.Join(root, ".agents", "skills", filmstyle.SkillName)
	os.MkdirAll(skill, 0o755)
	os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("# skill\n"), 0o644)
	os.WriteFile(filepath.Join(skill, "STYLE.md"), []byte("# style v1\n"), 0o644)
	resolved, err := ResolveAllSkills("claude", sceneDir, env)
	if err != nil {
		t.Fatal(err)
	}
	if resolved[filmstyle.SkillName] != filepath.Join(root, ".agents", "skills") {
		t.Fatalf("应当解析到项目里的整片风格：%v", resolved)
	}
	prompt, err := BuildPrompt(s, resolved)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"整片风格（强制）", skill, "STYLE.md", "不照搬 demo", "无音轨"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("整片风格段缺少 %q", want)
		}
	}
	if strings.Contains(prompt, "本镜头的配色、字体、版式、材质与动效由你根据文案和素材自主决定") {
		t.Error("装了整片风格后不该再让镜头自主定视觉")
	}
	if access := RendererAccess(resolved); !containsString(access.ReadDirs, filepath.Join(root, ".agents", "skills")) {
		t.Errorf("安全模式应当放行读取整片风格目录：%v", access.ReadDirs)
	}
	withStyle, err := Fingerprint(s, "claude", resolved)
	if err != nil {
		t.Fatal(err)
	}
	if withStyle.Fingerprint == base.Fingerprint || withStyle.Parts["skill:"+filmstyle.SkillName] == "" {
		t.Fatalf("装整片风格应当改变指纹并单列一项：%v", withStyle.Parts)
	}
	os.WriteFile(filepath.Join(skill, "STYLE.md"), []byte("# style v2\n"), 0o644)
	resetDigestCache()
	changed, _ := Fingerprint(s, "claude", resolved)
	if changed.Parts["skill:"+filmstyle.SkillName] == withStyle.Parts["skill:"+filmstyle.SkillName] {
		t.Error("STYLE.md 变了，整片风格那一项应当跟着变")
	}
}

func containsString(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func resetDigestCache() {
	treeDigests.Range(func(key, _ any) bool {
		treeDigests.Delete(key)
		return true
	})
}
