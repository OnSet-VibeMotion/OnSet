package hyperframes

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
)

// CLI 是 am 管理的 HyperFrames CLI：按固定版本装在用户级目录里，所有项目、所有镜头共用。
//
// 以前由渲染器在渲染途中 `npx --yes hyperframes@<版本>` 现下载：版本一升级，第一次渲染
// 就要先下几十 MB 的 npm 包，网络不好时渲染器空等二十多分钟、花一次模型调用，最后只
// 留下「没有产物」（实测）。现在由 am 在 init 与渲染前装好，所有调用都走 `am hyperframes`，
// 下载失败在开工前就报出来，而且不再依赖 npx 自己那份缓存是否还在。

// CLICommand 是渲染器与编排工具调用 CLI 的写法。提示词、锁定文件与安全模式的放行列表
// 都用它，版本号只在 am 里出现一次。
const CLICommand = "am hyperframes"

// CLIDirEnv 覆盖 CLI 的安装目录（测试与特殊部署用）。
const CLIDirEnv = "AM_HYPERFRAMES_CLI_DIR"

// cliMarker 写在安装目录里，内容是版本号：只有完整装好、自检通过的目录才有它。
const cliMarker = ".am-cli"

// CLIOptions 描述一次 CLI 安装。
type CLIOptions struct {
	// Env 是当前进程环境：PATH 找 npm，HOME 让 npm 读到用户的 .npmrc（镜像、代理、鉴权）。
	Env map[string]string
	// Version 留空取 PinnedVersion。
	Version string
	// Output 接收 npm 的输出。
	Output io.Writer
	// Progress 非空时汇报进度（npm 不报可量的进度，只有阶段）。
	Progress func(Progress)
	// Package 是要安装的 npm 包规格，留空取 hyperframes@<Version>。测试用它指向本地包。
	Package string
}

func (o CLIOptions) version() string {
	if o.Version != "" {
		return o.Version
	}
	return PinnedVersion
}

// CLIDir 返回某个版本 CLI 的安装目录；env 里既没有 CLIDirEnv 也没有 HOME / XDG_DATA_HOME 时为空。
func CLIDir(env map[string]string, version string) string {
	if dir := env[CLIDirEnv]; dir != "" {
		return dir
	}
	root := DefaultCacheDir(env)
	if root == "" {
		return ""
	}
	return filepath.Join(root, "cli-"+version)
}

// CLIBinary 返回安装目录里 CLI 的可执行文件。
func CLIBinary(dir string) string {
	return filepath.Join(dir, "node_modules", ".bin", "hyperframes")
}

// CLIReady 表示 dir 里是完整安装好的 version。
func CLIReady(dir, version string) bool {
	if dir == "" {
		return false
	}
	body, err := os.ReadFile(filepath.Join(dir, cliMarker))
	if err != nil || strings.TrimSpace(string(body)) != version {
		return false
	}
	info, err := os.Stat(CLIBinary(dir))
	return err == nil && !info.IsDir()
}

// cliAttempts 是 npm install 的尝试次数：国内网络下单次安装被掐断是常态。
const cliAttempts = 3

