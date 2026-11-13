package cli

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/term"
)

// setupView 是 am setup 的终端界面：每项前置资源一行，状态图标、名字、版本、进展
// 对齐成列。终端里原地重画（转圈图标与计时）；不是终端（管道、CI）时每次状态或
// 阶段变化打一行，不重画。git / npm 的原始输出不上屏，写进日志文件。
type setupView struct {
	out   io.Writer
	tty   bool
	color bool

	mu      sync.Mutex
	items   []viewItem
	drawn   int // 终端里上一次画了几行
	frame   int
	stop    chan struct{}
	done    chan struct{}
	started time.Time
}

type viewState int

const (
	viewPending viewState = iota
	viewRunning
	viewReady  // 本来就已就绪
	viewDone   // 这次装好
	viewFailed // 失败
)

type viewItem struct {
	name, version string
	state         viewState
	detail        string
	started       time.Time
	ended         time.Time
	lastPrinted   string // 非终端模式下上一次打出的行，避免重复
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func newSetupView(out io.Writer, names, versions []string) *setupView {
	v := &setupView{out: out, started: time.Now()}
	if file, ok := out.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		v.tty = true
		v.color = os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
	}
	for i := range names {
		v.items = append(v.items, viewItem{name: names[i], version: versions[i]})
	}
	return v
}

// Start 开始重画（终端里每 100 毫秒一次）。
func (v *setupView) Start() {
	if !v.tty {
		return
	}
	v.stop, v.done = make(chan struct{}), make(chan struct{})
	go func() {
		defer close(v.done)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-v.stop:
				return
			case <-ticker.C:
				v.mu.Lock()
				v.frame++
				v.redraw()
				v.mu.Unlock()
			}
		}
	}()
}

// Stop 停止重画并画最后一次。
func (v *setupView) Stop() {
	if v.stop != nil {
		close(v.stop)
		<-v.done
		v.stop = nil
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.tty {
		v.redraw()
	}
}

// Set 改一项的状态与进展说明。
func (v *setupView) Set(index int, state viewState, detail string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	item := &v.items[index]
	if state == viewRunning && item.state != viewRunning {
		item.started = time.Now()
	}
	if (state == viewDone || state == viewFailed) && item.ended.IsZero() {
		item.ended = time.Now()
	}
	item.state, item.detail = state, detail
	if v.tty {
		v.redraw()
		return
	}
	line := v.line(index)
	if line != item.lastPrinted {
		item.lastPrinted = line
		fmt.Fprintln(v.out, line)
	}
}

// Detail 只改进展说明（进行中的阶段）。
func (v *setupView) Detail(index int, detail string) {
	v.mu.Lock()
	state := v.items[index].state
	v.mu.Unlock()
	v.Set(index, state, detail)
}

// redraw 回到上次画的位置，把全部行重画一遍。调用方持锁。
func (v *setupView) redraw() {
	var b strings.Builder
	if v.drawn > 0 {
		fmt.Fprintf(&b, "\033[%dA", v.drawn)
	}
	for i := range v.items {
		b.WriteString("\r\033[K")
		b.WriteString(v.line(i))
		b.WriteByte('\n')
	}
	v.drawn = len(v.items)
	io.WriteString(v.out, b.String())
}

// 列宽：名字与版本按显示宽度（中文算两列）补齐。
func (v *setupView) widths() (int, int) {
	name, version := 0, 0
	for _, item := range v.items {
		name = max(name, displayWidth(item.name))
		version = max(version, displayWidth(item.version))
	}
	return name, version
}

func (v *setupView) line(index int) string {
	item := v.items[index]
	nameWidth, versionWidth := v.widths()
	var icon, detail string
	switch item.state {
	case viewPending:
		icon, detail = v.paint("2", "·"), v.paint("2", "等待")
	case viewRunning:
		icon = "›"
		if v.tty {
			icon = spinnerFrames[v.frame%len(spinnerFrames)]
		}
		icon = v.paint("36", icon)
		detail = item.detail
		if v.tty {
			detail += "  " + v.paint("2", clock(time.Since(item.started)))
		}
	case viewReady:
		icon, detail = v.paint("32", "✓"), v.paint("2", "已就绪")
	case viewDone:
		icon, detail = v.paint("32", "✓"), "完成 "+v.paint("2", "· "+clock(item.ended.Sub(item.started)))
	case viewFailed:
		icon, detail = v.paint("31", "✗"), v.paint("31", "失败")
	}
	version := pad(item.version, versionWidth)
	if versionWidth > 0 {
		version = v.paint("2", version) + "  "
	}
	return "  " + icon + " " + pad(item.name, nameWidth) + "  " + version + detail
}

func (v *setupView) paint(code, text string) string {
	if !v.color {
		return text
	}
	return "\033[" + code + "m" + text + "\033[0m"
}

// clock 把耗时写成 m:ss。
func clock(d time.Duration) string {
	seconds := int(d.Round(time.Second).Seconds())
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}

func pad(text string, width int) string {
	return text + strings.Repeat(" ", max(0, width-displayWidth(text)))
}

// displayWidth 是终端里的显示宽度：中日韩字符与全角符号占两列。
func displayWidth(text string) int {
	width := 0
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r), unicode.Is(unicode.Hiragana, r), unicode.Is(unicode.Katakana, r),
			r >= 0xFF00 && r <= 0xFFEF, r >= 0x3000 && r <= 0x303F:
			width += 2
		default:
			width++
		}
	}
	return width
}

// tailLines 返回文本最后 n 行非空行。
func tailLines(text string, n int) []string {
	var out []string
	lines := strings.Split(strings.ReplaceAll(text, "\r", "\n"), "\n")
	for i := len(lines) - 1; i >= 0 && len(out) < n; i-- {
		if line := strings.TrimRight(lines[i], " \t"); strings.TrimSpace(line) != "" {
			out = append([]string{line}, out...)
		}
	}
	return out
}

// homeShort 把家目录换成 ~，路径短一些。
func homeShort(path string) string {
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.HasPrefix(path, home) {
		return "~" + strings.TrimPrefix(path, home)
	}
	return path
}
