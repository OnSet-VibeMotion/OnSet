package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	"github.com/chouheiwa/articale-to-motion/internal/agentrun"
	"github.com/chouheiwa/articale-to-motion/internal/config"
	"github.com/chouheiwa/articale-to-motion/internal/ledger"

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

// recordOrchestratorUsage 把一次编排调用记进账本。记账失败只告警：
// 不能因为账没记上就让一次已经跑完的调用报错。
func recordOrchestratorUsage(ctx context.Context, path, source, tool string, env map[string]string, result agentrun.Result, runErr error, stderr io.Writer) {
	model := result.Model
	if model == "" {
		model = tools.ConfiguredModel(tool, env)
	}
	cancelled := ctx.Err() != nil || errors.Is(runErr, context.Canceled)
	entry := ledger.FromResult(source, tool, model, result.SessionID, result.Usage, runErr, cancelled)
	if err := ledger.Append(path, entry); err != nil {
		fmt.Fprintf(stderr, "警告：编排用量没能记进账本 %s：%v\n", path, err)
	}
}

// ProjectUsage 是 am usage 的机器可读结果。
type ProjectUsage struct {
	Renders      UsageReport     `json:"renders"`
	Orchestrator ledger.Summary  `json:"orchestrator"`
	Total        tools.Usage     `json:"total"`
	Memory       *ledger.Summary `json:"memory,omitempty"`
}

var usageSourceNames = map[string]string{
	ledger.SourceRun:         "am run",
	ledger.SourceStudio:      "Studio 对话",
	ledger.SourceConsolidate: "整理记忆",
}

func newUsageCommand(stdout io.Writer) *cobra.Command {
	var asJSON bool
	var scenesDir string
	cmd := &cobra.Command{
		Use: "usage", Args: noArgs, Short: "这个项目一共花了多少 token：渲染加编排",
		Long: `在项目根运行，合计两本账：

  渲染   scenes/ 下每个镜头的全部渲染尝试（同 am scene usage）
  编排   production/usage/orchestrator.jsonl：每次 am run、Studio 每一轮对话各一行，
         失败与取消的调用同样记入

记忆打开时另列「整理记忆」的用量：它不属于哪个项目，记在记忆库的
orchestrator-usage.jsonl 里，所有项目共用一本。

口径与 am scene usage 相同：输入含缓存，输出含推理；费用只有工具报了才有，
有的调用没读到用量时合计标为下限。`,
		Example: "  am usage\n  am usage --json\n  am usage --scenes scenes",
		RunE: func(cmd *cobra.Command, args []string) error {
			root, err := os.Getwd()
			if err != nil {
				return err
			}
			var report ProjectUsage
			report.Renders = UsageReport{Scenes: []SceneUsage{}, ByModel: map[string]tools.Usage{}}
			dir := scenesDir
			if !filepath.IsAbs(dir) {
				dir = filepath.Join(root, dir)
			}
			if _, statErr := os.Stat(dir); statErr == nil {
				scenes, err := schedule.Plan(dir)
				if err != nil {
					return err
				}
				report.Renders = collectUsage(scenes)
			}
			entries, err := ledger.Read(ledger.ProjectFile(root))
			if err != nil {
				return err
			}
			report.Orchestrator = ledger.Summarize(entries)
			if !report.Renders.Total.Empty() || report.Renders.Total.Partial {
				report.Total.Add(report.Renders.Total)
			}
			if report.Orchestrator.Calls > 0 {
				report.Total.Add(report.Orchestrator.Total)
			}
			if cfg, err := config.Load(root, nil); err == nil && cfg.Memory.Enabled && cfg.Memory.Dir != "" {
				memoryEntries, err := ledger.Read(ledger.MemoryFile(cfg.Memory.Dir))
				if err == nil && len(memoryEntries) > 0 {
					summary := ledger.Summarize(memoryEntries)
					report.Memory = &summary
				}
			}
			if asJSON {
				return printJSON(stdout, report)
			}
			attempts := 0
			for _, row := range report.Renders.Scenes {
				attempts += row.Attempts
			}
			fmt.Fprintf(stdout, "渲染：%d 个镜头、%d 次尝试 · %s\n", len(report.Renders.Scenes), attempts, usageOrNone(report.Renders.Total, attempts))
			for _, key := range ledger.SortedKeys(report.Renders.ByModel) {
				fmt.Fprintf(stdout, "  %s：%s\n", key, tools.FormatUsage(report.Renders.ByModel[key]))
			}
			fmt.Fprintf(stdout, "编排：%d 次调用 · %s\n", report.Orchestrator.Calls, usageOrNone(report.Orchestrator.Total, report.Orchestrator.Calls))
			for _, key := range ledger.SortedKeys(report.Orchestrator.BySource) {
				name := usageSourceNames[key]
				if name == "" {
					name = key
				}
				fmt.Fprintf(stdout, "  %s：%s\n", name, tools.FormatUsage(report.Orchestrator.BySource[key]))
			}
			for _, key := range ledger.SortedKeys(report.Orchestrator.ByModel) {
				fmt.Fprintf(stdout, "  %s：%s\n", key, tools.FormatUsage(report.Orchestrator.ByModel[key]))
			}
			fmt.Fprintf(stdout, "\n本项目合计：%s\n", usageOrNone(report.Total, attempts+report.Orchestrator.Calls))
			if report.Memory != nil {
				fmt.Fprintf(stdout, "整理记忆（所有项目共用，不计入上面的合计）：%d 次 · %s\n", report.Memory.Calls, tools.FormatUsage(report.Memory.Total))
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&scenesDir, "scenes", "scenes", "镜头根目录，相对项目根")
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	return cmd
}

func usageOrNone(u tools.Usage, count int) string {
	if count == 0 {
		return "还没有记录"
	}
	return tools.FormatUsage(u)
}
