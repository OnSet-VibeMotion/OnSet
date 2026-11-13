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
	// 全部风格来源经 sources 登记进 filmstyle；新增来源只改 sources 包。
	_ "github.com/chouheiwa/articale-to-motion/internal/filmstyle/sources"
)

// sourceSummary 是 am film-style 帮助里列出的已登记来源。
func sourceSummary() string {
	var lines []string
	for _, source := range filmstyle.Sources() {
		line := "  " + source.ID() + "  " + source.Name()
		if source.Gallery() != "" {
			line += "，图鉴 " + source.Gallery()
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// newFilmStyleCommand 管理整片风格：从某个风格来源挑一种，装进项目。
func newFilmStyleCommand(stdout io.Writer) *cobra.Command {
	var projectRoot string
	filmCmd := &cobra.Command{
		Use:   "film-style",
		Short: "整片风格：从风格来源里挑一种画面风格用于全片",
		Long: `整片风格是可选的。项目没有整片风格时，每个镜头自主决定视觉；装了整片风格后，
所有镜头画成同一种风格：镜头提示词把「视觉自由度」换成「整片风格」，渲染器必须
遵守该风格 STYLE.md 的不变量，故事与内容仍来自每个镜头自己的文案。

风格来自风格来源，每种风格的标识是「来源/目录名」；名字在各来源里唯一时也可以只写
目录名、中文名或英文名。已登记的来源：
` + sourceSummary() + `

装进项目的落在 .agents/skills/` + filmstyle.SkillName + `/：STYLE.md（不变量）、SKILL.md（怎么用、
技法参考在哪）与 ` + filmstyle.ManifestFile + `（来源与版本），项目整体拷走也能渲染。
各来源的数据是前置资源，由 am setup 下载；本组命令都不联网。`,
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

	var listJSON bool
	var listSource string
	listCmd := &cobra.Command{
		Use:   "list",
		Args:  noArgs,
		Short: "列出各风格来源里的全部风格",
		Long: `按来源、再按分类列出全部风格：标识（来源/目录名）、中文名、英文名、适用题材与说明。
不联网。--source 只列一个来源；--json 输出机器可读的列表。`,
		Example: `  am film-style list
  am film-style list --source lemo-opuscar
  am film-style list --json`,
		RunE: func(cmd *cobra.Command, args []string) error {
			sources := filmstyle.Sources()
			if listSource != "" {
				source, ok := filmstyle.SourceByID(listSource)
				if !ok {
					return fmt.Errorf("没有风格来源 %q。已登记：\n%s", listSource, sourceSummary())
				}
				sources = []filmstyle.Source{source}
			}
			if listJSON {
				var styles []filmstyle.Style
				for _, source := range sources {
					styles = append(styles, source.Catalog()...)
				}
				encoder := json.NewEncoder(stdout)
				encoder.SetIndent("", "  ")
				return encoder.Encode(styles)
			}
			current := ""
			if dir, err := root(); err == nil {
				if manifest, ok, _ := filmstyle.Installed(dir); ok {
					current = manifest.Key()
				}
			}
			for _, source := range sources {
				fmt.Fprintf(stdout, "== %s  %s\n", source.ID(), source.Name())
				if source.Gallery() != "" {
					fmt.Fprintf(stdout, "   图鉴：%s\n", source.Gallery())
				}
				catalog := source.Catalog()
				for _, category := range filmstyle.Categories(source.ID()) {
					fmt.Fprintf(stdout, "%s\n", category)
					for _, style := range catalog {
						if style.CategoryCN != category {
							continue
						}
						mark := " "
						if style.Key() == current {
							mark = "*"
						}
						extra := ""
						if len(style.Tags) > 0 {
							extra = "  [" + strings.Join(style.Tags, ", ") + "]"
						}
						fmt.Fprintf(stdout, " %s %-34s %s %s%s\n", mark, style.Key(), style.CN, style.EN, extra)
						fmt.Fprintf(stdout, "      适合：%s；%s\n", strings.Join(style.Uses, ", "), style.Summary)
					}
				}
				fmt.Fprintln(stdout)
			}
			if current != "" {
				fmt.Fprintln(stdout, "* 为本项目当前的整片风格")
			}
			return nil
		},
	}
	listCmd.Flags().BoolVar(&listJSON, "json", false, "以 JSON 输出")
	listCmd.Flags().StringVar(&listSource, "source", "", "只列一个风格来源")
	filmCmd.AddCommand(listCmd)

	var replace bool
	useCmd := &cobra.Command{
		Use:   "use STYLE",
		Args:  exactArgs(1, "STYLE"),
		Short: "把一种风格装成本项目的整片风格",
		Long: `STYLE 写成「来源/目录名」，或者在各来源里唯一的目录名、中文名、英文名。不联网：
来源数据是前置资源，先运行 am setup 准备好，这里只装进项目。

项目已有另一种整片风格时默认拒绝：换风格会让全部镜头的输入指纹变化，
已渲染的镜头都要重渲染。确认要换就加 --replace。同一种风格重复执行是幂等的。`,
		Example: `  am film-style use lemo-opuscar/impasto
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
			result, err := filmstyle.Install(filmstyle.InstallOptions{ProjectDir: dir, Style: style, Env: currentEnvironment(), Replace: replace})
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
		Short: "显示本项目的整片风格与各风格来源的状态",
		Long: `显示本项目装的整片风格（来源、名字、版本、技能目录），以及各风格来源的数据是否已由
am setup 准备好。不联网、不改任何文件。--json 输出机器可读的同一份信息。`,
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
			env := currentEnvironment()
			status := filmStyleStatus{Installed: installed}
			if installed {
				status.Style = &manifest
				status.SkillDir = filmstyle.InstalledDir(dir)
			}
			for _, source := range filmstyle.Sources() {
				item := sourceStatus{ID: source.ID(), Name: source.Name(), Location: source.Location(env), Ready: true}
				if checkErr := source.Check(env); checkErr != nil {
					item.Ready, item.Problem = false, checkErr.Error()
				}
				status.Sources = append(status.Sources, item)
			}
			if showJSON {
				encoder := json.NewEncoder(stdout)
				encoder.SetIndent("", "  ")
				return encoder.Encode(status)
			}
			if installed {
				fmt.Fprintf(stdout, "整片风格：%s %s（%s），版本 %s\n技能目录：%s\n",
					manifest.CN, manifest.EN, manifest.Key(), shortCommit(manifest.Version), status.SkillDir)
				if manifest.Legacy {
					fmt.Fprintln(stdout, "（旧版目录；再运行一次 am film-style use 会换成新目录）")
				}
			} else {
				fmt.Fprintln(stdout, "整片风格：无（各镜头自主定视觉）。用 am film-style list 查看可选风格")
			}
			for _, item := range status.Sources {
				state := "已就绪"
				if !item.Ready {
					state = "未准备（运行 am setup）"
				}
				fmt.Fprintf(stdout, "风格来源 %s：%s，%s\n", item.ID, state, item.Location)
			}
			return nil
		},
	}
	showCmd.Flags().BoolVar(&showJSON, "json", false, "以 JSON 输出")
	filmCmd.AddCommand(showCmd)

	filmCmd.AddCommand(&cobra.Command{
		Use:   "remove",
		Args:  noArgs,
		Short: "去掉本项目的整片风格，回到各镜头自主定视觉",
		Long: `删除 .agents/skills/` + filmstyle.SkillName + `/（以及旧版目录）。镜头提示词随之回到「视觉自由度」，
已渲染的镜头输入指纹变化、会被判为 Stale，要重渲染。风格来源的数据不动。`,
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

type sourceStatus struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Location string `json:"location"`
	Ready    bool   `json:"ready"`
	Problem  string `json:"problem,omitempty"`
}

type filmStyleStatus struct {
	Installed bool                `json:"installed"`
	Style     *filmstyle.Manifest `json:"style,omitempty"`
	SkillDir  string              `json:"skill_dir,omitempty"`
	Sources   []sourceStatus      `json:"sources"`
}

func reportFilmStyle(stdout io.Writer, style filmstyle.Style, result filmstyle.InstallResult) {
	switch {
	case result.Unchanged:
		fmt.Fprintf(stdout, "整片风格已是 %s，未改动\n", style.Label())
	case result.Replaced != "":
		fmt.Fprintf(stdout, "整片风格已从 %s 换成 %s；已渲染的镜头会被判为 Stale\n", result.Replaced, style.Label())
	default:
		fmt.Fprintf(stdout, "整片风格已设为 %s（版本 %s）\n", style.Label(), shortCommit(result.Manifest.Version))
	}
}

func shortCommit(commit string) string {
	if len(commit) > 12 {
		return commit[:12]
	}
	return commit
}
