package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/agentrun"
	"github.com/chouheiwa/articale-to-motion/internal/config"
	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
	"github.com/chouheiwa/articale-to-motion/internal/ledger"
	"github.com/chouheiwa/articale-to-motion/internal/mediaprobe"
	"github.com/chouheiwa/articale-to-motion/internal/memory"
	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/schedule"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
	"github.com/spf13/cobra"
)

// examWorkspace 是考场目录在项目里的位置。考场必须在项目里：渲染器从镜头目录
// 逐级向上找 .agents/skills，放到记忆库里就找不到项目的技能。
const examWorkspace = "production/memory-exams"

// newRunID 是一次 am scene run / run-all 调用的批次编号，同一批次的镜头共用，
// am memory report 按它对比「第一次」与「第二次」。
func newRunID() string { return "run-" + time.Now().UTC().Format("20060102-150405") }

// attachMemory 在渲染前为镜头召回记忆，并挂上把这次尝试写成经历的回调。
// 记忆关闭时原样返回，不建记忆库目录。
func attachMemory(s scene.Scene, cfg config.Config, warn io.Writer, run string) (scene.Scene, error) {
	if !cfg.Memory.Enabled {
		return s, nil
	}
	store, err := memory.Open(cfg.Memory.Dir)
	if err != nil {
		return s, err
	}
	renderer := s.Renderer
	if renderer == "" {
		renderer = cfg.Renderer
	}
	result, err := store.RecallScene(s, memory.RecallOptions{Snapshot: cfg.Memory.Snapshot, Budget: cfg.Memory.RecallBudget,
		Renderer: renderer, Model: store.CurrentModel(renderer, currentEnvironment())})
	if err != nil {
		return s, fmt.Errorf("召回记忆：%w", err)
	}
	s = result.Attach(s)
	s.AfterAttempt = func(attempt scene.Attempt) {
		recorded := s
		recorded.AfterAttempt = nil
		if _, err := store.RecordAttempt(recorded, attempt, memory.AttemptSource{Source: memory.SourceRender, Run: run}); err != nil {
			fmt.Fprintf(warn, "警告：镜头 %s 的经历没能写进记忆库：%v\n", s.ID, err)
		}
	}
	return s, nil
}

func openMemory(cfg config.Config) (*memory.Store, error) {
	return memory.Open(cfg.Memory.Dir)
}

func writeReport(path string, value any) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.AtomicWrite(path, append(body, '\n'), 0o644)
}

func printJSON(w io.Writer, value any) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintln(w, string(body))
	return err
}

func splitList(value string) []string {
	var out []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func newMemoryCommand(stdout, stderr io.Writer, unsafe *bool) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "memory",
		Short: "渲染记忆：经历、经验、召回、考试与回退",
		Long: `渲染记忆让下一次渲染比这一次好，而且对所有渲染工具都有效。

  经历   每次渲染尝试与人工反馈自动写成一段经历，只增不改
  经验   由 consolidate 从反复出现的失败里提炼，一条可由校验器判定的约束
  偏好   人工反馈里的审美取向，不参加考试，由人确认后生效

新经验先进入试用，经 exam 回放考试（多个渲染工具 × {不带, 带试用经验}）
通过才转为生效；生效记忆集合每变一次就生成一个快照，rollback 可回到任意一版。

渲染前由 am 按镜头特征与关键词召回相关的几条，注入提示词里固定的「记忆」段，
所有渲染工具收到逐字相同的文本。召回只读快照：手改记忆文件后运行 am memory status
把改动记成新快照，才会被召回。

项目配置（article-to-motion.conf）：
  MEMORY=on                  off 时完全不召回、不写经历
  MEMORY_SNAPSHOT=           留空跟随最新快照，写快照号就钉住
  MEMORY_RECALL_BUDGET=1500  每个镜头召回的记忆总字数上限
记忆库目录默认 ~/.local/share/am/memory，可用 AM_MEMORY_DIR 覆盖。`,
	}
	cmd.AddCommand(newMemoryListCommand(stdout), newMemoryShowCommand(stdout), newMemoryRecallCommand(stdout),
		newMemoryConsolidateCommand(stdout, stderr, unsafe), newMemoryExamCommand(stdout, unsafe),
		newMemoryPromoteCommand(stdout), newMemoryRejectCommand(stdout), newMemoryRetireCommand(stdout),
		newMemoryRollbackCommand(stdout), newMemoryStatusCommand(stdout), newMemoryFeedbackCommand(stdout),
		newMemoryTimelineCommand(stdout), newMemoryRememberCommand(stdout), newMemoryReportCommand(stdout), newMemoryImportCommand(stdout))
	return cmd
}

func loadMemoryConfig() (config.Config, *memory.Store, error) {
	cfg, err := config.Load(".", nil)
	if err != nil {
		// 不在项目里（没有 article-to-motion.conf）时也能看记忆库：
		// 按 AM_MEMORY_DIR 或默认位置打开。项目配置本身有错时照常报错。
		if _, statErr := os.Stat("article-to-motion.conf"); !os.IsNotExist(statErr) {
			return config.Config{}, nil, err
		}
		env := currentEnvironment()
		// 编排与渲染工具照项目配置的写法取环境变量，整理与考试在项目外也能跑。
		cfg = config.Config{Orchestrator: env["ORCHESTRATOR"], Renderer: env["RENDERER"],
			Memory: config.MemorySettings{Enabled: true, Dir: env["AM_MEMORY_DIR"], RecallBudget: config.DefaultMemoryRecallBudget}}
		if cfg.Memory.Dir == "" {
			cfg.Memory.Dir = config.DefaultMemoryDir(env)
		}
	}
	store, err := openMemory(cfg)
	return cfg, store, err
}

