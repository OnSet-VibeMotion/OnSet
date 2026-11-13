package studio

import (
	"net/http"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/ledger"
)

// TestChatTurnUsageIsRecordedAndSurvivesRevert：每轮对话的编排用量记进项目账本，
// 账本不算这一轮的改动，回退后账还在；镜头列表带项目合计。
func TestChatTurnUsageIsRecordedAndSurvivesRevert(t *testing.T) {
	f := newSessionFixture(t)
	status, body := studioRequest(t, http.MethodPost, f.url+"/api/sessions", `{"title":"记账"}`)
	requireStudioStatus(t, status, http.StatusCreated, body)
	id := body["session_id"].(string)
	status, body = studioRequest(t, http.MethodPost, f.url+"/api/sessions/"+id+"/turns", `{"message":"改一下"}`)
	requireStudioStatus(t, status, http.StatusAccepted, body)
	turnID := body["turn_id"].(string)
	detail := f.waitIdle(t, id)
	for _, change := range studioList(t, lastTurn(t, detail)["changes"]) {
		if path := change.(map[string]any)["path"].(string); path != "scenes/scene-001/prompt.md" {
			t.Fatalf("账本不能算进一轮的改动：%s", path)
		}
	}
	status, body = studioRequest(t, http.MethodPost, f.url+"/api/turns/"+turnID+"/revert", `{}`)
	requireStudioStatus(t, status, http.StatusOK, body)

	entries, err := ledger.Read(ledger.ProjectFile(f.root))
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries=%+v err=%v", entries, err)
	}
	e := entries[0]
	if e.Source != ledger.SourceStudio || e.Turn != turnID || e.Tool != "claude" || e.Model != "claude-fake" || e.Status != "succeeded" || e.Usage == nil || e.Usage.OutputTokens != 4 {
		t.Fatalf("entry=%+v", e)
	}

	status, body = studioRequest(t, http.MethodGet, f.url+"/api/scenes", "")
	requireStudioStatus(t, status, http.StatusOK, body)
	usage := body["usage"].(map[string]any)
	orchestrator := usage["orchestrator"].(map[string]any)
	total := usage["total"].(map[string]any)
	if orchestrator["calls"].(float64) != 1 || total["output_tokens"].(float64) != 4 || total["cost_usd"].(float64) != 0.01 {
		t.Fatalf("usage=%#v", usage)
	}
}
