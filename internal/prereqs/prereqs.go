// Package prereqs 是前置资源清单：要联网准备的每一项、怎么判断就绪、怎么准备。
//
// am setup（下载）与 Studio 的引导（只读状态）共用这一份清单，两边说的永远是同一组
// 东西。判断就绪不联网；准备只由 am setup 调用。错误类型与文案约定见 internal/prereq。
package prereqs

import (
	"context"
	"fmt"
	"io"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	_ "github.com/chouheiwa/articale-to-motion/internal/filmstyle/sources"
	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
)

// Run 是一次准备要用的环境与输出：git 走代理、npm 走自己的配置；工具的原始输出
// 写进 Log，Stage 汇报进行到哪一步。
type Run struct {
	Base, Git, NPM, Mixed map[string]string
	Log                   io.Writer
	Stage                 func(string)
}

// Item 是一项前置资源。
type Item struct {
	// Group 是 --only 认的大类（skills、cli、styles），ID 是这一项自己的名字；
	// 风格来源每个一项，ID 为 styles:<来源>。
	Group, ID string
	// Name 与 Version 分两列显示。
	Name, Version string
	// Required 表示做片必需（技能与 CLI）；整片风格来源只有选了风格才要。
	Required bool
	// Ready 不联网地判断是否已就绪；where 是给人看的位置。
	Ready   func(env map[string]string) (ok bool, where string)
	Prepare func(ctx context.Context, run Run) error
}

// hyperframesStage 把 HyperFrames 的进度译成一行说明。
func hyperframesStage(p hyperframes.Progress) string {
	if p.Indeterminate || p.Percent <= 0 || p.Percent >= 100 {
		return p.Stage
	}
	return fmt.Sprintf("%s %d%%", p.Stage, int(p.Percent))
}

// Items 返回全部前置资源，顺序即准备顺序。
func Items() []Item {
	version := hyperframes.PinnedVersion
	items := []Item{
		{
			Group: "skills", ID: "skills", Required: true,
			Name: "HyperFrames 技能", Version: version,
			Ready: func(env map[string]string) (bool, string) {
				dir := hyperframes.DefaultCacheDir(env)
				return hyperframes.SkillsReady(dir), dir
			},
			Prepare: func(ctx context.Context, run Run) error {
				return hyperframes.PrepareSkills(ctx, hyperframes.Options{
					Env: run.Git, CacheDir: hyperframes.DefaultCacheDir(run.Base), Output: run.Log,
					Progress: func(p hyperframes.Progress) { run.Stage(hyperframesStage(p)) },
				})
			},
		},
		{
			Group: "cli", ID: "cli", Required: true,
			Name: "HyperFrames CLI", Version: version,
			Ready: func(env map[string]string) (bool, string) {
				dir := hyperframes.CLIDir(env, hyperframes.PinnedVersion)
				return hyperframes.CLIReady(dir, hyperframes.PinnedVersion), dir
			},
			Prepare: func(ctx context.Context, run Run) error {
				_, err := hyperframes.EnsureCLI(ctx, hyperframes.CLIOptions{
					Env: run.NPM, Output: run.Log,
					Progress: func(p hyperframes.Progress) { run.Stage(hyperframesStage(p)) },
				})
				return err
			},
		},
	}
	for _, source := range filmstyle.Sources() {
		source := source
		items = append(items, Item{
			Group: "styles", ID: "styles:" + source.ID(),
			Name: "整片风格 " + source.ID(),
			Ready: func(env map[string]string) (bool, string) {
				return source.Check(env) == nil, source.Location(env)
			},
			Prepare: func(ctx context.Context, run Run) error {
				// 来源可能既用 git 又用 npm：git 的代理与 npm 的源合在一份环境里。
				return source.Prepare(ctx, filmstyle.PrepareOptions{
					Env: run.Mixed, Output: run.Log,
					Progress: func(p filmstyle.PrepareProgress) {
						run.Stage(fmt.Sprintf("(%d/%d) %s", p.Step, p.Steps, p.Stage))
					},
				})
			},
		})
	}
	return items
}

// Status 是一项的就绪状态（给 Studio 与 --check 用）。
type Status struct {
	ID       string `json:"id"`
	Group    string `json:"group"`
	Name     string `json:"name"`
	Version  string `json:"version,omitempty"`
	Required bool   `json:"required"`
	Ready    bool   `json:"ready"`
	Location string `json:"location"`
}

// Check 不联网地返回全部项的状态。
func Check(env map[string]string) []Status {
	var out []Status
	for _, item := range Items() {
		ok, where := item.Ready(env)
		out = append(out, Status{ID: item.ID, Group: item.Group, Name: item.Name, Version: item.Version, Required: item.Required, Ready: ok, Location: where})
	}
	return out
}
