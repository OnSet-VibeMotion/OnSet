package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestEveryProviderNamesItsCommand(t *testing.T) {
	for _, provider := range TTSProviders {
		if provider.Command == "" {
			t.Errorf("TTS %s 没有登记命令，安全模式下编排工具调用不了它", provider.ID)
		}
	}
	for _, aligner := range Aligners {
		if aligner.Command == "" {
			t.Errorf("对齐工具 %s 没有登记命令", aligner.ID)
		}
	}
}

func TestOrchestratorAccessFollowsConfig(t *testing.T) {
	cfg := Config{TTSProvider: "edge", AlignProvider: "mlx"}
	got := cfg.OrchestratorAccess("npx --yes hyperframes@1.0.0", "am").Commands
	want := append(append([]string{}, orchestratorBaseCommands...), "edge-tts", "mlx_audio.stt.generate", "npx --yes hyperframes@1.0.0")
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if again := cfg.OrchestratorAccess().Commands; len(again) != len(orchestratorBaseCommands)+2 || again[0] != "am" {
		t.Fatalf("基础清单被上一次调用改写了：%v", again)
	}
}

// 基础清单是给编排工具的常用命令：shell 本身、删除与改权限、安装与提权一律不进。
func TestOrchestratorBaseCommandsStayHarmless(t *testing.T) {
	forbidden := []string{"sh", "bash", "zsh", "rm", "chmod", "chown", "sudo", "brew", "pip", "pip3", "npm", "npx", "uv", "git", "eval", "env", "xargs"}
	for _, command := range orchestratorBaseCommands {
		for _, bad := range forbidden {
			if command == bad {
				t.Errorf("基础清单里不能有 %s", command)
			}
		}
	}
	for _, need := range []string{"cat", "head", "echo", "shasum", "curl", "git status", "python3", "node"} {
		found := false
		for _, command := range orchestratorBaseCommands {
			found = found || command == need
		}
		if !found {
			t.Errorf("基础清单缺 %s：编排工具会被拦下（实测）", need)
		}
	}
}

func TestOrchestratorAllowCommandsExtendTheAllowlist(t *testing.T) {
	root := t.TempDir()
	writeConf := func(body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, "article-to-motion.conf"), []byte("ORCHESTRATOR=claude\nRENDERER=claude\n"+body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeConf("ORCHESTRATOR_ALLOW_COMMANDS=uv run,  pnpm ,magick\n")
	cfg, err := Load(root, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	commands := cfg.OrchestratorAccess().Commands
	for _, want := range []string{"uv run", "pnpm", "magick"} {
		found := false
		for _, command := range commands {
			found = found || command == want
		}
		if !found {
			t.Errorf("补充的命令 %q 没有放行：%v", want, commands)
		}
	}
	for _, bad := range []string{"rm -rf /; ls", "a && b", "$(evil)", "x | y"} {
		writeConf("ORCHESTRATOR_ALLOW_COMMANDS=" + bad + "\n")
		if _, err := Load(root, map[string]string{}); err == nil || !strings.Contains(err.Error(), "ORCHESTRATOR_ALLOW_COMMANDS") {
			t.Errorf("%q 应当被拒绝：%v", bad, err)
		}
	}
}
