import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Buffer, run, tempDir } from './testutil';
import * as assets from '@am/engine/assets';
import * as flow from '@am/engine/flow';
import { sortedKeys } from '@am/engine/gojson';
import * as preset from '@am/engine/preset';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import * as song from '@am/engine/song';
import { applySongCues, SongExplainerSkillName, songOutputsCurrent, songScaffold, verifySongInputs } from '@am/engine/plugins/song';

it('song init modes', async () => {
  for (const delivery of ['speech', 'song']) {
    const root = path.join(tempDir(), 'project');
    const out = new Buffer();
    const err = new Buffer();
    expect(await run(['init', root, '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', delivery], out, err), err.text).toBe(0);
    expect(fs.existsSync(path.join(root, 'song.yaml')), delivery).toBe(delivery === 'song');
  }
  const root = path.join(tempDir(), 'bad');
  expect(await run(['init', root, '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song', '--narration', 'cast']), 'cast song accepted').not.toBe(0);
  expect(fs.existsSync(root), 'partial scaffold').toBe(false);
});

describe('song cues and validation', () => {
  for (const canvas of ['vertical-3x4', 'vertical-9x16']) {
    it(canvas, async () => {
      const root = tempDir();
      const out = new Buffer();
      expect(await run(['init', root, '--canvas', canvas, '--style', preset.defaultStyle().id, '--skip-hyperframes', '--delivery', 'song'], out, out), out.text).toBe(0);
      const dir = path.join(root, song.Store, 'candidates', 'chosen');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'audio.mp3'), 'audio');
      fs.writeFileSync(path.join(dir, 'lyrics.txt'), '歌词\n歌词');
      const c = song.candidate({ id: 'chosen', state: 'ready', audio: 'audio.mp3', lyrics: 'lyrics.txt', duration_seconds: 3.01 });
      c.audio_sha256 = song.hashFile(path.join(dir, c.audio));
      c.lyrics_sha256 = song.hashFile(path.join(dir, c.lyrics));
      song.writeJSON(path.join(dir, 'candidate.json'), song.candidateToJSON(c));
      song.select(root, c.id);
      const tl = song.timeline({
        schema: 1,
        candidate_id: c.id,
        audio_sha256: c.audio_sha256,
        lyrics_sha256: c.lyrics_sha256,
        duration_seconds: c.duration_seconds,
        reviewed: true,
        lines: [song.line({ id: 'line-1', text: '歌词', start: 0.3, end: 1.8 }), song.line({ id: 'line-2', text: '歌词', start: 2.1, end: 2.8 })],
        beats: [0.3, 1, 2, 3],
      });
      song.saveTimeline(root, tl);
      const scenesRoot = path.join(root, 'scenes');
      [1.5, 46.0 / 30].forEach((duration, i) => {
        const id = `scene-${String(i + 1).padStart(3, '0')}`;
        const sd = path.join(scenesRoot, id);
        fs.mkdirSync(sd, { recursive: true });
        fs.writeFileSync(path.join(sd, 'transcript.srt'), '');
        fs.writeFileSync(path.join(sd, 'frame.md'), fs.readFileSync(path.join(root, 'frame.md')));
        song.writeJSON(path.join(sd, 'scene.json'), sortedKeys({ id, duration_seconds: duration, text: '歌词', output: 'out.mp4', transcript: 'transcript.srt', style_guide: 'frame.md' }));
      });
      applySongCues(root, scenesRoot, out);
      expect(await run(['validate', 'song', '--project-root', root], out, out), out.text).toBe(0);
      const scenes = schedule.plan(scenesRoot);
      const p = scene.buildPrompt(scenes[0], { [SongExplainerSkillName]: path.join(root, '.agents', 'skills') });
      expect(p).toContain('song-explainer');
      expect(p).toContain('不得生成或替换歌曲');
      const local = song.readTimeline(path.join(scenes[1].directory, 'song-cues.json'));
      expect(local.lines![0].start).toBe(0);
      expect(Math.abs(local.lines![0].end - 0.3)).toBeLessThanOrEqual(1e-6);
      const st = fs.statSync(path.join(scenes[0].directory, 'scene.json'), { bigint: true }).mtimeNs;
      applySongCues(root, scenesRoot, out);
      const st2 = fs.statSync(path.join(scenes[0].directory, 'scene.json'), { bigint: true }).mtimeNs;
      expect(st2, 'idempotent cues changed mtime').toBe(st);
      for (const item of scenes) fs.writeFileSync(scene.outputPath(item), 'render');
      expect(() => songOutputsCurrent(scenes, '')).not.toThrow();
      tl.lines![0].start = 0.4;
      song.saveTimeline(root, tl);
      expect(() => verifySongInputs(scenes[0]), 'stale song allowed').toThrow();
      expect(await run(['validate', 'song', '--project-root', root], out, out), 'stale validate').not.toBe(0);
      applySongCues(root, scenesRoot, out);
      const updated = schedule.plan(scenesRoot);
      expect(() => songOutputsCurrent(updated, ''), 'stale render accepted by concat guard').toThrow();
      // A coverage failure must not partially update any scene.
      const before = fs.readFileSync(path.join(scenes[0].directory, 'scene.json'));
      const last = { ...scenes[1], duration_seconds: 1 };
      song.writeJSON(path.join(last.directory, 'scene.json'), scene.sceneToJSON(last));
      expect(() => applySongCues(root, scenesRoot, out), 'missing outro').toThrow();
      const after = fs.readFileSync(path.join(scenes[0].directory, 'scene.json'));
      expect(after.equals(before), 'partial update').toBe(true);
    });
  }
});

it('song scaffold conflict does not overwrite, and switches the recorded flow', () => {
  const root = tempDir();
  flow.recordFlow(root, { id: 'speech', canvas: 'vertical-3x4' });
  const skill = path.join(root, '.agents', 'skills', 'song-explainer', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, 'custom skill');
  expect(() => songScaffold(root), 'must reject conflict').toThrow();
  expect(fs.existsSync(path.join(root, 'song.yaml')), 'partial config').toBe(false);
  expect(flow.flowRecord(root)?.id).toBe('speech');
  fs.rmSync(skill);
  songScaffold(root);
  // 流程只看记录：补了歌曲资产，记录换成歌曲讲解，画幅不变。
  expect(flow.flowRecord(root)).toEqual({ id: 'song', canvas: 'vertical-3x4' });
  expect(fs.existsSync(path.join(root, 'PROMPT-SONG.md')), '不再往项目里拷提示词').toBe(false);
  expect(() => songScaffold(root), 'idempotent').not.toThrow();
});


it('scene run-all: --song-timeline and --srt are mutually exclusive', async () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'scenes'), { recursive: true });
  const out = new Buffer();
  const code = await run(['scene', 'run-all', path.join(root, 'scenes'), '--srt', 'sub.srt', '--song-timeline', 'production/song/timeline.json'], out, out);
  expect(code).not.toBe(0);
  expect(out.text).toContain('互斥');
});

it('song prompt requires the web handoff pause', () => {
  const b = assets.files().readText('plugins/song/sections/main.md');
  for (const want of ['song_handoff()', 'song_receive(', 'waiting_for_audio', '此处必须暂停等待用户回复', '不轮询目录', '完整歌词和曲风', 'FINAL_LYRICS']) {
    expect(b, `song prompt missing ${want}`).toContain(want);
  }
});
