package studio

import (
	"context"
	"os"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
	"github.com/chouheiwa/articale-to-motion/internal/hyperframes/hftest"
)

// TestMain 把记忆库指到临时目录：渲染记忆默认打开，没设 AM_MEMORY_DIR 的测试
// 会把经历与快照写进开发者真实的 ~/.local/share/am/memory。
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "am-memory-test-")
	if err != nil {
		panic(err)
	}
	os.Setenv("AM_MEMORY_DIR", dir)
	// 渲染前会确保 am 管理的 HyperFrames CLI 已装好；测试里换成假的，免得真的去 npm install。
	cli := dir + "/hyperframes-cli"
	if err := hftest.FakeCLI(cli); err != nil {
		panic(err)
	}
	os.Setenv(hyperframes.CLIDirEnv, cli)
	// 新建项目会在后台装 HyperFrames 官方技能，要联网；测试里换成什么都不做。
	installOfficialSkills = func(context.Context, string, func(hyperframes.Progress)) error { return nil }
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
