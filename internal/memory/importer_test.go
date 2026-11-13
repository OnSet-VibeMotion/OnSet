package memory

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/scene"
)

func writeAttemptFile(t *testing.T, path string, a scene.Attempt) {
	t.Helper()
	body, _ := json.Marshal(a)
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestImportProjectOrdersAttemptsAndDedupes：最早的尝试算首次，其余算重试；
// 老尝试没有校验器 ID 时按文字补上；重复导入跳过。
func TestImportProjectOrdersAttemptsAndDedupes(t *testing.T) {
	store := newStore(t)
	root := filepath.Join(t.TempDir(), "demo")
	s := writeSceneDir(t, filepath.Join(root, "scenes", "scene-001"), "scene-001", "中文", "")
	writeAttemptFile(t, filepath.Join(s.Directory, "attempts", "attempt-01", "render-scene-001.attempt.json"), scene.Attempt{
		Renderer: "claude", StartedAt: "2026-10-01T00:00:00Z", Outcome: scene.OutcomeVerificationFailed,
		Problems: []string{"源码不确定：index.html:3 [raf] 使用了 requestAnimationFrame：x", "总帧数不符：期望 30 帧，逐帧解码实测 31 帧"}})
	writeAttemptFile(t, s.AttemptLog(), scene.Attempt{Renderer: "claude", Model: "claude-opus-5-5", StartedAt: "2026-10-01T01:00:00Z", Outcome: scene.OutcomeSucceeded})
	result, err := store.ImportProject(root, ImportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Attempts != 2 || result.Failures != 1 || result.Run != "import:demo" {
		t.Fatalf("导入结果不对：%+v", result)
	}
	episodes, _ := store.Episodes()
	var first, second Episode
	for _, e := range episodes {
		if e.Passed() {
			second = e
		} else if e.Source == SourceRender {
			first = e
		}
	}
	if first.Retry || !second.Retry || !slices.Equal(first.Checks, []string{"determinism.raf", "output.frames"}) || second.Model != "claude-opus-5-5" {
		t.Errorf("顺序或校验器不对：first=%+v second=%+v", first, second)
	}
	if again, _ := store.ImportProject(root, ImportOptions{}); again.Attempts != 0 || again.Skipped != 2 {
		t.Errorf("重复导入应当跳过：%+v", again)
	}
	runs := RunReport(func() []Episode { e, _ := store.Episodes(); return e }())
	if len(runs) != 1 || runs[0].PassRate != 0 || runs[0].Retries != 1 {
		t.Errorf("导入的批次：%+v", runs)
	}
}

func TestDropRetimedKeepsRendererOffByOne(t *testing.T) {
	problems := []string{"总帧数不符：期望 1035 帧（34.500000 秒 × 30fps），逐帧解码实测 1036 帧", "源码不确定：x [raf] y"}
	checks := []string{"output.frames", "determinism.raf"}
	if p, _, note := dropRetimed("d", problems, checks); len(p) != 2 || note != "" {
		t.Errorf("差一帧是渲染器的错，要保留：%v %q", p, note)
	}
	problems[0] = "总帧数不符：期望 1035 帧（34.500000 秒 × 30fps），逐帧解码实测 1092 帧"
	p, c, note := dropRetimed("d", append(problems, "时长不符：期望 34.500 秒（容差 0.150），实测 36.400 秒"), append(checks, "output.duration"))
	if len(p) != 1 || c[0] != "determinism.raf" || !strings.Contains(note, "改过时长") {
		t.Errorf("差几十帧多半是改过时长，只丢时长与帧数：%v %v %q", p, c, note)
	}
}

// TestImportReverifiesArchivedOutputs：只有产物的老归档用现在的校验重判；
// 字体等素材从镜头目录补上，不会被误判成 font-missing。
func TestImportReverifiesArchivedOutputs(t *testing.T) {
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("本机没有 ffmpeg")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("本机没有 ffprobe")
	}
	store := newStore(t)
	root := filepath.Join(t.TempDir(), "demo")
	s := writeSceneDir(t, filepath.Join(root, "scenes", "scene-001"), "scene-001", "中文", "")
	os.WriteFile(filepath.Join(s.Directory, "frame.md"), []byte("---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n"), 0o644)
	os.WriteFile(filepath.Join(s.Directory, "scene.json"), []byte(`{"id":"scene-001","duration_seconds":3,"output":"out.mp4","transcript":"transcript.srt","text":"中文","style_guide":"frame.md"}`), 0o644)
	os.MkdirAll(filepath.Join(s.Directory, "fonts"), 0o755)
	os.WriteFile(filepath.Join(s.Directory, "fonts", "x.woff2"), []byte("font"), 0o644)
	archive := filepath.Join(root, "production", "failed-attempts", "scene-001-attempt-01-extra-frame")
	os.MkdirAll(archive, 0o755)
	os.WriteFile(filepath.Join(archive, "index.html"), []byte(`<style>@font-face{font-family:X;src:url('./fonts/x.woff2');font-display:block}</style>`), 0o644)
	cmd := exec.Command(ffmpeg, "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-frames:v", "91", "-pix_fmt", "yuv420p", filepath.Join(archive, "scene-001.mp4"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	result, err := store.ImportProject(root, ImportOptions{Env: map[string]string{"PATH": os.Getenv("PATH"), "HOME": t.TempDir()}, Tolerance: 0.15})
	if err != nil {
		t.Fatal(err)
	}
	episodes, _ := store.Episodes()
	if result.Failures != 1 || len(episodes) != 1 || !slices.Equal(episodes[0].Checks, []string{"output.frames"}) {
		t.Fatalf("多一帧的归档应当记为 output.frames，且字体不误判：%+v %+v", result, episodes)
	}
}