// EnsureCLI 返回装好的 CLI 安装目录，没有时用 npm 安装。
//
// npm install 在同级临时目录里进行，装好、跑过 `--version` 自检后整体改名进位，
// 中途失败不会留下一份看起来能用的残缺安装；同一时间只有一个进程在装（锁文件）。
// npm 用用户自己的配置（~/.npmrc 里的镜像、代理与鉴权），装出的版本由包规格钉死。
func EnsureCLI(ctx context.Context, opts CLIOptions) (string, error) {
	version := opts.version()
	dir := CLIDir(opts.Env, version)
	if dir == "" {
		return "", fmt.Errorf("无法确定 HyperFrames CLI 的安装目录：环境里没有 HOME，可用 %s 指定", CLIDirEnv)
	}
	if CLIReady(dir, version) {
		return dir, nil
	}
	report := opts.Progress
	if report == nil {
		report = func(Progress) {}
	}
	npm, err := envutil.LookPath("npm", opts.Env["PATH"])
	if err != nil {
		return "", fmt.Errorf("找不到 npm（需要 Node 20+），无法安装 HyperFrames CLI：%w", err)
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return "", err
	}
	unlock, err := lockFile(ctx, dir+".lock")
	if err != nil {
		return "", err
	}
	defer unlock()
	if CLIReady(dir, version) { // 等锁期间另一个进程装好了
		return dir, nil
	}
	pkg := opts.Package
	if pkg == "" {
		pkg = "hyperframes@" + version
	}
	var lastErr error
	for attempt := 1; attempt <= cliAttempts; attempt++ {
		stage := "安装 HyperFrames CLI " + version
		if attempt > 1 {
			stage = fmt.Sprintf("安装 HyperFrames CLI %s（重试 %d/%d）", version, attempt, cliAttempts)
		}
		report(Progress{Stage: stage, Indeterminate: true})
		if lastErr = installCLI(ctx, npm, dir, pkg, version, opts); lastErr == nil {
			report(Progress{Stage: "HyperFrames CLI 已就绪", Percent: 100})
			return dir, nil
		}
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if opts.Output != nil && attempt < cliAttempts {
			fmt.Fprintf(opts.Output, "安装 HyperFrames CLI 失败，重试（%d/%d）：%v\n", attempt+1, cliAttempts, lastErr)
		}
	}
	return "", fmt.Errorf("安装 HyperFrames CLI %s 失败（npm 用的是你的 ~/.npmrc；网络好转后重新运行即可）：%w", version, lastErr)
}

func installCLI(ctx context.Context, npm, dir, pkg, version string, opts CLIOptions) error {
	staging, err := os.MkdirTemp(filepath.Dir(dir), ".cli-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	// 一个空的 package.json 让 npm 把依赖装进这个目录，而不是往上找到别的项目。
	if err := os.WriteFile(filepath.Join(staging, "package.json"), []byte(`{"private":true}`+"\n"), 0o644); err != nil {
		return err
	}
	output := opts.Output
	if output == nil {
		output = io.Discard
	}
	cmd := exec.CommandContext(ctx, npm, "install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", pkg)
	cmd.Dir = staging
	cmd.Env = envutil.EnvList(opts.Env)
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("npm install %s：%w", pkg, err)
	}
	binary := CLIBinary(staging)
	if _, err := os.Stat(binary); err != nil {
		return fmt.Errorf("npm 装完了但没有 %s：包结构已变", filepath.Base(binary))
	}
	// 自检：能跑起来、报出的版本对得上，才算装好。
	check := exec.CommandContext(ctx, binary, "--version")
	check.Dir = staging
	check.Env = envutil.EnvList(opts.Env)
	out, err := check.Output()
	if err != nil {
		return fmt.Errorf("装好的 HyperFrames CLI 跑不起来：%w", err)
	}
	if got := strings.TrimSpace(string(out)); !strings.Contains(got, version) {
		return fmt.Errorf("装好的 HyperFrames CLI 报告版本 %q，期望 %s", got, version)
	}
	if err := os.WriteFile(filepath.Join(staging, cliMarker), []byte(version+"\n"), 0o644); err != nil {
		return err
	}
	_ = os.RemoveAll(dir) // 没有完成标记的残缺安装
	return os.Rename(staging, dir)
}

// CLICommandFor 构造运行缓存里 CLI 的命令；args 原样传给它。
func CLICommandFor(ctx context.Context, dir string, env map[string]string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, CLIBinary(dir), args...)
	cmd.Env = envutil.EnvList(env)
	return cmd
}

// lockStale 之后的锁视为上一个进程崩溃留下的；npm 安装最长也就十几分钟。
const lockStale = 30 * time.Minute

func lockFile(ctx context.Context, path string) (func(), error) {
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			fmt.Fprintf(file, "%d\n", os.Getpid())
			file.Close()
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("创建锁 %s：%w", path, err)
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > lockStale {
			os.Remove(path)
			continue
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}
