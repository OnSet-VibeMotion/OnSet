// 移植自 internal/song/song_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DefaultConfig, hashFile, loadConfig, select, selected, Store, writeJSON } from './store';
import { loadTimeline, problems, saveTimeline, slice, frames } from './timeline';
import { candidate, candidateToJSON, line, timeline, word } from './types';
import { cleanupTemps, tempDir } from './testsupport';

afterEach(cleanupTemps);

describe('song store', () => {
  it('selection and timeline lifecycle', () => {
    const root = tempDir();
    expect(() => selected(root), 'selection required').toThrow();
    fs.writeFileSync(path.join(root, 'song.yaml'), DefaultConfig);
    const dir = path.join(root, Store, 'candidates', 'first');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'audio.mp3'), 'audio');
    fs.writeFileSync(path.join(dir, 'lyrics.txt'), '同一句\n同一句\n');
    const c = candidate({ id: 'first', audio: 'audio.mp3', lyrics: 'lyrics.txt', duration_seconds: 10, state: 'ready' });
    c.audio_sha256 = hashFile(path.join(dir, c.audio));
    c.lyrics_sha256 = hashFile(path.join(dir, c.lyrics));
    writeJSON(path.join(dir, 'candidate.json'), candidateToJSON(c));
    expect(() => select(root, '../first'), 'unsafe id').toThrow();
    select(root, 'first');
    const tl = timeline({
      schema: 1,
      candidate_id: c.id,
      audio_sha256: c.audio_sha256,
      lyrics_sha256: c.lyrics_sha256,
      duration_seconds: 10,
      lines: [line({ id: 'l1', text: '同一句', start: 1, end: 3 }), line({ id: 'l2', text: '同一句', start: 6, end: 9 })],
    });
    expect(problems(tl)).toEqual([]);
    saveTimeline(root, tl);
    loadTimeline(root);
    fs.writeFileSync(path.join(dir, c.audio), 'changed');
    expect(() => loadTimeline(root), 'modified selection accepted').toThrow();
  });

  it('timeline problems', () => {
    const tl = timeline({
      schema: 1,
      duration_seconds: 10,
      lines: [line({ id: 'a', text: '词', start: 2, end: 4 }), line({ id: 'a', text: '词', start: 3, end: 12 })],
      beats: [4, 2],
    });
    expect(problems(tl).length).toBeGreaterThanOrEqual(3);
  });

  it('slice and frames', () => {
    const tl = timeline({
      duration_seconds: 10.01,
      lines: [line({ id: 'repeat-2', text: '再唱', start: 3, end: 7, words: [word({ text: '唱', start: 5, end: 7 })] })],
      beats: [3, 4, 6],
    });
    const c = slice(tl, 4, 2);
    expect(c.lines!.length).toBe(1);
    expect(c.lines![0].start).toBe(0);
    expect(c.lines![0].end).toBe(2);
    expect(c.lines![0].words![0].start).toBe(1);
    expect(c.beats).toEqual([0]);
    expect(frames(tl, 30)).toBe(301);
  });

  it('config strict', () => {
    const root = tempDir();
    for (const body of ['provider: other\n', DefaultConfig + 'api_key: secret\n']) {
      fs.writeFileSync(path.join(root, 'song.yaml'), body);
      expect(() => loadConfig(root), body).toThrow();
    }
    fs.writeFileSync(path.join(root, 'song.yaml'), DefaultConfig);
    expect(loadConfig(root).model).toContain('3.0');
    fs.writeFileSync(path.join(root, 'cast.yaml'), '{}');
    expect(() => loadConfig(root), 'cast+song').toThrow();
  });
});
