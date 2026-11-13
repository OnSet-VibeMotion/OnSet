package studio

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/chouheiwa/articale-to-motion/internal/agentrun"
	"github.com/chouheiwa/articale-to-motion/internal/config"
	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
	"github.com/chouheiwa/articale-to-motion/internal/ledger"
	"github.com/chouheiwa/articale-to-motion/internal/project"
	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// Studio 在 agentrun 事件之外自己发的几种事件。
const (
	kindUser         agentrun.Kind = "user"
	kindTurnStart    agentrun.Kind = "turn-start"
	kindTurnEnd      agentrun.Kind = "turn-end"
	kindFilesChanged agentrun.Kind = "files-changed"
	kindNotice       agentrun.Kind = "notice"
	kindTurnReverted agentrun.Kind = "turn-reverted"
	// kindQueued 是这一轮进行中用户又发的消息：排队，这一轮结束后作为下一轮发出。
	kindQueued agentrun.Kind = "queued"
	// kindUnqueued 是用户移除了一条排队的消息。
	kindUnqueued agentrun.Kind = "unqueued"
)

const (
	// transcriptLimit 是续接失败时补发的对话记录上限（字符）。
	transcriptLimit = 24000
	// changeCheckInterval 是对话进行中两次检查文件变化的最短间隔。
	changeCheckInterval = 500 * time.Millisecond
)

