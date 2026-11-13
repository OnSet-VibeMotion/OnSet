package filmstyle

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

// Library 是一份风格库检出。
type Library struct {
	// Dir 是检出根目录（含 core/、styles/）。
	Dir string
	// Commit 是检出的 commit；读不到时为空。
	Commit string
	// Managed 表示这份检出由 am 克隆（有 managedMarker）；
	// 为 false 时是用户自己的检出，am 不改动它的 git 状态。
	Managed bool
}

// LibraryOptions 描述一次风格库准备。
type LibraryOptions struct {
	// Env 是当前进程环境：PATH、代理、HOME / XDG_DATA_HOME 与 LibraryEnv。
	Env map[string]string
	// RepoURL 留空取 RepoURL；测试指向本地夹具仓库。
	RepoURL string
	// Commit 留空取 PinnedCommit。
	Commit string
	// Output 接收 git 的错误输出。
	Output io.Writer
}

func (o LibraryOptions) repo() string {
	if o.RepoURL != "" {
		return o.RepoURL
	}
	return RepoURL
}

func (o LibraryOptions) commit() string {
	if o.Commit != "" {
		return o.Commit
	}
	return PinnedCommit
}

// DefaultLibraryDir 返回默认的用户级风格库目录：按 commit 分目录，升级 am 换了
// 固定版本时新旧两份并存，老项目引用的那份不会被改写。
func DefaultLibraryDir(env map[string]string, commit string) string {
	base := env["XDG_DATA_HOME"]
	if base == "" {
		home := env["HOME"]
		if home == "" {
			home, _ = os.UserHomeDir()
		}
		base = filepath.Join(home, ".local", "share")
	}
	if len(commit) > 12 {
		commit = commit[:12]
	}
	return filepath.Join(base, "am", "lemo-opuscar", commit)
}

// LibraryDir 返回本次要用的风格库目录：LibraryEnv 优先，否则默认目录。
func LibraryDir(opts LibraryOptions) string {
	if dir := opts.Env[LibraryEnv]; dir != "" {
		return dir
	}
	return DefaultLibraryDir(opts.Env, opts.commit())
}

func isLibrary(dir string) bool {
	for _, rel := range []string{"core/lib.js", "styles"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err != nil {
			return false
		}
	}
	return true
}

// OpenLibrary 返回已有的风格库，不联网；没有时返回 os.ErrNotExist。
func OpenLibrary(opts LibraryOptions) (Library, error) {
	dir := LibraryDir(opts)
	if !isLibrary(dir) {
		return Library{}, fmt.Errorf("风格库 %s 还没有下载：%w", dir, os.ErrNotExist)
	}
	_, markerErr := os.Stat(filepath.Join(dir, managedMarker))
	lib := Library{Dir: dir, Managed: markerErr == nil}
	if git, err := envutil.LookPath("git", opts.Env["PATH"]); err == nil {
		if out, err := gitCommand(context.Background(), git, dir, opts.Env, nil, "rev-parse", "HEAD"); err == nil {
			lib.Commit = out
		}
	}
	return lib, nil
}

