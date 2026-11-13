package studio

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/ledger"
	"github.com/chouheiwa/articale-to-motion/internal/projectinit"
	"github.com/chouheiwa/articale-to-motion/internal/scene"
	"github.com/chouheiwa/articale-to-motion/internal/tools"

	"github.com/chouheiwa/articale-to-motion/internal/preset"
	"gopkg.in/yaml.v3"
)

//go:embed web
var webFiles embed.FS

type Config struct {
	ListenAddr  string
	ProjectPath string
	ConfigPath  string
	// Unsafe 对应 am --unsafe：编排工具与 am 子命令都关闭权限隔离。
	Unsafe bool
}

type Project struct {
	ID           string `json:"id"`
	Path         string `json:"path"`
	Name         string `json:"name"`
	LastOpenedAt string `json:"last_opened_at,omitempty"`
}

type registry struct {
	Schema   int       `json:"schema"`
	Projects []Project `json:"projects"`
	// LastParent 是上次新建项目时选的父目录，首页的「保存到」默认用它。
	LastParent string `json:"last_parent,omitempty"`
}

// ProjectSummary 是最近项目列表里每个项目的一行状态：做到哪一步、出了几个镜头、是否正忙。
type ProjectSummary struct {
	Stage     string `json:"stage"`
	Completed int    `json:"completed"`
	Total     int    `json:"total"`
	Busy      string `json:"busy,omitempty"`
	Missing   bool   `json:"missing,omitempty"`
}

// summaryLimit 是首页侧栏要摘要的最近项目数：每个摘要要扫一遍项目目录。
const summaryLimit = 15

type Server struct {
	config   Config
	mu       sync.RWMutex
	projects registry
	current  string
	started  time.Time
	features featureState
	sessions sessionState
	skills   skillsState
}

func New(cfg Config) (*Server, error) {
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = "127.0.0.1:4317"
	}
	if cfg.ConfigPath == "" {
		cfg.ConfigPath = defaultConfigPath()
	}
	s := &Server{config: cfg, started: time.Now()}
	if err := s.loadRegistry(); err != nil {
		return nil, err
	}
	if cfg.ProjectPath != "" {
		p, err := s.openProject(cfg.ProjectPath)
		if err != nil {
			return nil, err
		}
		s.current = p.ID
	}
	s.ensureFeatures()
	s.loadPersistedTasks()
	return s, nil
}

func defaultConfigPath() string {
	if p := os.Getenv("AM_STUDIO_CONFIG"); p != "" {
		return p
	}
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "am", "studio", "projects.json")
	}
	return filepath.Join(os.TempDir(), "am-studio-projects.json")
}

func (s *Server) loadRegistry() error {
	s.projects.Schema = 1
	body, err := os.ReadFile(s.config.ConfigPath)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取 Studio 项目登记失败：%w", err)
	}
	if err := json.Unmarshal(body, &s.projects); err != nil {
		return fmt.Errorf("项目登记损坏（Studio）：%w", err)
	}
	if s.projects.Schema == 0 {
		s.projects.Schema = 1
	}
	return nil
}