func newMemoryListCommand(stdout io.Writer) *cobra.Command {
	var status string
	var asJSON bool
	cmd := &cobra.Command{
		Use: "list", Args: noArgs, Short: "列出记忆",
		Long:    "列出记忆库里的经验与偏好，附按渲染工具分开的效果统计（召回次数 / 一次通过次数，只计正式渲染的首次尝试）。",
		Example: "  am memory list\n  am memory list --status trial --json",
		RunE: func(cmd *cobra.Command, args []string) error {
			if status != "" && status != "active" && status != "trial" && status != "rejected" && status != "dormant" {
				return fmt.Errorf("--status 只能是 active、trial、rejected 或 dormant")
			}
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			all, broken, err := store.Memories()
			if err != nil {
				return err
			}
			stats, err := store.Stats()
			if err != nil {
				return err
			}
			type row struct {
				memory.Memory
				Stats map[string]memory.Stat `json:"stats"`
			}
			rows := []row{}
			for _, m := range all {
				if status == "" || string(m.Status) == status {
					rows = append(rows, row{Memory: m, Stats: stats[m.Name]})
				}
			}
			if asJSON {
				return printJSON(stdout, rows)
			}
			if len(rows) == 0 {
				fmt.Fprintln(stdout, "（没有记忆）")
			}
			for _, r := range rows {
				label := ""
				if r.Kind == memory.KindPreference {
					label = " [偏好，未经机器验证]"
				}
				fmt.Fprintf(stdout, "%-8s %s%s — %s\n", r.Status, r.Name, label, r.Description)
				renderers := make([]string, 0, len(r.Stats))
				for name := range r.Stats {
					renderers = append(renderers, name)
				}
				sort.Strings(renderers)
				for _, name := range renderers {
					fmt.Fprintf(stdout, "         %s：召回 %d 次，一次通过 %d 次\n", name, r.Stats[name].Recalled, r.Stats[name].PassedFirstTry)
				}
			}
			for path, err := range broken {
				fmt.Fprintf(stdout, "无法解析：%s：%v\n", path, err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&status, "status", "", "只列某个状态：active、trial、rejected、dormant")
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	return cmd
}

func newMemoryShowCommand(stdout io.Writer) *cobra.Command {
	return &cobra.Command{
		Use: "show NAME", Args: exactArgs(1, "NAME"), Short: "显示一条记忆的全文",
		Long:    "按名字打印一条经验或偏好的完整文件内容（frontmatter 与正文），包括它的状态、来源经历与考试记录。",
		Example: "  am memory show font-local-block",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			m, ok, err := store.Find(args[0])
			if err != nil {
				return err
			}
			if !ok {
				return fmt.Errorf("记忆 %s 不存在", args[0])
			}
			_, err = stdout.Write(memory.Format(m))
			return err
		},
	}
}

func newMemoryRecallCommand(stdout io.Writer) *cobra.Command {
	var renderer, model string
	var withTrial, asJSON bool
	cmd := &cobra.Command{
		Use: "recall DIRECTORY", Args: exactArgs(1, "DIRECTORY"), Short: "预览一个镜头会召回哪些记忆，以及原因",
		Long: `按项目配置（MEMORY_SNAPSHOT、MEMORY_RECALL_BUDGET）预览镜头渲染时会召回的记忆。
不受 MEMORY=off 影响：关闭时渲染不召回，但仍可预览。`,
		Example: "  am memory recall scenes/scene-001\n  am memory recall scenes/scene-001 --with-trial --json",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			s, err := scene.Load(args[0])
			if err != nil {
				return err
			}
			if renderer == "" {
				renderer = s.Renderer
			}
			if renderer == "" {
				renderer = cfg.Renderer
			}
			if model == "" {
				model = store.CurrentModel(renderer, currentEnvironment())
			}
			opts := memory.RecallOptions{Snapshot: cfg.Memory.Snapshot, Budget: cfg.Memory.RecallBudget, Renderer: renderer, Model: model}
			if withTrial {
				all, _, err := store.Memories()
				if err != nil {
					return err
				}
				for _, m := range all {
					if m.Status == memory.StatusTrial {
						opts.Extra = append(opts.Extra, m)
					}
				}
			}
			result, err := store.RecallScene(s, opts)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(stdout, result)
			}
			snapshot := "（记忆库还没有快照）"
			if result.Snapshot > 0 {
				snapshot = fmt.Sprintf("#%d", result.Snapshot)
			}
			shownModel := model
			if shownModel == "" {
				shownModel = "未知（限定了模型的记忆不召回）"
			}
			fmt.Fprintf(stdout, "镜头 %s · 渲染工具 %s · 模型 %s · 快照 %s\n特征：%s\n召回 %d 条，用去 %d / %d 字\n",
				s.ID, renderer, shownModel, snapshot, strings.Join(result.Features, "、"), len(result.Items), result.Used, result.Budget)
			for _, item := range result.Items {
				fmt.Fprintf(stdout, "  ✓ %s（%s，得分 %.2f）— %s\n", item.Name, item.Reason(), item.Score, item.Description)
			}
			for _, item := range result.Omitted {
				if item.OmitReason == "limit" {
					fmt.Fprintf(stdout, "  ✗ %s 经验已满 %d 条，排在后面没注入（得分 %.2f）\n", item.Name, result.MaxLessons, item.Score)
					continue
				}
				fmt.Fprintf(stdout, "  ✗ %s 超出字数预算（%d 字）\n", item.Name, item.Chars)
			}
			if section := result.Section(); section != "" {
				fmt.Fprintf(stdout, "\n注入提示词的原文：%s", section)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&renderer, "renderer", "", "按这个渲染工具召回与排序；缺省取镜头的 renderer 或配置的 RENDERER")
	cmd.Flags().StringVar(&model, "model", "", "按这个模型召回；缺省取工具配置或最近一次实测到的模型")
	cmd.Flags().BoolVar(&withTrial, "with-trial", false, "把试用中的记忆也算进来（考试里试用组看到的样子）")
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	return cmd
}

func newMemoryConsolidateCommand(stdout, stderr io.Writer, unsafe *bool) *cobra.Command {
	var minCount int
	var all, asJSON bool
	var drafts string
	cmd := &cobra.Command{
		Use: "consolidate", Args: noArgs, Short: "整理：把反复出现的失败提炼成试用经验",
		Long: `把上次整理之后的失败经历按校验器聚类，出现次数不少于 --min-count 的组交给 ORCHESTRATOR
起草经验或修订旧经验。草稿要过格式校验才进入试用：字段齐全、checked_by 是已有校验器、
不出现渲染工具名或模型名、不照抄镜头文案、不超长、与已有记忆说同一件事时必须写成修订。

整理者只在记忆库的 consolidate/<run>/ 目录里写草稿，不改动项目。
--drafts 跳过整理者，直接收录一个目录里现成的草稿（lessons/*.md、preferences/*.md）。`,
		Example: "  am memory consolidate\n  am memory consolidate --min-count 1 --all\n  am memory consolidate --drafts ./my-drafts",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			opts := memory.ConsolidateOptions{MinCount: minCount, All: all, DraftsDir: drafts}
			if drafts == "" {
				opts.Drafter = func(ctx context.Context, workdir, prompt string) error {
					if cfg.Orchestrator == "" {
						return fmt.Errorf("没有配置整理者：在项目里运行，或用环境变量 ORCHESTRATOR 指定编排工具；也可以用 --drafts 直接收录现成草稿")
					}
					isUnsafe := envutil.IsUnsafe(*unsafe)
					env := cfg.ChildEnvironment(currentEnvironment(), isUnsafe, envutil.ParsePassthrough(os.Getenv("AM_PASSTHROUGH_ENV")))
					fmt.Fprintf(stdout, "整理者: %s\n工作目录: %s\n---\n", cfg.Orchestrator, workdir)
					printer := &eventPrinter{stdout: stdout, stderr: stderr}
					result, err := agentrun.Run(ctx, agentrun.Spec{
						Tool: cfg.Orchestrator, Workdir: workdir, Prompt: prompt, Unsafe: isUnsafe,
						SessionID: agentrun.NewSessionID(cfg.Orchestrator),
						// 整理者只写草稿文件，不需要任何命令。
						Access:   tools.OrchestratorAccess{},
						Env:      envList(env),
						LookPath: func(name string) (string, error) { return envutil.LookPath(name, env["PATH"]) },
					}, printer.print)
					if result.Started {
						recordOrchestratorUsage(ctx, ledger.MemoryFile(store.Dir), ledger.SourceConsolidate, cfg.Orchestrator, env, result, err, stderr)
					}
					return err
				}
			}
			result, err := store.Consolidate(cmd.Context(), opts)
			if err != nil {
				return err
			}
			if asJSON {
				return printJSON(stdout, result)
			}
			if len(result.Clusters) == 0 && drafts == "" {
				fmt.Fprintf(stdout, "没有出现 %d 次以上的同类失败，无需整理。\n", max(minCount, 1))
				return nil
			}
			fmt.Fprintf(stdout, "聚类出 %d 组高频失败：\n", len(result.Clusters))
			for _, c := range result.Clusters {
				fmt.Fprintf(stdout, "  %s × %d\n", c.Key, c.Count)
			}
			fmt.Fprintf(stdout, "进入试用：%s\n", orNone(result.Accepted))
			names := make([]string, 0, len(result.Rejected))
			for name := range result.Rejected {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				fmt.Fprintf(stdout, "被拒草稿 %s：\n  - %s\n", name, strings.Join(result.Rejected[name], "\n  - "))
			}
			if len(result.Accepted) > 0 {
				fmt.Fprintln(stdout, "下一步：am memory exam --renderers <工具1>,<工具2>")
			}
			return nil
		},
	}
	cmd.Flags().IntVar(&minCount, "min-count", 2, "一组失败至少出现几次才提炼")
	cmd.Flags().BoolVar(&all, "all", false, "不看上次整理时间，把全部经历都算进来")
	cmd.Flags().StringVar(&drafts, "drafts", "", "不调用整理者，直接收录该目录下现成的草稿")
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	return cmd
}

func orNone(list []string) string {
	if len(list) == 0 {
		return "（无）"
	}
	return strings.Join(list, "、")
}

func newMemoryExamCommand(stdout io.Writer, unsafe *bool) *cobra.Command {
	var renderers, trials, episodes, retest string
	var holdout []string
	var maxQuestions, repeat, jobs int
	var dryRun bool
	var reportPath string
	var tolerance float64
	cmd := &cobra.Command{
		Use: "exam", Args: noArgs, Short: "回放考试：试用经验能否转为生效",
		Long: `考试矩阵：考题 × 渲染工具 × {对照组：当前生效记忆, 试用组：再加试用经验}。
考题是试用经验来源的失败经历（冻结输入原样重放），加上 --holdout 给的留出镜头。
每格真实渲染一次（不重试），按确定性校验评分：一次通过得 10 分，否则每个失败项扣 1 分。

门槛（全部满足才转为生效）：
  1. 试用组总分严格高于对照组
  2. 任意一个渲染工具上，对照组通过的题试用组都通过
  3. 留出题上任意一个渲染工具的一次通过数不下降
  4. 所有格子都有有效结果——渲染工具自身故障使整场考试无效，不按 0 分算
  5. 考试期间生效记忆没变过，否则转为待人工确认

渲染次数 = 题数 × 渲染工具数 × 2 × 重复次数，每次都是一次完整的 AI CLI 调用。
考场建在项目的 production/memory-exams/ 下。`,
		Example: "  am memory exam --renderers claude,codex\n  am memory exam --renderers claude,codex --holdout scenes/scene-004 --report-json production/exam.json",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validateTolerance(tolerance); err != nil {
				return err
			}
			cfg, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			list := splitList(renderers)
			if len(list) == 0 {
				list = []string{cfg.Renderer}
			}
			for _, r := range list {
				if !tools.ValidTools[r] {
					return fmt.Errorf("无效的渲染工具：%s", r)
				}
			}
			if jobs == 0 {
				jobs = cfg.SceneJobs
			}
			root, err := os.Getwd()
			if err != nil {
				return err
			}
			workers := schedule.RenderWorkers(runtime.NumCPU(), schedule.SystemMemory(), jobs)
			progress := &syncWriter{writer: stdout}
			isUnsafe := envutil.IsUnsafe(*unsafe)
			run := func(ctx context.Context, s scene.Scene, renderer string) scene.Attempt {
				var attempt scene.Attempt
				s.AfterAttempt = func(a scene.Attempt) { attempt = a }
				s = s.WithRenderWorkers(workers)
				err := scene.Run(ctx, s, cfg, isUnsafe, currentEnvironment(), progress, tolerance)
				if attempt.Outcome == "" {
					attempt = scene.Attempt{SceneID: s.ID, Renderer: renderer, Outcome: scene.OutcomeFailed}
					if err != nil {
						attempt.Error = err.Error()
					}
				}
				return attempt
			}
			result, err := store.Exam(cmd.Context(), memory.ExamOptions{
				Renderers: list, Trial: splitList(trials), Episodes: splitList(episodes), Holdout: holdout, Retest: splitList(retest),
				MaxQuestions: maxQuestions, Repeat: repeat, Jobs: jobs, Budget: cfg.Memory.RecallBudget,
				Workspace: filepath.Join(root, examWorkspace), Run: run, DryRun: dryRun,
				ModelOf:   func(renderer string) string { return store.CurrentModel(renderer, currentEnvironment()) },
				PostCheck: blankPostCheck,
			})
			if err != nil {
				return err
			}
			if reportPath != "" {
				if err := writeReport(reportPath, result); err != nil {
					return err
				}
			}
			fmt.Fprint(stdout, renderExam(result))
			if !result.Verdict.Pass {
				return &exitError{code: 1, message: "考试未通过"}
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&renderers, "renderers", "", "参加考试的渲染工具，逗号分隔；缺省为配置的 RENDERER")
	cmd.Flags().StringVar(&trials, "trial", "", "只考这几条试用经验，逗号分隔；缺省考全部")
	cmd.Flags().StringVar(&episodes, "episodes", "", "错题来源经历，逗号分隔；缺省取试用经验的 from_episodes")
	cmd.Flags().StringVar(&retest, "retest", "", "重考这几条生效经验（逗号分隔）：对照组去掉它们，用于模型换了以后确认它们还有用")
	cmd.Flags().StringArrayVar(&holdout, "holdout", nil, "留出题的镜头目录，可重复")
	cmd.Flags().IntVar(&maxQuestions, "max-questions", 4, "错题数上限")
	cmd.Flags().IntVar(&repeat, "repeat", 1, "每格重复次数，按多数结果计分")
	cmd.Flags().IntVar(&jobs, "jobs", 0, "并发上限；缺省读配置 SCENE_JOBS")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "只出结果，不改记忆状态")
	cmd.Flags().StringVar(&reportPath, "report-json", "", "把考试结果写成 JSON")
	cmd.Flags().Float64Var(&tolerance, "duration-tolerance", 0.15, "产物时长与 duration_seconds 的允许偏差（秒）")
	return cmd
}

func renderExam(r memory.ExamResult) string {
	var b strings.Builder
	fmt.Fprintf(&b, "考试 %s：试用经验 %s\n", r.ID, strings.Join(r.Trials, "、"))
	mark := func(c memory.Cell) string {
		switch {
		case c.Invalid:
			return "⚠"
		case c.Passed:
			return "✅"
		}
		return fmt.Sprintf("❌%d", c.Problems)
	}
	header := []string{"考题"}
	for _, renderer := range r.Renderers {
		header = append(header, renderer+"·对照", renderer+"·试用")
	}
	b.WriteString(strings.Join(header, "\t") + "\n")
	for _, q := range r.Questions {
		row := []string{q.ID + "（" + q.SceneID + map[bool]string{true: "，留出", false: ""}[q.Holdout] + "）"}
		for _, renderer := range r.Renderers {
			for _, arm := range []memory.Arm{memory.ArmControl, memory.ArmTrial} {
				var marks []string
				for _, c := range r.Cells {
					if c.Question == q.ID && c.Renderer == renderer && c.Arm == arm {
						marks = append(marks, mark(c))
					}
				}
				row = append(row, strings.Join(marks, " "))
			}
		}
		b.WriteString(strings.Join(row, "\t") + "\n")
	}
	fmt.Fprintf(&b, "对照 %.1f 分，试用 %.1f 分\n", r.Verdict.ControlScore, r.Verdict.TrialScore)
	for _, reason := range r.Verdict.Reasons {
		fmt.Fprintf(&b, "  - %s\n", reason)
	}
	switch r.Applied {
	case "promoted":
		fmt.Fprintf(&b, "通过：试用经验转为生效，快照 #%d\n", r.Snapshot)
	case "rejected":
		b.WriteString("未通过：试用经验记为被拒\n")
	case "retest-passed":
		b.WriteString("重考通过：在当前模型上仍有提升，已补记考试编号\n")
	case "retest-failed":
		b.WriteString("重考未通过：在当前模型上没有提升。状态不变——可用 am memory retire 让它沉睡，或给它加 applies_when.models 限定到旧模型\n")
	default:
		if r.Verdict.Invalid {
			b.WriteString("考试无效：记忆状态不变\n")
		} else if r.Verdict.NeedsHuman {
			b.WriteString("待人工确认：用 am memory promote / reject 决定\n")
		} else {
			b.WriteString("未改动记忆状态（--dry-run）\n")
		}
	}
	return b.String()
}

func newMemoryPromoteCommand(stdout io.Writer) *cobra.Command {
	return &cobra.Command{
		Use: "promote NAME", Args: exactArgs(1, "NAME"), Short: "人工确认一条试用记忆生效",
		Long:    "偏好不参加考试，只能由人确认生效。经验通常由 exam 转为生效；人工确认的经验会让快照标为「未经考试」。",
		Example: "  am memory promote no-neon-overload",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			snapshot, err := store.Promote(args[0])
			if err != nil {
				return err
			}
			fmt.Fprintf(stdout, "%s 已生效，快照 #%d\n", args[0], snapshot.ID)
			return nil
		},
	}
}

