import { goRound } from '../gofmt';
import { localPath, Store, writeJSON } from './store';
import { frames, loadTimeline } from './timeline';

/**
 * exportPhrases bridges the song timeline to the existing visible-event review.
 * Confidence stays unknown: CTC success is not a measured singing accuracy score.
 */
export function exportPhrases(root: string, fps: number): void {
  if (fps <= 0) throw new Error('短语时间轴需要正整数 fps');
  const t = loadTimeline(root);
  const lines = t.lines ?? [];
  const phrases = lines.map((l, i) => ({
    phrase_id: l.id,
    subtitle_index: i + 1,
    source_text: l.text,
    semantic_order: i + 1,
    start_ms: goRound(l.start * 1000),
    end_ms: goRound(l.end * 1000),
    start_frame: Math.ceil(l.start * fps - 1e-9),
    end_frame_exclusive: Math.ceil(l.end * fps - 1e-9),
    alignment_source: t.source,
    confidence: null,
    reviewed: t.reviewed,
    visible_event_ids: [] as string[],
  }));
  // Go 的 map[string]any 按键排序输出。
  const body = {
    audio_sha256: t.audio_sha256,
    candidate_id: t.candidate_id,
    fps,
    lyrics_sha256: t.lyrics_sha256,
    phrases,
    schema: 1,
    total_frames: frames(t, fps),
  };
  for (const rel of [Store + '/phrase-timeline.json', 'production/phrase-timeline.json']) {
    writeJSON(localPath(root, rel), body);
  }
}
