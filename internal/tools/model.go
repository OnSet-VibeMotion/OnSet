package tools

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// DetectModel 从渲染工具的一行结构化输出里读出实际使用的模型；读不到时返回空串。
//
// claude、qoder、codebuddy 在 system/init 事件里带 model。codex 与 opencode 的流里
// 没有模型名（2026-11 实测录制，见 internal/agentrun/testdata），codex 改由
// ConfiguredModel 读配置文件，opencode 记为未知。
func DetectModel(tool, line string) string {
	switch tool {
	case "claude", "qoder", "codebuddy":
	default:
		return ""
	}
	var event struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Model   string `json:"model"`
	}
	if json.Unmarshal([]byte(line), &event) != nil || event.Type != "system" || event.Subtype != "init" {
		return ""
	}
	return strings.TrimSpace(event.Model)
}

// ConfiguredModel 返回渲染工具配置文件里声明的默认模型；没有声明或读不到时返回空串。
// 目前只有 codex 能这样读：$CODEX_HOME/config.toml（缺省 ~/.codex）顶层的 model。
func ConfiguredModel(tool string, env map[string]string) string {
	if tool != "codex" {
		return ""
	}
	home := env["CODEX_HOME"]
	if home == "" {
		if env["HOME"] == "" {
			return ""
		}
		home = filepath.Join(env["HOME"], ".codex")
	}
	file, err := os.Open(filepath.Join(home, "config.toml"))
	if err != nil {
		return ""
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		// 只认顶层键：进了 [profiles.x] 之类的表，model 就不是默认模型了。
		if strings.HasPrefix(line, "[") {
			return ""
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != "model" {
			continue
		}
		value = strings.TrimSpace(value)
		if i := strings.Index(value, "#"); i >= 0 && !strings.HasPrefix(value, "\"") {
			value = strings.TrimSpace(value[:i])
		}
		if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') {
			if end := strings.IndexByte(value[1:], value[0]); end >= 0 {
				return value[1 : end+1]
			}
		}
		return value
	}
	return ""
}