func newMemoryRejectCommand(stdout io.Writer) *cobra.Command {
	var reason string
	cmd := &cobra.Command{
		Use: "reject NAME", Args: exactArgs(1, "NAME"), Short: "人工拒绝一条试用记忆",
		Long:    "把一条试用中的记忆记为被拒，原因写进它的 rejected_reason。被拒记忆保留文件、不再参加考试，也不会被召回。",
		Example: "  am memory reject loop-forever --reason \"无限循环会被确定性扫描判失败\"",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			if err := store.Reject(args[0], reason); err != nil {
				return err
			}
			fmt.Fprintf(stdout, "%s 已记为被拒\n", args[0])
			return nil
		},
	}
	cmd.Flags().StringVar(&reason, "reason", "", "拒绝原因")
	return cmd
}

func newMemoryRetireCommand(stdout io.Writer) *cobra.Command {
	var reason string
	cmd := &cobra.Command{
		Use: "retire NAME", Args: exactArgs(1, "NAME"), Short: "让一条生效记忆转为沉睡",
		Long:    "am memory status 会列出待沉睡候选（召回后一次通过率不高于基线）；确认后用这条命令让它沉睡。",
		Example: "  am memory retire font-local-block --reason \"在两个渲染工具上都没有提升\"",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			snapshot, err := store.Retire(args[0], reason)
			if err != nil {
				return err
			}
			fmt.Fprintf(stdout, "%s 已转为沉睡，快照 #%d\n", args[0], snapshot.ID)
			return nil
		},
	}
	cmd.Flags().StringVar(&reason, "reason", "", "原因")
	return cmd
}

