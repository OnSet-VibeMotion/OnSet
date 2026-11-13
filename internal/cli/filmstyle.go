package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
)

// newFilmStyleCommand 管理整片风格：从 lemo-opuscar 风格库挑一种，装进项目。
func newFilmStyleCommand(stdout, stderr io.Writer) *cobra.Command {
	var projectRoot string
	filmCmd := &cobra.Command{
		Use:   "film-style",
		Short: "整片风格：从 lemo-opuscar 风格库挑一种画面风格用于全片",
		Long: `整片风格是可选的。项目没有整片风格时，每个镜头自主决定视觉；装了整片风格后，
所有镜头画成同一种风格：镜头提示词把「视觉自由度」换成「整片风格」，渲染器必须
遵守该风格 STYLE.md 的不变量（外观、材质、配色逻辑、字体、动效、镜头语法、禁忌），
故事与内容仍来自每个镜头自己的文案。

风格来自 lemo-opuscar（` + strings.TrimSuffix(filmstyle.RepoURL, ".git") + `，作者 LemoLab），
am 固定在 commit ` + filmstyle.PinnedCommit[:12] + `，共 ` + fmt.Sprint(filmstyle.PinnedStyleCount) + ` 种。

风格库本体放在用户级目录（默认 ~/.local/share/am/lemo-opuscar/<commit>，
可用 ` + filmstyle.LibraryEnv + ` 指向已有检出），所有项目共用；项目里只装选中的那一种，
落在 .agents/skills/` + filmstyle.SkillName + `/，项目整体拷走也能渲染。
风格库是前置资源，由 am setup 下载；本组命令都不联网。

只接画面风格：STYLE.md 的 Sound palette 只作为配乐方向的参考，配乐仍按制作流程
选用授权素材。`,
	}
	filmCmd.PersistentFlags().StringVar(&projectRoot, "project-root", "", "项目根目录，缺省为当前目录")
	root := func() (string, error) {
		dir := projectRoot
		if dir == "" {
			dir = "."
		}
		abs, err := filepath.Abs(dir)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(filepath.Join(abs, "article-to-motion.conf")); err != nil {
			return "", fmt.Errorf("%s 不是 am 项目（缺少 article-to-motion.conf），用 --project-root 指向项目根目录", abs)
		}
		return abs, nil
	}
	libraryOptions := func() filmstyle.LibraryOptions {
		return filmstyle.LibraryOptions{Env: currentEnvironment(), Output: stderr}
	}

	var listJSON bool
	listCmd := &cobra.Command{
		Use:   "list",
		Args:  noArgs,
		Short: "列出风格库里的全部风格",
		Long: `按分类列出全部风格：中文名、英文名、目录名与一句话说明。不联网。
图鉴（每种风格的 demo 片）：https://lemomo-ai.github.io/lemo-opuscar/`,
		Example: `  am film-style list
  am film-style list --json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			catalog := filmstyle.Catalog()
			if listJSON {
				encoder := json.NewEncoder(stdout)
				encoder.SetIndent("", "  ")
				return encoder.Encode(catalog)
			}
			current := ""
			if dir, err := root(); err == nil {
				if manifest, ok, _ := filmstyle.Installed(dir); ok {
					current = manifest.Slug
				}
			}
			for _, category := range filmstyle.Categories() {
				fmt.Fprintf(stdout, "%s\n", category)
				for _, style := range catalog {
					if style.CategoryCN != category {
						continue
					}
					mark := " "
					if style.Slug == current {
						mark = "*"
					}
					extra := ""
					if style.ThreeJS {
						extra = "  [three.js]"
					}
					fmt.Fprintf(stdout, " %s %-22s %s %s%s\n      适合：%s；demo：%s\n", mark, style.Slug, style.CN, style.EN, extra,
						strings.Join(style.Uses, ", "), style.LineCN)
				}
			}
			fmt.Fprintln(stdout, "\n图鉴：https://lemomo-ai.github.io/lemo-opuscar/")
			if current != "" {
				fmt.Fprintln(stdout, "* 为本项目当前的整片风格")
			}
			return nil
		},
	}
	listCmd.Flags().BoolVar(&listJSON, "json", false, "以 JSON 输出")
	filmCmd.AddCommand(listCmd)

	var replace bool
	useCmd := &cobra.Command{
		Use:   "use STYLE",
		Args:  exactArgs(1, "STYLE"),
		Short: "把一种风格装成本项目的整片风格",
		Long: `STYLE 可以是目录名、中文名或英文名。不联网：风格库是前置资源，先运行 am setup
把它完整下载好（全部 demo、海报与 three.js 依赖），这里只从风格库装进项目。

项目已有另一种整片风格时默认拒绝：换风格会让全部镜头的输入指纹变化，
已渲染的镜头都要重渲染。确认要换就加 --replace。同一种风格重复执行是幂等的。`,
		Example: `  am film-style use impasto
  am film-style use 油画厚涂
  am film-style use "Swiss Motion Graphics" --replace`,
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, err := root()
			if err != nil {
				return err
			}
			style, err := filmstyle.Lookup(args[0])
			if err != nil {
				return err
			}
			result, err := filmstyle.InstallForProject(dir, style, replace, libraryOptions())
			if err != nil {
				return err
			}
			reportFilmStyle(stdout, style, result)
			return nil
		},
	}
	useCmd.Flags().BoolVar(&replace, "replace", false, "允许换掉项目已有的另一种整片风格")
	filmCmd.AddCommand(useCmd)

	var showJSON bool
	showCmd := &cobra.Command{
		Use:   "show",
		Args:  noArgs,
		Short: "显示本项目的整片风格与风格库状态",
		Long: `显示本项目装的整片风格（名字、commit、技能目录），以及用户级风格库是否已下载。
不联网、不改任何文件。--json 输出机器可读的同一份信息。`,
		Example: `  am film-style show
  am film-style show --json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, err := root()
			if err != nil {
				return err
			}
			manifest, installed, err := filmstyle.Installed(dir)
			if err != nil {
				return err
			}
			status := filmStyleStatus{Installed: installed, Library: filmstyle.LibraryDir(libraryOptions())}
			if installed {
				status.Style = &manifest
				status.SkillDir = filmstyle.SkillDir(dir)
			}
			if lib, err := filmstyle.OpenLibrary(libraryOptions()); err == nil {
				status.LibraryReady = true
				status.Library = lib.Dir
				status.LibraryCommit = lib.Commit
			}
			if showJSON {
				encoder := json.NewEncoder(stdout)
				encoder.SetIndent("", "  ")
				return encoder.Encode(status)
			}
			if installed {
				fmt.Fprintf(stdout, "整片风格：%s %s（%s），commit %s\n技能目录：%s\n",
					manifest.CN, manifest.EN, manifest.Slug, shortCommit(manifest.Commit), status.SkillDir)
			} else {
				fmt.Fprintln(stdout, "整片风格：无（各镜头自主定视觉）。用 am film-style list 查看可选风格")
			}
			if !status.LibraryReady {
				fmt.Fprintf(stdout, "风格库：未下载（%s）\n", status.Library)
				return nil
			}
			fmt.Fprintf(stdout, "风格库：%s（commit %s）\n", status.Library, shortCommit(status.LibraryCommit))
			return nil
		},
	}
	showCmd.Flags().BoolVar(&showJSON, "json", false, "以 JSON 输出")
	filmCmd.AddCommand(showCmd)

	filmCmd.AddCommand(&cobra.Command{
		Use:   "remove",
		Args:  noArgs,
		Short: "去掉本项目的整片风格，回到各镜头自主定视觉",
		Long: `删除 .agents/skills/` + filmstyle.SkillName + `/。镜头提示词随之回到「视觉自由度」，
已渲染的镜头输入指纹变化、会被判为 Stale，要重渲染。用户级风格库不动。`,
		Example: `  am film-style remove`,
		RunE: func(cmd *cobra.Command, args []string) error {
			dir, err := root()
			if err != nil {
				return err
			}
			manifest, had, err := filmstyle.Remove(dir)
			if err != nil {
				return err
			}
			if !had {
				fmt.Fprintln(stdout, "本项目没有整片风格")
				return nil
			}
			fmt.Fprintf(stdout, "已去掉整片风格 %s %s；已渲染的镜头会被判为 Stale\n", manifest.CN, manifest.EN)
			return nil
		},
	})

	return filmCmd
}

type filmStyleStatus struct {
	Installed     bool                `json:"installed"`
	Style         *filmstyle.Manifest `json:"style,omitempty"`
	SkillDir      string              `json:"skill_dir,omitempty"`
	Library       string              `json:"library"`
	LibraryReady  bool                `json:"library_ready"`
	LibraryCommit string              `json:"library_commit,omitempty"`
}

func reportFilmStyle(stdout io.Writer, style filmstyle.Style, result filmstyle.InstallResult) {
	switch {
	case result.Unchanged:
		fmt.Fprintf(stdout, "整片风格已是 %s，未改动\n", style.Label())
	case result.Replaced != "":
		fmt.Fprintf(stdout, "整片风格已从 %s 换成 %s；已渲染的镜头会被判为 Stale\n", result.Replaced, style.Label())
	default:
		fmt.Fprintf(stdout, "整片风格已设为 %s（commit %s）\n", style.Label(), shortCommit(result.Manifest.Commit))
	}
}

func shortCommit(commit string) string {
	if len(commit) > 12 {
		return commit[:12]
	}
	return commit
}
