package filmstyle

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
)

// SetupOptions 描述一次风格库依赖安装。
type SetupOptions struct {
	Env    map[string]string
	Output io.Writer
}

func (o SetupOptions) output() io.Writer {
	if o.Output != nil {
		return o.Output
	}
	return io.Discard
}

// nodeMarker 记录装 node_modules 时 package.json 与 package-lock.json 的摘要。
const nodeMarker = ".am-ok"

// SetupNode 在风格库里按 package-lock.json 装 Node 依赖（three.js）。只有用 three.js 的
// 风格要它，由 EnsureForProject 在安装那种风格时调用。
// 用 npm ci 而不是 npm install：后者会改写锁文件，同一个 commit 装出不同版本。
// --ignore-scripts：只要 three 的源文件，不跑任何安装脚本，也不下载浏览器。
func SetupNode(ctx context.Context, lib Library, opts SetupOptions) error {
	want, err := filesDigest(filepath.Join(lib.Dir, "package.json"), filepath.Join(lib.Dir, "package-lock.json"))
	if err != nil {
		return fmt.Errorf("读取风格库的 package.json：%w", err)
	}
	marker := filepath.Join(lib.Dir, "node_modules", nodeMarker)
	if got, _ := os.ReadFile(marker); strings.TrimSpace(string(got)) == want {
		return nil
	}
	npm, err := envutil.LookPath("npm", opts.Env["PATH"])
	if err != nil {
		return fmt.Errorf("找不到 npm（需要 Node 20+），无法安装风格库的 three.js：%w", err)
	}
	fmt.Fprintln(opts.output(), "安装风格库的 Node 依赖（npm ci）…")
	cmd := exec.CommandContext(ctx, npm, "ci", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts")
	cmd.Dir = lib.Dir
	cmd.Env = envutil.EnvList(opts.Env)
	cmd.Stdout, cmd.Stderr = opts.output(), opts.output()
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("npm ci 失败：%w", err)
	}
	return os.WriteFile(marker, []byte(want+"\n"), 0o644)
}

func filesDigest(paths ...string) (string, error) {
	hash := sha256.New()
	for _, path := range paths {
		body, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		hash.Write(body)
	}
	return hex.EncodeToString(hash.Sum(nil))[:16], nil
}