func newMemoryRollbackCommand(stdout io.Writer) *cobra.Command {
	var to int
	cmd := &cobra.Command{
		Use: "rollback", Args: noArgs, Short: "回退到某个快照",
		Long:    "把快照 --to 的生效记忆集合恢复成一个新快照，不删除任何历史。缺省回到最新快照的上一个。",
		Example: "  am memory rollback\n  am memory rollback --to 3",
		RunE: func(cmd *cobra.Command, args []string) error {
			if to < 0 {
				return fmt.Errorf("--to 必须是快照号")
			}
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			snapshot, err := store.Rollback(to)
			if err != nil {
				return err
			}
			fmt.Fprintf(stdout, "已回退到快照 #%d，记为新快照 #%d（%d 条生效记忆）\n", snapshot.RestoredFrom, snapshot.ID, len(snapshot.Entries))
			return nil
		},
	}
	cmd.Flags().IntVar(&to, "to", 0, "目标快照号；缺省为最新快照的上一个")
	return cmd
}

func newMemoryStatusCommand(stdout io.Writer) *cobra.Command {
	var reportPath string
	var noRecord bool
	cmd := &cobra.Command{
		Use: "status", Args: noArgs, Short: "记忆库现状；发现人工编辑时记成新快照",
		Long: `汇总记忆库：各状态的记忆数、最新快照、经历数、上次整理后新增的失败数，以及待沉睡候选。

召回只读快照。手改了记忆文件时，status 会发现与最新快照不一致的生效记忆，
把当前状态记成一个新快照并标注「人工编辑，未经考试」；--no-record 只报告不记录。`,
		Example: "  am memory status\n  am memory status --report-json production/memory-status.json",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			report, err := store.Status(!noRecord, func(r string) string { return store.CurrentModel(r, currentEnvironment()) })
			if err != nil {
				return err
			}
			if reportPath != "" {
				if err := writeReport(reportPath, report); err != nil {
					return err
				}
			}
			state := "关闭"
			if cfg.Memory.Enabled {
				state = "打开"
			}
			pinned := "跟随最新"
			if cfg.Memory.Snapshot > 0 {
				pinned = "钉住 #" + strconv.Itoa(cfg.Memory.Snapshot)
			}
			fmt.Fprintf(stdout, "记忆库：%s\n本项目：记忆%s，快照%s，召回预算 %d 字\n最新快照：#%d\n", report.Dir, state, pinned, cfg.Memory.RecallBudget, report.Snapshot)
			keys := make([]string, 0, len(report.Counts))
			for key := range report.Counts {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				fmt.Fprintf(stdout, "  %s：%d\n", key, report.Counts[key])
			}
			fmt.Fprintf(stdout, "经历 %d 段，上次整理后新增失败 %d 段\n", report.Episodes, report.PendingFailures)
			if len(report.Drift) > 0 {
				if report.Recorded > 0 {
					fmt.Fprintf(stdout, "发现人工编辑：%s，已记为快照 #%d（未经考试）\n", strings.Join(report.Drift, "、"), report.Recorded)
				} else {
					fmt.Fprintf(stdout, "发现人工编辑：%s（未记快照，召回不会用到）\n", strings.Join(report.Drift, "、"))
				}
			}
			for _, r := range report.Retest {
				fmt.Fprintf(stdout, "需要重考：%s 当初在 %s 上用 %s 考过，现在是 %s（am memory exam --renderers %s --retest %s）\n",
					r.Name, r.Renderer, strings.Join(r.Examined, "、"), r.Current, r.Renderer, r.Name)
			}
			for _, x := range report.Suspect {
				renderer := strings.SplitN(x.Renderer, "/", 2)[0]
				fmt.Fprintf(stdout, "可疑：%s 在 %s 上召回 %d 次，其中 %d 次它要防的 %s 照样判了失败（am memory exam --renderers %s --retest %s）\n",
					x.Name, x.Renderer, x.Recalled, x.Harmful, strings.Join(x.Checks, "、"), renderer, x.Name)
			}
			for _, w := range report.Weak {
				fmt.Fprintf(stdout, "待沉睡：%s 在 %s 上召回 %d 次，一次通过率 %.0f%%，不高于基线 %.0f%%\n", w.Name, w.Renderer, w.Recalled, w.Rate*100, w.Baseline*100)
			}
			for path, problem := range report.Broken {
				fmt.Fprintf(stdout, "无法解析：%s：%s\n", path, problem)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&reportPath, "report-json", "", "把现状写成 JSON")
	cmd.Flags().BoolVar(&noRecord, "no-record", false, "只报告人工编辑，不记成新快照")
	return cmd
}

func newMemoryFeedbackCommand(stdout io.Writer) *cobra.Command {
	var up, down bool
	var note, element, region string
	var at float64
	cmd := &cobra.Command{
		Use: "feedback DIRECTORY", Args: exactArgs(1, "DIRECTORY"), Short: "为一个镜头补录人工反馈（👍 / 👎）",
		Long: "把人工反馈写成一段经历。👎 会进入下一次整理；说明里的审美取向会被写成偏好，偏好由人确认后才生效。",
		Example: `  am memory feedback scenes/scene-003 --down --note "满屏霓虹太刺眼" --at 2.5
  am memory feedback scenes/scene-003 --down --region 0.1,0.6,0.8,0.3 --note "字幕压住了图表"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if up == down {
				return fmt.Errorf("必须且只能给出 --up 或 --down 之一")
			}
			feedback := memory.Feedback{Verdict: "up", Note: strings.TrimSpace(note), Seconds: at, Element: element}
			if down {
				feedback.Verdict = "down"
			}
			if region != "" {
				for _, part := range strings.Split(region, ",") {
					value, err := strconv.ParseFloat(strings.TrimSpace(part), 64)
					if err != nil || value < 0 || value > 1 {
						return fmt.Errorf("--region 必须是 4 个 0..1 之间的数：x,y,w,h")
					}
					feedback.Region = append(feedback.Region, value)
				}
				if len(feedback.Region) != 4 {
					return fmt.Errorf("--region 必须是 4 个 0..1 之间的数：x,y,w,h")
				}
			}
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			s, err := scene.Load(args[0])
			if err != nil {
				return err
			}
			episode, err := store.RecordFeedback(s, feedback)
			if err != nil {
				return err
			}
			fmt.Fprintf(stdout, "已记录经历 %s\n", episode.ID)
			return nil
		},
	}
	cmd.Flags().BoolVar(&up, "up", false, "👍")
	cmd.Flags().BoolVar(&down, "down", false, "👎")
	cmd.Flags().StringVar(&note, "note", "", "说明")
	cmd.Flags().Float64Var(&at, "at", -1, "画面在镜头内的时间点（秒）")
	cmd.Flags().StringVar(&region, "region", "", "框选区域，归一化坐标 x,y,w,h")
	cmd.Flags().StringVar(&element, "element", "", "点选的元素")
	return cmd
}

func newMemoryTimelineCommand(stdout io.Writer) *cobra.Command {
	var asJSON bool
	var limit int
	cmd := &cobra.Command{
		Use: "timeline", Args: noArgs, Short: "记忆库的事件时间线",
		Long:    "按发生顺序列出记忆库的事件：写经历、整理、试用、草稿被拒、考试、生效、被拒、沉睡、快照、人工编辑与回退。",
		Example: "  am memory timeline --limit 20\n  am memory timeline --json",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			events, err := store.Timeline()
			if err != nil {
				return err
			}
			if limit > 0 && len(events) > limit {
				events = events[len(events)-limit:]
			}
			if asJSON {
				if events == nil {
					events = []memory.Event{}
				}
				return printJSON(stdout, events)
			}
			for _, event := range events {
				fmt.Fprintf(stdout, "%s  %-14s %s\n", event.Time, event.Type, event.Summary)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	cmd.Flags().IntVar(&limit, "limit", 0, "只显示最近若干条")
	return cmd
}

// preferenceBrief 返回追加给编排工具的用户偏好段；记忆关闭时为空。
// 读不到记忆库只警告：偏好是锦上添花，不能因此挡住整片制作。
func preferenceBrief(cfg config.Config, root string, warn io.Writer) string {
	if !cfg.Memory.Enabled {
		return ""
	}
	text, _, err := memory.OpenReadOnly(cfg.Memory.Dir).PreferenceBrief(memory.ProjectName(root), cfg.Memory.Snapshot)
	if err != nil {
		fmt.Fprintf(warn, "警告：读取用户偏好失败，本次不带偏好：%v\n", err)
		return ""
	}
	return text
}

func newMemoryRememberCommand(stdout io.Writer) *cobra.Command {
	var name, description, revises string
	var global, inferred bool
	cmd := &cobra.Command{
		Use: "remember TEXT", Args: exactArgs(1, "TEXT"), Short: "记住用户亲口说的一条偏好",
		Long: `把用户表达的长期取向直接记为生效的偏好，并生成快照。用户自己说出来的就是确认，
不需要再经人工确认或考试。

偏好会进入两处：编排工具每次开工前读到的「用户偏好」段（am run 与 Studio 对话），
以及每个镜头渲染时的记忆召回。默认只对当前项目成立，--global 对所有项目成立。
用户收回一条偏好时用 am memory retire NAME。

--inferred 用于用户没有明说、由编排工具推测出来的取向：它进入试用，出现在偏好段的
「待确认」里，用户认可（am memory promote NAME）后才生效。`,
		Example: `  am memory remember --name calm-palette --description "配色克制" "主色不超过两种高饱和色，背景用深色"
  am memory remember --global --name no-emoji "画面里不要出现 emoji"
  am memory remember --name calm-palette-v2 --revises calm-palette "配色只用品牌色加一个强调色"
  am memory remember --inferred --name slower-pacing "用户几次把节奏改慢，倾向每屏停留更久"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			root, err := os.Getwd()
			if err != nil {
				return err
			}
			m, snapshot, err := store.Remember(memory.RememberInput{Name: name, Description: description, Body: args[0],
				Project: memory.ProjectName(root), Global: global, Revises: revises, Inferred: inferred})
			if err != nil {
				return err
			}
			scope := "本项目（" + m.Scope + "）"
			if m.Scope == "" {
				scope = "所有项目"
			}
			if inferred {
				fmt.Fprintf(stdout, "推测的偏好 %s（%s）进入试用：%s；用户确认后运行 am memory promote %s\n", m.Name, scope, m.Description, m.Name)
				return nil
			}
			fmt.Fprintf(stdout, "已记住偏好 %s（%s）：%s，快照 #%d\n", m.Name, scope, m.Description, snapshot.ID)
			return nil
		},
	}
	cmd.Flags().StringVar(&name, "name", "", "偏好名，小写字母、数字与连字符；缺省按时间生成")
	cmd.Flags().StringVar(&description, "description", "", "一句话概括；缺省取正文第一句")
	cmd.Flags().BoolVar(&global, "global", false, "对用户所有项目都成立")
	cmd.Flags().StringVar(&revises, "revises", "", "替换的旧偏好名，旧偏好转为沉睡")
	cmd.Flags().BoolVar(&inferred, "inferred", false, "用户没有明说、由编排工具推测的取向：先进入试用，用户确认后才生效")
	return cmd
}

