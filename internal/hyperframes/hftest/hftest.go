// Package hftest 给测试造一份「已装好」的 HyperFrames CLI，免得测试真的去 npm install。
package hftest

import (
	"os"
	"path/filepath"

	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
)

// FakeCLI 在 dir 里写出带完成标记的假 CLI：它打印版本号并原样回显参数，退出码 0。
// 测试的 TestMain 把 hyperframes.CLIDirEnv 指向这里。
func FakeCLI(dir string) error {
	bin := hyperframes.CLIBinary(dir)
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		return err
	}
	script := "#!/bin/sh\nif [ \"$1\" = --version ]; then echo " + hyperframes.PinnedVersion + "; exit 0; fi\necho \"fake hyperframes $*\"\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ".am-cli"), []byte(hyperframes.PinnedVersion+"\n"), 0o644)
}
