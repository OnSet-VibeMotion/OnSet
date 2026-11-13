package cli

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/spf13/cobra"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
	"github.com/chouheiwa/articale-to-motion/internal/prereq"
)

// setupEnv 是一次准备要用的几份环境：git 走代理、npm 走自己的配置。
type setupEnv struct {
	base, git, npm, mixed map[string]string
	stdout, stderr        io.Writer
}

// setupItem 是一项前置资源。
type setupItem struct {
	// group 是 --only 认的大类（skills、cli、styles），id 是这一项自己的名字；
	// 风格来源每个一项，id 为 styles:<来源>。
	group, id string
	label     string
	// ready 不联网地判断是否已就绪；where 是给人看的位置。
	ready   func(env map[string]string) (ok bool, where string)
	prepare func(ctx context.Context, env setupEnv) error
}

func setupItems() []setupItem {
	items := []setupItem{
		{
			group: "skills", id: "skills",
			label: "HyperFrames " + hyperframesVersion + " 技能",
			ready: func(env map[string]string) (bool, string) {
				dir := hyperframes.DefaultCacheDir(env)
				return hyperframes.SkillsReady(dir), dir
			},
			prepare: func(ctx context.Context, env setupEnv) error {
				return hyperframes.PrepareSkills(ctx, hyperframes.Options{
					Env: env.git, CacheDir: hyperframes.DefaultCacheDir(env.base), Output: env.stderr, Progress: skillsProgressPrinter(env.stderr),
				})
			},
		},
		{
			group: "cli", id: "cli",
			label: "HyperFrames CLI " + hyperframesVersion,
			ready: func(env map[string]string) (bool, string) {
				dir := hyperframes.CLIDir(env, hyperframes.PinnedVersion)
				return hyperframes.CLIReady(dir, hyperframes.PinnedVersion), dir
			},
			prepare: func(ctx context.Context, env setupEnv) error {
				_, err := hyperframes.EnsureCLI(ctx, hyperframes.CLIOptions{Env: env.npm, Output: env.stderr, Progress: skillsProgressPrinter(env.stderr)})
				return err
			},
		},
	}
	for _, source := range filmstyle.Sources() {
		source := source
		items = append(items, setupItem{
			group: "styles", id: "styles:" + source.ID(),
			label: "整片风格来源 " + source.Name(),
			ready: func(env map[string]string) (bool, string) {
				return source.Check(env) == nil, source.Location(env)
			},
			prepare: func(ctx context.Context, env setupEnv) error {
				// 来源可能既用 git 又用 npm：git 的代理与 npm 的源合在一份环境里。
				return source.Prepare(ctx, filmstyle.PrepareOptions{
					Env: env.mixed, Output: env.stderr,
					Progress: func(p filmstyle.PrepareProgress) {
						fmt.Fprintf(env.stdout, "      (%d/%d) %s\n", p.Step, p.Steps, p.Stage)
					},
				})
			},
		})
	}
	return items
}

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
					known = known || item.id == id || item.group == id
				}
				if !known {
					var names []string
					for _, item := range items {
						names = append(names, item.id)
					}
					return fmt.Errorf("--only 不认 %q（可选：skills、cli、styles、%s）", id, strings.Join(names, "、"))
				}
			}
			var selected []setupItem
			for _, item := range items {
				if len(wanted) == 0 || wanted[item.id] || wanted[item.group] {
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
			envs := setupEnv{base: env, git: cloneMap(env), npm: cloneMap(env), stdout: stdout, stderr: stderr}
			if proxy != "" {
				envs.git["GIT_CONFIG_PARAMETERS"] = "'http.proxy'='" + proxy + "'"
			}
			if npmRegistry != "" {
				envs.npm["npm_config_registry"] = npmRegistry
			}
			envs.mixed = cloneMap(envs.git)
			if npmRegistry != "" {
				envs.mixed["npm_config_registry"] = npmRegistry
			}
			for index, item := range selected {
				fmt.Fprintf(stdout, "[%d/%d] %s\n", index+1, len(selected), item.label)
				if ok, where := item.ready(env); ok {
					fmt.Fprintf(stdout, "      已就绪：%s\n", where)
					continue
				}
				if err := item.prepare(cmd.Context(), envs); err != nil {
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
	cmd.Flags().StringSliceVar(&only, "only", nil, "只准备其中几项：skills、cli、styles 或 styles:<来源>（可逗号分隔）")
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