// recordCheckFindings 把事后检查（阅读时间、交接、空白帧）查出的问题按镜头写成经历。
// 记忆关闭、读不到配置或写失败时只警告，不改变检查命令本身的结果。
func recordCheckFindings(warn io.Writer, root string, scenes []scene.Scene, byScene map[string][]memory.Finding) {
	if len(byScene) == 0 {
		return
	}
	cfg, err := config.Load(root, nil)
	if err != nil || !cfg.Memory.Enabled {
		return
	}
	store, err := memory.Open(cfg.Memory.Dir)
	if err != nil {
		fmt.Fprintf(warn, "警告：检查结果没能写进记忆库：%v\n", err)
		return
	}
	for _, s := range scenes {
		if findings := byScene[s.ID]; len(findings) > 0 {
			if _, _, err := store.RecordCheck(s, findings); err != nil {
				fmt.Fprintf(warn, "警告：镜头 %s 的检查结果没能写进记忆库：%v\n", s.ID, err)
			}
		}
	}
}

// blankPostCheck 是考试里空白帧的补查：只看第 0 帧。
// 空白帧经验来自 --at 0 --check-blank（第 0 帧当封面），看末帧会把合法的淡出也算进去。
func blankPostCheck(ctx context.Context, s scene.Scene, checks []string) []memory.Finding {
	if !slices.Contains(checks, scene.CheckFramesBlank) {
		return nil
	}
	toolchain, err := mediaprobe.New(currentEnvironment())
	if err != nil {
		return []memory.Finding{{Check: scene.CheckFramesBlank, Problem: "无法补查空白帧：" + err.Error()}}
	}
	report, err := toolchain.ExtractFramesRegion(s.OutputPath(), []float64{0}, nil, filepath.Join(s.Directory, "visual-qc"))
	if err != nil {
		return []memory.Finding{{Check: scene.CheckFramesBlank, Problem: "无法补查空白帧：" + err.Error()}}
	}
	var findings []memory.Finding
	for _, problem := range report.Problems {
		findings = append(findings, memory.Finding{Check: scene.CheckFramesBlank, Problem: problem})
	}
	return findings
}

