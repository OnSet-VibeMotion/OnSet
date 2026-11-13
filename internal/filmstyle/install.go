package filmstyle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
)

// SkillsSubdir 是技能在项目里的落点，与 hyperframes.SkillsSubdir 一致。
const SkillsSubdir = ".agents/skills"

// SkillName 是整片风格在项目 .agents/skills/ 下的目录名。
//
// 带 am- 前缀而不叫 film-style：技能解析会从镜头目录逐级向上找 .agents/skills，
// 名字太通用容易撞上用户自己装的别的技能。
const SkillName = "am-film-style"

// ManifestFile 是整片风格技能目录里的来源记录。
const ManifestFile = "am-film-style.json"

// 契约里的两份必需文件。
const (
	StyleFile = "STYLE.md"
	GuideFile = "SKILL.md"
)

// legacySkillName / legacyManifest 是只有 lemo-opuscar 一个来源时的目录名与记录。
// 早先装过的项目照样认（读、渲染、去掉），下次装风格时换成新目录。
const (
	LegacySkillName = "lemo-film-style"
	legacyManifest  = "lemo-upstream.json"
	legacySource    = "lemo-opuscar"
)

// Manifest 是 am-film-style.json：这个项目装的是哪个来源的哪种风格。
type Manifest struct {
	Source string `json:"source"`
	Slug   string `json:"slug"`
	CN     string `json:"cn"`
	EN     string `json:"en"`
	// Version 是来源给的版本标识（例如上游 commit）。
	Version string `json:"version"`
	// Digest 是技能目录里除本文件外全部文件的内容摘要，用来判断重装是否有变化。
	Digest      string `json:"digest"`
	InstalledAt string `json:"installed_at"`
	// Legacy 表示读自旧目录（lemo-film-style），不写进文件。
	Legacy bool `json:"-"`
}

// Key 是 <来源>/<目录名>。
func (m Manifest) Key() string { return m.Source + "/" + m.Slug }

// SkillDir 返回项目里整片风格技能目录的路径。
func SkillDir(projectDir string) string {
	return filepath.Join(projectDir, filepath.FromSlash(SkillsSubdir), SkillName)
}

func legacyDir(projectDir string) string {
	return filepath.Join(projectDir, filepath.FromSlash(SkillsSubdir), LegacySkillName)
}

// InstalledDir 返回项目里实际装着整片风格的目录（新目录或旧目录）；没有时为空。
func InstalledDir(projectDir string) string {
	if _, err := os.Stat(filepath.Join(SkillDir(projectDir), ManifestFile)); err == nil {
		return SkillDir(projectDir)
	}
	if _, err := os.Stat(filepath.Join(legacyDir(projectDir), legacyManifest)); err == nil {
		return legacyDir(projectDir)
	}
	return ""
}

// Installed 读取项目里已装的整片风格；没有时 ok 为 false。
func Installed(projectDir string) (Manifest, bool, error) {
	body, err := os.ReadFile(filepath.Join(SkillDir(projectDir), ManifestFile))
	if err == nil {
		var manifest Manifest
		if err := json.Unmarshal(body, &manifest); err != nil {
			return Manifest{}, false, fmt.Errorf("%s 损坏：%w", ManifestFile, err)
		}
		return manifest, true, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Manifest{}, false, err
	}
	body, err = os.ReadFile(filepath.Join(legacyDir(projectDir), legacyManifest))
	if errors.Is(err, os.ErrNotExist) {
		return Manifest{}, false, nil
	}
	if err != nil {
		return Manifest{}, false, err
	}
	var legacy struct {
		Commit, Slug, CN, EN, Digest string
		InstalledAt                  string `json:"installed_at"`
	}
	if err := json.Unmarshal(body, &legacy); err != nil {
		return Manifest{}, false, fmt.Errorf("%s 损坏：%w", legacyManifest, err)
	}
	return Manifest{Source: legacySource, Slug: legacy.Slug, CN: legacy.CN, EN: legacy.EN, Version: legacy.Commit,
		Digest: legacy.Digest, InstalledAt: legacy.InstalledAt, Legacy: true}, true, nil
}

