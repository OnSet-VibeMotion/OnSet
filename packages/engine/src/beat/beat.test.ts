import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { audioStream, videoStream, type Media as ProbedMedia } from '../mediaprobe';
import { lastLine } from './analyze';
import { confirm, gridBars, gridProblems, loadGrid, newGrid, normalizeGrid, readDraft, regrid, summarize, totalFrames, type Grid } from './grid';
import { layout, type Plan, type Segment } from './plan';
import { sliceGrid } from './cue';
import { ConfigFile, DefaultConfig, DraftFile, Store, loadConfig } from './store';
import { importTrack, loadTrack } from './track';
import { writeDraftAndClick } from './analyze';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-beat-'));

/**
 * fourFour 是 120 BPM、4/4、弱起 0.5 秒的网格：第一个重拍在 0.5 秒，
 * 共 n 小节，音乐在最后一小节结束后再响 tail 秒。
 */
function fourFour(bars: number, tail: number): Grid {
  const g = newGrid({ schema: 1, source: 'test' });
  const beats: number[] = [0.0]; // 弱起拍
  const downbeats: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (let beat = 0; beat < 4; beat++) {
      const at = 0.5 + (bar * 4 + beat) * 0.5;
      beats.push(at);
      if (beat === 0) downbeats.push(at);
    }
  }
  g.beats = beats;
  g.downbeats = downbeats;
  g.duration_seconds = 0.5 + bars * 2 + tail;
  return g;
}

const clone = (g: Grid): Grid => ({ ...g, beats: g.beats && [...g.beats], downbeats: g.downbeats && [...g.downbeats] });

describe('grid', () => {
  it('reports grid problems', () => {
    expect(gridProblems(fourFour(4, 0.3))).toEqual([]);
    const off = fourFour(4, 0.3);
    off.downbeats![1] += 0.25;
    const p = gridProblems(off);
    expect(p.length === 1 && p[0].includes('没有落在任何普通拍上'), `重拍不在拍上应报错：${p}`).toBe(true);
    const unsorted = fourFour(4, 0.3);
    [unsorted.beats![3], unsorted.beats![4]] = [unsorted.beats![4], unsorted.beats![3]];
    const q = gridProblems(unsorted);
    expect(q.length > 0 && q[0].includes('beats'), `倒序应报错：${q}`).toBe(true);
    expect(gridProblems(fourFour(1, 0.3)).length, '只有一个重拍无法切分，应报错').toBeGreaterThan(0);
  });

  // 手改网格留下的毫秒级尾数在确认时对齐到普通拍。
  it('normalize snaps downbeats to beats', () => {
    const g = fourFour(3, 0);
    g.downbeats![1] += 0.0015;
    expect(normalizeGrid(g).downbeats![1]).toBe(g.beats![5]);
  });

  it('summarizes and cuts bars', () => {
    const g = fourFour(6, 1.0);
    const s = summarize(g);
    expect(s.bars === 6 && s.meters.get(4) === 5 && s.pickupSeconds === 0.5 && s.bpm >= 119.9 && s.bpm <= 120.1, `概况不符：${JSON.stringify(s)}`).toBe(true);
    const bars = gridBars(g);
    expect(bars[0].number).toBe(1);
    expect(bars[0].start_seconds).toBe(0.5);
    expect(bars[0].end_seconds).toBe(2.5);
    expect(bars[5].end_seconds).toBe(g.duration_seconds);
  });

  it('regrid shifts downbeats only', () => {
    const g = fourFour(4, 0);
    g.reviewed = true;
    const shifted = regrid(g, 4, 2);
    expect(shifted.reviewed).toBe(false);
    expect(shifted.beats!.length).toBe(g.beats!.length);
    expect(shifted.downbeats![0]).toBe(g.beats![2]);
    expect(shifted.downbeats![1]).toBe(g.beats![6]);
    expect(() => regrid(g, 3, 3), 'anchor 不小于 meter 应报错').toThrow();
    expect(() => regrid(g, 0, 0), 'meter 为 0 应报错').toThrow();
  });

  it('layout cuts on downbeat frames', () => {
    const g = fourFour(5, 0.4);
    const plan: Plan = { schema: 1, scenes: [{ id: 'a', bars: 2 }, { id: 'b', bars: 1 }, { id: 'c', bars: 2 }] };
    const segments = layout(g, plan, 30);
    // 弱起并进第一个镜头；切点在第 3、4 小节的重拍（4.5 秒、6.5 秒）。
    const want: Segment[] = [
      { id: 'a', firstBar: 1, bars: 2, startFrame: 0, frames: 135 },
      { id: 'b', firstBar: 3, bars: 1, startFrame: 135, frames: 60 },
      { id: 'c', firstBar: 4, bars: 2, startFrame: 195, frames: totalFrames(g.duration_seconds, 30) - 195 },
    ];
    expect(segments).toEqual(want);
    const bad: Plan[] = [
      { schema: 1, scenes: [{ id: 'a', bars: 2 }, { id: 'b', bars: 2 }] },
      { schema: 1, scenes: [{ id: 'a', bars: 3 }, { id: 'a', bars: 2 }] },
      { schema: 1, scenes: [{ id: 'a', bars: 5 }, { id: 'b', bars: 0 }] },
      { schema: 2, scenes: [{ id: 'a', bars: 5 }] },
    ];
    for (const plan of bad) expect(() => layout(g, plan, 30), `应拒绝计划 ${JSON.stringify(plan)}`).toThrow();
  });

  it('slice numbers bars and beats', () => {
    const g = fourFour(3, 0);
    const local = sliceGrid(g, { id: 'a', firstBar: 1, bars: 1, startFrame: 0, frames: 75 }, 30);
    // 弱起拍（第 0 小节）+ 第 1 小节 4 拍；第 2 小节的重拍在第 75 帧，不属于本镜头。
    expect(local.beats.length).toBe(5);
    const first = local.beats[0];
    expect(first.bar === 0 && first.beat === 1 && !first.downbeat, `弱起拍应记为第 0 小节：${JSON.stringify(first)}`).toBe(true);
    const down = local.beats[1];
    expect(down.bar === 1 && down.beat === 1 && down.downbeat && down.frame === 15, `重拍不符：${JSON.stringify(down)}`).toBe(true);
    const second = sliceGrid(g, { id: 'b', firstBar: 2, bars: 1, startFrame: 75, frames: 60 }, 30);
    const hit = second.beats[0];
    expect(hit.frame === 0 && hit.bar === 2 && hit.downbeat && hit.seconds === 0, `局部帧号应从镜头起点算：${JSON.stringify(hit)}`).toBe(true);
  });
});

