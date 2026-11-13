package memory

import (
	"path/filepath"
	"sync"
	"time"

	"github.com/chouheiwa/articale-to-motion/internal/tools"
)

// modelsFile 记录每个渲染工具最近一次实测到的模型。
//
// 召回发生在渲染器启动之前，而 claude 这类工具只在输出流里报模型名，
// 所以渲染前能拿到的「当前模型」只能是上一次实测到的那个；换了模型的
// 第一次渲染会按旧模型召回，渲染完立刻更新。
const modelsFile = "models.json"

type observedModel struct {
	Model  string `json:"model"`
	SeenAt string `json:"seen_at"`
}

var modelsMu sync.Mutex

// ObserveModel 记下渲染工具这次实测到的模型。
func (s *Store) ObserveModel(renderer, model string) error {
	if renderer == "" || model == "" {
		return nil
	}
	modelsMu.Lock()
	defer modelsMu.Unlock()
	path := filepath.Join(s.Dir, modelsFile)
	seen := map[string]observedModel{}
	_ = readJSON(path, &seen)
	if seen[renderer].Model == model {
		return nil
	}
	seen[renderer] = observedModel{Model: model, SeenAt: s.clock().UTC().Format(time.RFC3339)}
	return writeJSON(path, seen)
}

// CurrentModel 返回渲染工具当前的模型：工具配置文件声明的默认模型优先
// （codex 的 config.toml），否则取最近一次实测到的；都没有时返回空串。
func (s *Store) CurrentModel(renderer string, env map[string]string) string {
	if model := tools.ConfiguredModel(renderer, env); model != "" {
		return model
	}
	modelsMu.Lock()
	defer modelsMu.Unlock()
	seen := map[string]observedModel{}
	_ = readJSON(filepath.Join(s.Dir, modelsFile), &seen)
	return seen[renderer].Model
}