// EnsureLibrary 返回可用的风格库，没有时按固定 commit 稀疏克隆。
//
// 只检出指南、core/、tools/ 与每种风格的 STYLE.md / style.json / DEMO.md；
// demo 源码、海报与图鉴按用到的风格单独补（EnsureDemo），与上游 setup.sh 的
// 稀疏规则一致。
//
// 下载可以续传：克隆在固定的 <目录>.partial 里进行，失败时保留，下次接着下。
// --filter=blob:none 的文件内容是检出时一批取回的，一批里断一次整批白下，
// 所以检出分成 libraryStages 几段逐段扩大稀疏规则，每段取回的文件留在本地，
// 每段各自重试。全部完成、校验过 commit 后才整体改名进位，别处看到的风格库
// 永远是完整的。同一时间只有一个进程在下（锁文件）。
func EnsureLibrary(ctx context.Context, opts LibraryOptions) (Library, error) {
	if lib, err := OpenLibrary(opts); err == nil {
		return lib, nil
	}
	dir := LibraryDir(opts)
	// 用户经 LibraryEnv 指向的已有目录不是风格库时不往里克隆：那多半是指错了地方。
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		return Library{}, fmt.Errorf("%s 不是 lemo-opuscar 风格库（缺少 core/lib.js 或 styles/）", dir)
	}
	git, err := envutil.LookPath("git", opts.Env["PATH"])
	if err != nil {
		return Library{}, fmt.Errorf("找不到 git，无法下载风格库：%w", err)
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return Library{}, err
	}
	unlock, err := lock(ctx, dir+".lock")
	if err != nil {
		return Library{}, err
	}
	defer unlock()
	// 等锁期间另一个进程可能已经下完了。
	if lib, err := OpenLibrary(opts); err == nil {
		return lib, nil
	}
	partial := dir + ".partial"
	commit := opts.commit()
	if err := downloadLibrary(ctx, git, partial, commit, opts); err != nil {
		return Library{}, fmt.Errorf("%w\n已下载的部分保留在 %s，再运行一次会接着下载；也可以自己 git clone %s 后用 %s 指向它",
			err, partial, strings.TrimSuffix(opts.repo(), ".git"), LibraryEnv)
	}
	if err := os.WriteFile(filepath.Join(partial, managedMarker), []byte(commit+"\n"), 0o644); err != nil {
		return Library{}, err
	}
	_ = os.Remove(dir) // 空目录（例如开工前预先建好的）挡不住改名
	if err := os.Rename(partial, dir); err != nil {
		return Library{}, fmt.Errorf("放置风格库到 %s：%w", dir, err)
	}
	return Library{Dir: dir, Commit: commit, Managed: true}, nil
}

// libraryStages 是检出的几段稀疏规则，逐段扩大，最后一段等于 librarySparse。
// 先取体积小、立刻要用的（顶层文件、core/ 的代码、每种风格的说明），
// 体积大的（core/assets/ 等）放最后。
var libraryStages = [][]string{
	{"/*", "!/*/"},
	{"/*", "!/*/", "/core/", "!/core/assets/"},
	{"/*", "!/*/", "/core/", "!/core/assets/", "/styles/*/STYLE.md", "/styles/*/style.json", "/styles/*/DEMO.md"},
	librarySparse,
}

// stageAttempts 是每一步网络操作的尝试次数。经代理时偶尔整条 TLS 握手失败
// （SSL_ERROR_SYSCALL），重连一次就好，所以给得宽。
const stageAttempts = 5

// downloadLibrary 把 commit 下载并检出到 partial，已有的进度直接沿用。
func downloadLibrary(ctx context.Context, git, partial, commit string, opts LibraryOptions) error {
	run := func(args ...string) (string, error) {
		return gitCommand(ctx, git, partial, opts.Env, opts.Output, args...)
	}
	retry := func(what string, args ...string) error {
		var err error
		for attempt := 1; attempt <= stageAttempts; attempt++ {
			if _, err = run(args...); err == nil {
				return nil
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if opts.Output != nil && attempt < stageAttempts {
				fmt.Fprintf(opts.Output, "%s失败，重试（%d/%d）…\n", what, attempt+1, stageAttempts)
			}
		}
		return fmt.Errorf("%s失败：%w", what, err)
	}
	if _, err := os.Stat(filepath.Join(partial, ".git")); err != nil {
		if err := os.RemoveAll(partial); err != nil {
			return err
		}
		if err := os.MkdirAll(partial, 0o755); err != nil {
			return err
		}
		for _, step := range [][]string{
			{"init", "--quiet"},
			{"remote", "add", "origin", opts.repo()},
			{"config", "core.sparseCheckout", "true"},
		} {
			if _, err := run(step...); err != nil {
				return fmt.Errorf("准备风格库克隆（git %s）：%w", strings.Join(step, " "), err)
			}
		}
	} else if _, err := run("remote", "set-url", "origin", opts.repo()); err != nil {
		return fmt.Errorf("更新风格库的上游地址：%w", err)
	}
	if _, err := run("rev-parse", "--verify", "--quiet", commit+"^{commit}"); err != nil {
		if err := retry("从 "+opts.repo()+" 下载风格库 "+commit+" ", "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", commit); err != nil {
			return err
		}
	}
	if head, _ := run("rev-parse", "--verify", "--quiet", "HEAD"); head != commit {
		if err := writeSparse(partial, libraryStages[0]); err != nil {
			return err
		}
		if err := retry("检出风格库", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", commit); err != nil {
			return err
		}
	}
	for i, patterns := range libraryStages {
		if err := writeSparse(partial, patterns); err != nil {
			return err
		}
		// --reset：上一次在这一段中途断开时工作区可能只更新了一半，按 HEAD 重来。
		if err := retry(fmt.Sprintf("检出风格库（第 %d/%d 段）", i+1, len(libraryStages)), "read-tree", "--reset", "-u", "HEAD"); err != nil {
			return err
		}
	}
	head, err := run("rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if head != commit {
		return fmt.Errorf("风格库检出到 %s，与固定的 %s 不符，拒绝使用", head, commit)
	}
	if !isLibrary(partial) {
		return fmt.Errorf("风格库 %s 上缺少 core/lib.js 或 styles/：上游目录结构已变", commit)
	}
	return nil
}

// managedMarker 标记一份由 am 克隆的风格库：只有它的稀疏规则可以由 am 改
// （EnsureDemo 补 demo）。用户自己的检出没有这个文件，am 不碰它的 git 状态。
// 不用「目录是不是默认目录」来判断：am 会把风格库目录经 LibraryEnv 显式传给
// 子进程，子进程看到的总是显式指定。
const managedMarker = ".am-library"

// librarySparse 是风格库的稀疏检出规则（非 cone 模式）。
var librarySparse = []string{
	"/*",
	"!/styles/*/demo/",
	"!/styles/*/poster.jpg",
	"!/styleboard/",
	"!/docs/",
	"!/core/assets/",
}

func writeSparse(dir string, patterns []string) error {
	info := filepath.Join(dir, ".git", "info")
	if err := os.MkdirAll(info, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(info, "sparse-checkout"), []byte(strings.Join(patterns, "\n")+"\n"), 0o644)
}

func readSparse(dir string) ([]string, error) {
	body, err := os.ReadFile(filepath.Join(dir, ".git", "info", "sparse-checkout"))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, line := range strings.Split(string(body), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out = append(out, line)
		}
	}
	return out, nil
}

