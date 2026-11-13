// Package projectinit 建一个新的视频项目：am init 与 Studio 的「新建项目」共用这一条路。
//
// 两边曾经各写一份：Studio 那份漏了讲解形式（歌曲 / 卡点）、多角色对话，也不装
// HyperFrames 官方技能——在 Studio 里新建的项目渲染时拿不到 hyperframes 入口技能，
// 渲染器要么报缺失要么自己瞎写。放在一处，两个入口建出的项目逐字节相同。
package projectinit

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"

	assets "github.com/chouheiwa/articale-to-motion"
	"github.com/chouheiwa/articale-to-motion/internal/beat"
	"github.com/chouheiwa/articale-to-motion/internal/cast"
	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
	"github.com/chouheiwa/articale-to-motion/internal/hyperframes"
	"github.com/chouheiwa/articale-to-motion/internal/preset"
	"github.com/chouheiwa/articale-to-motion/internal/project"
	"github.com/chouheiwa/articale-to-motion/internal/song"
	"gopkg.in/yaml.v3"
)

// 讲解形式（am init --delivery）。
const (
	DeliverySpeech = "speech"
	DeliverySong   = "song"
	DeliveryBeat   = "beat"
)

// 叙事模式（am init --narration）。solo 是单口播；cast 是多角色对话，额外写出 cast.yaml 与 cast/。
const (
	NarrationSolo = "solo"
	NarrationCast = "cast"
)

// CastDefaultGroundY、CastDefaultGapMs 是新建 cast.yaml 时写入的默认班底参数，
// am cast add 新建 cast.yaml 时用同一组值。
const CastDefaultGroundY = 0.78

var CastDefaultGapMs = cast.GapMs{Turn: 240, Interject: 100}

// Options 是建一个项目要的全部选择。
type Options struct {
	Target    string
	Canvas    string
	Style     preset.Style
	Delivery  string
	Narration string
	// Extra 是调用方另外要写进项目的文件（如自定义风格描述）。
	Extra map[string][]byte
}

// Validate 检查讲解形式与叙事模式的组合，以及目标目录里已有的模式文件。
func Validate(opts Options) error {
	if opts.Narration != NarrationSolo && opts.Narration != NarrationCast {
		return fmt.Errorf("无效的叙事模式：%s（可选：%s %s）", opts.Narration, NarrationSolo, NarrationCast)
	}
	switch opts.Delivery {
	case DeliverySpeech, DeliverySong, DeliveryBeat:
	default:
		return fmt.Errorf("讲解形式必须为 %s、%s 或 %s", DeliverySpeech, DeliverySong, DeliveryBeat)
	}
	target := opts.Target
	if opts.Delivery == DeliveryBeat && (opts.Narration == NarrationCast || cast.HasRoster(target) || song.Enabled(target)) {
		return fmt.Errorf("卡点模式不能与歌曲讲解或多角色对话同时启用")
	}
	if (opts.Delivery == DeliverySong && (opts.Narration == NarrationCast || cast.HasRoster(target))) || (opts.Narration == NarrationCast && song.Enabled(target)) {
		return fmt.Errorf("首版不支持 song + cast")
	}
	return nil
}

// Create 写出项目文件：三棵内置资产树、风格字体、模式文件与调用方的额外文件，
// 多角色对话再写 cast.yaml 与 cast/。不装 HyperFrames 技能，见 InstallSkills。
func Create(opts Options) (project.InitResult, error) {
	if err := Validate(opts); err != nil {
		return project.InitResult{}, err
	}
	shared, err := assets.Shared()
	if err != nil {
		return project.InitResult{}, err
	}
	presetFiles, err := assets.Preset(opts.Canvas)
	if err != nil {
		return project.InitResult{}, err
	}
	styleFiles, err := assets.Style(opts.Style.ID, opts.Canvas)
	if err != nil {
		return project.InitResult{}, err
	}
	extra, err := assets.StyleFonts(opts.Style)
	if err != nil {
		return project.InitResult{}, err
	}
	for path, body := range opts.Extra {
		extra[path] = body
	}
	switch opts.Delivery {
	case DeliverySong:
		extra["song.yaml"] = []byte(song.DefaultConfig)
	case DeliveryBeat:
		extra[beat.ConfigFile] = []byte(beat.DefaultConfig)
	}
	result, err := project.InitializeWithFiles(opts.Target, extra, shared, presetFiles, styleFiles)
	if err != nil {
		return result, err
	}
	if opts.Narration == NarrationCast {
		if err := WriteCastScaffold(opts.Target); err != nil {
			return result, fmt.Errorf("项目文件已写入，但写出 %s 失败：%w", cast.RosterFile, err)
		}
	}
	return result, nil
}

// InstallSkills 把固定版本的 HyperFrames 官方技能装进项目的 .agents/skills/，
// 与内置技能重名的保留内置版本（返回在 Protected 里）。要联网。
// progress 非空时汇报整体进度（见 hyperframes.Progress）。
func InstallSkills(ctx context.Context, target string, env map[string]string, output io.Writer, progress func(hyperframes.Progress)) (hyperframes.Result, error) {
	builtin, err := assets.BuiltinSkills()
	if err != nil {
		return hyperframes.Result{}, err
	}
	return hyperframes.Install(ctx, hyperframes.Options{
		ProjectDir: target,
		Version:    hyperframes.PinnedVersion,
		Env:        env,
		Protected:  builtin,
		Output:     output,
		Progress:   progress,
	})
}

// SkillsInstalled 表示项目里装过 HyperFrames 官方技能（有来源记录）。
func SkillsInstalled(target string) bool {
	_, err := os.Stat(filepath.Join(target, hyperframes.SkillsSubdir, hyperframes.ManifestFile))
	return err == nil
}

// CastYAML 构造新建项目的 cast.yaml。走 cast.Roster + yaml.Marshal 而不是手写模板，
// 与 am cast add 新建 cast.yaml 共用同一条构造路径；packs 留空（序列化为 `packs: []`）。
func CastYAML() ([]byte, error) {
	roster := cast.Roster{
		Schema:   cast.SchemaVersion,
		Defaults: cast.Defaults{GroundY: CastDefaultGroundY, GapMs: CastDefaultGapMs},
	}
	body, err := yaml.Marshal(roster)
	if err != nil {
		return nil, fmt.Errorf("序列化 %s 失败：%w", cast.RosterFile, err)
	}
	return body, nil
}

// WriteCastScaffold 在 target 下写出 cast.yaml 并建出空的 cast/ 目录。
//
// packs 刻意留空：刚建出的项目本来就还没有引入任何角色包，不在这里塞占位角色，
// 也不判空报错。与 project.Initialize 的幂等语义一致：cast.yaml 已存在且内容相同
// 就跳过，内容不同就报错，不静默覆盖。
func WriteCastScaffold(target string) error {
	if err := os.MkdirAll(filepath.Join(target, "cast"), 0o755); err != nil {
		return fmt.Errorf("创建 %s 目录失败：%w", cast.RosterFile, err)
	}
	rosterPath := filepath.Join(target, cast.RosterFile)
	body, err := CastYAML()
	if err != nil {
		return err
	}
	if existing, err := os.ReadFile(rosterPath); err == nil {
		if !bytes.Equal(existing, body) {
			return fmt.Errorf("目标文件已存在且内容不同：%s", rosterPath)
		}
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("检查 %s 失败：%w", rosterPath, err)
	}
	if err := fsutil.AtomicWrite(rosterPath, body, 0o644); err != nil {
		return fmt.Errorf("写入 %s 失败：%w", rosterPath, err)
	}
	return nil
}
