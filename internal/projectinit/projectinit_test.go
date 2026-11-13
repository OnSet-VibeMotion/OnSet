package projectinit

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chouheiwa/articale-to-motion/internal/preset"
)

func TestValidateRejectsConflictingModes(t *testing.T) {
	dir := t.TempDir()
	for _, bad := range []Options{
		{Target: dir, Delivery: "opera", Narration: NarrationSolo},
		{Target: dir, Delivery: DeliverySpeech, Narration: "choir"},
		{Target: dir, Delivery: DeliveryBeat, Narration: NarrationCast},
		{Target: dir, Delivery: DeliverySong, Narration: NarrationCast},
	} {
		if err := Validate(bad); err == nil {
			t.Errorf("%+v 应当报错", bad)
		}
	}
	if err := Validate(Options{Target: dir, Delivery: DeliverySpeech, Narration: NarrationCast}); err != nil {
		t.Fatal(err)
	}
}

// TestCreateWritesModeFiles：卡点写 beat.yaml、歌曲写 song.yaml、多角色写 cast.yaml 与 cast/。
func TestCreateWritesModeFiles(t *testing.T) {
	cases := map[string]struct {
		delivery, narration string
		want                []string
	}{
		"beat":   {DeliveryBeat, NarrationSolo, []string{"beat.yaml"}},
		"song":   {DeliverySong, NarrationSolo, []string{"song.yaml"}},
		"cast":   {DeliverySpeech, NarrationCast, []string{"cast.yaml", "cast"}},
		"speech": {DeliverySpeech, NarrationSolo, []string{"PROMPT-PRODUCTION.md", "frame.md"}},
	}
	for name, c := range cases {
		dir := filepath.Join(t.TempDir(), name)
		_, err := Create(Options{Target: dir, Canvas: preset.Default().ID, Style: preset.CustomStyle, Delivery: c.delivery, Narration: c.narration,
			Extra: map[string][]byte{"docs/note.md": []byte("x")}})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		for _, file := range append(c.want, "docs/note.md") {
			if _, err := os.Stat(filepath.Join(dir, file)); err != nil {
				t.Errorf("%s 缺 %s", name, file)
			}
		}
	}
	// 已有内容不同的 cast.yaml 不覆盖。
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "cast.yaml"), []byte("other"), 0o644)
	if err := WriteCastScaffold(dir); err == nil || !strings.Contains(err.Error(), "内容不同") {
		t.Fatalf("err=%v", err)
	}
	if SkillsInstalled(dir) {
		t.Fatal("没有来源记录不算装过")
	}
}
