package studio

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	"github.com/chouheiwa/articale-to-motion/internal/filmstyle/lemo"
)

func writeStudioJPEG(t *testing.T, path string, width, height int) {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 风格目录随二进制下发，不联网就能列出；海报从风格库读并缩成缩略图；
// 本项目的整片风格可查、可装（经 am film-style 任务）、未知风格直接拒绝。
func TestFilmStyleEndpoints(t *testing.T) {
	library := t.TempDir()
	writeStudioFile(t, filepath.Join(library, "core", "lib.js"), "//")
	first := lemo.Catalog()[0].Slug
	lemoSource := func(body map[string]any) map[string]any {
		for _, item := range studioList(t, body["sources"]) {
			if source := item.(map[string]any); source["id"] == lemo.SourceID {
				return source
			}
		}
		t.Fatalf("风格来源里没有 %s：%v", lemo.SourceID, body["sources"])
		return nil
	}
	// 来源数据是前置资源：先看没准备好时报 ready=false、提示 am setup。
	t.Setenv(lemo.LibraryEnv, filepath.Join(t.TempDir(), "absent"))
	_, empty := startStudio(t, Config{ProjectPath: t.TempDir(), ConfigPath: filepath.Join(t.TempDir(), "projects.json")})
	status, body := studioRequest(t, http.MethodGet, empty.URL+"/api/film-styles", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if source := lemoSource(body); source["ready"] != false || !strings.Contains(source["problem"].(string), "am setup") {
		t.Fatalf("来源没准备好时应当报 ready=false 并指向 am setup：%v", source)
	}

	for _, slug := range []string{first, "impasto"} {
		writeStudioFile(t, filepath.Join(library, "styles", slug, "STYLE.md"), "# "+slug)
		writeStudioFile(t, filepath.Join(library, "styles", slug, "demo", "index.html"), "<html>")
		writeStudioJPEG(t, filepath.Join(library, "styles", slug, "poster.jpg"), 960, 540)
	}
	t.Setenv(lemo.LibraryEnv, library)

	root := t.TempDir()
	writeStudioFile(t, filepath.Join(root, "article-to-motion.conf"), "")
	_, ts := startStudio(t, Config{ProjectPath: root, ConfigPath: filepath.Join(t.TempDir(), "projects.json")})

	status, body = studioRequest(t, http.MethodGet, ts.URL+"/api/film-styles", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if styles := studioList(t, body["styles"]); len(styles) != len(filmstyle.Catalog()) {
		t.Fatalf("应当列出全部 %d 种风格：%d", len(filmstyle.Catalog()), len(styles))
	}
	if source := lemoSource(body); source["ready"] != true || source["gallery"] == "" || len(studioList(t, source["categories"])) < 2 {
		t.Fatalf("来源应当已就绪并附图鉴链接与分类：%v", source)
	}

	res, err := http.Get(ts.URL + "/api/film-styles/lemo-opuscar/impasto/poster.jpg")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "image/jpeg" {
		t.Fatalf("海报：%d %s", res.StatusCode, res.Header.Get("Content-Type"))
	}
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(raw)); err != nil || cfg.Width != posterThumbWidth {
		t.Fatalf("菜单里应当给缩略图（宽 %d）：%+v %v", posterThumbWidth, cfg, err)
	}
	for _, path := range []string{"/api/film-styles/lemo-opuscar/no-such/poster.jpg", "/api/film-styles/lemo-opuscar/watercolor/poster.jpg", "/api/film-styles/lemo-opuscar/impasto/STYLE.md", "/api/film-styles/impasto/poster.jpg", "/api/film-styles/other/impasto/poster.jpg"} {
		res, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusNotFound {
			t.Errorf("%s 应当 404，实际 %d", path, res.StatusCode)
		}
	}

	status, body = studioRequest(t, http.MethodGet, ts.URL+"/api/film-style", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	if body["installed"] != false {
		t.Fatalf("新项目不该有整片风格：%v", body)
	}
	status, body = studioRequest(t, http.MethodPost, ts.URL+"/api/film-style", `{"style":"no-such"}`)
	if status != http.StatusBadRequest {
		t.Fatalf("未知风格应当 400：%d %v", status, body)
	}
	// 合法风格会起一个 am film-style 任务；测试里 os.Executable 是测试二进制本身，
	// 真起任务会把整套测试再跑一遍，所以这里只验到拒绝未知风格为止。
}
