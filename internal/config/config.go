package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

const (
	DefaultSceneJobs = 3
	MaxSceneJobs     = 16
)

var secretKey = regexp.MustCompile(`(?i)(API_KEY|TOKEN|SECRET|PASSWORD)$`)

type Config struct {
	Orchestrator string
	Renderer     string
	TTSProvider  string
	// AlignProvider 是已解析的对齐工具，auto 已落成具体取值。
	AlignProvider string
	SceneJobs     int
	Overlay       map[string]string
	// Memory 是渲染记忆的项目侧设置，见 internal/memory。
	Memory MemorySettings
	// FilmStyleLibrary 是整片风格的用户级风格库目录，见 internal/filmstyle。
	FilmStyleLibrary string
}

// MemorySettings 是渲染记忆的项目侧设置。
//
// 默认打开：项目随使用积累经验与偏好。没有召回到任何记忆时提示词与输入指纹
// 都与关闭时逐字相同，所以打开它不会让已有镜头变成 Stale。
type MemorySettings struct {
	// Enabled 为 false 时完全不召回、不写经历（对照组）。
	Enabled bool
	// Dir 是记忆库目录，AM_MEMORY_DIR 可覆盖，默认 ~/.local/share/am/memory。
	Dir string
	// Snapshot 为 0 表示跟随最新快照，否则钉住该快照。
	Snapshot int
	// RecallBudget 是每个镜头召回的记忆总字数上限。
	RecallBudget int
	// Explore 是正式渲染时探索的比例：这么多比例的镜头把召回里排最后的一条经验换成
	// 排在上限外的第一条，给没机会被召回的经验攒样本。0 关闭。
	Explore float64
}

// DefaultMemoryRecallBudget 是每个镜头召回记忆的默认总字数上限。
const DefaultMemoryRecallBudget = 1500

// DefaultMemoryExplore 是默认的探索比例；MaxMemoryExplore 是上限。
const (
	DefaultMemoryExplore = 0.1
	MaxMemoryExplore     = 0.5
)

// DefaultMemoryDir 返回默认记忆库目录：用户级，可跨项目复用。
// XDG_DATA_HOME 有值时用它，否则落在 HOME 下的 .local/share。
func DefaultMemoryDir(environ map[string]string) string {
	if dir := environ["XDG_DATA_HOME"]; dir != "" {
		return filepath.Join(dir, "am", "memory")
	}
	home := environ["HOME"]
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return filepath.Join(home, ".local", "share", "am", "memory")
}

func envMap() map[string]string {
	return envutil.EnvMap()
}

func parseFile(path string) (map[string]string, error) {
	out := make(map[string]string)
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if len(value) >= 2 && ((value[0] == '\'' && value[len(value)-1] == '\'') || (value[0] == '"' && value[len(value)-1] == '"')) {
			value = value[1 : len(value)-1]
		}
		out[key] = value
	}
	return out, scanner.Err()
}

