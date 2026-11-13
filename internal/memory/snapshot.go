package memory

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SnapshotEntry 是快照里的一条生效记忆，存完整文件内容：回退时原样写回，
// 召回也只读快照，不读记忆文件——所以手改记忆文件要经 am memory status
// 记成新快照才会生效，同样的镜头输入加同一个快照永远得到同样的召回。
type SnapshotEntry struct {
	Name    string `json:"name"`
	Kind    Kind   `json:"kind"`
	Digest  string `json:"digest"`
	Content string `json:"content"`
}

// Snapshot 是记忆库在某一刻的生效记忆集合。
type Snapshot struct {
	ID        int    `json:"id"`
	CreatedAt string `json:"created_at"`
	// Cause 是触发快照的事件类型（promote、rollback、manual_edit……）。
	Cause   string          `json:"cause"`
	Summary string          `json:"summary"`
	Entries []SnapshotEntry `json:"entries"`
	// Stats 是生成快照时冻结的效果统计，召回排序用它而不是实时统计：
	// 实时统计每渲染一次就变，召回结果就不再只由快照决定。
	Stats map[string]map[string]Stat `json:"stats,omitempty"`
	// Unverified 表示快照里有未经考试的改动（人工编辑）。
	Unverified bool `json:"unverified,omitempty"`
	// RestoredFrom 是回退来源快照号。
	RestoredFrom int `json:"restored_from,omitempty"`
}

// Memories 解析快照里的全部记忆。
func (s Snapshot) Memories() ([]Memory, error) {
	out := make([]Memory, 0, len(s.Entries))
	for _, entry := range s.Entries {
		m, err := Parse(entry.Kind, []byte(entry.Content))
		if err != nil {
			return nil, fmt.Errorf("快照 #%d 的记忆 %s：%w", s.ID, entry.Name, err)
		}
		out = append(out, m)
	}
	return out, nil
}

func (s *Store) snapshotPath(id int) string {
	return filepath.Join(s.Dir, "snapshots", fmt.Sprintf("%06d.json", id))
}

// SnapshotIDs 返回全部快照号，升序。
func (s *Store) SnapshotIDs() ([]int, error) {
	entries, err := os.ReadDir(filepath.Join(s.Dir, "snapshots"))
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var ids []int
	for _, entry := range entries {
		name := strings.TrimSuffix(entry.Name(), ".json")
		if id, err := strconv.Atoi(name); err == nil && name != entry.Name() {
			ids = append(ids, id)
		}
	}
	sort.Ints(ids)
	return ids, nil
}

// LoadSnapshot 读出指定快照。
func (s *Store) LoadSnapshot(id int) (Snapshot, error) {
	var snapshot Snapshot
	if err := readJSON(s.snapshotPath(id), &snapshot); err != nil {
		if os.IsNotExist(err) {
			return Snapshot{}, fmt.Errorf("快照 #%d 不存在", id)
		}
		return Snapshot{}, fmt.Errorf("读取快照 #%d：%w", id, err)
	}
	return snapshot, nil
}

// LatestSnapshot 读出最新快照；还没有任何快照时 ok 为 false。
func (s *Store) LatestSnapshot() (Snapshot, bool, error) {
	ids, err := s.SnapshotIDs()
	if err != nil || len(ids) == 0 {
		return Snapshot{}, false, err
	}
	snapshot, err := s.LoadSnapshot(ids[len(ids)-1])
	return snapshot, err == nil, err
}

// ResolveSnapshot 返回召回要用的快照：pinned 为 0 时跟随最新快照。
// 记忆库还没有快照时返回 ok=false，此时什么也不召回。
func (s *Store) ResolveSnapshot(pinned int) (Snapshot, bool, error) {
	if pinned > 0 {
		snapshot, err := s.LoadSnapshot(pinned)
		return snapshot, err == nil, err
	}
	return s.LatestSnapshot()
}

// activeEntries 把当前生效记忆的文件内容列成快照条目。
func (s *Store) activeEntries() ([]SnapshotEntry, error) {
	all, _, err := s.Memories()
	if err != nil {
		return nil, err
	}
	var entries []SnapshotEntry
	for _, m := range all {
		if m.Status != StatusActive {
			continue
		}
		body, err := os.ReadFile(s.Path(m.Kind, m.Name))
		if err != nil {
			return nil, err
		}
		entries = append(entries, SnapshotEntry{Name: m.Name, Kind: m.Kind, Digest: digestBytes(body), Content: string(body)})
	}
	return entries, nil
}

