package align

import (
	"sort"
	"strings"
)

// ViewBlock 是终稿给人看的一块：标题或一段正文。
type ViewBlock struct {
	// Kind 为 heading 或 para。
	Kind  string     `json:"kind"`
	Level int        `json:"level,omitempty"`
	Text  string     `json:"text,omitempty"`
	Nodes []ViewNode `json:"nodes,omitempty"`
}

// ViewNode 是正文里的一段：
//
//	text    普通文字（显示即朗读）
//	alt     <显示|朗读>，Text 是显示侧，Spoken 是朗读侧；两侧之一可以为空
//	phrase  受保护短语 @{ID}…@{/ID}，内容在 Children 里，可以嵌套
type ViewNode struct {
	Kind     string     `json:"kind"`
	Text     string     `json:"text,omitempty"`
	Spoken   string     `json:"spoken,omitempty"`
	ID       string     `json:"id,omitempty"`
	Children []ViewNode `json:"children,omitempty"`
}

// ViewStats 是终稿的规模：朗读单元数（一个汉字、一个英文词或一个数算一个）、
// 段数与受保护短语数。
type ViewStats struct {
	Units      int `json:"units"`
	Paragraphs int `json:"paragraphs"`
	Phrases    int `json:"phrases"`
}

// View 把解析后的终稿整理成给人读的结构：保留标题与分段，标记原样标出，不丢任何
// 一处显示与朗读的差别。短语跨段时在每段里各标一次。
func (s *Script) View() ([]ViewBlock, ViewStats) {
	stats := ViewStats{Units: len(s.Tokens), Phrases: len(s.Phrases)}
	var blocks []ViewBlock
	nextHeading := 0
	flushHeadings := func(upTo int) {
		for nextHeading < len(s.headings) && s.headings[nextHeading].atPiece <= upTo {
			h := s.headings[nextHeading]
			blocks = append(blocks, ViewBlock{Kind: "heading", Level: h.level, Text: h.text})
			nextHeading++
		}
	}
	for start := 0; start < len(s.pieces); {
		end := start
		for end < len(s.pieces) && s.pieces[end].para == s.pieces[start].para {
			end++
		}
		flushHeadings(start)
		blocks = append(blocks, ViewBlock{Kind: "para", Nodes: s.viewNodes(start, end)})
		stats.Paragraphs++
		start = end
	}
	flushHeadings(len(s.pieces))
	return blocks, stats
}

// viewNodes 把 piece 区间 [from, to) 排成节点树。短语按嵌套关系开合，越过区间边界的截断。
func (s *Script) viewNodes(from, to int) []ViewNode {
	var spans []PhraseSpan
	for _, p := range s.Phrases {
		if p.startPiece < to && p.endPiece > from {
			spans = append(spans, p)
		}
	}
	// 外层在前：开始早的在前，同一处开始的结束晚的在前。
	sort.SliceStable(spans, func(i, j int) bool {
		a, b := spans[i], spans[j]
		if max(a.startPiece, from) != max(b.startPiece, from) {
			return max(a.startPiece, from) < max(b.startPiece, from)
		}
		return a.endPiece > b.endPiece
	})

	type frame struct {
		node *ViewNode
		end  int
	}
	root := &ViewNode{}
	stack := []frame{{node: root, end: to}}
	next := 0
	appendText := func(parent *ViewNode, text string) {
		if text == "" {
			return
		}
		if n := len(parent.Children); n > 0 && parent.Children[n-1].Kind == "text" {
			parent.Children[n-1].Text += text
			return
		}
		parent.Children = append(parent.Children, ViewNode{Kind: "text", Text: text})
	}
	closeTop := func() {
		top := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		parent := stack[len(stack)-1].node
		parent.Children = append(parent.Children, *top.node)
	}
	for p := from; p < to; p++ {
		for len(stack) > 1 && stack[len(stack)-1].end <= p {
			closeTop()
		}
		for next < len(spans) && max(spans[next].startPiece, from) == p {
			stack = append(stack, frame{node: &ViewNode{Kind: "phrase", ID: spans[next].ID}, end: spans[next].endPiece})
			next++
		}
		parent := stack[len(stack)-1].node
		piece := s.pieces[p]
		switch {
		case piece.softBreak:
			appendText(parent, piece.display)
		case piece.plain:
			appendText(parent, piece.display)
		default:
			parent.Children = append(parent.Children, ViewNode{Kind: "alt", Text: piece.display, Spoken: piece.spoken})
		}
	}
	for len(stack) > 1 {
		closeTop()
	}
	nodes := root.Children
	// 段首段尾的空白不显示。
	if n := len(nodes); n > 0 && nodes[0].Kind == "text" {
		nodes[0].Text = strings.TrimLeft(nodes[0].Text, " \t　")
	}
	if n := len(nodes); n > 0 && nodes[n-1].Kind == "text" {
		nodes[n-1].Text = strings.TrimRight(nodes[n-1].Text, " \t　")
	}
	return nodes
}
