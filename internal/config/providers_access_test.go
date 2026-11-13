package config

import (
	"reflect"
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

// 基础清单是给编排工具的「常用且不危险」命令：能执行任意代码或删改权限的一律不进，
// 否则安全模式的白名单形同虚设。要用解释器的工具（funasr 对应 python3）只按配置单独放行。
func TestOrchestratorBaseCommandsStayHarmless(t *testing.T) {
	forbidden := []string{"python", "python3", "node", "sh", "bash", "zsh", "rm", "chmod", "chown", "sudo", "brew", "pip", "pip3", "npm", "npx", "uv", "git", "eval", "env", "xargs"}
	for _, command := range orchestratorBaseCommands {
		for _, bad := range forbidden {
			if command == bad {
				t.Errorf("基础清单里不能有 %s", command)
			}
		}
	}
	for _, need := range []string{"cat", "head", "echo", "shasum", "curl", "git status"} {
		found := false
		for _, command := range orchestratorBaseCommands {
			found = found || command == need
		}
		if !found {
			t.Errorf("基础清单缺 %s：编排工具会被拦下（实测）", need)
		}
	}
}
