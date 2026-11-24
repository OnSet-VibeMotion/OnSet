/**
 * 歌曲讲解的项目骨架初始化、镜头覆盖校验、局部 cue 写入与产物新鲜度检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as assets from '../../assets';
import { flowRecord, recordFlow } from '../../flow/lock';
import { atomicWrite } from '../../fsutil';
import { goPathError } from '../../gofmt';
import { marshal, marshalIndent } from '../../gojson';
import * as project from '../../project';
import { decodeRawMap, encodeRawMapIndent } from '../../rawjson';
import type { Scene } from '../../scene';
import * as scene from '../../scene';
import * as schedule from '../../schedule';
import * as song from '../../song';
import { verifySongInputs } from './block';

type Out = { write(text: string): void };

export function songScaffold(root: string): void {
  if (fs.existsSync(path.join(root, 'cast.yaml'))) throw new Error('首版不支持 song + cast');
  const extra: Record<string, Uint8Array> = {
    'song.yaml': Buffer.from(song.DefaultConfig),
  };
  const shared = assets.shared();
  const files = shared.walkFiles();
  for (const prefix of ['.agents/skills/song-explainer']) {
    const matched = files.filter((file) => file === prefix || file.startsWith(prefix + '/'));
    if (matched.length === 0) throw new Error(`open ${prefix}: file does not exist`);
    for (const file of matched) extra[file] = shared.readFile(file);
  }
  project.initializeWithFiles(root, extra);
  // 项目用哪个流程只看锁文件的记录：补了歌曲资产就把记录换成歌曲讲解（画幅不变），制作提示词随之按歌曲讲解组合。
  const rec = flowRecord(root);
  if (rec && rec.id !== 'song') recordFlow(root, { ...rec, id: 'song' });
}

/** Go 的 %v 打印 []string：[a b c]。 */
export function formatList(list: readonly string[]): string {
  return '[' + list.join(' ') + ']';
}

export function songCoverage(root: string, scenes: readonly Scene[], t: song.Timeline, requireCues: boolean): void {
  const canvas = scene.canvasOf(root, 'frame.md');
  if (!t.reviewed)
    throw new Error('歌曲时间轴尚未人工复核；使用 song_prepare({"timeline": "<文件>", "reviewed": true})');
  const target = song.frames(t, canvas.fps) / canvas.fps;
  const p = schedule.coverageProblems(scenes, target, 1e-6);
  if (p.length > 0) throw new Error(`歌曲需从零覆盖前奏至尾奏：${formatList(p)}`);
  let cursor = 0;
  for (const s of scenes) {
    if (s.cast !== null) throw new Error('首版不支持 song + cast');
    scene.verifyFrameAlignment(s);
    if (requireCues) {
      if (s.song === null || s.song.fps !== canvas.fps || Math.abs(s.song.start_seconds - cursor) > 1e-6) {
        throw new Error(`镜头 ${s.id} 歌曲起点不一致，请运行 song_cues()`);
      }
      const targetPath = path.resolve(path.join(root, song.Store, 'timeline.json'));
      const cuePath = path.resolve(path.join(s.directory, s.song.timeline));
      if (targetPath !== cuePath) throw new Error(`镜头 ${s.id} 引用了其他项目歌曲`);
      song.verifyCue(s.directory, s.song, s.duration_seconds);
    }
    cursor += s.duration_seconds;
  }
}

/** 写出 MarshalIndent 加换行的原文；内容不变时不碰文件（与 song.WriteJSON 相同）。 */
function writeText(file: string, text: string): void {
  const b = Buffer.from(text);
  try {
    if (fs.readFileSync(file).equals(b)) return;
  } catch {
    // 不存在或读不了：照常写。
  }
  atomicWrite(file, b, 0o644);
}

export function applySongCues(root: string, scenesRoot: string, out: Out): void {
  const t = song.loadTimeline(root);
  const scenes = schedule.plan(scenesRoot);
  songCoverage(root, scenes, t, false);
  const timeline = path.resolve(path.join(root, song.Store, 'timeline.json'));
  const sha = song.hashFile(timeline);
  const canvas = scene.canvasOf(root, 'frame.md');
  const updates: { path: string; body: string }[] = [];
  let cursor = 0;
  for (const s of scenes) {
    const dir = path.resolve(s.directory);
    const rel = path.relative(dir, timeline);
    const data = song.slice(t, cursor, s.duration_seconds);
    const encoded = marshalIndent(song.timelineToJSON(data)) + '\n';
    // Compute the exact file digest before mutating any scene.
    const dataSHA = song.bytesHash(encoded);
    const cue: song.Cue = {
      fps: canvas.fps,
      timeline: rel,
      sha256: sha,
      start_seconds: cursor,
      data: 'song-cues.json',
      data_sha256: dataSHA,
    };
    const sceneFile = song.localPath(dir, 'scene.json');
    const cueFile = song.localPath(dir, cue.data);
    let raw: string;
    try {
      raw = fs.readFileSync(sceneFile, 'utf8');
    } catch (err) {
      throw new Error(goPathError('open', sceneFile, err), { cause: err });
    }
    const fields = decodeRawMap(raw);
    fields.set('song', marshal(song.cueToJSON(cue)));
    updates.push({ path: cueFile, body: encoded }, { path: sceneFile, body: encodeRawMapIndent(fields) + '\n' });
    cursor += s.duration_seconds;
  }
  for (const u of updates) writeText(u.path, u.body);
  out.write(`已更新 ${scenes.length} 个镜头的歌曲依赖\n`);
}

function statNs(file: string): bigint {
  try {
    return fs.statSync(file, { bigint: true }).mtimeNs;
  } catch (err) {
    throw new Error(goPathError('stat', file, err), { cause: err });
  }
}

/**
 * Reject stale song renders even if callers bypass run-all and go straight to
 * concat/mux. The existing renderer's file timestamps define artifact freshness.
 */
export function songOutputsCurrent(scenes: readonly Scene[], master: string): void {
  const masterTime = master !== '' ? statNs(master) : null;
  for (const s of scenes) {
    if (s.song === null) continue;
    verifySongInputs(s);
    const output = statNs(scene.outputPath(s));
    for (const name of ['scene.json', 'prompt.md', s.song.data]) {
      const file = path.join(s.directory, name);
      if (name === 'prompt.md' && !fs.existsSync(file)) continue;
      if (statNs(file) > output) throw new Error(`歌曲镜头 ${s.id} 已过期，需要 "force": true 重渲染`);
    }
    if (masterTime !== null && output > masterTime) throw new Error(`静音母版早于镜头 ${s.id}，需要重新 concat()`);
  }
}
