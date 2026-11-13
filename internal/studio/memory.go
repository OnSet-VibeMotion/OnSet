package studio

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/config"
	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/memory"
	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// 记忆面板。读接口直接读记忆库（只读，不记快照）；所有改动都经 am memory 子命令，
// 与 Studio「自己不写项目文件」的原则一致——记忆库本身也只由 am memory 改。
func (s *Server) memoryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/memory", s.memoryAPI)
	mux.HandleFunc("/api/memory/recall", s.memoryRecallAPI)
	mux.HandleFunc("/api/memory/actions/", s.memoryActionAPI)
}

type memoryRow struct {
	memory.Memory
	Stats map[string]memory.Stat `json:"stats"`
}

type examCellView struct {
	memory.Cell
	// Output 是这一格产物相对项目根的路径，供缩略图读取；不在项目里时为空。
	Output string `json:"output,omitempty"`
}

type examView struct {
	memory.ExamResult
	Cells []examCellView `json:"cells"`
}

func (s *Server) memoryStore(w http.ResponseWriter) (Project, config.Config, *memory.Store, bool) {
	p, ok := s.projectOr404(w)
	if !ok {
		return p, config.Config{}, nil, false
	}
	cfg, err := config.Load(p.Path, nil)
	if err != nil {
		s.error(w, http.StatusBadRequest, "invalid_config", err.Error())
		return p, cfg, nil, false
	}
	store, err := memory.Open(cfg.Memory.Dir)
	if err != nil {
		s.error(w, http.StatusInternalServerError, "memory_unavailable", err.Error())
		return p, cfg, nil, false
	}
	return p, cfg, store, true
}

func (s *Server) memoryAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	p, cfg, store, ok := s.memoryStore(w)
	if !ok {
		return
	}
	status, err := store.Status(false)
	if err != nil {
		s.error(w, http.StatusInternalServerError, "memory_unavailable", err.Error())
		return
	}
	all, _, err := store.Memories()
	if err != nil {
		s.error(w, http.StatusInternalServerError, "memory_unavailable", err.Error())
		return
	}
	stats, err := store.Stats()
	if err != nil {
		s.error(w, http.StatusInternalServerError, "memory_unavailable", err.Error())
		return
	}
	rows := make([]memoryRow, 0, len(all))
	for _, m := range all {
		rows = append(rows, memoryRow{Memory: m, Stats: stats[m.Name]})
	}
	events, err := store.Timeline()
	if err != nil {
		s.error(w, http.StatusInternalServerError, "memory_unavailable", err.Error())
		return
	}
	// 经历事件可能成百上千条，面板只要最近的；整理、考试这些节点事件全留。
	timeline := make([]memory.Event, 0, len(events))
	episodes := 0
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type == memory.EventEpisode {
			episodes++
			if episodes > 50 {
				continue
			}
		}
		timeline = append(timeline, events[i])
	}
	exams, err := store.Exams()
	if err != nil {
		s.error(w, http.StatusInternalServerError, "memory_unavailable", err.Error())
		return
	}
	views := make([]examView, 0, len(exams))
	for _, exam := range exams {
		view := examView{ExamResult: exam, Cells: make([]examCellView, 0, len(exam.Cells))}
		for _, cell := range exam.Cells {
			c := examCellView{Cell: cell}
			if rel, err := filepath.Rel(p.Path, filepath.Join(cell.Workdir, "out.mp4")); err == nil && !strings.HasPrefix(rel, "..") && fileExists(filepath.Join(p.Path, rel)) {
				c.Output = filepath.ToSlash(rel)
			}
			view.Cells = append(view.Cells, c)
		}
		views = append(views, view)
	}
	snapshots, err := store.SnapshotIDs()
	if err != nil {
		s.error(w, http.StatusInternalServerError, "memory_unavailable", err.Error())
		return
	}
	if snapshots == nil {
		snapshots = []int{}
	}
	s.write(w, http.StatusOK, map[string]any{
		"enabled": cfg.Memory.Enabled, "dir": store.Dir, "pinned": cfg.Memory.Snapshot, "budget": cfg.Memory.RecallBudget,
		"renderer": cfg.Renderer, "status": status, "memories": rows, "timeline": timeline, "exams": views, "snapshots": snapshots,
	})
}

func (s *Server) memoryRecallAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	p, cfg, store, ok := s.memoryStore(w)
	if !ok {
		return
	}
	id := r.URL.Query().Get("scene")
	for _, summary := range discoverScenes(p.Path) {
		if summary.ID != id {
			continue
		}
		sc, err := scene.Load(summary.Directory)
		if err != nil {
			s.error(w, http.StatusBadRequest, "invalid_scene", err.Error())
			return
		}
		renderer := r.URL.Query().Get("renderer")
		if renderer == "" {
			renderer = sc.Renderer
		}
		if renderer == "" {
			renderer = cfg.Renderer
		}
		result, err := store.RecallScene(sc, memory.RecallOptions{Snapshot: cfg.Memory.Snapshot, Budget: cfg.Memory.RecallBudget,
			Renderer: renderer, Model: store.CurrentModel(renderer, envutil.EnvMap())})
		if err != nil {
			s.error(w, http.StatusBadRequest, "recall_failed", err.Error())
			return
		}
		reasons := make([]string, 0, len(result.Items))
		for _, item := range result.Items {
			reasons = append(reasons, item.Reason())
		}
		s.write(w, http.StatusOK, map[string]any{"recall": result, "reasons": reasons, "section": result.Section()})
		return
	}
	s.error(w, http.StatusNotFound, "scene_not_found", "镜头不存在")
}