// EnsureDemo 让风格库里有 slug 的 demo 源码与海报。用户指定的检出（不归 am 管）
// 原样使用：没有就报错，不去改它的稀疏规则。
func EnsureDemo(ctx context.Context, lib Library, slug string, opts LibraryOptions) error {
	demo := filepath.Join(lib.Dir, "styles", slug, "demo")
	_, statErr := os.Stat(filepath.Join(demo, "index.html"))
	if !lib.Managed {
		if statErr != nil {
			return fmt.Errorf("风格库 %s 里没有 %s 的 demo 源码（styles/%s/demo/）", lib.Dir, slug, slug)
		}
		return nil
	}
	// am 管理的风格库以完成记录为准，不以 index.html 在不在为准：上一次在取文件
	// 中途断开时 index.html 可能已经写出、其余文件还没有。
	if statErr == nil && demoDone(lib.Dir, slug) && (!DemoUsesCoreAssets(demo) || coreAssetsReady(lib.Dir)) {
		return nil
	}
	git, err := envutil.LookPath("git", opts.Env["PATH"])
	if err != nil {
		return fmt.Errorf("找不到 git，无法下载 demo 源码：%w", err)
	}
	unlock, err := lock(ctx, lib.Dir+".lock")
	if err != nil {
		return err
	}
	defer unlock()
	patterns, err := readSparse(lib.Dir)
	if err != nil {
		return fmt.Errorf("读取风格库稀疏规则：%w", err)
	}
	for _, add := range []string{"/styles/" + slug + "/demo/", "/styles/" + slug + "/poster.jpg"} {
		if !contains(patterns, add) {
			patterns = append(patterns, add)
		}
	}
	if err := writeSparse(lib.Dir, patterns); err != nil {
		return err
	}
	readTree := func() error {
		var readErr error
		for attempt := 1; attempt <= stageAttempts; attempt++ {
			if _, readErr = gitCommand(ctx, git, lib.Dir, opts.Env, opts.Output, "read-tree", "--reset", "-u", "HEAD"); readErr == nil || ctx.Err() != nil {
				break
			}
		}
		return readErr
	}
	if err := readTree(); err != nil {
		// 稀疏规则已经写进去了，下次 EnsureDemo 看到 demo 不全会接着取。
		return fmt.Errorf("下载 %s 的 demo 源码失败（再运行一次会接着下载）：%w", slug, err)
	}
	if _, err := os.Stat(filepath.Join(demo, "index.html")); err != nil {
		return fmt.Errorf("风格库里 %s 的 demo 没有 index.html：上游目录结构已变", slug)
	}
	// core/assets/（约 12 MB 的 3D 模型）只有个别风格用，不在首次检出里，用到时才取。
	if DemoUsesCoreAssets(demo) && !coreAssetsReady(lib.Dir) {
		if !contains(patterns, "/core/assets/") {
			patterns = append(patterns, "/core/assets/") // 非 cone 规则后写的生效，盖过 !/core/assets/
		}
		if err := writeSparse(lib.Dir, patterns); err != nil {
			return err
		}
		if err := readTree(); err != nil {
			return fmt.Errorf("下载 %s 要用的 core/assets/ 失败（再运行一次会接着下载）：%w", slug, err)
		}
		if err := os.WriteFile(filepath.Join(lib.Dir, ".git", coreAssetsDone), []byte("ok\n"), 0o644); err != nil {
			return err
		}
	}
	return markDemoDone(lib.Dir, slug)
}

