// Package ledger 是编排工具用量的账本。
//
// 渲染的用量记在每个镜头的尝试记录里；编排工具（am run、Studio 对话、整理记忆）
// 没有这样的落点，跑完只在终端打印一行，关掉就没了。账本是一份只追加的 JSONL：
// 每次调用一行，失败、取消的调用照样记——钱已经花了。
package ledger

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// 调用来源。
const (
	SourceRun         = "run"         // am run
	SourceStudio      = "studio"      // Studio 的一轮对话或「开始制作」
	SourceConsolidate = "consolidate" // am memory consolidate 的整理者
)

// ProjectFile 是项目里的账本路径。它在 production/usage/ 下而不是 production/studio/：
// am run 不是 Studio，但两者的账要记在一起。Studio 扫描项目时跳过这个目录，
// 回退一轮不会把账抹掉。
func ProjectFile(project string) string {
	return filepath.Join(ProjectDir(project), "orchestrator.jsonl")
}

// ProjectDir 是项目里账本所在的目录。
func ProjectDir(project string) string {
	return filepath.Join(project, "production", "usage")
}

// Entry 是一次编排调用的账。
type Entry struct {
	Time   string `json:"time"`
	Source string `json:"source"`
	Tool   string `json:"tool"`
	// Model 来自输出流或工具配置；读不到就留空。
	Model   string `json:"model,omitempty"`
	Session string `json:"session,omitempty"`
	// Turn 是 Studio 的轮次编号。
	Turn string `json:"turn,omitempty"`
	// Status 是 succeeded / failed / cancelled。
	Status string `json:"status"`
	// Usage 为 nil 表示这次没读到用量，汇总时标为不完整。
	Usage *tools.Usage `json:"usage,omitempty"`
}

// Append 把一条账追加到 path。每条是一次 O_APPEND 的单行写入，并发调用不会穿插。
func Append(path string, entry Entry) error {
	if entry.Time == "" {
		entry.Time = time.Now().UTC().Format(time.RFC3339)
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	if _, err := file.Write(append(line, '\n')); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

// Read 读出 path 里的全部账，按写入顺序；文件不存在时返回空，坏行跳过。
func Read(path string) ([]Entry, error) {
	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Entry
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry Entry
		if json.Unmarshal([]byte(line), &entry) == nil {
			out = append(out, entry)
		}
	}
	return out, nil
}

// Summary 是一组账的合计。
type Summary struct {
	Calls    int                    `json:"calls"`
	Total    tools.Usage            `json:"total"`
	BySource map[string]tools.Usage `json:"by_source"`
	// ByModel 的键是「编排工具/模型」，模型未知时只有工具名。
	ByModel map[string]tools.Usage `json:"by_model"`
}

// Summarize 合计一组账。
func Summarize(entries []Entry) Summary {
	out := Summary{BySource: map[string]tools.Usage{}, ByModel: map[string]tools.Usage{}}
	for _, entry := range entries {
		out.Calls++
		var usage tools.Usage
		if entry.Usage != nil {
			usage = *entry.Usage
		}
		key := entry.Tool
		if entry.Model != "" {
			key += "/" + entry.Model
		}
		bySource, byModel := out.BySource[entry.Source], out.ByModel[key]
		for _, target := range []*tools.Usage{&out.Total, &bySource, &byModel} {
			target.Add(usage)
		}
		out.BySource[entry.Source], out.ByModel[key] = bySource, byModel
	}
	return out
}

// SortedKeys 返回 map 的键，按字典序。
func SortedKeys(m map[string]tools.Usage) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// FromResult 从一次调用的结果组一条账：没读到用量时 Usage 留空。
func FromResult(source, tool, model, session string, usage tools.Usage, err error, cancelled bool) Entry {
	entry := Entry{Source: source, Tool: tool, Model: model, Session: session, Status: "succeeded"}
	switch {
	case cancelled:
		entry.Status = "cancelled"
	case err != nil:
		entry.Status = "failed"
	}
	if !usage.Empty() {
		u := usage
		entry.Usage = &u
	}
	return entry
}

// MemoryFile 是记忆库里的账本：整理记忆不属于哪个项目，记在记忆库里。
func MemoryFile(memoryDir string) string {
	return filepath.Join(memoryDir, "orchestrator-usage.jsonl")
}
