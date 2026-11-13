package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
	"github.com/chouheiwa/articale-to-motion/internal/prereq"
	"github.com/chouheiwa/articale-to-motion/internal/prereqs"
)

func newSetupCommand(stdout, stderr io.Writer) *cobra.Command {
	var check bool
	var only []string
	var proxy, npmRegistry string
	cmd := &cobra.Command{
		Use:   "setup",
		Args:  noArgs,
		Short: "下载并准备全部前置资源（HyperFrames 技能与 CLI、整片风格来源）",
		Long: `要联网的东西都由这一条命令准备，放在用户级目录里，所有项目共用：

  skills   HyperFrames ` + hyperframesVersion + ` 官方技能（git，缓存在 ~/.local/share/am/hyperframes/<commit>）
  cli      HyperFrames CLI ` + hyperframesVersion + `（npm，装在 ~/.local/share/am/hyperframes/cli-<版本>）
  styles   每个整片风格来源一项（styles:<来源>），数据放在 ~/.local/share/am/film-styles/<来源>；
           已登记的来源：
` + sourceSummary() + `

其余命令（am init、am film-style use、am scene run、am hyperframes、am studio）只检查
不下载，缺了就提示先运行 am setup。已就绪的项直接跳过；下载断了再运行一次会接着下。
git 与 npm 的原始输出写进 ~/.local/share/am/setup.log，失败时屏幕上给出最后几行。

--proxy 只给 git（GitHub）用，例如本机的 Clash；npm 照常用你 ~/.npmrc 里的镜像与代理，
要临时换源用 --npm-registry。--only 认 skills、cli、styles（全部风格来源）或
styles:<来源>。--check 只报告哪些已就绪、哪些缺，不下载；有缺项时退出码为 1。`,
		Example: `  am setup
  am setup --proxy http://127.0.0.1:7890
  am setup --only styles --proxy http://127.0.0.1:7890
  am setup --only styles:lemo-opuscar
  am setup --check`,
		RunE: func(cmd *cobra.Command, args []string) error {
			env := currentEnvironment()
			selected, err := selectSetupItems(prereqs.Items(), only)
			if err != nil {
				return err
			}
			if check {
				return setupCheck(stdout, env, selected)
			}
			return setupPrepare(cmd.Context(), stdout, env, selected, proxy, npmRegistry)
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "只检查哪些已就绪，不下载；有缺项时退出码为 1")
	cmd.Flags().StringSliceVar(&only, "only", nil, "只准备其中几项：skills、cli、styles 或 styles:<来源>（可逗号分隔）")
	cmd.Flags().StringVar(&proxy, "proxy", "", "git 下载（GitHub）用的代理，例如 http://127.0.0.1:7890；不影响 npm")
	cmd.Flags().StringVar(&npmRegistry, "npm-registry", "", "npm 用的源，覆盖 ~/.npmrc 的 registry")
	_ = stderr
	return cmd
}

func selectSetupItems(items []prereqs.Item, only []string) ([]prereqs.Item, error) {
	wanted := map[string]bool{}
	for _, value := range only {
		for _, id := range strings.Split(value, ",") {
			if id = strings.TrimSpace(id); id != "" {
				wanted[id] = true
			}
		}
	}
	for id := range wanted {
		known := false
		for _, item := range items {
			known = known || item.ID == id || item.Group == id
		}
		if !known {
			var names []string
			for _, item := range items {
				names = append(names, item.ID)
			}
			return nil, fmt.Errorf("--only 不认 %q（可选：skills、cli、styles、%s）", id, strings.Join(names, "、"))
		}
	}
	var selected []prereqs.Item
	for _, item := range items {
		if len(wanted) == 0 || wanted[item.ID] || wanted[item.Group] {
			selected = append(selected, item)
		}
	}
	return selected, nil
}

func newItemsView(stdout io.Writer, items []prereqs.Item) *setupView {
	names, versions := make([]string, len(items)), make([]string, len(items))
	for i, item := range items {
		names[i], versions[i] = item.Name, item.Version
	}
	return newSetupView(stdout, names, versions)
}

// setupCheck 只报告：每项一行，已就绪 / 缺，附位置。
func setupCheck(stdout io.Writer, env map[string]string, items []prereqs.Item) error {
	view := newItemsView(stdout, items)
	nameWidth, versionWidth := view.widths()
	fmt.Fprintln(stdout)
	missing := 0
	for _, item := range items {
		ok, where := item.Ready(env)
		icon, state := view.paint("32", "✓"), "已就绪"
		if !ok {
			icon, state = view.paint("31", "✗"), view.paint("31", "缺")
			missing++
		}
		version := ""
		if versionWidth > 0 {
			version = view.paint("2", pad(item.Version, versionWidth)) + "  "
		}
		fmt.Fprintf(stdout, "  %s %s  %s%s  %s\n", icon, pad(item.Name, nameWidth), version, pad(state, 6), view.paint("2", homeShort(where)))
	}
	fmt.Fprintln(stdout)
	if missing > 0 {
		fmt.Fprintf(stdout, "缺 %d 项，运行 %s 准备。\n", missing, prereq.SetupCommand)
		return &exitError{code: 1, message: ""}
	}
	fmt.Fprintln(stdout, "前置资源都已就绪。")
	return nil
}

// setupLogPath 是 git / npm 原始输出的日志：<数据目录>/am/setup.log，每次运行覆盖。
func setupLogPath(env map[string]string) string {
	return filepath.Join(filepath.Dir(hyperframes.DefaultCacheDir(env)), "setup.log")
}

// setupPrepare 逐项准备，界面每项一行；失败时停下，给出错误与日志最后几行。
func setupPrepare(ctx context.Context, stdout io.Writer, env map[string]string, items []prereqs.Item, proxy, npmRegistry string) error {
	logPath := setupLogPath(env)
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return err
	}
	logFile, err := os.Create(logPath)
	if err != nil {
		return fmt.Errorf("创建日志 %s：%w", logPath, err)
	}
	defer logFile.Close()

	// git 的代理用 GIT_CONFIG_PARAMETERS（等同 git -c http.proxy=…）只给 git：
	// 设成 HTTPS_PROXY 的话 npm 也会走它，国内镜像经代理反而连不上（实测）。
	run := prereqs.Run{Base: env, Git: cloneMap(env), NPM: cloneMap(env), Log: logFile}
	if proxy != "" {
		run.Git["GIT_CONFIG_PARAMETERS"] = "'http.proxy'='" + proxy + "'"
	}
	if npmRegistry != "" {
		run.NPM["npm_config_registry"] = npmRegistry
	}
	run.Mixed = cloneMap(run.Git)
	if npmRegistry != "" {
		run.Mixed["npm_config_registry"] = npmRegistry
	}

	view := newItemsView(stdout, items)
	header := "am setup · 准备前置资源"
	if proxy != "" {
		header += view.paint("2", "（git 代理 "+proxy+"）")
	}
	fmt.Fprintf(stdout, "\n%s\n\n", header)
	for i, item := range items {
		if ok, _ := item.Ready(env); ok {
			view.items[i].state = viewReady
		}
	}
	if !view.tty {
		for i := range items {
			if view.items[i].state == viewReady {
				view.Set(i, viewReady, "")
			}
		}
	}
	view.Start()
	started := time.Now()
	for i, item := range items {
		if view.items[i].state == viewReady {
			continue
		}
		fmt.Fprintf(logFile, "\n===== %s %s =====\n", item.Name, item.Version)
		view.Set(i, viewRunning, "准备中")
		index := i
		run.Stage = func(stage string) { view.Detail(index, stage) }
		if err := item.Prepare(ctx, run); err != nil {
			fmt.Fprintf(logFile, "\n[am] %v\n", err)
			view.Set(i, viewFailed, "")
			view.Stop()
			logFile.Sync()
			body, _ := os.ReadFile(logPath)
			fmt.Fprintf(stdout, "\n%s %s 没准备好：%v\n", view.paint("31", "✗"), item.Name, err)
			// 日志最后一行是 am 自己记的错误，上面已经打过，不重复。
			if tail := tailLines(strings.TrimRight(string(body[:max(0, strings.LastIndex(string(body), "\n[am] "))]), "\n"), 12); len(tail) > 0 {
				fmt.Fprintln(stdout, view.paint("2", "\n  日志最后几行："))
				for _, line := range tail {
					fmt.Fprintln(stdout, view.paint("2", "  │ "+line))
				}
			}
			fmt.Fprintf(stdout, "\n完整日志：%s\n再运行一次 am setup 会接着下；GitHub 慢可以加 --proxy。\n", homeShort(logPath))
			return &exitError{code: 1, message: ""}
		}
		view.Set(i, viewDone, "")
	}
	view.Stop()
	fmt.Fprintf(stdout, "\n全部就绪，用时 %s。\n", clock(time.Since(started)))
	return nil
}

func cloneMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
