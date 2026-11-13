package memory

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// EventRemember 是用户亲口说出、当场记下的偏好。
const EventRemember = "remember"

// PreferenceBrief 是交给编排工具的「用户偏好」段，以及它的摘要。
//
// 经验只注入渲染提示词，偏好还要给编排工具：用户随口一句「来个科普的」，
// 是编排工具在理解、在决定分镜和风格，渲染器只拿到已经展开的镜头说明。
// 段落里总带着「怎样记下新偏好」，记忆库是空的时候也一样——第一条偏好就是这样来的。
func (s *Store) PreferenceBrief(project string, pinned int) (string, string, error) {
	var prefs []Memory
	snapshot, ok, err := s.ResolveSnapshot(pinned)
	if err != nil {
		return "", "", err
	}
	if ok {
		all, err := snapshot.Memories()
		if err != nil {
			return "", "", err
		}
		for _, m := range all {
			if m.Kind == KindPreference && (m.Scope == "" || m.Scope == project) {
				prefs = append(prefs, m)
			}
		}
	}
	var b strings.Builder
	b.WriteString("用户偏好（来自 am 记忆库：用户以往亲口说过、或在反馈里表达过的长期取向）：\n")
	if len(prefs) == 0 {
		b.WriteString("（还没有记下任何偏好）\n")
	}
	for _, m := range prefs {
		scope := "全局"
		if m.Scope != "" {
			scope = "本项目"
		}
		fmt.Fprintf(&b, "- 【%s】（%s）%s\n", m.Name, scope, m.Description)
		if body := strings.TrimSpace(m.Body); body != "" && body != m.Description {
			for _, line := range strings.Split(body, "\n") {
				b.WriteString("  " + line + "\n")
			}
		}
	}
	var pending []Memory
	if all, _, err := s.Memories(); err == nil {
		for _, m := range all {
			if m.Kind == KindPreference && m.Status == StatusTrial && (m.Scope == "" || m.Scope == project) {
				pending = append(pending, m)
			}
		}
	}
	if len(pending) > 0 {
		b.WriteString("\n待确认的偏好（从用户以往的回退、反复提的要求和 👍 / 👎 里归纳的，还没生效）：\n")
		for _, m := range pending {
			fmt.Fprintf(&b, "- 【%s】%s\n", m.Name, m.Description)
		}
		b.WriteString("找合适的时机用一句话问用户认不认可；认可就运行 am memory promote <名字>，不认可运行 am memory reject <名字>。不要一次问完，也不要打断正在做的事。\n\n")
	}
	b.WriteString(`用户这次的话说得简短或含糊时，先按这些偏好补全意图再动手；这次明说的要求与偏好冲突时以这次为准，并问一句要不要更新偏好。

记住新偏好：用户表达了以后也适用的取向（如「以后都…」「我不喜欢…」「默认用…」「每次都要…」）时，当场运行
  am memory remember --name <小写英文短名> --description "<一句话概括>" "<完整说明>"
只对这个项目成立时照此写；对用户所有项目都成立时加 --global；替换一条旧偏好时加 --revises <旧名>。
用户收回一条偏好时运行 am memory retire <名字>。只记长期取向，不记这一次的具体修改要求。
`)
	text := b.String()
	sum := sha256.Sum256([]byte(text))
	return text, hex.EncodeToString(sum[:]), nil
}

// RememberInput 是一条当场记下的偏好。
type RememberInput struct {
	Name        string
	Description string
	Body        string
	// Project 是偏好所属的项目名；Global 为 true 时忽略。
	Project string
	Global  bool
	Revises string
}

// Remember 直接把用户亲口说的偏好记为生效并生成快照。
//
// 经人工 👎 整理出来的偏好要人确认才生效；这里不用——用户自己说出来的就是确认。
func (s *Store) Remember(in RememberInput) (Memory, Snapshot, error) {
	body := strings.TrimSpace(in.Body)
	if body == "" {
		return Memory{}, Snapshot{}, fmt.Errorf("偏好内容为空")
	}
	if !in.Global && in.Project == "" {
		return Memory{}, Snapshot{}, fmt.Errorf("当前目录不在项目里；对所有项目都成立的偏好请加 --global")
	}
	name := in.Name
	if name == "" {
		name = "pref-" + s.clock().UTC().Format("20060102-150405")
	}
	description := strings.TrimSpace(in.Description)
	if description == "" {
		description = firstSentence(body)
	}
	m := Memory{Kind: KindPreference, Body: body, Meta: Meta{Name: name, Description: description, Status: StatusActive,
		CheckedBy: []string{CheckerHuman}, Revises: in.Revises}}
	if !in.Global {
		m.Scope = in.Project
	}
	existing, _, err := s.Memories()
	if err != nil {
		return Memory{}, Snapshot{}, err
	}
	for _, other := range existing {
		if other.Name == name {
			return Memory{}, Snapshot{}, fmt.Errorf("记忆 %s 已存在；替换它请换个名字并加 --revises %s", name, name)
		}
	}
	if problems := Lint(m, LintContext{Existing: existing}); len(problems) > 0 {
		return Memory{}, Snapshot{}, fmt.Errorf("偏好不合格：\n  - %s", strings.Join(problems, "\n  - "))
	}
	if err := s.Write(m); err != nil {
		return Memory{}, Snapshot{}, err
	}
	if in.Revises != "" {
		if old, ok, err := s.Find(in.Revises); err != nil {
			return Memory{}, Snapshot{}, err
		} else if ok && old.Status == StatusActive {
			if err := s.setStatus(old, StatusDormant, "", ""); err != nil {
				return Memory{}, Snapshot{}, err
			}
		}
	}
	summary := fmt.Sprintf("记住偏好 %s：%s", name, description)
	snapshot, err := s.TakeSnapshot(EventRemember, summary, false)
	if err != nil {
		return Memory{}, Snapshot{}, err
	}
	return m, snapshot, s.Log(Event{Type: EventRemember, Snapshot: snapshot.ID, Summary: summary,
		Detail: map[string]any{"memory": name, "scope": m.Scope, "revises": in.Revises, "at": time.Now().UTC().Format(time.RFC3339)}})
}

func firstSentence(text string) string {
	line := strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	if i := strings.IndexAny(line, "。！？!?"); i > 0 {
		line = line[:i]
	}
	if utf8.RuneCountInString(line) > MaxDescriptionChars {
		line = string([]rune(line)[:MaxDescriptionChars-1]) + "…"
	}
	return line
}