func newMemoryReportCommand(stdout io.Writer) *cobra.Command {
	var last int
	var compare string
	var allProjects, asJSON bool
	cmd := &cobra.Command{
		Use: "report", Args: noArgs, Short: "按渲染批次对比：一次通过率、重试、问题数、耗时与 token",
		Long: `一次 am scene run / run-all 调用是一个批次。报告按批次汇总正式渲染：
  镜头数、首次尝试就通过的镜头数与比例（事后检查查出问题的不算通过）、
  重试次数、问题数（含事后检查查出的）、耗时、token、平均每镜召回的记忆条数、用到的快照，
并按「渲染工具/模型」分开列出——换了渲染工具带来的变化不能算成记忆的功劳。

缺省只看当前项目的批次，并对比最近两批；--compare 指定任意两批。`,
		Example: "  am memory report\n  am memory report --compare run-20261113-101500,run-20261114-153000\n  am memory report --json",
		RunE: func(cmd *cobra.Command, args []string) error {
			_, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			episodes, err := store.Episodes()
			if err != nil {
				return err
			}
			root, _ := os.Getwd()
			project := memory.ProjectName(root)
			runs := []memory.RunSummary{}
			for _, r := range memory.RunReport(episodes) {
				if allProjects || project == "" || r.Project == project {
					runs = append(runs, r)
				}
			}
			var pair []memory.RunSummary
			if compare != "" {
				ids := splitList(compare)
				if len(ids) != 2 {
					return fmt.Errorf("--compare 要给两个批次编号，逗号分隔")
				}
				for _, id := range ids {
					found := false
					for _, r := range runs {
						if r.Run == id {
							pair, found = append(pair, r), true
						}
					}
					if !found {
						return fmt.Errorf("找不到批次 %s", id)
					}
				}
			} else if len(runs) >= 2 {
				pair = runs[len(runs)-2:]
			}
			if last > 0 && len(runs) > last {
				runs = runs[len(runs)-last:]
			}
			if asJSON {
				return printJSON(stdout, map[string]any{"runs": runs, "compare": pair})
			}
			if len(runs) == 0 {
				fmt.Fprintln(stdout, "还没有带批次编号的渲染记录。")
				return nil
			}
			fmt.Fprintln(stdout, "批次\t\t\t镜头\t一次通过\t重试\t问题(事后)\t耗时\ttoken(入/出)\t召回/镜\t快照")
			for _, r := range runs {
				fmt.Fprintf(stdout, "%s\t%d\t%d（%.0f%%）\t%d\t%d(%d)\t%.0fs\t%d/%d\t%.1f\t%v\n", r.Run, r.Scenes, r.PassedFirstTry, r.PassRate*100,
					r.Retries, r.Problems, r.CheckProblems, r.Seconds, r.InputTokens, r.OutputTokens, r.Recalled, r.Snapshots)
			}
			if len(pair) == 2 {
				fmt.Fprintf(stdout, "\n对比 %s → %s\n", pair[0].Run, pair[1].Run)
				fmt.Fprint(stdout, compareLine("全部", pair[0].RunStats, pair[1].RunStats))
				keys := map[string]bool{}
				for key := range pair[0].ByModel {
					keys[key] = true
				}
				for key := range pair[1].ByModel {
					keys[key] = true
				}
				sorted := make([]string, 0, len(keys))
				for key := range keys {
					sorted = append(sorted, key)
				}
				sort.Strings(sorted)
				for _, key := range sorted {
					a, aok := pair[0].ByModel[key]
					b, bok := pair[1].ByModel[key]
					if aok && bok {
						fmt.Fprint(stdout, compareLine(key, a, b))
					} else {
						fmt.Fprintf(stdout, "  %s：只出现在其中一批，不可比\n", key)
					}
				}
			}
			return nil
		},
	}
	cmd.Flags().IntVar(&last, "last", 10, "只列最近若干批")
	cmd.Flags().StringVar(&compare, "compare", "", "对比的两个批次编号，逗号分隔；缺省为最近两批")
	cmd.Flags().BoolVar(&allProjects, "all-projects", false, "列出所有项目的批次")
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	return cmd
}

