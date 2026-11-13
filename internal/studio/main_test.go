package studio

import (
	"os"
	"testing"
)

// TestMain 把记忆库指到临时目录：渲染记忆默认打开，没设 AM_MEMORY_DIR 的测试
// 会把经历与快照写进开发者真实的 ~/.local/share/am/memory。
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "am-memory-test-")
	if err != nil {
		panic(err)
	}
	os.Setenv("AM_MEMORY_DIR", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}
