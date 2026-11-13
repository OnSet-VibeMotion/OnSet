package studio

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestCreateHonoursModesAndInstallsSkills：新建项目与 am init 同一条路——卡点、多角色对话
// 写出各自的模式文件，并在后台装官方技能；装失败的项目可以补装。
func TestCreateHonoursModesAndInstallsSkills(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	s, ts := startStudio(t, Config{ConfigPath: filepath.Join(t.TempDir(), "projects.json")})
	calls := make(chan string, 4)
	fail := true
	s.skills.install = func(_ context.Context, dir string) error {
		failing := fail
		calls <- dir
		if failing {
			return errors.New("没有网络")
		}
		return nil
	}
	wait := func(dir string) SkillsStatus {
		t.Helper()
		select {
		case got := <-calls:
			if got != dir {
				t.Fatalf("installed into %s, want %s", got, dir)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("没有开始装技能")
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if status := s.skillsStatus(dir); !status.Installing {
				return status
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("安装没有结束")
		return SkillsStatus{}
	}

	status, body := studioRequest(t, http.MethodPost, ts.URL+"/api/projects/create", fmt.Sprintf(`{"parent":%q,"name":"beat-film","delivery":"beat"}`, home))
	requireStudioStatus(t, status, http.StatusCreated, body)
	beatDir := body["project"].(map[string]any)["path"].(string)
	if _, err := os.Stat(filepath.Join(beatDir, "beat.yaml")); err != nil {
		t.Fatalf("卡点项目要有 beat.yaml：%v", err)
	}
	if got := wait(beatDir); got.Error == "" || got.Installed {
		t.Fatalf("装失败要记下原因：%+v", got)
	}

	// 补装成功。
	fail = false
	status, body = studioRequest(t, http.MethodPost, ts.URL+"/api/skills/install", "")
	requireStudioStatus(t, status, http.StatusAccepted, body)
	if got := wait(beatDir); got.Error != "" {
		t.Fatalf("补装后不该再有错误：%+v", got)
	}

	status, body = studioRequest(t, http.MethodPost, ts.URL+"/api/projects/create", fmt.Sprintf(`{"parent":%q,"name":"cast-film","narration":"cast"}`, home))
	requireStudioStatus(t, status, http.StatusCreated, body)
	castDir := body["project"].(map[string]any)["path"].(string)
	for _, name := range []string{"cast.yaml", "cast"} {
		if _, err := os.Stat(filepath.Join(castDir, name)); err != nil {
			t.Fatalf("多角色对话项目缺 %s：%v", name, err)
		}
	}
	wait(castDir)
	status, body = studioRequest(t, http.MethodGet, ts.URL+"/api/skills", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if body["status"].(map[string]any)["installed"] != false {
		t.Fatalf("没有来源记录就不算装过：%#v", body["status"])
	}
}
