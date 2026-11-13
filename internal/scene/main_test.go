package scene

import (
	"os"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
	"github.com/chouheiwa/articale-to-motion/internal/hyperframes/hftest"
)

// TestMain：渲染前会确保 am 管理的 HyperFrames CLI 已装好，测试里换成假的，
// 免得真的去 npm install。
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "am-hyperframes-cli-test-")
	if err != nil {
		panic(err)
	}
	if err := hftest.FakeCLI(dir); err != nil {
		panic(err)
	}
	os.Setenv(hyperframes.CLIDirEnv, dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
