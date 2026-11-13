package cli

import (
	"fmt"
	"io"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/studio"
	"github.com/spf13/cobra"
)

func newStudioCommand(stdout, stderr io.Writer, unsafe *bool) *cobra.Command {
	var listen, configPath string
	cmd := &cobra.Command{
		Use:   "studio [PROJECT_DIR]",
		Short: "启动本地 ArticleToMotion Studio 工作台",
		Long: `启动本地网页工作台，读取并管理一个或多个 ArticleToMotion 项目。

省略 PROJECT_DIR 时显示工作台并等待选择项目；传入目录会登记并直接打开。
默认只监听 127.0.0.1。需要从手机访问时，请先用 Tailscale、VPN 或 SSH 隧道，
再显式指定 --listen；Studio 本身不提供公网账户或 HTTPS。项目文件仍是状态真相源，
工作台不会读取或保存项目凭据。`,
		Args: maxArgs(1, "PROJECT_DIR"),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := ""
			if len(args) == 1 {
				path = args[0]
			}
			if listen == "" {
				listen = "127.0.0.1:4317"
			}
			if listen != "127.0.0.1:4317" && listen != "localhost:4317" && listen != "[::1]:4317" {
				fmt.Fprintf(stderr, "提示：Studio 将监听 %s。远程访问请使用 Tailscale、VPN 或 SSH 隧道。\n", listen)
			}
			s, err := studio.New(studio.Config{ListenAddr: listen, ProjectPath: path, ConfigPath: configPath, Unsafe: envutil.IsUnsafe(*unsafe)})
			if err != nil {
				return err
			}
			fmt.Fprintf(stdout, "ArticleToMotion Studio 已启动：http://%s\n", listen)
			return s.ListenAndServe(cmd.Context())
		},
	}
	cmd.Flags().StringVar(&listen, "listen", "127.0.0.1:4317", "监听地址（默认只允许本机访问）")
	cmd.Flags().StringVar(&configPath, "config", "", "Studio 项目登记文件路径（默认使用用户配置目录）")
	cmd.Example = "  am studio\n  am studio /path/to/project\n  am studio --listen 127.0.0.1:4317"
	cmd.AddCommand(newStudioShowCommand(stdout))
	return cmd
}

// newStudioShowCommand 让 Studio 里的编排工具把网页切到某一页。
func newStudioShowCommand(stdout io.Writer) *cobra.Command {
	var note string
	var pages []string
	for _, page := range studio.ViewPages {
		line := "  " + page.ID + "  " + page.Label
		switch page.Target {
		case "scene":
			line += "，要给镜头编号"
		case "scene?":
			line += "，可以给镜头编号"
		case "file":
			line += "，要给项目里的相对路径"
		}
		pages = append(pages, line)
	}
	cmd := &cobra.Command{
		Use:   "show PAGE [TARGET]",
		Args:  rangeArgs(1, 2, "PAGE [TARGET]"),
		Short: "把 Studio 网页切到某一页（在 Studio 的对话里运行时有效）",
		Long: `给 Studio 里的编排工具用：把用户的网页切到要用户看的那一页，例如口播稿写好请用户审、
某个镜头渲染完请用户看效果。--note 的一句话显示在对话里，说明为什么要看这一页。

不在 Studio 的对话里运行（例如 am run、终端里手动执行）时什么都不做，退出码为 0。

页面：
` + strings.Join(pages, "\n"),
		Example: `  am studio show script --note "口播稿写好了，请看一遍"
  am studio show scene scene-003
  am studio show file production/treatment.md`,
		RunE: func(cmd *cobra.Command, args []string) error {
			req := studio.ViewRequest{Page: args[0], Note: strings.TrimSpace(note)}
			if len(args) == 2 {
				req.Target = args[1]
			}
			inStudio, err := studio.WriteViewRequest(currentEnvironment(), req)
			if err != nil {
				return err
			}
			if !inStudio {
				fmt.Fprintln(stdout, "当前不在 Studio 的对话里，没有网页可切，已跳过。")
				return nil
			}
			fmt.Fprintln(stdout, "已请 Studio 网页切到「"+pageLabel(req.Page)+"」。")
			return nil
		},
	}
	cmd.Flags().StringVar(&note, "note", "", "显示在对话里的一句说明")
	return cmd
}

func pageLabel(id string) string {
	for _, page := range studio.ViewPages {
		if page.ID == id {
			return page.Label
		}
	}
	return id
}
