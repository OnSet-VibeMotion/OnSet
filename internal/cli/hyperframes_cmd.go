package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"

	"github.com/spf13/cobra"

	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
)

// newHyperframesCommand 是 am 管理的 HyperFrames CLI 的入口：参数原样转给固定版本的 CLI。
func newHyperframesCommand(stdout, stderr io.Writer) *cobra.Command {
	return &cobra.Command{
		Use:   "hyperframes [ARGS...]",
		Short: "运行 am 管理的固定版本 HyperFrames CLI",
		Long: `用固定版本 ` + hyperframesVersion + ` 的 HyperFrames CLI 执行 ARGS，工作目录不变，退出码透传。

CLI 由 am 装在用户级目录（默认 ~/.local/share/am/hyperframes/cli-` + hyperframesVersion + `，
可用 ` + hyperframes.CLIDirEnv + ` 指定），所有项目共用；am init 与渲染前会先装好，这里缺了也会先装。
安装用 npm 与你自己的 ~/.npmrc（镜像、代理、鉴权都照常生效）。

渲染器和编排工具调用 CLI 一律写成 am hyperframes <子命令>，不要用 npx：npx 会在
渲染途中现下载，网络不好时整次渲染白跑。`,
		Example: `  am hyperframes lint
  am hyperframes check --json
  am hyperframes snapshot --at 1.5 --describe false
  am hyperframes render`,
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			env := currentEnvironment()
			dir, err := hyperframes.EnsureCLI(cmd.Context(), hyperframes.CLIOptions{
				Env: env, Output: stderr, Progress: skillsProgressPrinter(stderr),
			})
			if err != nil {
				return err
			}
			child := hyperframes.CLICommandFor(cmd.Context(), dir, env, args...)
			child.Stdin, child.Stdout, child.Stderr = os.Stdin, stdout, stderr
			if err := child.Run(); err != nil {
				var exit *exec.ExitError
				if errors.As(err, &exit) {
					return &exitError{code: exit.ExitCode(), message: fmt.Sprintf("hyperframes 退出码 %d", exit.ExitCode())}
				}
				return err
			}
			return nil
		},
	}
}
