package studio

import (
	"net/http"
	"os"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/prereq"
	"github.com/chouheiwa/articale-to-motion/internal/prereqs"
)

// SetupStatus 是 /api/setup 的结果：前置资源的就绪状态，给首页与顶栏的引导用。
//
// Studio 只读不下载（前置资源只由用户在终端里跑的 am setup 准备，见 internal/prereqs）：
// 网页列出缺哪几项、给出要复制的命令，用户跑完后重新检查。
type SetupStatus struct {
	// Ready 表示做片必需的项（技能与 CLI）都已就绪；整片风格来源缺了只影响选风格。
	Ready   bool             `json:"ready"`
	Items   []prereqs.Status `json:"items"`
	Command string           `json:"command"`
}

func (s *Server) setupAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	resp := SetupStatus{Ready: true, Items: prereqs.Check(envutil.EnvMap()), Command: prereq.SetupCommand}
	// 浏览器端到端测试不联网、也没有真实的前置资源：与跳过技能安装用同一个开关，
	// 当作全部就绪，不让引导挡住测试流程。
	if os.Getenv("AM_STUDIO_SKIP_SKILL_INSTALL") == "1" {
		for i := range resp.Items {
			resp.Items[i].Ready = true
		}
	}
	for _, item := range resp.Items {
		if item.Required && !item.Ready {
			resp.Ready = false
		}
	}
	s.write(w, http.StatusOK, resp)
}
