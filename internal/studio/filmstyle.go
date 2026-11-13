package studio

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/chouheiwa/articale-to-motion/internal/envutil"
	"github.com/chouheiwa/articale-to-motion/internal/filmstyle"
	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
)

// 整片风格（internal/filmstyle）在 Studio 里的入口：风格目录与海报、本项目的整片风格、
// 装 / 换 / 去掉。风格库是前置资源（am setup 准备），这里只读不下载。装与去掉经 am film-style 子命令完成，占项目写锁，与渲染、拼接同一条路：
// Studio 自己不写项目文件。

// filmStyleGallery 是上游图鉴，每种风格都有 demo 片可看。
const filmStyleGallery = "https://lemomo-ai.github.io/lemo-opuscar/"

func (s *Server) filmStyleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/film-styles", s.filmStylesAPI)
	mux.HandleFunc("/api/film-styles/", s.filmStylePosterAPI)
	mux.HandleFunc("/api/film-style", s.projectFilmStyleAPI)
}

func filmStyleOptions() filmstyle.LibraryOptions {
	return filmstyle.LibraryOptions{Env: envutil.EnvMap()}
}

// FilmStylesResponse 是 /api/film-styles 的结果。
type FilmStylesResponse struct {
	Styles     []filmstyle.Style `json:"styles"`
	Categories []string          `json:"categories"`
	Gallery    string            `json:"gallery"`
	// Posters 是海报是否可用：ready，或 missing（风格库还没由 am setup 准备好，附 PostersError）。
	Posters      string `json:"posters"`
	PostersError string `json:"posters_error,omitempty"`
}

// filmStylesAPI 列出风格目录（随二进制下发，不联网）。风格库是前置资源，Studio 不下载它：
// 没准备好时海报显示占位，并提示在终端运行 am setup。
func (s *Server) filmStylesAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	resp := FilmStylesResponse{Styles: filmstyle.Catalog(), Categories: filmstyle.Categories(), Gallery: filmStyleGallery, Posters: "ready"}
	if _, err := filmstyle.RequireLibrary(filmStyleOptions()); err != nil {
		resp.Posters, resp.PostersError = "missing", err.Error()
	}
	s.write(w, http.StatusOK, resp)
}

