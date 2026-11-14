import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinFlows, installStation, recordFlow } from '../flow';
import { computeStations, confirmGateFromChat, readGates, readProgress, recordGate, stationDefs, stationOfPath } from './progress';
import { discoverScenes } from './scenes';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** 一个记下了流程（缺省口播）的项目，带着给定的文件。 */
function project(files: Record<string, string>, flowID = 'speech'): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-progress-')));
  recordFlow(root, { id: flowID, canvas: 'vertical-3x4' });
  roots.push(root);
  for (const [name, body] of Object.entries(files)) write(root, name, body);
  return root;
}

function write(root: string, name: string, body: string, ageSeconds = 0): void {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  if (ageSeconds) {
    const t = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, t, t);
  }
}

const scene = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}';
const stations = (root: string) => computeStations(root, discoverScenes(root));
const status = (root: string) => Object.fromEntries(stations(root).stations.map((s) => [s.id, s.status]));

describe('production map', () => {
  it('starts at the first station of an empty project', () => {
    const p = stations(project({}));
    expect(p.mode).toBe('speech');
    expect(p.current).toBe('intake');
    expect(p.waiting_on).toBe('ai');
  });

  it('stops at a review gate and waits on the user', () => {
    const root = project({ 'production/input-inventory.md': 'x', 'production/script-final.md': '# 标题\n口播稿正文' });
    const p = stations(root);
    expect(p.current).toBe('gate-script');
    expect(p.waiting_on).toBe('user');
    expect(p.stations.find((s) => s.id === 'script')?.detail).toBe('约 5 字');
  });

  it('records a confirmation and notices when the confirmed file changes', () => {
    const root = project({ 'production/script-final.md': '初稿' });
    recordGate(root, 'gate-script');
    expect(status(root)['gate-script']).toBe('confirmed');
    expect(stations(root).current).toBe('voice');
    write(root, 'production/script-final.md', '改过的稿子');
    expect(status(root)['gate-script']).toBe('changed');
    expect(stations(root).current).toBe('gate-script');
    expect(() => recordGate(root, 'gate-voice')).toThrow('还没写出来');
    expect(() => recordGate(root, 'gate-nope')).toThrow('没有这个审核关卡');
  });

  // 用户在对话里说「就按这个分镜，开始渲染」时，编排工具经 studio_confirm 记下关卡（2026-11：之前只认界面按钮）。
  it('records a gate the user confirmed in the chat, only with the user\'s own words', () => {
    const root = project({ 'production/scene-plan.json': '{}', 'scenes/scene-001/scene.json': scene });
    expect(stations(root).current).toBe('gate-storyboard');
    const message = '就按这七种风格，开始渲染';
    // 原话对不上这一轮用户的话：不记。
    expect(() => confirmGateFromChat(root, message, '分镜没问题')).toThrow('没有「分镜没问题」');
    expect(() => confirmGateFromChat(root, message, ' ')).toThrow('原话');
    expect(status(root)['gate-storyboard']).toBe('todo');
    // 标点、空白不同照样认；不指定关卡时记路线上在等确认的那一关。
    const { gate, label } = confirmGateFromChat(root, message, '就按这七种风格 开始渲染。');
    expect(gate).toBe('gate-storyboard');
    expect(label).toBe('分镜审核');
    const confirmed = stations(root).stations.find((s) => s.id === 'gate-storyboard');
    expect(confirmed?.status).toBe('confirmed');
    expect(confirmed?.said).toBe('就按这七种风格 开始渲染。');
    expect(readGates(root)['gate-storyboard'].said).toBe('就按这七种风格 开始渲染。');
    // 路线上没有在等的关卡、或关卡写错，都照实拒绝。
    expect(() => confirmGateFromChat(root, message, '开始渲染')).toThrow('没有在等用户确认的关卡');
    expect(() => confirmGateFromChat(root, message, '开始渲染', 'gate-nope')).toThrow('没有这个审核关卡');
  });

  it('does not reopen the script review when only readings change', () => {
    const root = project({ 'production/script-final.md': '# 开头\n\n训练和考试都没为“不知道”给过分。\n' });
    recordGate(root, 'gate-script');
    // 修一个多音字的读音、加受保护短语与声音事件：显示的字不变。
    write(root, 'production/script-final.md', '# 开头\n\n训练和考试都没为“不知道”@{score}<给过分|给过芬>@{/score}。<|[笑]>\n');
    expect(status(root)['gate-script']).toBe('confirmed');
    // 显示的字变了、标题变了、分段变了，都算改过。
    for (const body of ['# 开头\n\n训练和考试都没为“不知道”给过一分。\n', '# 开场\n\n训练和考试都没为“不知道”给过分。\n', '# 开头\n\n训练和考试\n\n都没为“不知道”给过分。\n']) {
      write(root, 'production/script-final.md', body);
      expect(status(root)['gate-script'], body).toBe('changed');
    }
    // 写坏了解析不了：按改过算。
    write(root, 'production/script-final.md', '# 开头\n\n<给过分\n');
    expect(status(root)['gate-script']).toBe('changed');
  });

  it('counts gates without a record as passed once later work exists, and missing early outputs as skipped', () => {
    const root = project({ 'production/script-final.md': 'x', 'production/audio/voice.wav': 'x', 'production/audio/voice.srt': '1\n00:00:00,000 --> 00:00:01,000\n字\n' });
    const s = status(root);
    expect(s.intake).toBe('skipped');
    expect(s['gate-script']).toBe('passed');
    expect(s['gate-voice']).toBe('passed');
    expect(s.timeline).toBe('done');
    // 整片风格是可选的，不挡路：下一站是拆分镜头。
    expect(stations(root).current).toBe('plan');
  });

  it('marks downstream work stale when its input is newer', () => {
    const root = project({});
    write(root, 'production/audio/voice.srt', 'x', 60);
    write(root, 'production/audio/voice.wav', 'x');
    expect(status(root).timeline).toBe('stale');
    expect(stations(root).current).toBe('timeline');
  });

  it('follows the scenes through to publishing', () => {
    const root = project({
      'production/scene-plan.json': '{}',
      'scenes/scene-001/scene.json': scene,
    });
    expect(stations(root).current).toBe('gate-storyboard');
    write(root, 'scenes/scene-001/out.mp4', 'x');
    expect(status(root).render).toBe('done');
    expect(stations(root).stations.find((s) => s.id === 'render')?.detail).toBe('1 / 1 个镜头出片');
    write(root, 'production/visual-qc/scene-001.json', '{}');
    write(root, 'production/silent-master.mp4', 'x');
    write(root, 'production/audio/candidate.mp4', 'x');
    write(root, 'production/review/review.json', '{"problems":[]}');
    expect(stations(root).current).toBe('gate-final');
    write(root, 'production/approval.json', '{"approved_at":"2026-11-10T03:18:43Z"}');
    write(root, 'publish.md', '---\n{"publish_status": "pending_manual_checks"}\n---\n');
    const p = stations(root);
    expect(p.current).toBe('publish');
    expect(p.waiting_on).toBe('user');
    write(root, 'publish.md', '---\n{"publish_status": "ready"}\n---\n');
    expect(stations(root).current).toBe('');
  });

  it('keeps the plan current once the cues follow a new voice', () => {
    const root = project({
      'production/scene-plan.json': '{}',
      'production/audio/voice.srt': '1\n00:00:00,000 --> 00:00:01,000\n字\n',
      'scenes/scene-001/scene.json': scene,
    });
    write(root, 'production/scene-plan.json', '{}', 600);
    write(root, 'scenes/scene-001/scene.json', scene, 600);
    // 重新配音，cues 还没跟上：要重拆。
    expect(status(root).plan).toBe('stale');
    // 重跑 cues：计划本身没改，镜头的时长跟上了新配音。
    write(root, 'scenes/scene-001/scene.json', scene);
    expect(status(root).plan).toBe('done');
  });

  it('asks to rework the storyboard when the film style is chosen after it', () => {
    const style = '.agents/skills/onset-film-style/onset-film-style.json';
    const plan = (root: string) => stations(root).stations.find((s) => s.id === 'plan')!;
    for (const flowID of ['speech', 'beat']) {
      const planFile = flowID === 'beat' ? 'production/beat/plan.json' : 'production/scene-plan.json';
      const root = project({ 'beat.yaml': 'x', 'scenes/scene-001/scene.json': scene }, flowID);
      write(root, planFile, '{}', 600);
      write(root, 'production/treatment.md', 'x', 600);
      // 风格在分镜之前定：分镜照它写，不用重做。
      write(root, style, '{}', 1200);
      expect(plan(root).status, flowID).toBe('done');
      expect(plan(root).stale_note).toBeUndefined();
      // 分镜写好之后才定（或换了）风格：分镜要按新风格改。
      write(root, style, '{}');
      expect(plan(root).status, flowID).toBe('stale');
      expect(plan(root).stale_note).toContain('镜头语言');
      // 按新风格改过处理方案就算跟上了。
      write(root, 'production/treatment.md', 'y');
      expect(plan(root).status, flowID).toBe('done');
    }
  });

  it('uses the beat stations for beat projects', () => {
    const root = project({ 'beat.yaml': 'x', 'production/beat/story.md': '# 片名' }, 'beat');
    const p = stations(root);
    expect(p.mode).toBe('beat');
    expect(p.current).toBe('gate-story');
    expect(p.stations.map((s) => s.id)).not.toContain('script');
  });

  it('files each turn under the stations it touched', () => {
    const root = project({ 'production/script-final.md': 'x' });
    const turn = {
      turn_id: 't-20261110-010203-aaaaaaaa',
      session_id: 's-1',
      kind: 'chat',
      message: '@素材包\n把稿子改短一点\n第二行',
      status: 'succeeded',
      started_at: '2026-11-10T01:02:03Z',
      ended_at: '2026-11-10T01:03:03Z',
      changes: [
        { path: 'production/script-final.md', change: 'modified', revertable: true },
        { path: 'production/audio/voice.wav', change: 'added', revertable: false },
        { path: 'production/studio/blobs/x', change: 'added', revertable: false },
      ],
      before: null,
    };
    write(root, 'production/studio/turns/' + turn.turn_id + '.json', JSON.stringify(turn));
    const p = readProgress(root);
    expect(p.turns[turn.turn_id]).toEqual(['整理口播稿', '配音']);
    const script = p.stations.find((s) => s.id === 'script')!;
    expect(script.turns).toEqual([
      { turn_id: turn.turn_id, session_id: 's-1', message: '把稿子改短一点', status: 'succeeded', at: '2026-11-10T01:03:03Z', files: 1, paths: ['production/script-final.md'] },
    ]);
  });

  it('sorts changed files into stations', () => {
    expect(stationOfPath('production/audio/try-a.mp3', 'speech')).toBe('voice');
    expect(stationOfPath('production/audio/align.json', 'speech')).toBe('timeline');
    expect(stationOfPath('production/audio/premix.wav', 'speech')).toBe('sound');
    expect(stationOfPath('scenes/scene-001/prompt.md', 'speech')).toBe('plan');
    expect(stationOfPath('scenes/scene-001/index.html', 'speech')).toBe('render');
    expect(stationOfPath('covers/douyin.png', 'speech')).toBe('publish');
    expect(stationOfPath('production/beat/plan.json', 'beat')).toBe('plan');
    expect(stationOfPath('production/studio/step.json', 'speech')).toBe('');
  });

  it('places and judges a third-party station from its declaration', () => {
    const root = project({});
    write(root, 'production/review/review.json', '{"problems":[]}', 120);
    installStation(`link:${path.join(__dirname, '..', 'flow', 'testdata', 'fake-publisher')}`);
    const ids = stations(root).stations.map((s) => s.id);
    expect(ids.slice(-2)).toEqual(['publish', 'auto-publish']);
    expect(status(root)['auto-publish']).toBe('todo');
    write(root, 'production/publish/receipts.json', '{}', 60);
    expect(status(root)['auto-publish']).toBe('done');
    // 插件的产物不让自带的站变成「跳过」。
    expect(status(root)['publish']).toBe('todo');
    // 复查比回执新：要重新发。
    write(root, 'production/review/review.json', '{"problems":[]}');
    expect(status(root)['auto-publish']).toBe('stale');
    expect(stationOfPath('production/publish/receipts.json', 'speech')).toBe('');
  });

  it('judges every station of every builtin flow', () => {
    for (const f of builtinFlows) expect(() => stationDefs(f.id), f.id).not.toThrow();
  });
});
