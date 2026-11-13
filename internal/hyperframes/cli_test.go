package hyperframes

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakePackage 造一个本地 npm 包：bin 名为 hyperframes，--version 打印 version。
// 用 file: 规格安装，走的是与真实安装相同的 npm install 路径，完全离线。
func fakePackage(t *testing.T, version string) string {
	t.Helper()
	dir := t.TempDir()
	files := map[string]string{
		"package.json": `{"name":"hyperframes","version":"` + version + `","bin":{"hyperframes":"cli.js"}}`,
		"cli.js":       "#!/usr/bin/env node\nif (process.argv[2] === '--version') { console.log('" + version + "'); } else { console.log('ran ' + process.argv.slice(2).join(' ')); }\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func requireNpm(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("npm"); err != nil {
		t.Skip("没有 npm")
	}
}

// am 管理 CLI：装进指定目录、自检通过才算装好；再调用时直接用，不再碰 npm。
func TestEnsureCLIInstallsOnceAndReusesTheCache(t *testing.T) {
	requireNpm(t)
	pkg := fakePackage(t, "9.9.9")
	dir := filepath.Join(t.TempDir(), "cli-9.9.9")
	env := map[string]string{"PATH": os.Getenv("PATH"), "HOME": os.Getenv("HOME"), CLIDirEnv: dir}
	got, err := EnsureCLI(context.Background(), CLIOptions{Env: env, Version: "9.9.9", Package: "file:" + pkg, Output: &bytes.Buffer{}})
	if err != nil {
		t.Fatal(err)
	}
	if got != dir || !CLIReady(dir, "9.9.9") {
		t.Fatalf("应当装进 %s 并带完成标记：%s", dir, got)
	}
	out, err := CLICommandFor(context.Background(), dir, env, "render", "--quality", "high").Output()
	if err != nil || !strings.Contains(string(out), "ran render --quality high") {
		t.Fatalf("应当把参数原样转给 CLI：%q %v", out, err)
	}
	// 第二次连 npm 都找不到，照样可用：说明走的是缓存。
	env["PATH"] = t.TempDir() + string(os.PathListSeparator) + filepath.Dir(nodePath(t))
	if _, err := EnsureCLI(context.Background(), CLIOptions{Env: env, Version: "9.9.9", Package: "file:" + pkg}); err != nil {
		t.Fatalf("已装好时不该再安装：%v", err)
	}
}

func nodePath(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("node")
	if err != nil {
		t.Skip("没有 node")
	}
	return path
}

// 版本对不上（自检失败）就不算装好，也不留下残缺目录；版本号写在完成标记里，换版本会重装。
func TestEnsureCLIRejectsWrongVersion(t *testing.T) {
	requireNpm(t)
	pkg := fakePackage(t, "1.0.0")
	dir := filepath.Join(t.TempDir(), "cli-9.9.9")
	env := map[string]string{"PATH": os.Getenv("PATH"), "HOME": os.Getenv("HOME"), CLIDirEnv: dir}
	_, err := EnsureCLI(context.Background(), CLIOptions{Env: env, Version: "9.9.9", Package: "file:" + pkg, Output: &bytes.Buffer{}})
	if err == nil || !strings.Contains(err.Error(), "期望 9.9.9") {
		t.Fatalf("报告的版本不对时应当失败：%v", err)
	}
	if _, statErr := os.Stat(dir); statErr == nil {
		t.Error("失败的安装不该留下目录")
	}
	if CLIReady(dir, "9.9.9") {
		t.Error("失败的安装不该被当成可用")
	}
}

func TestCLIDirFollowsEnvironment(t *testing.T) {
	if got := CLIDir(map[string]string{"HOME": "/h"}, "1.2.3"); got != "/h/.local/share/am/hyperframes/cli-1.2.3" {
		t.Errorf("默认目录不对：%s", got)
	}
	if got := CLIDir(map[string]string{"HOME": "/h", "XDG_DATA_HOME": "/x"}, "1.2.3"); got != "/x/am/hyperframes/cli-1.2.3" {
		t.Errorf("应当遵循 XDG_DATA_HOME：%s", got)
	}
	if got := CLIDir(map[string]string{"HOME": "/h", CLIDirEnv: "/c"}, "1.2.3"); got != "/c" {
		t.Errorf("显式指定的目录优先：%s", got)
	}
	if got := CLIDir(map[string]string{}, "1.2.3"); got != "" {
		t.Errorf("没有 HOME 时不猜家目录：%s", got)
	}
}
