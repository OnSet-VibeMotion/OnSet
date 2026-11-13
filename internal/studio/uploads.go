package studio

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

// 上传的文件放在 Studio 自己的状态目录里，不直接写进项目：Studio 不写项目文件，
// 文件该放到项目的哪里、要不要转格式，由编排工具在这一轮里决定，这样改动照常
// 进轮次快照、可以回退。production/studio 不进快照，上传本身不算任何一轮的改动。
const (
	uploadDir = "production/studio/uploads"
	// maxUploadBytes 是单个文件的上限：配音、配乐、参考视频都要能传。
	maxUploadBytes = 512 << 20
	maxUploadFiles = 10
)

// uploadsAPI 接收 multipart 表单里的 file 字段（可多个），存进 production/studio/uploads/，
// 返回可以直接附进下一条消息的附件。
func (s *Server) uploadsAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.method(w, http.MethodPost)
		return
	}
	p, ok := s.projectOr404(w)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadFiles*maxUploadBytes)
	reader, err := r.MultipartReader()
	if err != nil {
		s.error(w, http.StatusBadRequest, "invalid_upload", "需要 multipart/form-data")
		return
	}
	dir := filepath.Join(p.Path, filepath.FromSlash(uploadDir))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		s.error(w, http.StatusInternalServerError, "upload_failed", err.Error())
		return
	}
	var out []Attachment
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			s.error(w, http.StatusBadRequest, "invalid_upload", err.Error())
			return
		}
		if part.FormName() != "file" || part.FileName() == "" {
			part.Close()
			continue
		}
		if len(out) >= maxUploadFiles {
			part.Close()
			s.error(w, http.StatusBadRequest, "too_many_files", fmt.Sprintf("一次最多上传 %d 个文件", maxUploadFiles))
			return
		}
		original := filepath.Base(part.FileName())
		if strings.HasPrefix(original, ".env") {
			part.Close()
			s.error(w, http.StatusBadRequest, "forbidden_file", ".env 不能上传：凭据不进项目")
			return
		}
		name := time.Now().Format("20060102-150405") + "-" + newID("u")[2:8] + "-" + safeFileName(original)
		target := filepath.Join(dir, name)
		size, err := saveUpload(part, target)
		part.Close()
		if err != nil {
			_ = os.Remove(target)
			s.error(w, http.StatusBadRequest, "upload_failed", err.Error())
			return
		}
		out = append(out, Attachment{Path: uploadDir + "/" + name, Name: original, Size: size, Upload: true})
	}
	if len(out) == 0 {
		s.error(w, http.StatusBadRequest, "no_file", "没有收到文件")
		return
	}
	s.write(w, http.StatusCreated, map[string]any{"attachments": out})
}

func saveUpload(src io.Reader, target string) (int64, error) {
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	size, err := io.Copy(file, io.LimitReader(src, maxUploadBytes+1))
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return size, err
	}
	if size > maxUploadBytes {
		return size, fmt.Errorf("文件超过 %d MB", maxUploadBytes>>20)
	}
	if size == 0 {
		return 0, errors.New("文件是空的")
	}
	return size, nil
}

// safeFileName 保留中文与常见字符，去掉路径分隔符、控制字符和开头的点。
func safeFileName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r == '/' || r == '\\' || r == ':' || unicode.IsControl(r):
			b.WriteRune('_')
		case unicode.IsSpace(r):
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimLeft(b.String(), ".")
	if runes := []rune(out); len(runes) > 80 {
		ext := filepath.Ext(out)
		out = string(runes[:80-len([]rune(ext))]) + ext
	}
	if out == "" {
		out = "file"
	}
	return out
}

// uploadKind 按扩展名给编排工具一个提示：文章、图片、音频还是视频。
func uploadKind(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".md", ".txt", ".docx", ".pdf", ".html", ".srt", ".json":
		return "文档"
	case ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg":
		return "图片"
	case ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg":
		return "音频"
	case ".mp4", ".mov", ".webm", ".mkv":
		return "视频"
	case ".woff", ".woff2", ".ttf", ".otf":
		return "字体"
	}
	return "文件"
}