func (s *Server) saveRegistry() error {
	if err := os.MkdirAll(filepath.Dir(s.config.ConfigPath), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(s.projects, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(s.config.ConfigPath), ".projects-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(body); err == nil {
		err = tmp.Chmod(0o600)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, s.config.ConfigPath)
}

func canonicalProjectPath(path string) (string, error) {
	if path == "" {
		return "", errors.New("项目路径不能为空")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	clean, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("项目目录不可用：%w", err)
	}
	info, err := os.Stat(clean)
	if err != nil || !info.IsDir() {
		return "", errors.New("项目路径必须是目录")
	}
	return clean, nil
}

func projectID(path string) string {
	sum := sha256.Sum256([]byte(path))
	return "project-" + hex.EncodeToString(sum[:8])
}

func (s *Server) openProject(path string) (Project, error) {
	path, err := canonicalProjectPath(path)
	if err != nil {
		return Project{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.projects.Projects {
		if s.projects.Projects[i].Path == path {
			s.projects.Projects[i].LastOpenedAt = time.Now().UTC().Format(time.RFC3339)
			_ = s.saveRegistry()
			return s.projects.Projects[i], nil
		}
	}
	p := Project{ID: projectID(path), Path: path, Name: filepath.Base(path), LastOpenedAt: time.Now().UTC().Format(time.RFC3339)}
	s.projects.Projects = append(s.projects.Projects, p)
	if err := s.saveRegistry(); err != nil {
		return Project{}, err
	}
	return p, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.health)
	mux.HandleFunc("/api/projects", s.projectsAPI)
	mux.HandleFunc("/api/projects/open", s.openAPI)
	mux.HandleFunc("/api/projects/create", s.createAPI)
	mux.HandleFunc("/api/directories", s.directoriesAPI)
	mux.HandleFunc("/api/projects/recent/remove", s.removeAPI)
	mux.HandleFunc("/api/workspaces/current", s.currentAPI)
	mux.HandleFunc("/api/workspaces/switch", s.switchAPI)
	mux.HandleFunc("/api/state", s.stateAPI)
	mux.HandleFunc("/api/scenes", s.scenesAPI)
	mux.HandleFunc("/api/script", s.scriptAPI)
	mux.HandleFunc("/api/assets", s.assetsAPI)
	mux.HandleFunc("/api/publish", s.publishAPI)
	s.featureRoutes(mux)
	s.sessionRoutes(mux)
	s.uiRoutes(mux)
	s.memoryRoutes(mux)
	mux.HandleFunc("/", s.static)
	return withJSONErrors(mux)
}

type directoryEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsProject bool   `json:"is_project"`
}

func studioBrowseRoot() string {
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return filepath.Clean(home)
	}
	if cwd, err := os.Getwd(); err == nil {
		return filepath.Clean(cwd)
	}
	return string(filepath.Separator)
}