// memoryAction 是面板能触发的 am memory 子命令。参数只取白名单里的字段，
// 不接受任意命令行。
type memoryActionRequest struct {
	Name      string    `json:"name"`
	To        int       `json:"to"`
	Renderers []string  `json:"renderers"`
	SceneID   string    `json:"scene_id"`
	Verdict   string    `json:"verdict"`
	Note      string    `json:"note"`
	Seconds   *float64  `json:"seconds"`
	Region    []float64 `json:"region"`
	Global    bool      `json:"global"`
}

func (s *Server) memoryActionAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.method(w, http.MethodPost)
		return
	}
	p, ok := s.projectOr404(w)
	if !ok {
		return
	}
	action := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/memory/actions/"), "/")
	var req memoryActionRequest
	if err := decodeJSON(r, &req); err != nil {
		s.error(w, http.StatusBadRequest, "invalid_json", "请求不是合法 JSON")
		return
	}
	var args []string
	label := ""
	switch action {
	case "consolidate":
		args, label = []string{"memory", "consolidate"}, "整理记忆"
	case "exam":
		if len(req.Renderers) == 0 {
			s.error(w, http.StatusBadRequest, "invalid_renderers", "至少选一个渲染工具")
			return
		}
		for _, renderer := range req.Renderers {
			if !tools.ValidTools[renderer] {
				s.error(w, http.StatusBadRequest, "invalid_renderers", "无效的渲染工具："+renderer)
				return
			}
		}
		args, label = []string{"memory", "exam", "--renderers", strings.Join(req.Renderers, ",")}, "记忆考试"
	case "rollback":
		if req.To < 1 {
			s.error(w, http.StatusBadRequest, "invalid_snapshot", "要给出快照号")
			return
		}
		args, label = []string{"memory", "rollback", "--to", strconv.Itoa(req.To)}, fmt.Sprintf("回退到快照 #%d", req.To)
	case "promote", "reject", "retire":
		if !memory.ValidName(req.Name) {
			s.error(w, http.StatusBadRequest, "invalid_name", "记忆名不合法")
			return
		}
		args, label = []string{"memory", action, req.Name}, map[string]string{"promote": "确认生效 ", "reject": "拒绝 ", "retire": "沉睡 "}[action]+req.Name
	case "remember":
		if strings.TrimSpace(req.Note) == "" {
			s.error(w, http.StatusBadRequest, "empty_note", "偏好内容为空")
			return
		}
		args = []string{"memory", "remember", req.Note}
		if req.Global {
			args = append(args, "--global")
		}
		if out, err := s.runStudioCLI(r.Context(), p, args...); err != nil {
			s.error(w, http.StatusBadRequest, "remember_failed", err.Error())
		} else {
			s.write(w, http.StatusOK, map[string]any{"message": strings.TrimSpace(string(out))})
		}
		return
	case "feedback":
		var directory string
		for _, sc := range discoverScenes(p.Path) {
			if sc.ID == req.SceneID {
				directory = sc.Directory
			}
		}
		if directory == "" {
			s.error(w, http.StatusNotFound, "scene_not_found", "镜头不存在")
			return
		}
		if req.Verdict != "up" && req.Verdict != "down" {
			s.error(w, http.StatusBadRequest, "invalid_verdict", "反馈只能是 up 或 down")
			return
		}
		args = []string{"memory", "feedback", directory, "--" + req.Verdict, "--note", req.Note}
		if req.Seconds != nil {
			args = append(args, "--at", strconv.FormatFloat(*req.Seconds, 'f', 3, 64))
		}
		if len(req.Region) == 4 {
			parts := make([]string, 4)
			for i, v := range req.Region {
				parts[i] = strconv.FormatFloat(v, 'f', 4, 64)
			}
			args = append(args, "--region", strings.Join(parts, ","))
		}
		// 反馈只写一段经历，很快，直接同步返回。
		if out, err := s.runStudioCLI(r.Context(), p, args...); err != nil {
			s.error(w, http.StatusBadRequest, "feedback_failed", err.Error())
		} else {
			s.write(w, http.StatusOK, map[string]any{"message": strings.TrimSpace(string(out))})
		}
		return
	default:
		s.error(w, http.StatusNotFound, "unknown_action", "不支持的操作："+action)
		return
	}
	work := func(ctx context.Context, t *Task) error {
		_, err := s.runStudioCLI(ctx, p, args...)
		return err
	}
	// 考试会在项目的 production/memory-exams 下渲染，占项目写权；其余只改记忆库。
	if action == "exam" {
		t, err := s.runWriteTask(p, "memory.exam", label, work)
		if err != nil {
			s.writeTaskError(w, err)
			return
		}
		s.write(w, http.StatusAccepted, map[string]any{"task_id": t.ID})
		return
	}
	t := s.addTask("memory."+action, label)
	s.runTask(t, func(ctx context.Context) error { return work(ctx, t) })
	s.write(w, http.StatusAccepted, map[string]any{"task_id": t.ID})
}

// preferenceBrief 是这一轮要交给编排工具的用户偏好段与摘要；记忆关闭或读不到时为空。
func (s *Server) preferenceBrief(p Project, cfg config.Config) (string, string) {
	if !cfg.Memory.Enabled {
		return "", ""
	}
	// 建好记忆库：codex 沙箱只能把已存在的目录加进可写范围（见 OrchestratorAccess）。
	_, _ = memory.Open(cfg.Memory.Dir)
	text, digest, err := memory.OpenReadOnly(cfg.Memory.Dir).PreferenceBrief(memory.ProjectName(p.Path), cfg.Memory.Snapshot)
	if err != nil {
		return "", ""
	}
	return text, digest
}