// SessionMeta 是会话的元数据，落在 production/studio/sessions/<id>.json。
type SessionMeta struct {
	ID           string    `json:"session_id"`
	Title        string    `json:"title"`
	Kind         string    `json:"kind"` // chat | production
	Tool         string    `json:"tool"`
	Renderer     string    `json:"renderer,omitempty"`
	CLISessionID string    `json:"cli_session_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	Turns        []string  `json:"turns"`
	RunningTurn  string    `json:"running_turn,omitempty"`
	// PreferenceDigest 是上一次交给编排工具的用户偏好段的摘要：偏好没变、
	// CLI 会话也还在时不再重复发送，续接的会话里已经有了。
	PreferenceDigest string `json:"preference_digest,omitempty"`
}

// SessionEvent 是会话事件流里的一条，逐行追加到 <id>.events.jsonl。
type SessionEvent struct {
	Seq  int       `json:"seq"`
	Turn string    `json:"turn_id,omitempty"`
	Time time.Time `json:"time"`
	agentrun.Event
	Status  string       `json:"status,omitempty"`
	Files   []string     `json:"files,omitempty"`
	Changes []FileChange `json:"changes,omitempty"`
	// QueueID 标出 queued / unqueued 事件说的是哪一条排队的消息。
	QueueID string `json:"queue_id,omitempty"`
	// View 是编排工具经 am studio show 请网页切到的页面（view 事件）。
	View *ViewRequest `json:"view,omitempty"`
}

// Attachment 是随消息附上的画面上下文。
type Attachment struct {
	SceneID  string  `json:"scene_id,omitempty"`
	Path     string  `json:"path,omitempty"`
	Seconds  float64 `json:"seconds,omitempty"`
	Region   *Box    `json:"region,omitempty"`
	Selector string  `json:"selector,omitempty"`
	Source   string  `json:"source,omitempty"`
	Note     string  `json:"note,omitempty"`
	// Upload 表示用户上传的文件（Path 在 production/studio/uploads/ 下），Name 是原文件名。
	Upload bool   `json:"upload,omitempty"`
	Name   string `json:"name,omitempty"`
	Size   int64  `json:"size,omitempty"`
	// Quote 是用户右键「引用到对话」的一段文字，Source 是它所在的项目文件（可以为空，
	// 例如引用的是编排工具的回复），Label 是给人看的出处（「口播稿第 3 段」）。
	Quote string `json:"quote,omitempty"`
	Label string `json:"label,omitempty"`
	// Ref 为 true 表示只是指给编排工具看的一样东西（镜头 SceneID 或文件 Source），不带截图。
	Ref bool `json:"ref,omitempty"`
}

// maxQuoteRunes 是一条引用的上限：再长就该让编排工具自己去读文件。
const maxQuoteRunes = 4000

// Box 是画面上的一个区域，单位是视频像素。
type Box struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

type session struct {
	project string
	meta    SessionMeta
	events  []SessionEvent
	wake    chan struct{}
	cancel  context.CancelFunc
	// queue 是这一轮进行中排队的消息，结束后合并成下一轮。只在内存里：
	// Studio 重启时进行中的轮次本来就会被标成 interrupted，排队的消息随之作废。
	queue []turnRequest
}

type sessionState struct {
	mu       sync.Mutex
	sessions map[string]*session // key: 项目路径 + "\x00" + 会话 id
	loaded   map[string]bool
	busy     map[string]string // 项目路径 → 占用者说明
}

// BusyError 表示项目正被另一轮对话或一个写任务占用。
type BusyError struct{ Holder string }

func (e *BusyError) Error() string {
	return "项目正忙：" + e.Holder + "，请等它结束或先取消"
}

func sessionKey(projectPath, id string) string { return projectPath + "\x00" + id }

func newID(prefix string) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return prefix + "-" + time.Now().UTC().Format("20060102-150405") + "-" + hex.EncodeToString(b[:])
}

func sessionsDir(projectPath string) string {
	return filepath.Join(studioRoot(projectPath), "sessions")
}

// acquire 占用项目的写权。同一时间只允许一个写入者：一轮对话或一个会改文件的任务。
func (s *Server) acquire(projectPath, holder string) error {
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	if s.sessions.busy == nil {
		s.sessions.busy = map[string]string{}
	}
	if current, ok := s.sessions.busy[projectPath]; ok {
		return &BusyError{Holder: current}
	}
	s.sessions.busy[projectPath] = holder
	return nil
}

func (s *Server) release(projectPath string) {
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	delete(s.sessions.busy, projectPath)
}

func (s *Server) busyHolder(projectPath string) string {
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	return s.sessions.busy[projectPath]
}

// loadSessions 首次访问某个项目时从磁盘读出它的全部会话。
// 上次 Studio 退出时还在进行的轮次标成 interrupted：进程已经不在了。
func (s *Server) loadSessions(projectPath string) {
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	if s.sessions.sessions == nil {
		s.sessions.sessions = map[string]*session{}
		s.sessions.loaded = map[string]bool{}
	}
	if s.sessions.loaded[projectPath] {
		return
	}
	s.sessions.loaded[projectPath] = true
	entries, err := os.ReadDir(sessionsDir(projectPath))
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(sessionsDir(projectPath), name))
		if err != nil {
			continue
		}
		var meta SessionMeta
		if json.Unmarshal(body, &meta) != nil || !validID(meta.ID) {
			continue
		}
		sess := &session{project: projectPath, meta: meta, wake: make(chan struct{})}
		sess.events = readEvents(filepath.Join(sessionsDir(projectPath), meta.ID+".events.jsonl"))
		if meta.RunningTurn != "" {
			if turn, err := loadTurn(projectPath, meta.RunningTurn); err == nil && turn.Status == "running" {
				ended := time.Now().UTC()
				turn.Status, turn.Error, turn.EndedAt = "interrupted", "Studio 在本轮进行中退出", &ended
				_ = saveTurn(projectPath, turn)
			}
			sess.meta.RunningTurn = ""
			_ = writeMeta(sess)
		}
		s.sessions.sessions[sessionKey(projectPath, meta.ID)] = sess
	}
}

func readEvents(path string) []SessionEvent {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	var events []SessionEvent
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		var event SessionEvent
		if json.Unmarshal(scanner.Bytes(), &event) == nil {
			events = append(events, event)
		}
	}
	return events
}

func writeMeta(sess *session) error {
	body, err := json.MarshalIndent(sess.meta, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.AtomicWrite(filepath.Join(sessionsDir(sess.project), sess.meta.ID+".json"), append(body, '\n'), 0o644)
}

func (s *Server) listSessions(projectPath string) []SessionMeta {
	s.loadSessions(projectPath)
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	out := []SessionMeta{}
	for _, sess := range s.sessions.sessions {
		if sess.project == projectPath {
			out = append(out, sess.meta)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out
}

func (s *Server) getSession(projectPath, id string) *session {
	s.loadSessions(projectPath)
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	return s.sessions.sessions[sessionKey(projectPath, id)]
}

func (s *Server) createSession(projectPath, kind, title string, agents agentChoice) (*session, error) {
	s.loadSessions(projectPath)
	now := time.Now().UTC()
	sess := &session{project: projectPath, wake: make(chan struct{}), meta: SessionMeta{
		ID: newID("s"), Title: title, Kind: kind, Tool: agents.Tool, Renderer: agents.Renderer, CreatedAt: now, UpdatedAt: now, Turns: []string{},
	}}
	if err := writeMeta(sess); err != nil {
		return nil, err
	}
	s.sessions.mu.Lock()
	s.sessions.sessions[sessionKey(projectPath, sess.meta.ID)] = sess
	s.sessions.mu.Unlock()
	return sess, nil
}

// emit 追加一条事件：编号、落盘、唤醒等待中的 SSE 连接。
//
// 落盘也在锁内：一轮对话与一次回退可能同时发事件，锁外写文件会让行序与 seq 不一致，
// 重启后按行读回来的事件就对不上 SSE 的 Last-Event-ID。
func (s *Server) emit(sess *session, turn string, event SessionEvent) {
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	event.Seq = len(sess.events) + 1
	event.Turn = turn
	event.Time = time.Now().UTC()
	sess.events = append(sess.events, event)
	if body, err := json.Marshal(event); err == nil {
		path := filepath.Join(sessionsDir(sess.project), sess.meta.ID+".events.jsonl")
		if file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
			_, _ = file.Write(append(body, '\n'))
			_ = file.Close()
		}
	}
	close(sess.wake)
	sess.wake = make(chan struct{})
}

// updateMeta 在锁内修改会话元数据并落盘。
func (s *Server) updateMeta(sess *session, change func(*SessionMeta)) {
	s.sessions.mu.Lock()
	change(&sess.meta)
	sess.meta.UpdatedAt = time.Now().UTC()
	meta := *sess
	s.sessions.mu.Unlock()
	_ = writeMeta(&meta)
}

// eventsAfter 返回 seq 大于 after 的事件，以及下一次要等待的唤醒通道。
func (s *Server) eventsAfter(sess *session, after int) ([]SessionEvent, <-chan struct{}, bool) {
	s.sessions.mu.Lock()
	defer s.sessions.mu.Unlock()
	var out []SessionEvent
	if after < len(sess.events) {
		out = append(out, sess.events[max(after, 0):]...)
	}
	return out, sess.wake, sess.meta.RunningTurn != ""
}

// attachmentText 把附件写成编排工具能读的说明。
func attachmentText(attachments []Attachment) string {
	if len(attachments) == 0 {
		return ""
	}
	var uploads, refs, frames []Attachment
	for _, a := range attachments {
		switch {
		case a.Upload:
			uploads = append(uploads, a)
		case a.Quote != "" || a.Ref:
			refs = append(refs, a)
		default:
			frames = append(frames, a)
		}
	}
	var b strings.Builder
	if len(uploads) > 0 {
		b.WriteString("\n\n用户上传的文件（存在 Studio 的上传目录里，不属于项目；要用时先复制或转换到项目里合适的位置，例如文章放项目根或 docs/，素材放 assets/）：")
		for _, a := range uploads {
			fmt.Fprintf(&b, "\n- %s「%s」：%s", uploadKind(a.Name), a.Name, a.Path)
		}
	}
	if len(refs) > 0 {
		b.WriteString("\n\n用户引用的内容（这条消息说的就是这些）：")
		for _, a := range refs {
			b.WriteString("\n- ")
			switch {
			case a.Quote != "":
				label := a.Label
				if label == "" {
					label = "一段文字"
				}
				b.WriteString(label)
				if a.Source != "" {
					fmt.Fprintf(&b, "（%s）", a.Source)
				}
				b.WriteString("：")
				for _, line := range strings.Split(strings.TrimSpace(a.Quote), "\n") {
					b.WriteString("\n  > " + line)
				}
			case a.SceneID != "":
				fmt.Fprintf(&b, "镜头 %s", a.SceneID)
			case a.Source != "":
				fmt.Fprintf(&b, "文件 %s", a.Source)
			}
			if a.Note != "" {
				b.WriteString("\n  备注：" + a.Note)
			}
		}
	}
	if len(frames) == 0 {
		return b.String()
	}
	b.WriteString("\n\n附带的画面上下文：")
	for _, a := range frames {
		b.WriteString("\n- ")
		if a.SceneID != "" {
			fmt.Fprintf(&b, "镜头 %s ", a.SceneID)
		}
		if a.Path != "" {
			fmt.Fprintf(&b, "%.2f 秒处的截图 %s（请打开查看）", a.Seconds, a.Path)
		}
		if a.Region != nil {
			fmt.Fprintf(&b, "，用户圈出的区域：x=%d y=%d 宽 %d 高 %d（视频像素）", a.Region.X, a.Region.Y, a.Region.W, a.Region.H)
		}
		if a.Selector != "" {
			fmt.Fprintf(&b, "，合成里选中的元素 `%s`", a.Selector)
			if a.Source != "" {
				fmt.Fprintf(&b, "（%s）", a.Source)
			}
		}
		if a.Note != "" {
			b.WriteString("，备注：" + a.Note)
		}
	}
	return b.String()
}

// validateAttachments 只接受 Studio 自己抽出的截图与项目内的合成文件。
func validateAttachments(projectPath string, attachments []Attachment) error {
	for _, a := range attachments {
		if a.Path != "" {
			clean := filepath.ToSlash(filepath.Clean(a.Path))
			prefix := "production/studio/attachments/"
			if a.Upload {
				prefix = uploadDir + "/"
			}
			if !strings.HasPrefix(clean, prefix) || strings.Contains(clean, "..") {
				return fmt.Errorf("附件路径不在 %s 下：%s", prefix, a.Path)
			}
			if !fileExists(filepath.Join(projectPath, filepath.FromSlash(clean))) {
				return fmt.Errorf("附件不存在：%s", a.Path)
			}
		}
		if a.Source != "" {
			if _, err := containedPath(projectPath, a.Source); err != nil {
				return err
			}
		}
		if n := utf8.RuneCountInString(a.Quote); n > maxQuoteRunes {
			return fmt.Errorf("引用太长（%d 字，上限 %d）：长内容请直接说文件名，让编排工具自己读", n, maxQuoteRunes)
		}
		if a.Ref && a.SceneID == "" && a.Source == "" {
			return fmt.Errorf("引用要指明镜头或文件")
		}
	}
	return nil
}

// chatPreamble 是聊天会话第一轮的开场说明。整片制作会话第一轮直接发制作提示词，末尾附 studioInteraction。
func chatPreamble(rulesName string) string {
	return "你正在协助用户修改当前目录下的 ArticleToMotion 视频项目。动手前先读项目规则 " + rulesName +
		"。需要渲染、校验、复查时直接运行 am 的子命令。改完用几句话说明改了哪些文件、为什么，以及接下来要不要重渲染哪些镜头。\n\n" +
		studioInteraction + "\n\n用户的请求："
}

// studioInteraction 告诉编排工具怎样在 Studio 里和用户来回：多步任务先列待办清单
// （网页据此显示进度），要用户拍板时用 choices 代码块（网页渲染成按钮，见 Chat.tsx 的 parseChoices）。
var studioInteraction = `你在 Studio 网页里和用户对话，下面几条约定让网页能把你的进度和问题显示好：
- 多步骤的工作先用你的待办清单工具列出步骤，做的过程中及时更新状态，用户会在对话顶部看到进度。
- 需要用户拍板时（选风格、确认分镜、确认一条推测的偏好、几种做法里选一种），先把问题和各选项的差别写清楚，再在回复的最后单独放一个语言标成 choices 的代码块，每行一个选项，例如：
` + "```choices\n用方案 A：深色科技风\n用方案 B：白板手绘风\n```" + `
  用户会看到可点的按钮，点了就把那一行原样发给你。问完就结束这一轮等用户回复，不要替用户选。用户也可能直接打字回答。
- 推荐整片风格时（用户没指定画风、或要换风格），先用 am film-style list --json 挑出两三种贴合的，在回复里放一个语言标成 film-styles 的代码块，每行一种，写「来源/目录名」加一句为什么合适，例如：
` + "```film-styles\nlemo-opuscar/impasto 厚涂笔触适合讲历史人物的分量\n```" + `
  网页会显示每种风格的海报，用户点「用这个风格」就把选择发给你，你再运行 am film-style use。「不用整片风格，各镜头自主定视觉」写进同一条回复的 choices 代码块。
- 要用户试听音频、看图片或视频时（音色试听、配音片段、封面候选、预览帧），在回复里写出每个文件在项目里的相对路径，例如 production/audio/auditions/try-A.wav，网页会在回复下面直接放播放器和缩略图；只写文件名、目录另说的话网页未必找得到。
` + viewInteraction()

// transcript 把会话里已有的对话整理成文字，供续接失败时补发。只保留末尾 transcriptLimit 字。
func transcript(events []SessionEvent) string {
	var b strings.Builder
	for _, event := range events {
		switch event.Kind {
		case kindUser:
			b.WriteString("\n用户：" + event.Text + "\n")
		case agentrun.KindText:
			b.WriteString("你：" + event.Text + "\n")
		}
	}
	runes := []rune(b.String())
	if len(runes) > transcriptLimit {
		runes = runes[len(runes)-transcriptLimit:]
	}
	return strings.TrimSpace(string(runes))
}

// turnRequest 是发起一轮对话所需的全部输入。
type turnRequest struct {
	// QueueID 只对排队的消息有值，网页用它移除、引导某一条。
	QueueID     string
	Message     string
	Prompt      string // 非空时直接作为发给编排工具的提示词（整片制作的第一轮）
	Attachments []Attachment
	// View 是用户发消息时在看的页面。
	View *ViewState
}

// startTurn 占用项目写权、打开始快照，然后在后台跑这一轮。返回时编排工具已经启动。
func (s *Server) startTurn(p Project, sess *session, req turnRequest) (*Turn, error) {
	if err := validateAttachments(p.Path, req.Attachments); err != nil {
		return nil, err
	}
	s.sessions.mu.Lock()
	meta := sess.meta
	s.sessions.mu.Unlock()
	cfg, err := sessionConfig(p.Path, meta)
	if err != nil {
		return nil, err
	}
	if err := s.acquire(p.Path, "会话「"+sess.meta.Title+"」正在对话"); err != nil {
		return nil, err
	}
	turn, prompt, err := s.prepareTurn(p, sess, cfg, req)
	if err != nil {
		s.release(p.Path)
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.sessions.mu.Lock()
	sess.cancel = cancel
	s.sessions.mu.Unlock()
	go s.runTurn(ctx, p, sess, cfg, turn, prompt)
	return turn, nil
}

func (s *Server) prepareTurn(p Project, sess *session, cfg config.Config, req turnRequest) (*Turn, string, error) {
	rulesName, err := tools.ProjectRulesFilename(cfg.Orchestrator)
	if err != nil {
		return nil, "", err
	}
	if _, err := project.WriteRules(p.Path, rulesName); err != nil {
		return nil, "", err
	}
	before, err := scanTree(p.Path)
	if err != nil {
		return nil, "", fmt.Errorf("扫描项目：%w", err)
	}
	message := req.Message + attachmentText(req.Attachments)
	if where := req.View.Describe(); where != "" {
		message += "\n\n" + where
	}
	prompt := req.Prompt
	switch {
	case prompt != "":
		prompt += "\n\n---\n\n" + studioInteraction
		// 只上传了文章、没写话时也要把附件交过去。
		if strings.TrimSpace(message) != "" {
			prompt += "\n\n用户补充：" + strings.TrimSpace(message)
		}
	case len(sess.meta.Turns) == 0 && sess.meta.Kind == "chat":
		prompt = chatPreamble(rulesName) + message
	default:
		prompt = message
	}
	brief, digest := s.preferenceBrief(p, cfg)
	resend := brief != "" && (digest != sess.meta.PreferenceDigest || sess.meta.CLISessionID == "" || len(sess.meta.Turns) == 0)
	if resend {
		prompt = brief + "\n---\n\n" + prompt
	}
	display := req.Message
	if display == "" {
		display = "开始整片制作"
	}
	turn := &Turn{ID: newID("t"), SessionID: sess.meta.ID, Kind: sess.meta.Kind, Message: display, Status: "running", StartedAt: time.Now().UTC(), Before: before, Changes: []FileChange{}}
	if err := saveTurn(p.Path, turn); err != nil {
		return nil, "", err
	}
	s.updateMeta(sess, func(meta *SessionMeta) {
		meta.Turns = append(meta.Turns, turn.ID)
		meta.RunningTurn = turn.ID
		if resend {
			meta.PreferenceDigest = digest
		}
		if meta.Tool == "" {
			meta.Tool = cfg.Orchestrator
		}
	})
	s.emit(sess, turn.ID, SessionEvent{Event: agentrun.Event{Kind: kindUser, Text: display + attachmentText(req.Attachments)}})
	s.emit(sess, turn.ID, SessionEvent{Event: agentrun.Event{Kind: kindTurnStart}, Status: "running"})
	return turn, prompt, nil
}

// runTurn 在后台跑一轮。写权由 finishTurn 释放，这里不能再 defer 一次：
// 释放之后下一轮可能已经拿到写权，重复释放会把它的锁也放掉。
func (s *Server) runTurn(ctx context.Context, p Project, sess *session, cfg config.Config, turn *Turn, prompt string) {
	env := cfg.ChildEnvironment(envutil.EnvMap(), s.config.Unsafe, envutil.ParsePassthrough(os.Getenv("AM_PASSTHROUGH_ENV")))
	if err := envutil.AddExecutableLocation(env); err != nil {
		s.emit(sess, turn.ID, SessionEvent{Event: agentrun.Event{Kind: kindNotice, Text: err.Error()}})
	}
	inbox := viewInbox(p.Path, turn.ID)
	env[ViewInboxEnv], env[ViewProjectEnv] = inbox, p.Path
	stopViews := s.watchViews(sess, turn.ID, inbox)
	defer stopViews()
	lastStat := statTree(p.Path)
	lastCheck := time.Now()
	checkFiles := func(force bool) {
		if !force && time.Since(lastCheck) < changeCheckInterval {
			return
		}
		lastCheck = time.Now()
		current := statTree(p.Path)
		if changed := changedPaths(lastStat, current); len(changed) > 0 {
			s.emit(sess, turn.ID, SessionEvent{Event: agentrun.Event{Kind: kindFilesChanged}, Files: changed})
		}
		lastStat = current
	}
	emit := func(event agentrun.Event) {
		if event.Kind == agentrun.KindDone {
			return
		}
		if event.Kind == agentrun.KindSession {
			s.updateMeta(sess, func(meta *SessionMeta) { meta.CLISessionID = event.SessionID })
		}
		s.emit(sess, turn.ID, SessionEvent{Event: event})
		if event.Kind == agentrun.KindToolResult {
			checkFiles(false)
		}
	}
	s.sessions.mu.Lock()
	previous := sess.meta.CLISessionID
	earlierTurns := len(sess.meta.Turns) > 1
	// 末尾两条是本轮刚发的 user 与 turn-start，不算进历史。
	history := transcript(sess.events[:max(len(sess.events)-2, 0)])
	s.sessions.mu.Unlock()
	spec := agentrun.Spec{
		Tool: cfg.Orchestrator, Workdir: p.Path, Prompt: prompt, Unsafe: s.config.Unsafe,
		Access:   cfg.OrchestratorAccess(),
		Env:      envutil.EnvList(env),
		LookPath: func(name string) (string, error) { return envutil.LookPath(name, env["PATH"]) },
	}
	resumed := previous != "" && earlierTurns
	if resumed {
		spec.SessionID, spec.Resume = previous, true
	} else {
		spec.SessionID = agentrun.NewSessionID(cfg.Orchestrator)
		if earlierTurns && history != "" {
			spec.Prompt = reseedPrompt(history, prompt)
		}
	}
	result, err := agentrun.Run(ctx, spec, emit)
	s.recordUsage(ctx, p, sess, cfg.Orchestrator, env, turn.ID, result, err)
	if err != nil && resumed && !result.Produced && ctx.Err() == nil {
		s.emit(sess, turn.ID, SessionEvent{Event: agentrun.Event{Kind: kindNotice, Text: "原会话无法续接（" + err.Error() + "），已带上之前的对话记录开新会话"}})
		spec.SessionID, spec.Resume = agentrun.NewSessionID(cfg.Orchestrator), false
		spec.Prompt = reseedPrompt(history, prompt)
		result, err = agentrun.Run(ctx, spec, emit)
		s.recordUsage(ctx, p, sess, cfg.Orchestrator, env, turn.ID, result, err)
	}
	checkFiles(true)
	stopViews()
	s.finishTurn(ctx, p, sess, turn, err)
}

// watchViews 在这一轮进行中轮询收件目录，把 am studio show 的请求译成 view 事件。
// 返回的函数停止轮询、把剩下的请求处理完并删掉收件目录；可以调用多次。
func (s *Server) watchViews(sess *session, turnID, inbox string) func() {
	deliver := func() {
		for _, req := range drainViewInbox(inbox) {
			req := req
			s.emit(sess, turnID, SessionEvent{Event: agentrun.Event{Kind: kindView, Text: req.Note}, View: &req})
		}
	}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(viewPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				deliver()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
			deliver()
			_ = os.RemoveAll(inbox)
		})
	}
}

func reseedPrompt(history, prompt string) string {
	return "下面是这个项目里你和用户之前的对话记录（较早的部分可能被截掉），供你接上上下文：\n\n" + history + "\n\n---\n\n" +
		studioInteraction + "\n\n---\n\n" + prompt
}

func (s *Server) finishTurn(ctx context.Context, p Project, sess *session, turn *Turn, runErr error) {
	after, scanErr := scanTree(p.Path)
	ended := time.Now().UTC()
	turn.EndedAt = &ended
	if scanErr == nil {
		turn.After = after
		turn.Changes = diffTrees(turn.Before, after)
	}
	switch {
	case ctx.Err() != nil:
		turn.Status = "cancelled"
	case runErr != nil:
		turn.Status, turn.Error = "failed", runErr.Error()
	case scanErr != nil:
		turn.Status, turn.Error = "failed", "结束快照失败："+scanErr.Error()
	default:
		turn.Status = "succeeded"
	}
	_ = saveTurn(p.Path, turn)
	if turn.Kind == "chat" && turn.Status != "cancelled" {
		s.recordUtterance(p, turn, false)
	}
	s.sessions.mu.Lock()
	sess.cancel = nil
	s.sessions.mu.Unlock()
	s.updateMeta(sess, func(meta *SessionMeta) { meta.RunningTurn = "" })
	// 先放写权再发 turn-end：网页收到 turn-end 就可能立刻发下一轮。
	s.release(p.Path)
	end := SessionEvent{Event: agentrun.Event{Kind: kindTurnEnd, Text: turn.Error}, Status: turn.Status, Changes: turn.Changes}
	s.emit(sess, turn.ID, end)
	s.drainQueue(p, sess)
}

// cancelSession 取消会话里正在进行的一轮。keepQueue 为 false 时一并清掉排队的消息：
// 用户按停止，多半是不想让这些要求接着跑了；「打断并发送」要保留它们。
func (s *Server) cancelSession(sess *session, keepQueue bool) error {
	s.sessions.mu.Lock()
	cancel := sess.cancel
	dropped := 0
	if cancel != nil && !keepQueue {
		dropped = len(sess.queue)
		sess.queue = nil
	}
	turnID := sess.meta.RunningTurn
	s.sessions.mu.Unlock()
	if cancel == nil {
		return errors.New("这个会话没有正在进行的对话")
	}
	if dropped > 0 {
		s.emit(sess, turnID, SessionEvent{Event: agentrun.Event{Kind: kindNotice, Text: fmt.Sprintf("已停止，排队的 %d 条消息不再发送", dropped)}})
	}
	cancel()
	return nil
}

// enqueueTurn 在这一轮进行中收下一条消息：返回 false 表示会话此刻没有在跑，调用方直接开新一轮。
func (s *Server) enqueueTurn(p Project, sess *session, req turnRequest) (bool, error) {
	if err := validateAttachments(p.Path, req.Attachments); err != nil {
		return false, err
	}
	s.sessions.mu.Lock()
	if sess.cancel == nil {
		s.sessions.mu.Unlock()
		return false, nil
	}
	req.QueueID = newID("q")
	sess.queue = append(sess.queue, req)
	turnID := sess.meta.RunningTurn
	s.sessions.mu.Unlock()
	s.emit(sess, turnID, SessionEvent{Event: agentrun.Event{Kind: kindQueued, Text: req.Message + attachmentText(req.Attachments)}, QueueID: req.QueueID})
	return true, nil
}

// unqueue 移除一条排队的消息；找不到（已经发出去了）时返回 false。
func (s *Server) unqueue(sess *session, queueID string) bool {
	s.sessions.mu.Lock()
	found := false
	for i, req := range sess.queue {
		if req.QueueID == queueID {
			sess.queue = append(sess.queue[:i:i], sess.queue[i+1:]...)
			found = true
			break
		}
	}
	turnID := sess.meta.RunningTurn
	s.sessions.mu.Unlock()
	if found {
		s.emit(sess, turnID, SessionEvent{Event: agentrun.Event{Kind: kindUnqueued}, QueueID: queueID})
	}
	return found
}

// steer 把一条排队的消息提到最前，并停掉进行中的一轮：这一轮结束后排队的消息立刻发出。
func (s *Server) steer(sess *session, queueID string) bool {
	s.sessions.mu.Lock()
	index := -1
	for i, req := range sess.queue {
		if req.QueueID == queueID {
			index = i
			break
		}
	}
	if index > 0 {
		req := sess.queue[index]
		sess.queue = append([]turnRequest{req}, append(sess.queue[:index:index], sess.queue[index+1:]...)...)
	}
	s.sessions.mu.Unlock()
	if index < 0 {
		return false
	}
	return s.cancelSession(sess, true) == nil
}

// drainQueue 在一轮结束后把排队的消息合并成下一轮发出。
func (s *Server) drainQueue(p Project, sess *session) {
	s.sessions.mu.Lock()
	queue := sess.queue
	sess.queue = nil
	s.sessions.mu.Unlock()
	if len(queue) == 0 {
		return
	}
	merged := turnRequest{}
	var messages []string
	for _, req := range queue {
		messages = append(messages, req.Message)
		merged.Attachments = append(merged.Attachments, req.Attachments...)
		if req.View != nil {
			merged.View = req.View
		}
	}
	merged.Message = strings.Join(messages, "\n\n")
	if len(queue) > 1 {
		merged.Message = "（上一轮进行中你陆续补充了几条要求，一并处理）\n\n" + merged.Message
	}
	if _, err := s.startTurn(p, sess, merged); err != nil {
		s.emit(sess, "", SessionEvent{Event: agentrun.Event{Kind: kindNotice, Text: "排队的消息没能发出（" + err.Error() + "），请重新发送：" + merged.Message}})
	}
}

// revert 回退一轮，并在会话里记一条事件。
func (s *Server) revert(p Project, turnID string) (*Turn, []string, error) {
	turn, err := loadTurn(p.Path, turnID)
	if err != nil {
		return nil, nil, err
	}
	if err := s.acquire(p.Path, "正在回退一轮对话"); err != nil {
		return nil, nil, err
	}
	defer s.release(p.Path)
	skipped, err := revertTurn(p.Path, turn)
	if err != nil {
		return turn, nil, err
	}
	turn.Status = "reverted"
	if err := saveTurn(p.Path, turn); err != nil {
		return turn, skipped, err
	}
	if turn.Kind == "chat" {
		s.recordUtterance(p, turn, true)
	}
	if sess := s.getSession(p.Path, turn.SessionID); sess != nil {
		s.emit(sess, turn.ID, SessionEvent{Event: agentrun.Event{Kind: kindTurnReverted}, Status: "reverted", Files: skipped})
	}
	return turn, skipped, nil
}

// containedPath 把相对项目根的路径解析成绝对路径，拒绝逃出项目（含符号链接）。
func containedPath(projectPath, rel string) (string, error) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", fmt.Errorf("路径必须是项目内的相对路径：%s", rel)
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("路径逃出了项目：%s", rel)
	}
	root, err := filepath.EvalSymlinks(projectPath)
	if err != nil {
		return "", err
	}
	full := filepath.Join(projectPath, clean)
	resolved, err := filepath.EvalSymlinks(full)
	if err != nil {
		return "", err
	}
	if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
		return "", fmt.Errorf("路径逃出了项目：%s", rel)
	}
	return full, nil
}

// recordUsage 把一次编排调用记进项目的用量账本。续接失败后重开的会话是两次调用，
// 各记一行：第一次哪怕只打了一行错误，也可能已经读了一遍上下文。
func (s *Server) recordUsage(ctx context.Context, p Project, sess *session, tool string, env map[string]string, turnID string, result agentrun.Result, runErr error) {
	if !result.Started {
		return
	}
	model := result.Model
	if model == "" {
		model = tools.ConfiguredModel(tool, env)
	}
	cancelled := ctx.Err() != nil || errors.Is(runErr, context.Canceled)
	entry := ledger.FromResult(ledger.SourceStudio, tool, model, result.SessionID, result.Usage, runErr, cancelled)
	entry.Turn = turnID
	if err := ledger.Append(ledger.ProjectFile(p.Path), entry); err != nil {
		s.emit(sess, turnID, SessionEvent{Event: agentrun.Event{Kind: kindNotice, Text: "编排用量没能记进账本：" + err.Error()}})
	}
}