class FakeMedia {
  decodes = 0;
  clicks: number[][] = [];
  constructor(readonly media: ProbedMedia = audioOnly(0)) {}
  probe(): ProbedMedia {
    return this.media;
  }
  decode(): void {
    this.decodes++;
  }
  async decodeAnalysisWAV(): Promise<void> {}
  async clickTrack(_music: string, dest: string, beats: number[]): Promise<void> {
    this.clicks.push(beats);
    fs.writeFileSync(dest, 'wav');
  }
}

function audioOnly(seconds: number): ProbedMedia {
  return { path: '', duration_seconds: seconds, video: null, audio: audioStream({ duration_seconds: seconds }) };
}

function newProject(): string {
  const root = tempDir();
  fs.writeFileSync(path.join(root, ConfigFile), DefaultConfig);
  return root;
}

function writeMusic(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('track', () => {
  it('import binds audio and refuses silent replace', () => {
    const root = newProject();
    const media = new FakeMedia(audioOnly(10.5));
    const first = writeMusic(tempDir(), 'Song.MP3', 'first');
    const track = importTrack(root, first, media, false);
    expect(track.audio).toBe('music-' + track.audio_sha256.slice(0, 12) + '.mp3');
    expect(track.duration_seconds).toBe(10.5);
    expect(track.source).toBe('Song.MP3');
    expect(media.decodes).toBe(1);
    expect(importTrack(root, first, media, false), '同一首重复导入应幂等').toEqual(track);
    const second = writeMusic(tempDir(), 'other.wav', 'second');
    expect(() => importTrack(root, second, media, false), '换歌应要求 --replace').toThrow('--replace');
    const replaced = importTrack(root, second, media, true);
    expect(path.extname(replaced.audio)).toBe('.wav');
    expect(fs.existsSync(path.join(root, Store, track.audio)), '替换后旧音乐应被删除').toBe(false);
    // 音乐被外部改动后，记录与文件对不上。
    fs.writeFileSync(path.join(root, Store, replaced.audio), 'tampered');
    expect(() => loadTrack(root), '音乐被改动应报错').toThrow();
  });

  it('import rejects video and unknown formats', () => {
    const root = newProject();
    const video = new FakeMedia({ path: '', duration_seconds: 3, audio: audioStream(), video: videoStream() });
    expect(() => importTrack(root, writeMusic(tempDir(), 'a.mp3', 'x'), video, false), '带视频流的文件应拒绝').toThrow();
    expect(() => importTrack(root, writeMusic(tempDir(), 'a.txt', 'x'), new FakeMedia(audioOnly(3)), false), '未知格式应拒绝').toThrow();
  });

  it('config rejects coexisting modes', () => {
    const root = newProject();
    fs.writeFileSync(path.join(root, 'song.yaml'), 'schema: 1\n');
    expect(() => loadConfig(root), '与歌曲模式共存应报错').toThrow('song.yaml');
    const other = tempDir();
    fs.writeFileSync(path.join(other, ConfigFile), 'schema: 1\ncheckpoint: huge\npython: python3\n');
    expect(() => loadConfig(other), '未知模型应报错').toThrow();
  });
});

function importedProject(g: Grid): [string, Grid] {
  const root = newProject();
  const track = importTrack(root, writeMusic(tempDir(), 'm.wav', 'music'), new FakeMedia(audioOnly(g.duration_seconds)), false);
  return [root, { ...g, audio_sha256: track.audio_sha256 }];
}

describe('confirm', () => {
  it('is the only way to a reviewed grid', async () => {
    const [root, g] = importedProject(fourFour(4, 0.2));
    const media = new FakeMedia();
    await writeDraftAndClick(root, g, media);
    expect(media.clicks.length, '写草稿时应同时生成试听轨').toBe(1);
    expect(() => loadGrid(root), '只有草稿时不应读到正式网格').toThrow();
    const draft = readDraft(path.join(root, DraftFile));
    expect(draft.reviewed, '草稿必须是未确认状态').toBe(false);
    confirm(root, draft);
    const loaded = loadGrid(root);
    expect(loaded.reviewed, '确认后应能读到正式网格').toBe(true);
    const foreign = { ...clone(draft), audio_sha256: 'other' };
    expect(() => confirm(root, foreign), '属于另一首音乐的网格不能确认').toThrow();
    const broken = clone(draft);
    broken.downbeats = broken.downbeats!.slice(0, 1);
    expect(() => confirm(root, broken), '不合格网格不能确认').toThrow();
  });

  it('lastLine skips progress noise', () => {
    expect(lastLine('0.1%\r50%\r100%\nTraceback\nValueError: bad\n\n')).toBe('ValueError: bad');
  });
});