func Load(root string, environ map[string]string) (Config, error) {
	if environ == nil {
		environ = envMap()
	}
	dotenv, err := parseFile(filepath.Join(root, ".env"))
	if err != nil {
		return Config{}, fmt.Errorf("读取 .env: %w", err)
	}
	for key := range dotenv {
		if secretKey.MatchString(key) {
			return Config{}, fmt.Errorf(".env 不得保存密钥 %s，请使用对应工具的登录命令", key)
		}
	}
	conf, err := parseFile(filepath.Join(root, "article-to-motion.conf"))
	if err != nil {
		return Config{}, fmt.Errorf("读取 article-to-motion.conf: %w", err)
	}
	resolve := func(key, fallback string) string {
		for _, source := range []map[string]string{environ, dotenv, conf} {
			if value := source[key]; value != "" {
				return value
			}
		}
		return fallback
	}
	cfg := Config{Orchestrator: resolve("ORCHESTRATOR", ""), Renderer: resolve("RENDERER", ""), TTSProvider: resolve("TTS_PROVIDER", "minimax"), Overlay: dotenv}
	if !tools.ValidTools[cfg.Orchestrator] {
		return Config{}, fmt.Errorf("无效的 ORCHESTRATOR: %s（可选：codex claude qoder codebuddy opencode）", cfg.Orchestrator)
	}
	if !tools.ValidTools[cfg.Renderer] {
		return Config{}, fmt.Errorf("无效的 RENDERER: %s（可选：codex claude qoder codebuddy opencode）", cfg.Renderer)
	}
	if !validTTSProvider(cfg.TTSProvider) {
		return Config{}, fmt.Errorf("无效的 TTS_PROVIDER: %s（可选：%s）", cfg.TTSProvider, TTSProviderIDs())
	}
	align := resolve("ALIGN_PROVIDER", AlignAuto)
	if align != AlignAuto && !validAligner(align) {
		return Config{}, fmt.Errorf("无效的 ALIGN_PROVIDER: %s（可选：%s）", align, AlignerIDs())
	}
	cfg.AlignProvider = hostAligner(align)
	cfg.SceneJobs, err = strconv.Atoi(resolve("SCENE_JOBS", strconv.Itoa(DefaultSceneJobs)))
	if err != nil || cfg.SceneJobs < 1 || cfg.SceneJobs > MaxSceneJobs {
		return Config{}, fmt.Errorf("SCENE_JOBS 必须在 1..%d 之间", MaxSceneJobs)
	}
	switch value := strings.ToLower(resolve("MEMORY", "on")); value {
	case "on":
		cfg.Memory.Enabled = true
	case "off":
	default:
		return Config{}, fmt.Errorf("无效的 MEMORY: %s（可选：on off）", value)
	}
	cfg.Memory.Dir = resolve("AM_MEMORY_DIR", DefaultMemoryDir(environ))
	cfg.FilmStyleLibrary = resolve(filmstyle.LibraryEnv, filmstyle.DefaultLibraryDir(environ, filmstyle.PinnedCommit))
	if value := resolve("MEMORY_SNAPSHOT", ""); value != "" {
		cfg.Memory.Snapshot, err = strconv.Atoi(value)
		if err != nil || cfg.Memory.Snapshot < 1 {
			return Config{}, fmt.Errorf("MEMORY_SNAPSHOT 必须是正整数快照号，留空表示跟随最新快照")
		}
	}
	cfg.Memory.RecallBudget, err = strconv.Atoi(resolve("MEMORY_RECALL_BUDGET", strconv.Itoa(DefaultMemoryRecallBudget)))
	if err != nil || cfg.Memory.RecallBudget < 0 {
		return Config{}, fmt.Errorf("MEMORY_RECALL_BUDGET 必须是非负整数")
	}
	cfg.Memory.Explore, err = strconv.ParseFloat(resolve("MEMORY_EXPLORE", strconv.FormatFloat(DefaultMemoryExplore, 'f', -1, 64)), 64)
	if err != nil || cfg.Memory.Explore < 0 || cfg.Memory.Explore > MaxMemoryExplore {
		return Config{}, fmt.Errorf("MEMORY_EXPLORE 必须是 0 到 %g 之间的小数（0 关闭探索）", MaxMemoryExplore)
	}
	return cfg, nil
}

func (c Config) ChildEnvironment(base map[string]string, unsafe bool, passthrough []string) map[string]string {
	if base == nil {
		base = envMap()
	}
	out := make(map[string]string)
	if unsafe {
		for key, value := range base {
			out[key] = value
		}
	} else {
		// USER / LOGNAME / SHELL 不是凭据，但工具链要靠它们确定身份：
		// macOS 上 claude CLI 缺 USER 就读不到 Keychain 里的登录态，
		// 报的却是「Not logged in」，与权限隔离毫无关联，极难排查。
		//
		// CODEX_HOME 同理不是凭据，而是 Codex 的数据目录：用户改过它时，缺了这个
		// 变量 Codex 回到 ~/.codex 找登录态，报未登录；内置生图的产物也落到
		// 那里，自定义风格的定风格阶段拿不到氛围参照图。
		allowed := []string{"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CODEX_HOME"}
		allowed = append(allowed, passthrough...)
		for _, key := range allowed {
			if value, ok := base[key]; ok {
				out[key] = value
			}
		}
	}
	for key, value := range c.Overlay {
		out[key] = value
	}
	out["ORCHESTRATOR"] = c.Orchestrator
	out["RENDERER"] = c.Renderer
	out["TTS_PROVIDER"] = c.TTSProvider
	if c.AlignProvider != "" {
		out["ALIGN_PROVIDER"] = c.AlignProvider
	}
	// 记忆设置与 ORCHESTRATOR 一样显式写进去：编排工具调用的 am memory remember、
	// am scene run 必须用同一个记忆库。安全模式的白名单里没有 AM_MEMORY_DIR，
	// 不写的话子进程回落到默认目录——既不是这一个库，也不在 codex 沙箱放行的范围里
	// （实测：偏好写入被拒，报「没有写入权限」）。
	if c.Memory.Dir != "" {
		out["AM_MEMORY_DIR"] = c.Memory.Dir
		out["MEMORY"] = "off"
		if c.Memory.Enabled {
			out["MEMORY"] = "on"
		}
		out["MEMORY_RECALL_BUDGET"] = strconv.Itoa(c.Memory.RecallBudget)
		out["MEMORY_EXPLORE"] = strconv.FormatFloat(c.Memory.Explore, 'f', -1, 64)
		if c.Memory.Snapshot > 0 {
			out["MEMORY_SNAPSHOT"] = strconv.Itoa(c.Memory.Snapshot)
		}
	}
	// 风格库目录同理显式写进去：默认目录由 XDG_DATA_HOME 推出，而它不在白名单里，
	// 编排工具调用的 am film-style 会算出另一个目录，找不到已下载的风格库与采样库。
	if c.FilmStyleLibrary != "" {
		out[filmstyle.LibraryEnv] = c.FilmStyleLibrary
	}
	if unsafe {
		out["AM_UNSAFE"] = "1"
	}
	return out
}
