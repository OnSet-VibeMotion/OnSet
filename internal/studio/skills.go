package studio

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/projectinit"
)

// skillsState 记录各项目 HyperFrames 官方技能的后台安装情况。
type skillsState struct {
	mu      sync.Mutex
	running map[string]bool
	errors  map[string]string
	install func(ctx context.Context, dir string) error
}

// installOfficialSkills 是默认的安装函数。包级变量只为测试：TestMain 换成不联网的版本；
// 浏览器端到端测试起的是真二进制，靠 AM_STUDIO_SKIP_SKILL_INSTALL=1 跳过联网。
var installOfficialSkills = func(ctx context.Context, dir string) error {
	if os.Getenv("AM_STUDIO_SKIP_SKILL_INSTALL") == "1" {
		return nil
	}
	var log bytes.Buffer
	_, err := projectinit.InstallSkills(ctx, dir, envutil.EnvMap(), &log)
	if err != nil && log.Len() > 0 {
		return &installError{err: err, log: strings.TrimSpace(log.String())}
	}
	return err
}

// skillInstallTimeout 是一次安装的上限：要浅克隆上游仓库，网络差时不能无限挂着。
const skillInstallTimeout = 5 * time.Minute

func (s *Server) skillInstaller() func(ctx context.Context, dir string) error {
	if s.skills.install != nil {
		return s.skills.install
	}
	return installOfficialSkills
}

type installError struct {
	err error
	log string
}

func (e *installError) Error() string { return e.err.Error() + "\n" + tail(e.log, 600) }

func tail(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return "…" + string(runes[len(runes)-n:])
}

// installSkills 在后台把官方技能装进项目；已经在装就不重复开。
func (s *Server) installSkills(dir string) {
	s.skills.mu.Lock()
	if s.skills.running == nil {
		s.skills.running, s.skills.errors = map[string]bool{}, map[string]string{}
	}
	if s.skills.running[dir] {
		s.skills.mu.Unlock()
		return
	}
	s.skills.running[dir] = true
	delete(s.skills.errors, dir)
	install := s.skillInstaller()
	s.skills.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), skillInstallTimeout)
		defer cancel()
		err := install(ctx, dir)
		s.skills.mu.Lock()
		delete(s.skills.running, dir)
		if err != nil {
			s.skills.errors[dir] = err.Error()
		}
		s.skills.mu.Unlock()
	}()
}

// SkillsStatus 是项目里 HyperFrames 官方技能的状态。
type SkillsStatus struct {
	Installed  bool   `json:"installed"`
	Installing bool   `json:"installing"`
	Error      string `json:"error,omitempty"`
}

func (s *Server) skillsStatus(dir string) SkillsStatus {
	s.skills.mu.Lock()
	defer s.skills.mu.Unlock()
	return SkillsStatus{Installed: projectinit.SkillsInstalled(dir), Installing: s.skills.running[dir], Error: s.skills.errors[dir]}
}

// skillsInstallAPI 给缺技能的项目补装（在 Studio 里新建、装到一半断网的项目）。
func (s *Server) skillsInstallAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.method(w, http.MethodPost)
		return
	}
	p, ok := s.projectOr404(w)
	if !ok {
		return
	}
	s.installSkills(p.Path)
	s.write(w, http.StatusAccepted, s.skillsStatus(p.Path))
}