// TakeSnapshot 把当前生效记忆集合记成一个新快照，并写进时间线。
func (s *Store) TakeSnapshot(cause, summary string, unverified bool) (Snapshot, error) {
	entries, err := s.activeEntries()
	if err != nil {
		return Snapshot{}, err
	}
	stats, err := s.Stats()
	if err != nil {
		return Snapshot{}, err
	}
	return s.saveSnapshot(Snapshot{Cause: cause, Summary: summary, Entries: entries, Stats: stats, Unverified: unverified})
}

func (s *Store) saveSnapshot(snapshot Snapshot) (Snapshot, error) {
	ids, err := s.SnapshotIDs()
	if err != nil {
		return Snapshot{}, err
	}
	snapshot.ID = 1
	if len(ids) > 0 {
		snapshot.ID = ids[len(ids)-1] + 1
	}
	snapshot.CreatedAt = s.clock().UTC().Format(time.RFC3339)
	if snapshot.Entries == nil {
		snapshot.Entries = []SnapshotEntry{}
	}
	if err := writeJSON(s.snapshotPath(snapshot.ID), snapshot); err != nil {
		return Snapshot{}, err
	}
	if err := s.writeIndex(); err != nil {
		return Snapshot{}, err
	}
	names := make([]string, 0, len(snapshot.Entries))
	for _, entry := range snapshot.Entries {
		names = append(names, entry.Name)
	}
	return snapshot, s.Log(Event{Type: EventSnapshot, Snapshot: snapshot.ID,
		Summary: fmt.Sprintf("快照 #%d：%s", snapshot.ID, snapshot.Summary),
		Detail:  map[string]any{"cause": snapshot.Cause, "memories": names, "unverified": snapshot.Unverified}})
}

// Drift 比较当前生效记忆与最新快照，列出新增、删除或内容变了的记忆名。
// 还没有快照时，所有生效记忆都算新增。
func (s *Store) Drift() ([]string, error) {
	entries, err := s.activeEntries()
	if err != nil {
		return nil, err
	}
	latest, ok, err := s.LatestSnapshot()
	if err != nil {
		return nil, err
	}
	previous := map[string]string{}
	if ok {
		for _, entry := range latest.Entries {
			previous[entry.Name] = entry.Digest
		}
	}
	var changed []string
	for _, entry := range entries {
		if previous[entry.Name] != entry.Digest {
			changed = append(changed, entry.Name)
		}
		delete(previous, entry.Name)
	}
	for name := range previous {
		changed = append(changed, name)
	}
	sort.Strings(changed)
	return changed, nil
}

// Rollback 把快照 to 的生效记忆集合恢复成一个新快照，不删除任何历史。
// to 为 0 时回到最新快照的上一个。
//
// 快照里的记忆按快照内容原样写回并置为生效；当前生效、但不在目标快照里的
// 记忆转为沉睡，文件保留。
func (s *Store) Rollback(to int) (Snapshot, error) {
	ids, err := s.SnapshotIDs()
	if err != nil {
		return Snapshot{}, err
	}
	if to == 0 {
		if len(ids) < 2 {
			return Snapshot{}, fmt.Errorf("只有 %d 个快照，没有可回退的上一版；用 --to 指定快照号", len(ids))
		}
		to = ids[len(ids)-2]
	}
	target, err := s.LoadSnapshot(to)
	if err != nil {
		return Snapshot{}, err
	}
	keep := map[string]bool{}
	restored, err := target.Memories()
	if err != nil {
		return Snapshot{}, err
	}
	for _, m := range restored {
		keep[m.Name] = true
		m.Status = StatusActive
		if err := s.Write(m); err != nil {
			return Snapshot{}, err
		}
	}
	all, _, err := s.Memories()
	if err != nil {
		return Snapshot{}, err
	}
	for _, m := range all {
		if m.Status == StatusActive && !keep[m.Name] {
			m.Status = StatusDormant
			if err := s.Write(m); err != nil {
				return Snapshot{}, err
			}
		}
	}
	entries, err := s.activeEntries()
	if err != nil {
		return Snapshot{}, err
	}
	snapshot, err := s.saveSnapshot(Snapshot{Cause: EventRollback, Summary: fmt.Sprintf("回退到快照 #%d", to),
		Entries: entries, Stats: target.Stats, Unverified: target.Unverified, RestoredFrom: to})
	if err != nil {
		return Snapshot{}, err
	}
	return snapshot, s.Log(Event{Type: EventRollback, Snapshot: snapshot.ID, Summary: fmt.Sprintf("回退到快照 #%d，记为新快照 #%d", to, snapshot.ID)})
}
