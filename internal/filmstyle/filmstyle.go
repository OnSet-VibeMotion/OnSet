// Package filmstyle 是整片风格的通用部分：风格来源的接口与登记、风格目录的查找，
// 以及把一种风格装进项目的契约。
//
// am 自身不锁定视觉风格（见制作提示词「视觉方向」）。整片风格是可选项：从某个风格
// 来源里挑一种，装成项目里的一个技能（.agents/skills/am-film-style/），镜头提示词据此
// 把「视觉自由度」换成「遵守整片风格」。
//
// 契约只有三个文件，与来源无关：
//
//	STYLE.md         风格的不变量（渲染器必须遵守）
//	SKILL.md         这套风格在 HyperFrames 镜头里怎么用、技法参考在哪
//	am-film-style.json  来源、风格、版本与内容摘要（ManifestFile）
//
// 其余文件（demo 源码、引擎、模型）由各来源自己决定。镜头渲染与制作提示词只依赖
// 这份契约，不点名任何来源。具体来源在子包里实现 Source 并在 init 里 Register，
// 例如 internal/filmstyle/lemo（lemo-opuscar 风格库）。新增来源不需要改这里。
//
// 风格来源的数据是前置资源：只由 am setup 经 Source.Prepare 下载，其余路径只检查。
package filmstyle

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Style 是某个来源风格目录里的一种风格。
type Style struct {
	// Source 是来源 ID，Slug 是来源内的目录名；两者合起来（Key）全局唯一。
	Source string `json:"source"`
	Slug   string `json:"slug"`
	// Order 是来源内的展示顺序。
	Order      string   `json:"order"`
	CN         string   `json:"cn"`
	EN         string   `json:"en"`
	CategoryCN string   `json:"category_cn"`
	CategoryEN string   `json:"category_en"`
	Uses       []string `json:"uses"`
	// Summary 是一句话中文说明（例如来源 demo 片讲了什么）。
	Summary string `json:"summary"`
	// Tags 是附加标记，例如 three.js。
	Tags []string `json:"tags,omitempty"`
}

// Key 是全局唯一的风格标识：<来源>/<目录名>。
func (s Style) Key() string { return s.Source + "/" + s.Slug }

// Label 是一行中文说明：中文名、英文名与标识。
func (s Style) Label() string {
	return fmt.Sprintf("%s %s（%s）", s.CN, s.EN, s.Key())
}

// PrepareProgress 是 Source.Prepare 的进度：第 Step 步（共 Steps 步）在做 Stage。
type PrepareProgress struct {
	Step, Steps int
	Stage       string
}

// PrepareOptions 描述一次前置资源准备（am setup）。
type PrepareOptions struct {
	// Env 是给下载工具用的环境（PATH、HOME、代理、npm 设置）。
	Env      map[string]string
	Output   io.Writer
	Progress func(PrepareProgress)
}

// Source 是一个风格来源。
type Source interface {
	// ID 是来源标识，只用小写字母、数字和连字符，例如 lemo-opuscar。
	ID() string
	// Name 是给人看的来源名。
	Name() string
	// Gallery 是来源的在线图鉴，没有时为空。
	Gallery() string
	// Catalog 返回来源里的全部风格（Source 字段已填），不联网。
	Catalog() []Style
	// Location 是来源数据在本机的位置，给 am setup 显示。
	Location(env map[string]string) string
	// Check 判断来源数据是否已就绪，没就绪返回 prereq.MissingError。不联网。
	Check(env map[string]string) error
	// Prepare 下载来源数据（只由 am setup 调用），已就绪时直接返回。
	Prepare(ctx context.Context, opts PrepareOptions) error
	// Poster 返回风格海报的本机路径；没有海报时返回错误。
	Poster(env map[string]string, slug string) (string, error)
	// Fill 把风格写进 dir（空的临时目录），至少写出 STYLE.md 与 SKILL.md，返回版本标识
	// （例如上游 commit）。不联网；数据没就绪返回 prereq.MissingError。
	Fill(dir string, style Style, env map[string]string) (version string, err error)
	// EnvKeys 是这个来源读的环境变量（例如数据目录的覆盖），要显式传给子进程。
	EnvKeys() []string
}

var registry []Source

// Register 登记一个风格来源，由来源子包在 init 里调用。ID 重复会 panic。
func Register(source Source) {
	for _, existing := range registry {
		if existing.ID() == source.ID() {
			panic("filmstyle: 风格来源重复登记：" + source.ID())
		}
	}
	registry = append(registry, source)
	sort.SliceStable(registry, func(i, j int) bool { return registry[i].ID() < registry[j].ID() })
}