// filmStylePosterAPI 返回 /api/film-styles/{slug}/poster.jpg：风格库里有就给，没有 404，
// 网页显示占位块。
func (s *Server) filmStylePosterAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/film-styles/"), "/"), "/")
	if len(parts) != 2 || parts[1] != "poster.jpg" {
		s.error(w, http.StatusNotFound, "not_found", "没有这个资源")
		return
	}
	style, ok := filmstyle.Find(parts[0])
	if !ok || style.Slug != parts[0] {
		s.error(w, http.StatusNotFound, "unknown_film_style", "风格库里没有这种风格")
		return
	}
	lib, err := filmstyle.OpenLibrary(filmStyleOptions())
	if err != nil {
		s.error(w, http.StatusNotFound, "poster_unavailable", "风格海报还没有下载")
		return
	}
	path := filmstyle.PosterPath(lib, style.Slug)
	if _, err := os.Stat(path); err != nil {
		s.error(w, http.StatusNotFound, "poster_unavailable", "风格海报还没有下载")
		return
	}
	// 原图 1920×1080、合计 23 MB，菜单里一屏几十张会很卡：缩成 480 宽的缩略图，
	// 缓存在风格库旁边（与 commit 绑定，内容不会变）。缩不了就退回原图。
	if r.URL.Query().Get("size") != "full" {
		if thumb, err := posterThumbnail(lib.Dir, style.Slug, path); err == nil {
			path = thumb
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeFile(w, r, path)
}

// posterThumbWidth 是菜单缩略图的宽度。
const posterThumbWidth = 480

// posterThumbnail 返回海报缩略图路径，没有就生成：按面积平均缩小（box filter），只用标准库。
func posterThumbnail(libDir, slug, source string) (string, error) {
	dir := filepath.Join(libDir+".thumbs", strconv.Itoa(posterThumbWidth))
	target := filepath.Join(dir, slug+".jpg")
	if _, err := os.Stat(target); err == nil {
		return target, nil
	}
	file, err := os.Open(source)
	if err != nil {
		return "", err
	}
	defer file.Close()
	img, err := jpeg.Decode(file)
	if err != nil {
		return "", err
	}
	bounds := img.Bounds()
	if bounds.Dx() <= posterThumbWidth {
		return source, nil
	}
	width := posterThumbWidth
	height := bounds.Dy() * width / bounds.Dx()
	out := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		y0, y1 := bounds.Min.Y+y*bounds.Dy()/height, bounds.Min.Y+(y+1)*bounds.Dy()/height
		for x := 0; x < width; x++ {
			x0, x1 := bounds.Min.X+x*bounds.Dx()/width, bounds.Min.X+(x+1)*bounds.Dx()/width
			var r, g, b, n uint32
			for sy := y0; sy < y1; sy++ {
				for sx := x0; sx < x1; sx++ {
					cr, cg, cb, _ := img.At(sx, sy).RGBA()
					r, g, b, n = r+cr, g+cg, b+cb, n+1
				}
			}
			if n == 0 {
				continue
			}
			out.Set(x, y, color.RGBA{uint8(r / n >> 8), uint8(g / n >> 8), uint8(b / n >> 8), 255})
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, out, &jpeg.Options{Quality: 82}); err != nil {
		return "", err
	}
	if err := fsutil.AtomicWrite(target, buf.Bytes(), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// ProjectFilmStyle 是本项目的整片风格。
type ProjectFilmStyle struct {
	Installed bool                `json:"installed"`
	Manifest  *filmstyle.Manifest `json:"manifest,omitempty"`
	Style     *filmstyle.Style    `json:"style,omitempty"`
	// StyleFile 是 STYLE.md 在项目里的相对路径，网页经 /api/files 读。
	StyleFile string `json:"style_file,omitempty"`
}

// projectFilmStyleAPI：GET 查看本项目的整片风格；POST {"style","replace"} 装或换；DELETE 去掉。
func (s *Server) projectFilmStyleAPI(w http.ResponseWriter, r *http.Request) {
	p, ok := s.projectOr404(w)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		manifest, installed, err := filmstyle.Installed(p.Path)
		if err != nil {
			s.error(w, http.StatusInternalServerError, "film_style_unreadable", err.Error())
			return
		}
		resp := ProjectFilmStyle{Installed: installed}
		if installed {
			resp.Manifest = &manifest
			resp.StyleFile = filmstyle.SkillsSubdir + "/" + filmstyle.SkillName + "/STYLE.md"
			if style, found := filmstyle.Find(manifest.Slug); found {
				resp.Style = &style
			}
		}
		s.write(w, http.StatusOK, resp)
	case http.MethodPost:
		var req struct {
			Style   string `json:"style"`
			Replace bool   `json:"replace"`
			// Remove 为 true 时等同 DELETE：网页的按钮动作统一走 POST。
			Remove bool `json:"remove"`
		}
		if err := decodeJSON(r, &req); err != nil {
			s.error(w, http.StatusBadRequest, "invalid_json", "请求不是合法 JSON")
			return
		}
		if req.Remove {
			s.removeFilmStyle(w, p)
			return
		}
		style, err := filmstyle.Lookup(req.Style)
		if err != nil {
			s.error(w, http.StatusBadRequest, "unknown_film_style", err.Error())
			return
		}
		t, err := s.startFilmStyleTask(p, style, req.Replace)
		if err != nil {
			s.writeTaskError(w, err)
			return
		}
		s.write(w, http.StatusAccepted, map[string]any{"task_id": t.ID})
	case http.MethodDelete:
		s.removeFilmStyle(w, p)
	default:
		s.method(w, "GET, POST, DELETE")
	}
}

// startFilmStyleTask 起一个 am film-style use 写任务。
func (s *Server) startFilmStyleTask(p Project, style filmstyle.Style, replace bool) (*Task, error) {
	args := []string{"film-style", "use", style.Slug, "--project-root", p.Path}
	if replace {
		args = append(args, "--replace")
	}
	return s.runWriteTask(p, "film-style.use", "整片风格："+style.CN, func(ctx context.Context, t *Task) error {
		_, err := s.runStudioCLI(ctx, p, args...)
		return err
	})
}

func (s *Server) removeFilmStyle(w http.ResponseWriter, p Project) {
	t, err := s.runWriteTask(p, "film-style.remove", "去掉整片风格", func(ctx context.Context, t *Task) error {
		_, err := s.runStudioCLI(ctx, p, "film-style", "remove", "--project-root", p.Path)
		return err
	})
	if err != nil {
		s.writeTaskError(w, err)
		return
	}
	s.write(w, http.StatusAccepted, map[string]any{"task_id": t.ID})
}