// InstallOptions 描述一次整片风格安装。
type InstallOptions struct {
	ProjectDir string
	Style      Style
	// Env 交给来源找它的数据。
	Env map[string]string
	// Replace 为 true 时允许把已装的另一种风格换掉。换风格会让所有镜头的输入
	// 指纹变化，所以默认拒绝。
	Replace bool
	// Now 用于测试；零值取当前时间。
	Now time.Time
}

// InstallResult 汇报安装结果。
type InstallResult struct {
	Manifest Manifest
	// Unchanged 表示项目里已是同一份内容，没有改动任何文件。
	Unchanged bool
	// Replaced 是被换掉的风格标识，没有换时为空。
	Replaced string
}

// Install 把 opts.Style 装进项目的 .agents/skills/am-film-style/。不联网：来源数据
// 没就绪时由来源返回 prereq.MissingError。
//
// 先在同级临时目录让来源写好整棵技能树、校验契约，再整体换位：中途失败时项目里
// 要么是旧风格、要么是新风格，不会半新半旧。装好后删掉旧目录（lemo-film-style）。
func Install(opts InstallOptions) (InstallResult, error) {
	style := opts.Style
	source, ok := SourceByID(style.Source)
	if !ok {
		return InstallResult{}, fmt.Errorf("没有风格来源 %q", style.Source)
	}
	previous, had, err := Installed(opts.ProjectDir)
	if err != nil {
		return InstallResult{}, err
	}
	if had && previous.Key() != style.Key() && !opts.Replace {
		return InstallResult{}, fmt.Errorf(
			"项目已使用整片风格 %s %s（%s）。换成 %s 会让全部镜头需要重渲染；确认要换就加 --replace",
			previous.CN, previous.EN, previous.Key(), style.Label())
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
	version, err := source.Fill(staging, style, opts.Env)
	if err != nil {
		return InstallResult{}, err
	}
	for _, required := range []string{StyleFile, GuideFile} {
		if _, err := os.Stat(filepath.Join(staging, required)); err != nil {
			return InstallResult{}, fmt.Errorf("风格来源 %s 没有写出 %s：违反整片风格契约", source.ID(), required)
		}
	}
	digest, err := treeDigest(staging)
	if err != nil {
		return InstallResult{}, err
	}
	if had && !previous.Legacy && previous.Key() == style.Key() && previous.Digest == digest && previous.Version == version {
		return InstallResult{Manifest: previous, Unchanged: true}, nil
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	manifest := Manifest{Source: style.Source, Slug: style.Slug, CN: style.CN, EN: style.EN, Version: version,
		Digest: digest, InstalledAt: now.UTC().Format(time.RFC3339)}
	body, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return InstallResult{}, err
	}
	if err := fsutil.AtomicWrite(filepath.Join(staging, ManifestFile), append(body, '\n'), 0o644); err != nil {
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
	// 旧目录与新目录并存的话，两份都会被当成整片风格；新的放好了就删旧的。
	_ = os.RemoveAll(legacyDir(opts.ProjectDir))
	result := InstallResult{Manifest: manifest}
	if had && previous.Key() != style.Key() {
		result.Replaced = previous.Key()
	}
	return result, nil
}

// Remove 删除项目里的整片风格（新旧目录都删），回到镜头自主定视觉。
func Remove(projectDir string) (Manifest, bool, error) {
	manifest, had, err := Installed(projectDir)
	if err != nil || !had {
		return manifest, had, err
	}
	if err := os.RemoveAll(SkillDir(projectDir)); err != nil {
		return manifest, true, err
	}
	return manifest, true, os.RemoveAll(legacyDir(projectDir))
}

// treeDigest 是目录下全部文件（按相对路径排序）的内容摘要，不含来源记录本身。
func treeDigest(root string) (string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() && entry.Name() != ManifestFile {
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
