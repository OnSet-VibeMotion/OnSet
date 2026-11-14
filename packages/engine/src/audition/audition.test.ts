import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { load as loadScene, newAttempt, type Scene } from '../scene';
import * as audition from './audition';

let root = '';

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-audition-')));
  fs.writeFileSync(path.join(root, 'onset.conf'), '');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas: {width_px: 1080, height_px: 1440, fps: 30}\n---\n');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeScene(): Scene {
  const dir = path.join(root, 'scenes', 'scene-001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:03,000\n字幕\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":3,"output":"scene-001.mp4","transcript":"transcript.srt","text":"一段口播"}');
  fs.writeFileSync(path.join(dir, 'prompt.md'), '画面说明');
  return loadScene(dir);
}

const reverse = <T>(list: T[]): T[] => [...list].reverse();
const at = new Date(2026, 10, 14, 15, 30, 12);

/** 假装选手渲染完：写产物、合成代码与日志，再把尝试记录抄进试镜。 */
function finish(a: audition.Audition, slot: string, outcome = 'succeeded'): void {
  const c = a.contestants.find((x) => x.slot === slot)!;
  const dir = path.join(root, c.workdir);
  if (outcome === 'succeeded') fs.writeFileSync(path.join(dir, 'scene-001.mp4'), 'video-' + slot);
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>' + slot + '</html>');
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'bg.png'), 'png-' + slot);
  fs.writeFileSync(path.join(dir, 'render-scene-001.stream.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, '.onset-render.json'), '{"fingerprint":"of-the-copy"}');
  audition.applyAttempt(root, c, newAttempt({ scene_id: 'scene-001', renderer: c.renderer, model: 'seen-' + c.renderer, outcome, seconds: 12, problems: outcome === 'succeeded' ? null : ['时长不对'] }), '');
  audition.save(root, a);
}

describe('audition', () => {
  it('parses contestants as renderer[:model], splitting at the first colon only', () => {
    expect(audition.parseEntry('claude')).toEqual({ renderer: 'claude', model: '' });
    expect(audition.parseEntry(' opencode:deepseek/deepseek-v4 ')).toEqual({ renderer: 'opencode', model: 'deepseek/deepseek-v4' });
    expect(audition.parseEntry('codex:a:b')).toEqual({ renderer: 'codex', model: 'a:b' });
    expect(() => audition.parseEntry(':x')).toThrow('选手写法不对');
  });

  it('freezes the scene into one directory per blind slot', () => {
    const sc = writeScene();
    const a = audition.create(root, sc, [{ renderer: 'claude', model: 'opus' }, { renderer: 'codex', model: '' }], { withMemory: true, now: at, shuffle: reverse });
    expect(a.id).toBe('audition-20261114-153012');
    expect(a.scene_dir).toBe('scenes/scene-001');
    // 洗牌之后 A 是后报名的 codex：标号与报名顺序无关。
    expect(a.contestants.map((c) => [c.slot, c.renderer])).toEqual([
      ['A', 'codex'],
      ['B', 'claude'],
    ]);
    for (const c of a.contestants) {
      const dir = path.join(root, c.workdir);
      expect(c.workdir.startsWith(audition.Dir + '/')).toBe(true);
      for (const f of ['scene.json', 'prompt.md', 'transcript.srt', 'frame.md']) expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
    expect(audition.load(root, a.id)).toEqual(a);
    // 同一秒再开一场不撞名。
    expect(audition.create(root, sc, [{ renderer: 'claude', model: '' }, { renderer: 'codex', model: '' }], { withMemory: false, now: at }).id).toBe('audition-20261114-153012-2');
    expect(audition.list(root).map((x) => x.id)).toEqual(['audition-20261114-153012-2', 'audition-20261114-153012']);
  });

  it('rejects too few or duplicate contestants', () => {
    const sc = writeScene();
    expect(() => audition.create(root, sc, [{ renderer: 'claude', model: '' }], { withMemory: true })).toThrow('至少');
    expect(() => audition.create(root, sc, [{ renderer: 'claude', model: 'x' }, { renderer: 'claude', model: 'x' }], { withMemory: true })).toThrow('选手重复');
  });

  it('hides who is who until the verdict', () => {
    const sc = writeScene();
    const a = audition.create(root, sc, [{ renderer: 'claude', model: 'opus' }, { renderer: 'codex', model: 'gpt' }], { withMemory: true, now: at, shuffle: reverse });
    finish(a, 'A');
    finish(a, 'B', 'verification_failed');
    const blind = JSON.stringify(audition.blindJSON(a));
    for (const secret of ['claude', 'codex', 'opus', 'gpt', 'seen-', '时长不对', '"seconds"', '"usage"']) expect(blind).not.toContain(secret);
    expect(audition.blindJSON(a).blind).toBe(true);
    const voted = audition.vote(root, a.id, { kind: 'winner', winner: 'A', note: '节奏好' }, at);
    const open = audition.blindJSON(voted);
    expect(open.blind).toBe(false);
    expect(JSON.stringify(open)).toContain('codex');
  });

  it('only votes when everyone is done and only for a slot with output', () => {
    const sc = writeScene();
    const a = audition.create(root, sc, [{ renderer: 'claude', model: '' }, { renderer: 'codex', model: '' }], { withMemory: true, now: at, shuffle: reverse });
    finish(a, 'A');
    expect(() => audition.vote(root, a.id, { kind: 'tie' })).toThrow('还有选手没渲染完');
    finish(a, 'B', 'failed');
    expect(() => audition.vote(root, a.id, { kind: 'winner', winner: 'B' })).toThrow('B 没有产物');
    expect(() => audition.vote(root, a.id, { kind: 'winner', winner: 'Z' })).toThrow('没有 Z');
    expect(() => audition.vote(root, a.id, { kind: 'best' })).toThrow('评判只能是');
    expect(audition.vote(root, a.id, { kind: 'none', note: '都太乱' }).verdict?.kind).toBe('none');
    // 可以改判，以最后一次为准。
    expect(audition.vote(root, a.id, { kind: 'winner', winner: 'A' }).verdict?.winner).toBe('A');
  });

  it('keeps the last verdict per audition in the user-level log', () => {
    const sc = writeScene();
    const mem = path.join(root, 'memory');
    const a = audition.create(root, sc, [{ renderer: 'claude', model: 'opus' }, { renderer: 'codex', model: '' }], { withMemory: true, now: at, shuffle: reverse });
    finish(a, 'A');
    finish(a, 'B');
    audition.recordVerdict(mem, 'demo', audition.vote(root, a.id, { kind: 'tie' }, at));
    audition.recordVerdict(mem, 'demo', audition.vote(root, a.id, { kind: 'winner', winner: 'B' }, at));
    const rows = audition.readVerdicts(mem);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('winner');
    // 指定了模型用指定的，没指定用实际读到的。
    expect(rows[0].winner).toBe('claude/opus');
    expect(rows[0].contestants.map((c) => c.model).sort()).toEqual(['opus', 'seen-codex']);
  });

  it('adopts the winner: archives the old render, copies everything but the frozen inputs', () => {
    const sc = writeScene();
    fs.writeFileSync(path.join(sc.directory, 'scene-001.mp4'), 'old-video');
    const a = audition.create(root, sc, [{ renderer: 'claude', model: '' }, { renderer: 'codex', model: '' }], { withMemory: true, now: at, shuffle: reverse });
    finish(a, 'A');
    finish(a, 'B');
    expect(() => audition.adoptFiles(root, a, 'A', loadScene(sc.directory))).toThrow('先评判再采用');
    const voted = audition.vote(root, a.id, { kind: 'winner', winner: 'B' }, at);
    const { contestant, files } = audition.adoptFiles(root, voted, 'B', loadScene(sc.directory), at);
    expect(contestant.renderer).toBe('claude');
    expect(files).toEqual(['assets/bg.png', 'index.html', 'render-scene-001.stream.jsonl', 'scene-001.mp4']);
    expect(fs.readFileSync(path.join(sc.directory, 'scene-001.mp4'), 'utf8')).toBe('video-B');
    expect(fs.readFileSync(path.join(sc.directory, 'attempts', 'attempt-01', 'scene-001.mp4'), 'utf8')).toBe('old-video');
    // 项目里没有 frame.md 的镜头目录不会被塞进一份，渲染记录要按项目里的镜头重写。
    expect(fs.existsSync(path.join(sc.directory, 'frame.md'))).toBe(false);
    expect(fs.existsSync(path.join(sc.directory, '.onset-render.json'))).toBe(false);
    expect(audition.load(root, a.id).adopted?.slot).toBe('B');
  });

  it('refuses to adopt after the scene changed', () => {
    const sc = writeScene();
    const a = audition.create(root, sc, [{ renderer: 'claude', model: '' }, { renderer: 'codex', model: '' }], { withMemory: true, now: at, shuffle: reverse });
    finish(a, 'A');
    finish(a, 'B', 'verification_failed');
    const voted = audition.vote(root, a.id, { kind: 'winner', winner: 'A' }, at);
    expect(() => audition.adoptFiles(root, voted, 'B', loadScene(sc.directory))).toThrow('没有合格的产物');
    fs.writeFileSync(path.join(sc.directory, 'prompt.md'), '改过的画面说明');
    expect(() => audition.adoptFiles(root, voted, 'A', loadScene(sc.directory))).toThrow('在试镜之后改过');
  });
});