func compareLine(label string, a, b memory.RunStats) string {
	return fmt.Sprintf("  %s：一次通过率 %.0f%% → %.0f%%，重试 %d → %d，问题 %d → %d，平均耗时 %.0fs → %.0fs，平均 token %s → %s\n",
		label, a.PassRate*100, b.PassRate*100, a.Retries, b.Retries, a.Problems, b.Problems,
		perScene(a.Seconds, a.Scenes), perScene(b.Seconds, b.Scenes),
		tokensPerScene(a), tokensPerScene(b))
}

func perScene(total float64, scenes int) float64 {
	if scenes == 0 {
		return 0
	}
	return total / float64(scenes)
}

func tokensPerScene(s memory.RunStats) string {
	if s.InputTokens+s.OutputTokens == 0 {
		return "—"
	}
	return strconv.FormatInt((s.InputTokens+s.OutputTokens)/int64(max(s.Scenes, 1)), 10)
}

func newMemoryImportCommand(stdout io.Writer) *cobra.Command {
	var asJSON bool
	var tolerance float64
	cmd := &cobra.Command{
		Use: "import PROJECT...", Args: cobra.MinimumNArgs(1), Short: "把已有项目的渲染历史导入为种子经历",
		Long: `从已有项目里导入渲染历史，作为记忆的种子：
  - 镜头目录里的尝试记录（render-<id>.attempt.json）与 attempts/ 下归档的尝试；
  - 只有产物没有尝试记录的归档（含 production/failed-attempts/<镜头>-attempt-NN-*），
    用现在的产物校验重判一遍，只记失败；
  - production/review/review.json 里没接上的交接；
  - production/visible-event-inventory.json（schema 1）的阅读时间问题。

每个镜头最早的一次尝试算首次尝试，其余算重试；批次编号是 import:<项目名>，
am memory report --all-projects 能看到这些项目当时的一次通过率。
冻结的输入是镜头现在的输入（历史输入没有留存）。重复导入同一个来源会跳过。`,
		Example: "  am memory import ../c-language-20260929 ../agent原理/ep01-前大模型时代",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validateTolerance(tolerance); err != nil {
				return err
			}
			cfg, store, err := loadMemoryConfig()
			if err != nil {
				return err
			}
			var results []memory.ImportResult
			for _, project := range args {
				result, err := store.ImportProject(project, memory.ImportOptions{Env: currentEnvironment(), Tolerance: tolerance, Renderer: cfg.Renderer})
				if err != nil {
					return fmt.Errorf("导入 %s：%w", project, err)
				}
				results = append(results, result)
			}
			if asJSON {
				return printJSON(stdout, results)
			}
			for _, r := range results {
				fmt.Fprintf(stdout, "%s：%d 个镜头，导入 %d 次尝试（%d 次校验失败）、%d 条事后检查问题，跳过 %d\n",
					r.Project, r.Scenes, r.Attempts, r.Failures, r.Checks, r.Skipped)
				for _, note := range r.Notes {
					fmt.Fprintf(stdout, "  提示：%s\n", note)
				}
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "输出 JSON")
	cmd.Flags().Float64Var(&tolerance, "duration-tolerance", 0.15, "重新校验归档产物时的时长容差（秒）")
	return cmd
}
