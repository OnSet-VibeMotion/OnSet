package memory

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
)

// Store 是一个记忆库目录。
//
//	MEMORY.md        索引：每条生效记忆一行
//	lessons/         经验，一条一个文件
//	preferences/     偏好
//	episodes/        经历，按月分目录，每段一个目录（episode.json + 冻结输入）
//	exams/           考试结果
//	snapshots/       记忆库快照
//	consolidate/     整理时交给整理者的工作目录
//	timeline.jsonl   事件日志
type Store struct {
	Dir string
	// now 可在测试里替换。
	now func() time.Time
}

// Open 返回 dir 处的记忆库，按需建出子目录。
func Open(dir string) (*Store, error) {
	if dir == "" {
		return nil, errors.New("记忆库目录为空")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	for _, sub := range []string{"lessons", "preferences", "episodes", "exams", "snapshots"} {
		if err := os.MkdirAll(filepath.Join(abs, sub), 0o755); err != nil {
			return nil, fmt.Errorf("建立记忆库目录：%w", err)
		}
	}
	return &Store{Dir: abs, now: time.Now}, nil
}

// OpenReadOnly 返回 dir 处的记忆库但不建任何目录，供只读的调用方使用：
// 目录不存在时读出来就是空库。
func OpenReadOnly(dir string) *Store {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	return &Store{Dir: abs, now: time.Now}
}

func (s *Store) clock() time.Time {
	if s.now == nil {
		return time.Now()
	}
	return s.now()
}

// Path 返回一条记忆的文件路径。
func (s *Store) Path(kind Kind, name string) string {
	return filepath.Join(s.Dir, kind.dir(), name+".md")
}

// Memories 读出记忆库里的全部经验与偏好，按层、名字排序。
// 解析失败的文件单独返回，不让一份坏文件拖垮整次召回。
func (s *Store) Memories() ([]Memory, map[string]error, error) {
	var out []Memory
	broken := map[string]error{}
	for _, kind := range []Kind{KindLesson, KindPreference} {
		entries, err := os.ReadDir(filepath.Join(s.Dir, kind.dir()))
		if err != nil && !os.IsNotExist(err) {
			return nil, nil, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
				continue
			}
			path := filepath.Join(s.Dir, kind.dir(), entry.Name())
			body, err := os.ReadFile(path)
			if err != nil {
				return nil, nil, err
			}
			m, err := Parse(kind, body)
			if err == nil && m.Name+".md" != entry.Name() {
				err = fmt.Errorf("name 字段 %q 与文件名不一致", m.Name)
			}
			if err != nil {
				broken[filepath.ToSlash(filepath.Join(kind.dir(), entry.Name()))] = err
				continue
			}
			out = append(out, m)
		}
	}
	sortMemories(out)
	return out, broken, nil
}

func sortMemories(list []Memory) {
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].Kind != list[j].Kind {
			return list[i].Kind < list[j].Kind
		}
		return list[i].Name < list[j].Name
	})
}

// Find 按名字找一条记忆。
func (s *Store) Find(name string) (Memory, bool, error) {
	all, _, err := s.Memories()
	if err != nil {
		return Memory{}, false, err
	}
	for _, m := range all {
		if m.Name == name {
			return m, true, nil
		}
	}
	return Memory{}, false, nil
}

// Write 原子写出一条记忆，并刷新索引。
func (s *Store) Write(m Memory) error {
	if !ValidName(m.Name) {
		return fmt.Errorf("记忆名不合法：%q（小写字母、数字与连字符，3–64 字符）", m.Name)
	}
	if err := fsutil.AtomicWrite(s.Path(m.Kind, m.Name), Format(m), 0o644); err != nil {
		return err
	}
	return s.writeIndex()
}

// writeIndex 重写 MEMORY.md：每条生效记忆一行「标题 — 一句话钩子」。
// 它只给人读，召回不读它。
func (s *Store) writeIndex() error {
	all, _, err := s.Memories()
	if err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("# 渲染记忆索引\n\n由 am 维护，只列生效记忆。改记忆请改 lessons/ 与 preferences/ 下的文件，再运行 am memory status。\n\n")
	count := 0
	for _, m := range all {
		if m.Status != StatusActive {
			continue
		}
		count++
		label := ""
		if m.Kind == KindPreference {
			label = "（偏好，未经机器验证）"
		}
		fmt.Fprintf(&b, "- [%s](%s/%s.md) — %s%s\n", m.Name, m.Kind.dir(), m.Name, m.Description, label)
	}
	if count == 0 {
		b.WriteString("（暂无生效记忆）\n")
	}
	return fsutil.AtomicWrite(filepath.Join(s.Dir, "MEMORY.md"), []byte(b.String()), 0o644)
}

// Event 是时间线上的一条事件。
type Event struct {
	Time     string         `json:"time"`
	Type     string         `json:"type"`
	Snapshot int            `json:"snapshot,omitempty"`
	Summary  string         `json:"summary"`
	Detail   map[string]any `json:"detail,omitempty"`
}

// 时间线事件类型。
const (
	EventEpisode     = "episode"
	EventConsolidate = "consolidate"
	EventTrial       = "trial"
	EventDraftReject = "draft_rejected"
	EventExam        = "exam"
	EventPromote     = "promote"
	EventReject      = "reject"
	EventDormant     = "dormant"
	EventRollback    = "rollback"
	EventManualEdit  = "manual_edit"
	EventSnapshot    = "snapshot"
)

// Log 追加一条时间线事件。
//
// 每条事件是一次 O_APPEND 的单行写入：run-all 的几个镜头会同时写经历事件，
// 本地文件系统上单次追加写不会互相穿插。
func (s *Store) Log(event Event) error {
	if event.Time == "" {
		event.Time = s.clock().UTC().Format(time.RFC3339)
	}
	line, err := json.Marshal(event)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(s.Dir, "timeline.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(line, '\n'))
	return err
}

// Timeline 读出全部时间线事件，按写入顺序。坏行跳过。
func (s *Store) Timeline() ([]Event, error) {
	body, err := os.ReadFile(filepath.Join(s.Dir, "timeline.jsonl"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var events []Event
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var event Event
		if json.Unmarshal([]byte(line), &event) == nil {
			events = append(events, event)
		}
	}
	return events, nil
}

func writeJSON(path string, value any) error {
	body, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return fsutil.AtomicWrite(path, append(body, '\n'), 0o644)
}

func readJSON(path string, target any) error {
	body, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, target)
}
