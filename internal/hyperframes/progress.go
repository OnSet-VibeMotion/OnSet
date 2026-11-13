package hyperframes

import (
	"bytes"
	"regexp"
	"strconv"
	"sync"
)

// Progress 是安装的一次进度汇报。Percent 是整体进度（0–100）；Indeterminate 为 true
// 时这一步没有可量的进度（检出技能文件时 git 一声不吭），界面显示不确定进度。
type Progress struct {
	Stage         string  `json:"stage"`
	Percent       float64 `json:"percent"`
	Indeterminate bool    `json:"indeterminate,omitempty"`
}

// 各步在整体进度里占的区间。实测（0.8.225，经代理）克隆约 49 秒、检出约 11 秒、
// 拷贝不到 1 秒；克隆又分成 git 报告的几个阶段，最耗时的是接收对象。
var cloneStages = []struct {
	prefix   string
	label    string
	from, to float64
}{
	{"remote: Counting objects", "连接上游仓库", 0, 4},
	{"remote: Compressing objects", "连接上游仓库", 4, 8},
	{"Receiving objects", "下载技能仓库", 8, 62},
	{"Resolving deltas", "整理下载内容", 62, 68},
	{"Updating files", "整理下载内容", 68, 72},
}

const (
	checkoutStart = 72
	copyStart     = 95
)

var percentPattern = regexp.MustCompile(`(\d{1,3})%`)

// gitProgress 解析 git --progress 写到 stderr 的进度行（以 \r 或 \n 分隔），
// 换算成整体进度回调出去；原始输出照样转给 next。
type gitProgress struct {
	mu     sync.Mutex
	report func(Progress)
	next   interface{ Write([]byte) (int, error) }
	buf    []byte
	last   float64
}

func (g *gitProgress) Write(p []byte) (int, error) {
	if g.next != nil {
		_, _ = g.next.Write(p)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.buf = append(g.buf, p...)
	for {
		i := bytes.IndexAny(g.buf, "\r\n")
		if i < 0 {
			break
		}
		g.line(string(g.buf[:i]))
		g.buf = g.buf[i+1:]
	}
	return len(p), nil
}

func (g *gitProgress) line(line string) {
	for _, stage := range cloneStages {
		if len(line) < len(stage.prefix) || line[:len(stage.prefix)] != stage.prefix {
			continue
		}
		match := percentPattern.FindStringSubmatch(line)
		if match == nil {
			return
		}
		percent, _ := strconv.Atoi(match[1])
		overall := stage.from + (stage.to-stage.from)*float64(min(percent, 100))/100
		// 只往前走：git 的几个阶段偶尔交错，进度条倒退比停一下更让人不安。
		if overall < g.last {
			return
		}
		g.last = overall
		g.report(Progress{Stage: stage.label, Percent: overall})
		return
	}
}