func (s *Server) directoriesAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	root := studioBrowseRoot()
	requested := r.URL.Query().Get("path")
	path := root
	if requested != "" {
		abs, err := filepath.Abs(requested)
		if err != nil {
			s.error(w, http.StatusBadRequest, "invalid_directory", "目录路径无效")
			return
		}
		path = filepath.Clean(abs)
	}
	withinRoot, err := filepath.Rel(root, path)
	if err != nil || withinRoot == ".." || strings.HasPrefix(withinRoot, ".."+string(filepath.Separator)) {
		s.error(w, http.StatusForbidden, "directory_outside_root", "只能浏览服务器用户目录下的文件夹")
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		s.error(w, http.StatusBadRequest, "directory_unavailable", "目录不存在或不可读取")
		return
	}
	items, err := os.ReadDir(path)
	if err != nil {
		s.error(w, http.StatusForbidden, "directory_unreadable", "没有权限读取这个目录")
		return
	}
	entries := make([]directoryEntry, 0)
	for _, item := range items {
		if !item.IsDir() || strings.HasPrefix(item.Name(), ".") {
			continue
		}
		child := filepath.Join(path, item.Name())
		entries = append(entries, directoryEntry{Name: item.Name(), Path: child, IsProject: isStudioProjectDir(child)})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsProject != entries[j].IsProject {
			return entries[i].IsProject
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	parent := ""
	if path != root {
		parent = filepath.Dir(path)
	}
	s.write(w, http.StatusOK, map[string]any{"path": path, "parent": parent, "root": root, "entries": entries})
}

func isStudioProjectDir(path string) bool {
	if info, err := os.Stat(filepath.Join(path, "frame.md")); err == nil && !info.IsDir() {
		return true
	}
	if info, err := os.Stat(filepath.Join(path, "scenes")); err == nil && info.IsDir() {
		return true
	}
	return false
}

func (s *Server) ListenAndServe(ctx context.Context) error {
	ln, err := net.Listen("tcp", s.config.ListenAddr)
	if err != nil {
		return err
	}
	defer ln.Close()
	h := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() { <-ctx.Done(); _ = h.Shutdown(context.Background()) }()
	err = h.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	s.write(w, http.StatusOK, map[string]any{"ok": true, "service": "am-studio", "started_at": s.started.UTC()})
}
func (s *Server) projectsAPI(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	projects := append([]Project{}, s.projects.Projects...)
	current, lastParent := s.current, s.projects.LastParent
	s.mu.RUnlock()
	// 摘要要扫目录，放在锁外。
	recent := append([]Project{}, projects...)
	sort.SliceStable(recent, func(i, j int) bool { return recent[i].LastOpenedAt > recent[j].LastOpenedAt })
	summaries := map[string]ProjectSummary{}
	for i, p := range recent {
		if i >= summaryLimit {
			break
		}
		summaries[p.ID] = s.summarize(p)
	}
	s.write(w, http.StatusOK, map[string]any{"projects": projects, "current_project_id": current, "summaries": summaries,
		"default_parent": defaultParent(lastParent, recent)})
}

func (s *Server) summarize(p Project) ProjectSummary {
	if info, err := os.Stat(p.Path); err != nil || !info.IsDir() {
		return ProjectSummary{Missing: true}
	}
	scenes := discoverScenes(p.Path)
	summary := ProjectSummary{Stage: stageFor(p.Path, scenes), Total: len(scenes), Busy: s.busyHolder(p.Path)}
	for _, sc := range scenes {
		if sc.Exists && !sc.Stale {
			summary.Completed++
		}
	}
	return summary
}

// defaultParent 是新建项目的默认父目录：上次选的，否则最近一个项目所在的目录，否则家目录。
func defaultParent(last string, recent []Project) string {
	for _, candidate := range append([]string{last}, parentsOf(recent)...) {
		if candidate == "" || !isWithinStudioBrowseRoot(candidate) {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return studioBrowseRoot()
}

func parentsOf(projects []Project) []string {
	var out []string
	for _, p := range projects {
		out = append(out, filepath.Dir(p.Path))
	}
	return out
}

type pathRequest struct {
	Path string `json:"path"`
}

type createProjectRequest struct {
	Parent string `json:"parent"`
	Name   string `json:"name"`
	Canvas string `json:"canvas"`
	Style  string `json:"style"`
	// Delivery 与 Narration 同 am init --delivery / --narration，缺省为 speech / solo。
	Delivery  string `json:"delivery"`
	Narration string `json:"narration"`
}

func (s *Server) createAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.method(w, http.MethodPost)
		return
	}
	var req createProjectRequest
	if json.NewDecoder(r.Body).Decode(&req) != nil || strings.TrimSpace(req.Name) == "" {
		s.error(w, http.StatusBadRequest, "invalid_request", "请填写项目名称")
		return
	}
	if req.Canvas == "" {
		req.Canvas = preset.Default().ID
	}
	if req.Style == "" {
		// 工作台与 CLI 保持一致：内置风格是可选风格包，默认进入模型自主
		// 定风格流程，避免新项目被清晰系统蓝图预先定向。
		req.Style = preset.CustomStyle.ID
	}
	parent, err := filepath.Abs(req.Parent)
	if err != nil {
		s.error(w, http.StatusBadRequest, "invalid_directory", "父目录无效")
		return
	}
	if !isWithinStudioBrowseRoot(parent) {
		s.error(w, http.StatusForbidden, "directory_outside_root", "只能在服务器用户目录下创建项目")
		return
	}
	if info, statErr := os.Stat(parent); statErr != nil || !info.IsDir() {
		s.error(w, http.StatusBadRequest, "directory_unavailable", "父目录不存在")
		return
	}
	name := filepath.Base(filepath.Clean(req.Name))
	if name == "." || name == ".." || name != req.Name || strings.ContainsAny(name, `/\\`) {
		s.error(w, http.StatusBadRequest, "invalid_project_name", "项目名称只能是一个文件夹名称")
		return
	}
	target := filepath.Join(parent, name)
	if _, statErr := os.Stat(target); statErr == nil {
		s.error(w, http.StatusConflict, "project_exists", "这个目录已经存在")
		return
	}
	styleMeta := preset.CustomStyle
	if req.Style != preset.CustomStyle.ID {
		var ok bool
		styleMeta, ok = preset.StyleByID(req.Style)
		if !ok {
			s.error(w, http.StatusBadRequest, "invalid_style", "未知风格")
			return
		}
	}
	if req.Delivery == "" {
		req.Delivery = projectinit.DeliverySpeech
	}
	if req.Narration == "" {
		req.Narration = projectinit.NarrationSolo
	}
	extra := map[string][]byte{}
	if req.Style == preset.CustomStyle.ID {
		extra[preset.CustomStyleBriefPath] = []byte("# 风格描述\n\n" +
			"> 由工作台的自主定风格流程写入。制作开始前按这里的描述生成 frame.md、" +
			"`" + preset.CustomStyle.GuideDoc() + "` 与四张示例图。\n\n" +
			preset.AutomaticStyleBrief + "\n")
	}
	opts := projectinit.Options{Target: target, Canvas: req.Canvas, Style: styleMeta, Delivery: req.Delivery, Narration: req.Narration, Extra: extra}
	if err := projectinit.Validate(opts); err != nil {
		s.error(w, http.StatusBadRequest, "invalid_mode", err.Error())
		return
	}
	if _, ok := preset.ByID(req.Canvas); !ok {
		s.error(w, http.StatusBadRequest, "invalid_canvas", "未知画幅："+req.Canvas)
		return
	}
	if _, err := projectinit.Create(opts); err != nil {
		s.error(w, http.StatusBadRequest, "project_create_failed", err.Error())
		return
	}
	p, err := s.openProject(target)
	if err != nil {
		s.error(w, http.StatusInternalServerError, "project_register_failed", err.Error())
		return
	}
	// 官方技能要联网装，放到后台：项目先打开，制作早期（定风格、写稿、配音）用不到技能。
	// 用登记后的路径（已 EvalSymlinks），与 currentProject() 返回的一致。
	s.installSkills(p.Path)
	s.mu.Lock()
	s.current = p.ID
	s.projects.LastParent = parent
	_ = s.saveRegistry()
	s.mu.Unlock()
	s.write(w, http.StatusCreated, map[string]any{"project": p})
}

func isWithinStudioBrowseRoot(path string) bool {
	root := studioBrowseRoot()
	rel, err := filepath.Rel(root, filepath.Clean(path))
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (s *Server) openAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.method(w, http.MethodPost)
		return
	}
	var req pathRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.error(w, 400, "invalid_json", "请求不是合法 JSON")
		return
	}
	p, err := s.openProject(req.Path)
	if err != nil {
		s.error(w, 400, "project_unavailable", err.Error())
		return
	}
	s.mu.Lock()
	s.current = p.ID
	_ = s.saveRegistry()
	s.mu.Unlock()
	s.write(w, 200, map[string]any{"project": p})
}
func (s *Server) removeAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.method(w, http.MethodPost)
		return
	}
	var req struct {
		ID string `json:"project_id"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.ID == "" {
		s.error(w, 400, "invalid_request", "缺少 project_id")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.projects.Projects[:0]
	for _, p := range s.projects.Projects {
		if p.ID != req.ID {
			out = append(out, p)
		}
	}
	s.projects.Projects = out
	if s.current == req.ID {
		s.current = ""
	}
	if err := s.saveRegistry(); err != nil {
		s.error(w, 500, "registry_write_failed", err.Error())
		return
	}
	s.write(w, 200, map[string]any{"ok": true})
}
func (s *Server) currentAPI(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.projects.Projects {
		if p.ID == s.current {
			s.write(w, 200, map[string]any{"project": p})
			return
		}
	}
	s.write(w, 200, map[string]any{"project": nil})
}
func (s *Server) switchAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.method(w, http.MethodPost)
		return
	}
	var req struct {
		ProjectID string `json:"project_id"`
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil {
		s.error(w, 400, "invalid_json", "请求不是合法 JSON")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.projects.Projects {
		if p.ID == req.ProjectID {
			s.current = p.ID
			_ = s.saveRegistry()
			s.write(w, 200, map[string]any{"project": p})
			return
		}
	}
	s.error(w, 404, "project_not_found", "项目未登记")
}

func (s *Server) currentProject() (Project, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.projects.Projects {
		if p.ID == s.current {
			info, err := os.Stat(p.Path)
			if err != nil || !info.IsDir() {
				return Project{}, errors.New("当前项目目录不存在或不可访问")
			}
			return p, nil
		}
	}
	return Project{}, errors.New("尚未打开项目")
}
func (s *Server) stateAPI(w http.ResponseWriter, _ *http.Request) {
	p, err := s.currentProject()
	if err != nil {
		s.error(w, 404, "no_project", err.Error())
		return
	}
	s.write(w, 200, inspectProject(p))
}
func (s *Server) scenesAPI(w http.ResponseWriter, r *http.Request) {
	p, err := s.currentProject()
	if err != nil {
		s.error(w, 404, "no_project", err.Error())
		return
	}
	if r.URL.Path != "/api/scenes" {
		id := strings.TrimPrefix(r.URL.Path, "/api/scenes/")
		s.sceneAPI(w, p, id)
		return
	}
	scenes := discoverScenes(p.Path)
	s.write(w, 200, map[string]any{"scenes": scenes, "usage": projectUsage(p.Path, scenes)})
}

// ProjectUsage 是整个项目花掉的 token：渲染（各镜头全部尝试）加编排（用量账本）。
type ProjectUsage struct {
	Renders      tools.Usage    `json:"renders"`
	Attempts     int            `json:"attempts"`
	Orchestrator ledger.Summary `json:"orchestrator"`
	Total        tools.Usage    `json:"total"`
}

func projectUsage(project string, scenes []SceneSummary) ProjectUsage {
	out := ProjectUsage{}
	for _, scene := range scenes {
		if scene.Attempts == 0 || scene.Usage == nil {
			continue
		}
		out.Attempts += scene.Attempts
		out.Renders.Add(*scene.Usage)
	}
	entries, _ := ledger.Read(ledger.ProjectFile(project))
	out.Orchestrator = ledger.Summarize(entries)
	if out.Attempts > 0 {
		out.Total.Add(out.Renders)
	}
	if out.Orchestrator.Calls > 0 {
		out.Total.Add(out.Orchestrator.Total)
	}
	return out
}
func (s *Server) sceneAPI(w http.ResponseWriter, p Project, id string) {
	for _, scene := range discoverScenes(p.Path) {
		if scene.ID == id {
			body, err := os.ReadFile(filepath.Join(scene.Directory, "scene.json"))
			var data map[string]any
			if err == nil {
				_ = json.Unmarshal(body, &data)
			}
			s.write(w, 200, map[string]any{"id": scene.ID, "directory": scene.Directory, "duration_seconds": scene.DurationSeconds, "output": scene.Output, "exists": scene.Exists, "stale": scene.Stale, "data": data})
			return
		}
	}
	s.error(w, 404, "scene_not_found", "镜头不存在")
}

type SceneSummary struct {
	ID              string  `json:"id"`
	Directory       string  `json:"directory"`
	DurationSeconds float64 `json:"duration_seconds,omitempty"`
	Output          string  `json:"output,omitempty"`
	Exists          bool    `json:"exists"`
	Stale           bool    `json:"stale"`
	// Attempts 与 Usage 是这个镜头全部渲染尝试（含归档）的次数与用量合计。
	Attempts int          `json:"attempts"`
	Usage    *tools.Usage `json:"usage,omitempty"`
	// Rendering 表示这个镜头此刻正在渲染：渲染日志最近还在写，且比上一次尝试记录新。
	Rendering bool `json:"rendering,omitempty"`
}

// renderingWindow 是判定「还在渲染」的日志静默上限。渲染工具一直往流日志里写事件，
// 超过这么久没动静，多半是进程已经没了（被杀、机器睡眠），不再显示成渲染中。
const renderingWindow = 3 * time.Minute

func sceneRendering(dir, id string, now time.Time) bool {
	var latest time.Time
	for _, name := range []string{"render-" + id + ".stream.jsonl", "render-" + id + ".user.log", "render-" + id + ".stderr.log"} {
		if info, err := os.Stat(filepath.Join(dir, name)); err == nil && info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}
	if latest.IsZero() || now.Sub(latest) > renderingWindow {
		return false
	}
	attempt, err := os.Stat(filepath.Join(dir, "render-"+id+".attempt.json"))
	return err != nil || attempt.ModTime().Before(latest)
}

func discoverScenes(root string) []SceneSummary {
	var out []SceneSummary
	exams := filepath.Join(root, "production", "memory-exams")
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		// 渲染记忆的考场里是镜头副本，不是项目的镜头。
		if err == nil && d.IsDir() && path == exams {
			return filepath.SkipDir
		}
		if err != nil || d.IsDir() || d.Name() != "scene.json" {
			return nil
		}
		body, e := os.ReadFile(path)
		if e != nil {
			return nil
		}
		var v struct {
			ID       string  `json:"id"`
			Duration float64 `json:"duration_seconds"`
			Output   string  `json:"output"`
		}
		if json.Unmarshal(body, &v) != nil || v.ID == "" {
			return nil
		}
		output := filepath.Join(filepath.Dir(path), v.Output)
		rel, relErr := filepath.Rel(filepath.Dir(path), output)
		contained := relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(v.Output)
		exists := contained && fileExists(output)
		stale := false
		if exists {
			sceneInfo, sceneErr := os.Stat(path)
			outputInfo, outputErr := os.Stat(output)
			stale = sceneErr == nil && outputErr == nil && sceneInfo.ModTime().After(outputInfo.ModTime())
		}
		summary := SceneSummary{ID: v.ID, Directory: filepath.Dir(path), DurationSeconds: v.Duration, Output: v.Output, Exists: exists, Stale: stale,
			Rendering: sceneRendering(filepath.Dir(path), v.ID, time.Now())}
		if history := scene.AttemptHistory(summary.Directory, v.ID); len(history) > 0 {
			var total tools.Usage
			for _, attempt := range history {
				if attempt.Usage != nil {
					total.Add(*attempt.Usage)
				} else {
					total.Add(tools.Usage{})
				}
			}
			summary.Attempts, summary.Usage = len(history), &total
		}
		out = append(out, summary)
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }
func inspectProject(p Project) map[string]any {
	scenes := discoverScenes(p.Path)
	done := 0
	stale := 0
	for _, sc := range scenes {
		if sc.Exists {
			done++
		}
		if sc.Stale {
			stale++
		}
	}
	meta := projectMetadata(p.Path)
	return map[string]any{"project": p, "stage": stageFor(p.Path, scenes), "metadata": meta, "media": map[string]any{"audio": fileExists(filepath.Join(p.Path, "production", "audio", "candidate.mp4")), "final": fileExists(filepath.Join(p.Path, "final.mp4")) || fileExists(filepath.Join(p.Path, "production", "final.mp4")), "publish": fileExists(filepath.Join(p.Path, "publish.md"))}, "scenes": map[string]any{"total": len(scenes), "completed": done, "stale": stale}, "issues": projectIssues(p.Path)}
}

func projectIssues(root string) any {
	body, err := os.ReadFile(filepath.Join(root, "production", "review", "review.json"))
	if err != nil {
		return []any{}
	}
	var report map[string]any
	if json.Unmarshal(body, &report) != nil {
		return []any{}
	}
	if issues, ok := report["issues"]; ok {
		return issues
	}
	return []any{}
}

// projectMetadata 从 frame.md 的 front matter 取风格与画幅。Studio 只是观察者，项目改到一半、
// front matter 写坏了也照样返回能读到的部分，不报错。
//
// 只看顶层键：front matter 里 colors.canvas 这类同名的嵌套键是颜色值，按行扫描会读错。
func projectMetadata(root string) map[string]string {
	result := map[string]string{}
	body, err := os.ReadFile(filepath.Join(root, "frame.md"))
	if err != nil {
		return result
	}
	text := strings.ReplaceAll(string(body), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return result
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return result
	}
	var front map[string]any
	if yaml.Unmarshal([]byte(text[4:4+end]), &front) != nil {
		return result
	}
	for _, key := range []string{"style_id", "style_name"} {
		if value, ok := front[key].(string); ok && value != "" {
			result[key] = value
		}
	}
	switch canvas := front["canvas"].(type) {
	case string:
		// 旧项目把画幅预设 id 直接写成标量。
		if canvas != "" {
			result["canvas_id"] = canvas
		}
	case map[string]any:
		width, _ := canvas["width_px"].(int)
		height, _ := canvas["height_px"].(int)
		fps, _ := canvas["fps"].(int)
		orientation, _ := canvas["orientation"].(string)
		if width > 0 && height > 0 {
			result["canvas"] = fmt.Sprintf("%d×%d", width, height)
		}
		if fps > 0 {
			result["fps"] = fmt.Sprint(fps)
		}
		if orientation != "" {
			result["orientation"] = orientation
		}
		if p, ok := preset.ByCanvas(width, height, fps, orientation); ok {
			result["canvas_id"] = p.ID
		}
	}
	return result
}

// stageFor 按项目里已有的产物推断制作进度，口播与卡点两种模式都适用。只看文件是否存在，
// 不读内容：它是网页上的一行提示，判断错了也不影响任何流程。
func stageFor(root string, scenes []SceneSummary) string {
	exists := func(parts ...string) bool { return fileExists(filepath.Join(append([]string{root}, parts...)...)) }
	final := exists("final.mp4") || exists("production", "final.mp4")
	rendered := len(scenes) > 0
	for _, sc := range scenes {
		rendered = rendered && sc.Exists
	}
	switch {
	case final && exists("publish.md"):
		return "publish"
	case final:
		return "review"
	case rendered:
		return "assemble"
	case len(scenes) > 0:
		return "render"
	case exists("production", "script-final.md"), exists("production", "audio", "voice.srt"), exists("production", "scene-plan.json"),
		exists("production", "beat", "grid.json"), exists("production", "beat", "plan.json"),
		exists("script.md"), exists("SCRIPT.md"), exists("transcription.srt"):
		return "plan"
	default:
		return "setup"
	}
}

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		s.error(w, http.StatusNotFound, "not_found", "Studio API 路径不存在")
		return
	}
	name := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
	// 不带扩展名的路径都回落到 index.html（前端路由）；带扩展名却找不到的直接 404，
	// 否则缺失的脚本会拿到一份 HTML，浏览器报的是 MIME 错误，很难看出真正原因。
	if name == "." || name == "" || filepath.Ext(name) == "" {
		name = "index.html"
	}
	body, err := fs.ReadFile(webFiles, "web/"+name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	// 模块脚本必须带 JavaScript 的 MIME，靠内容嗅探会得到 text/plain，浏览器直接拒绝执行。
	if kind := mime.TypeByExtension(filepath.Ext(name)); kind != "" {
		w.Header().Set("Content-Type", kind)
	}
	if name == "index.html" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
	}
	w.Write(body)
}
func (s *Server) write(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) error(w http.ResponseWriter, status int, code, message string) {
	s.write(w, status, map[string]any{"code": code, "message": message, "details": []any{}, "retryable": false})
}
func (s *Server) method(w http.ResponseWriter, want string) {
	w.Header().Set("Allow", want)
	s.error(w, 405, "method_not_allowed", "只允许 "+want)
}
func withJSONErrors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { next.ServeHTTP(w, r) })
}
