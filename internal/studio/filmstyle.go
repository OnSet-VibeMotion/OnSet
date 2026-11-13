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
	// 风格来源在 init 里登记进 filmstyle；新增来源在这里加一行（cli 里同样一行）。
	_ "github.com/chouheiwa/articale-to-motion/internal/filmstyle/lemo"
	"github.com/chouheiwa/articale-to-motion/internal/fsutil"
)

// 整片风格（internal/filmstyle）在 Studio 里的入口：各风格来源的目录与海报、本项目的
// 整片风格、装 / 换 / 去掉。来源数据是前置资源（am setup 准备），这里只读不下载。
// 装与去掉经 am film-style 子命令完成，占项目写锁，与渲染、拼接同一条路：Studio 自己
// 不写项目文件。这里不点名任何来源，全部经 filmstyle.Sources() 取。

func (s *Server) filmStyleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/film-styles", s.filmStylesAPI)
	mux.HandleFunc("/api/film-styles/", s.filmStylePosterAPI)
	mux.HandleFunc("/api/film-style", s.projectFilmStyleAPI)
}

// FilmStyleSource 是 /api/film-styles 里的一个来源。
type FilmStyleSource struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Gallery    string   `json:"gallery,omitempty"`
	Categories []string `json:"categories"`
	// Ready 为 false 时来源数据还没由 am setup 准备好：海报显示占位，选了也装不上（附 Problem）。
	Ready   bool   `json:"ready"`
	Problem string `json:"problem,omitempty"`
}

// FilmStylesResponse 是 /api/film-styles 的结果。
type FilmStylesResponse struct {
	Sources []FilmStyleSource `json:"sources"`
	Styles  []filmstyle.Style `json:"styles"`
}

// filmStylesAPI 列出各来源的风格目录（随二进制下发，不联网）与来源数据是否就绪。
func (s *Server) filmStylesAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	env := envutil.EnvMap()
	resp := FilmStylesResponse{Styles: filmstyle.Catalog()}
	for _, source := range filmstyle.Sources() {
		item := FilmStyleSource{ID: source.ID(), Name: source.Name(), Gallery: source.Gallery(), Categories: filmstyle.Categories(source.ID()), Ready: true}
		if err := source.Check(env); err != nil {
			item.Ready, item.Problem = false, err.Error()
		}
		resp.Sources = append(resp.Sources, item)
	}
	s.write(w, http.StatusOK, resp)
}

// filmStylePosterAPI 返回 /api/film-styles/{来源}/{目录名}/poster.jpg：来源数据里有就给，
// 没有 404，网页显示占位块。
func (s *Server) filmStylePosterAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.method(w, http.MethodGet)
		return
	}
	parts := strings.Split(strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/film-styles/"), "/"), "/")
	if len(parts) != 3 || parts[2] != "poster.jpg" {
		s.error(w, http.StatusNotFound, "not_found", "没有这个资源")
		return
	}
	style, ok, _ := filmstyle.Find(parts[0] + "/" + parts[1])
	if !ok || style.Source != parts[0] || style.Slug != parts[1] {
		s.error(w, http.StatusNotFound, "unknown_film_style", "没有这种风格")
		return
	}
	source, _ := filmstyle.SourceByID(style.Source)
	env := envutil.EnvMap()
	path, err := source.Poster(env, style.Slug)
	if err != nil {
		s.error(w, http.StatusNotFound, "poster_unavailable", "风格海报还没有准备好（am setup）")
		return
	}
	// 原图常是 1920×1080，菜单里一屏几十张会很卡：缩成 480 宽的缩略图，缓存在
	// <风格根目录>/.thumbs/<来源>/ 下，原图比缩略图新时重做。缩不了就退回原图。
	if r.URL.Query().Get("size") != "full" {
		cache := filepath.Join(filmstyle.RootDir(env), ".thumbs", style.Source, strconv.Itoa(posterThumbWidth))
		if thumb, err := posterThumbnail(cache, style.Slug, path); err == nil {
			path = thumb
		}
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Content-Type", "image/jpeg")
	http.ServeFile(w, r, path)
}

// posterThumbWidth 是菜单缩略图的宽度。
const posterThumbWidth = 480

// posterThumbnail 返回海报缩略图路径，没有就生成：按面积平均缩小（box filter），只用标准库。
func posterThumbnail(dir, slug, source string) (string, error) {
	target := filepath.Join(dir, slug+".jpg")
	if thumb, err := os.Stat(target); err == nil {
		if original, err := os.Stat(source); err == nil && !original.ModTime().After(thumb.ModTime()) {
			return target, nil
		}
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
			if rel, err := filepath.Rel(p.Path, filmstyle.InstalledDir(p.Path)); err == nil {
				resp.StyleFile = filepath.ToSlash(filepath.Join(rel, filmstyle.StyleFile))
			}
			if style, found, _ := filmstyle.Find(manifest.Key()); found {
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
	args := []string{"film-style", "use", style.Key(), "--project-root", p.Path}
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