// coreAssetsDone 是 core/assets/ 完整取回的记录，理由同 demosDoneFile。
const coreAssetsDone = "am-core-assets"

func coreAssetsReady(libDir string) bool {
	_, err := os.Stat(filepath.Join(libDir, ".git", coreAssetsDone))
	return err == nil
}

// DemoUsesCoreAssets 判断 demo 源码是否引用风格库的 core/assets/（Poly Haven 模型与贴图）。
func DemoUsesCoreAssets(demo string) bool {
	found := false
	_ = filepath.WalkDir(demo, func(path string, entry os.DirEntry, err error) error {
		if err != nil || found {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			if skipInDemo[entry.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		switch strings.ToLower(filepath.Ext(path)) {
		case ".js", ".mjs", ".html", ".json":
		default:
			return nil
		}
		if body, readErr := os.ReadFile(path); readErr == nil && strings.Contains(string(body), "core/assets/") {
			found = true
		}
		return nil
	})
	return found
}

// demosDoneFile 记录已经完整取回 demo 的风格，一行一个。
const demosDoneFile = "am-demos"

func demoDone(libDir, slug string) bool {
	body, err := os.ReadFile(filepath.Join(libDir, ".git", demosDoneFile))
	if err != nil {
		return false
	}
	return contains(strings.Fields(string(body)), slug)
}

func markDemoDone(libDir, slug string) error {
	if demoDone(libDir, slug) {
		return nil
	}
	file, err := os.OpenFile(filepath.Join(libDir, ".git", demosDoneFile), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = fmt.Fprintln(file, slug)
	return err
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// gitCommand 在 dir 里运行 git，屏蔽用户 git 配置并跳过 LFS，返回去掉首尾空白的标准输出。
func gitCommand(ctx context.Context, git, dir string, env map[string]string, stderr io.Writer, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, git, args...)
	cmd.Dir = dir
	cmd.Env = envutil.EnvList(gitEnv(env))
	cmd.Stderr = stderr
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// gitEnv 沿用 PATH 与代理，屏蔽用户的 git 配置：钩子、filter、autocrlf 会让
// 同一个 commit 在不同机器上检出不同的树。
func gitEnv(env map[string]string) map[string]string {
	out := make(map[string]string, len(env)+4)
	for key, value := range env {
		out[key] = value
	}
	out["GIT_LFS_SKIP_SMUDGE"] = "1"
	out["GIT_CONFIG_GLOBAL"] = os.DevNull
	out["GIT_CONFIG_SYSTEM"] = os.DevNull
	out["GIT_TERMINAL_PROMPT"] = "0"
	// 连接被掐断时 git 的按需取文件（--filter=blob:none）不报错，只是一直挂着
	// （实测：检出时 fetch-pack 断开后整个 am 卡了半小时）。低于 1 KB/s 持续
	// 60 秒就放弃，让调用方拿到一个能重试的错误。用户显式设置时尊重用户的值。
	if out["GIT_HTTP_LOW_SPEED_LIMIT"] == "" {
		out["GIT_HTTP_LOW_SPEED_LIMIT"] = "1000"
	}
	if out["GIT_HTTP_LOW_SPEED_TIME"] == "" {
		out["GIT_HTTP_LOW_SPEED_TIME"] = "60"
	}
	return out
}

// lockStale 之后的锁视为上一个进程崩溃留下的。
const lockStale = 30 * time.Minute

// lock 以独占创建锁文件的方式串行化对同一份风格库的改动。
func lock(ctx context.Context, path string) (func(), error) {
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
		case <-time.After(200 * time.Millisecond):
		}
	}
}
