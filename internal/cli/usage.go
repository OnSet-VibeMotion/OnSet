package cli

import (
	"fmt"
	"io"
	"sort"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/schedule"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
	"github.com/spf13/cobra"
)

// SceneUsage 是一个镜头全部渲染尝试的用量账。
type SceneUsage struct {
	SceneID   string      `json:"scene_id"`
	Attempts  int         `json:"attempts"`
	Succeeded int         `json:"succeeded"`
	Usage     tools.Usage `json:"usage"`
	// ByModel 按「渲染工具/模型」分开，模型未知时只有渲染工具。
	ByModel map[string]tools.Usage `json:"by_model"`
}

// UsageReport 是 am scene usage 的机器可读结果。
type UsageReport struct {
	Scenes  []SceneUsage           `json:"scenes"`
	Total   tools.Usage            `json:"total"`
	ByModel map[string]tools.Usage `json:"by_model"`
}

func usageKey(renderer, model string) string {
	if model == "" {
		return renderer
	}
	return renderer + "/" + model
}

// collectUsage 汇总 ROOT 下每个镜头的全部尝试记录（含 attempts/ 里归档的）。
func collectUsage(scenes []scene.Scene) UsageReport {
	report := UsageReport{Scenes: []SceneUsage{}, ByModel: map[string]tools.Usage{}}
	for _, s := range scenes {
		row := SceneUsage{SceneID: s.ID, ByModel: map[string]tools.Usage{}}
		for _, attempt := range scene.AttemptHistory(s.Directory, s.ID) {
			row.Attempts++
			if attempt.Outcome == scene.OutcomeSucceeded {
				row.Succeeded++
			}
			var usage tools.Usage
			if attempt.Usage != nil {
				usage = *attempt.Usage
			}
			key := usageKey(attempt.Renderer, attempt.Model)
			for _, target := range []*tools.Usage{&row.Usage, &report.Total} {
				target.Add(usage)
			}
			perRow, perAll := row.ByModel[key], report.ByModel[key]
			perRow.Add(usage)
			perAll.Add(usage)
			row.ByModel[key], report.ByModel[key] = perRow, perAll
		}
		report.Scenes = append(report.Scenes, row)
	}
	return report
}

func newSceneUsageCommand(stdout io.Writer) *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use: "usage ROOT", Args: exactArgs(1, "ROOT"), Short: "每个镜头的渲染一共花了多少 token",
		Long: `汇总 ROOT 下每个镜头全部渲染尝试的用量：当前这一次加 attempts/ 里归档的，
失败的尝试与调度层的重试一样计入——它们同样花了 token。

口径统一为：输入含缓存命中与写入，缓存是输入里命中的部分，输出含推理 token；
费用只有工具报了才有（claude 系与 opencode 报，codex 不报）。有的尝试没读到用量时，
合计标为下限。每次 am scene run 结束时也会打印这一次的用量，run-all 的汇总与
--report-json 里有每个镜头这一批的合计。`,
		Example: "  am scene usage scenes/\n  am scene usage scenes/ --json",
		RunE: func(cmd *cobra.Command, args []string) error {
			scenes, err := schedule.Plan(args[0])
			if err != nil {
				return err
			}
			report := collectUsage(scenes)
			if asJSON {
				return printJSON(stdout, report)
			}
			for _, row := range report.Scenes {
				if row.Attempts == 0 {
					fmt.Fprintf(stdout, "%s：还没有渲染记录\n", row.SceneID)
					continue
				}
				fmt.Fprintf(stdout, "%s：%d 次尝试（%d 次成功）· %s\n", row.SceneID, row.Attempts, row.Succeeded, tools.FormatUsage(row.Usage))
			}
			keys := make([]string, 0, len(report.ByModel))
			for key := range report.ByModel {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			fmt.Fprintf(stdout, "\n合计：%s\n", tools.FormatUsage(report.Total))
			for _, key := range keys {
				fmt.Fprintf(stdout, "  %s：%s\n", key, tools.FormatUsage(report.ByModel[key]))
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	return cmd
}
