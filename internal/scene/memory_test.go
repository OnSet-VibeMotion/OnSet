package scene

import (
	"errors"
	"os"
	"strings"
	"testing"
)

// TestVerificationChecksAlignWithProblems：渲染记忆按 Checks 聚类失败，
// Checks 与 Problems 必须一一对应，且产物校验的每条文字都能归到具体校验器——
// 落进 output.other 说明 mediaprobe 改了措辞而这里没跟上。
func TestVerificationChecksAlignWithProblems(t *testing.T) {
	dir := writeScene(t, `{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}`)
	s, _ := Load(dir)
	bin := t.TempDir()
	fakeFfprobe(t, bin, probeReply{widthPx: 720, heightPx: 1280, fpsNum: 25, duration: "9.000", audio: true})
	os.WriteFile(s.OutputPath(), []byte("video"), 0o644)
	os.WriteFile(dir+"/index.html", []byte("<script>requestAnimationFrame(() => {})</script>"), 0o644)
	err := VerifyOutput(s, map[string]string{"PATH": bin, "HOME": t.TempDir()}, 0.15)
	var verification *VerificationError
	if !errors.As(err, &verification) {
		t.Fatalf("应当是 *VerificationError：%v", err)
	}
	if len(verification.Checks) != len(verification.Problems) {
		t.Fatalf("Checks %v 与 Problems %v 不等长", verification.Checks, verification.Problems)
	}
	want := map[string]bool{CheckOutputResolution: true, CheckOutputFPS: true, CheckOutputDuration: true,
		CheckOutputFrames: true, CheckOutputAudio: true, DeterminismCheckPrefix + "raf": true}
	for i, check := range verification.Checks {
		if check == CheckOutputOther {
			t.Errorf("问题没能归到具体校验器：%s", verification.Problems[i])
		}
		delete(want, check)
	}
	if len(want) > 0 {
		t.Errorf("缺少校验器：%v（实际 %v）", want, verification.Checks)
	}
}

// TestMemoryRecallEntersPromptAndFingerprint：召回段在确定性段之后注入，
// 指纹单列 memory 一项；没有召回时提示词与指纹与引入记忆之前完全一致。
func TestMemoryRecallEntersPromptAndFingerprint(t *testing.T) {
	dir := writeScene(t, `{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}`)
	s, _ := Load(dir)
	plain, err := BuildPrompt(s, nil)
	if err != nil {
		t.Fatal(err)
	}
	base, err := Fingerprint(s, "claude", nil)
	if err != nil {
		t.Fatal(err)
	}
	s.Memory = &MemoryRecall{}
	if empty, _ := BuildPrompt(s, nil); empty != plain {
		t.Error("没有召回条目时提示词不该变化")
	}
	if fp, _ := Fingerprint(s, "claude", nil); fp.Fingerprint != base.Fingerprint {
		t.Error("没有召回条目时指纹不该变化：打开记忆会让老镜头全部 Stale")
	}
	s.Memory = &MemoryRecall{Snapshot: 3, Names: []string{"font-local-block"}, Section: "\n记忆（召回）：\n- 【font-local-block】字体用本地文件\n", Digest: "abc"}
	prompt, _ := BuildPrompt(s, nil)
	section := strings.Index(prompt, "【font-local-block】")
	if section < 0 || section < strings.Index(prompt, "确定性（强制") {
		t.Fatalf("召回段应当出现在确定性段之后：\n%s", prompt)
	}
	fp, _ := Fingerprint(s, "claude", nil)
	if fp.Parts["memory"] != "abc" {
		t.Errorf("指纹应当单列 memory 项：%v", fp.Parts)
	}
	changed := fp.Changed(base)
	if !strings.Contains(strings.Join(changed, ","), "memory") {
		t.Errorf("Changed 应当点名 memory：%v", changed)
	}
	s.AfterAttempt = func(Attempt) {}
	if again, _ := Fingerprint(s, "claude", nil); again.Fingerprint != fp.Fingerprint {
		t.Error("AfterAttempt 不是输入，不该影响指纹")
	}
}
