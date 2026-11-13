package cli

import (
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
	"github.com/chouheiwa/articale-to-motion/internal/prereq"
)

// setupItem 是一项前置资源。
type setupItem struct {
	id    string
	label string
	// ready 不联网地判断是否已就绪；detail 是给人看的位置说明。
	ready func(env map[string]string) (bool, string)
}

func setupItems() []setupItem {
	return []setupItem{
		{
			id:    "skills",
			label: "HyperFrames " + hyperframesVersion + " 技能",
			ready: func(env map[string]string) (bool, string) {
				dir := hyperframes.DefaultCacheDir(env)
				return hyperframes.SkillsReady(dir), dir
			},
		},
		{
			id:    "cli",
			label: "HyperFrames CLI " + hyperframesVersion,
			ready: func(env map[string]string) (bool, string) {
				dir := hyperframes.CLIDir(env, hyperframes.PinnedVersion)
				return hyperframes.CLIReady(dir, hyperframes.PinnedVersion), dir
			},
		},
		{
			id:    "styles",
			label: fmt.Sprintf("lemo-opuscar 风格库（%d 种风格，含 demo、海报与 three.js 依赖）", filmstyle.PinnedStyleCount),
			ready: func(env map[string]string) (bool, string) {
				opts := filmstyle.LibraryOptions{Env: env}
				_, err := filmstyle.RequireLibrary(opts)
				return err == nil, filmstyle.LibraryDir(opts)
			},
		},
	}
}

func newSetupCommand(stdout, stderr io.Writer) *cobra.Command {
	var check bool
	var only []string
	var proxy, npmRegistry string
	cmd := &cobra.Command{
		Use:   "setup",
		Args:  noArgs,
		Short: "下载并准备全部前置资源（HyperFrames 技能与 CLI、整片风格库）",
		Long: `要联网的东西都由这一条命令准备，放在用户级目录里，所有项目共用：

  skills   HyperFrames ` + hyperframesVersion + ` 官方技能（git，缓存在 ~/.local/share/am/hyperframes/<commit>）
  cli      HyperFrames CLI ` + hyperframesVersion + `（npm，装在 ~/.local/share/am/hyperframes/cli-<版本>）
  styles   lemo-opuscar 风格库：全部风格说明、demo 源码、海报、core/assets 模型
           与 three.js 依赖（git + npm，约 100 MB，在 ~/.local/share/am/lemo-opuscar/<commit>）

其余命令（am init、am film-style use、am scene run、am hyperframes、am studio）只检查
不下载，缺了就提示先运行 am setup。已就绪的项直接跳过；下载断了再运行一次会接着下。

--proxy 只给 git（GitHub）用，例如本机的 Clash；npm 照常用你 ~/.npmrc 里的镜像与代理，
要临时换源用 --npm-registry。--check 只报告哪些已就绪、哪些缺，不下载；有缺项时退出码为 1。`,
		Example: `  am setup
  am setup --proxy http://127.0.0.1:7890
  am setup --only styles --proxy http://127.0.0.1:7890
  am setup --check`,
		RunE: func(cmd *cobra.Command, args []string) error {
			env := currentEnvironment()
			items := setupItems()
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
					known = known || item.id == id
				}
				if !known {
					return fmt.Errorf("--only 只认 skills、cli、styles，收到 %q", id)
				}
			}
			selected := items[:0:0]
			for _, item := range items {
				if len(wanted) == 0 || wanted[item.id] {
					selected = append(selected, item)
				}
			}
			if check {
				missing := 0
				for _, item := range selected {
					ok, where := item.ready(env)
					mark := "✓"
					if !ok {
						mark = "✗"
						missing++
					}
					fmt.Fprintf(stdout, "%s %s  %s\n", mark, item.label, where)
				}
				if missing > 0 {
					return &exitError{code: 1, message: fmt.Sprintf("缺 %d 项前置资源，运行 %s 准备", missing, prereq.SetupCommand)}
				}
				return nil
			}
			// git 的代理用 GIT_CONFIG_PARAMETERS（等同 git -c http.proxy=…）只给 git：
			// 设成 HTTPS_PROXY 的话 npm 也会走它，国内镜像经代理反而连不上（实测）。
			gitEnv := cloneMap(env)
			if proxy != "" {
				gitEnv["GIT_CONFIG_PARAMETERS"] = "'http.proxy'='" + proxy + "'"
			}
			npmEnv := cloneMap(env)
			if npmRegistry != "" {
				npmEnv["npm_config_registry"] = npmRegistry
			}
			for index, item := range selected {
				fmt.Fprintf(stdout, "[%d/%d] %s\n", index+1, len(selected), item.label)
				if ok, where := item.ready(env); ok {
					fmt.Fprintf(stdout, "      已就绪：%s\n", where)
					continue
				}
				var err error
				switch item.id {
				case "skills":
					err = hyperframes.PrepareSkills(cmd.Context(), hyperframes.Options{
						Env: gitEnv, CacheDir: hyperframes.DefaultCacheDir(env), Output: stderr, Progress: skillsProgressPrinter(stderr),
					})
				case "cli":
					_, err = hyperframes.EnsureCLI(cmd.Context(), hyperframes.CLIOptions{Env: npmEnv, Output: stderr, Progress: skillsProgressPrinter(stderr)})
				case "styles":
					// 风格库的 git 步骤走代理，最后一步 npm ci 走 npm 自己的配置：合成一份环境。
					libEnv := cloneMap(gitEnv)
					if npmRegistry != "" {
						libEnv["npm_config_registry"] = npmRegistry
					}
					_, err = filmstyle.PrepareLibrary(cmd.Context(), filmstyle.PrepareOptions{
						LibraryOptions: filmstyle.LibraryOptions{Env: libEnv, Output: stderr},
						Progress: func(p filmstyle.PrepareProgress) {
							fmt.Fprintf(stdout, "      (%d/%d) %s\n", p.Step, p.Steps, p.Stage)
						},
					})
				}
				if err != nil {
					return fmt.Errorf("%s 没准备好：%w\n再运行一次 am setup 会接着下；GitHub 慢可以加 --proxy", item.label, err)
				}
				_, where := item.ready(env)
				fmt.Fprintf(stdout, "      完成：%s\n", where)
			}
			fmt.Fprintln(stdout, "前置资源已就绪。")
			return nil
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "只检查哪些已就绪，不下载；有缺项时退出码为 1")
	cmd.Flags().StringSliceVar(&only, "only", nil, "只准备其中几项：skills、cli、styles（可逗号分隔）")
	cmd.Flags().StringVar(&proxy, "proxy", "", "git 下载（GitHub）用的代理，例如 http://127.0.0.1:7890；不影响 npm")
	cmd.Flags().StringVar(&npmRegistry, "npm-registry", "", "npm 用的源，覆盖 ~/.npmrc 的 registry")
	return cmd
}

func cloneMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