// Sources 返回全部已登记的来源，按 ID 排序。
func Sources() []Source { return append([]Source(nil), registry...) }

// SourceByID 按 ID 找来源。
func SourceByID(id string) (Source, bool) {
	for _, source := range registry {
		if source.ID() == id {
			return source, true
		}
	}
	return nil, false
}

// Catalog 返回全部来源的风格，按来源、来源内顺序排列。
func Catalog() []Style {
	var out []Style
	for _, source := range registry {
		out = append(out, source.Catalog()...)
	}
	return out
}

// Categories 按首次出现的顺序返回某个来源的风格分类（中文名）。
func Categories(sourceID string) []string {
	var out []string
	seen := map[string]bool{}
	for _, style := range Catalog() {
		if style.Source == sourceID && !seen[style.CategoryCN] {
			seen[style.CategoryCN] = true
			out = append(out, style.CategoryCN)
		}
	}
	return out
}

// Find 按标识（来源/目录名）、目录名、中文名或英文名（不区分大小写）查找风格。
// 不带来源的名字在多个来源里都有时返回 ambiguous，由调用方要求写全。
func Find(name string) (style Style, ok bool, ambiguous []Style) {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" {
		return Style{}, false, nil
	}
	var matches []Style
	for _, candidate := range Catalog() {
		if strings.ToLower(candidate.Key()) == key {
			return candidate, true, nil
		}
		if strings.ToLower(candidate.Slug) == key || strings.ToLower(candidate.EN) == key || candidate.CN == strings.TrimSpace(name) {
			matches = append(matches, candidate)
		}
	}
	switch len(matches) {
	case 0:
		return Style{}, false, nil
	case 1:
		return matches[0], true, nil
	default:
		return Style{}, false, matches
	}
}

// Suggest 返回名字里含 name 的风格，供找不到时提示。
func Suggest(name string) []Style {
	key := strings.ToLower(strings.TrimSpace(name))
	if key == "" {
		return nil
	}
	var out []Style
	for _, style := range Catalog() {
		if strings.Contains(strings.ToLower(style.Key()), key) || strings.Contains(strings.ToLower(style.EN), key) || strings.Contains(style.CN, strings.TrimSpace(name)) {
			out = append(out, style)
		}
	}
	if len(out) > 5 {
		out = out[:5]
	}
	return out
}

// Lookup 与 Find 相同，找不到或有歧义时返回说明清楚的错误。
func Lookup(name string) (Style, error) {
	style, ok, ambiguous := Find(name)
	if ok {
		return style, nil
	}
	labels := func(list []Style) string {
		out := make([]string, len(list))
		for i, s := range list {
			out[i] = s.Label()
		}
		return strings.Join(out, "、")
	}
	if len(ambiguous) > 0 {
		return Style{}, fmt.Errorf("%q 在多个风格来源里都有：%s。写成「来源/目录名」", name, labels(ambiguous))
	}
	message := fmt.Sprintf("风格目录里没有 %q", name)
	if candidates := Suggest(name); len(candidates) > 0 {
		message += "，相近的有：" + labels(candidates)
	}
	return Style{}, fmt.Errorf("%s。用 am film-style list 查看全部风格", message)
}

// RootEnv 覆盖全部风格来源数据的根目录。
const RootEnv = "AM_FILM_STYLES_DIR"

// RootDir 返回风格来源数据的根目录：RootEnv，否则 XDG_DATA_HOME 或 HOME 下的
// .local/share/am/film-styles。各来源在它下面以自己的 ID 分目录。
func RootDir(env map[string]string) string {
	if dir := env[RootEnv]; dir != "" {
		return dir
	}
	base := env["XDG_DATA_HOME"]
	if base == "" {
		home := env["HOME"]
		if home == "" {
			home, _ = os.UserHomeDir()
		}
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "am", "film-styles")
}

// SourceDir 返回某个来源的数据目录：<根目录>/<来源 ID>。
func SourceDir(env map[string]string, sourceID string) string {
	return filepath.Join(RootDir(env), sourceID)
}

// ChildEnvKeys 是要显式传给子进程的环境变量：根目录与各来源自己的覆盖。
// 安全模式的白名单里没有它们，不传的话子进程算出另一个目录，找不到已准备好的数据。
func ChildEnvKeys() []string {
	keys := []string{RootEnv}
	for _, source := range registry {
		keys = append(keys, source.EnvKeys()...)
	}
	return keys
}
