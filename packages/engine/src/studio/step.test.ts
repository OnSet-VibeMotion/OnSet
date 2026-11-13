import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverScenes } from './scenes';
import { stepOf } from './studio';
import { readStepMark, writeStepMark } from './view';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-step-')));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

const scene = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}';
const step = (root: string) => stepOf(root, discoverScenes(root));

describe('production step', () => {
  it('guesses the step from the files until the orchestrator marks one', () => {
    // 新项目：第一步。
    expect(step(project({}))).toEqual({ step: 'script' });
    expect(step(project({ 'production/script-final.md': 'x' }))).toEqual({ step: 'script' });
    expect(step(project({ 'beat.yaml': 'x', 'production/beat/grid.json': '{}' }))).toEqual({ step: 'beat' });
    expect(step(project({ 'production/scene-plan.json': '{}' }))).toEqual({ step: 'storyboard' });
    expect(step(project({ 'production/scene-plan.json': '{}', 'scenes/scene-001/scene.json': scene }))).toEqual({ step: 'storyboard' });
    // 镜头都出片了，下一站是画面验收，仍在「镜头」这一步。
    expect(step(project({ 'scenes/scene-001/scene.json': scene, 'scenes/scene-001/out.mp4': 'x' }))).toEqual({ step: 'scene' });
    expect(step(project({ 'scenes/scene-001/scene.json': scene, 'scenes/scene-001/out.mp4': 'x', 'production/silent-master.mp4': 'x' }))).toEqual({ step: 'final' });
    expect(step(project({ 'production/approval.json': '{}', 'publish.md': 'x' }))).toEqual({ step: 'publish' });
    // 全部做完停在最后一步。
    expect(step(project({ 'production/approval.json': '{}', 'publish.md': '---\n{"publish_status": "ready"}\n---\n' }))).toEqual({ step: 'publish' });
  });

  it('prefers what the orchestrator marked, and ignores unknown steps', () => {
    const root = project({ 'final.mp4': 'x' });
    writeStepMark(root, 'storyboard');
    expect(step(root)).toEqual({ step: 'storyboard', step_marked: true });
    // 标记之后又有了新产物：标记过时，改按产物推。
    const later = new Date(Date.now() + 60_000);
    fs.mkdirSync(path.join(root, 'production'), { recursive: true });
    fs.writeFileSync(path.join(root, 'production', 'script-final.md'), 'x');
    fs.utimesSync(path.join(root, 'production', 'script-final.md'), later, later);
    expect(step(root)).toEqual({ step: 'script' });
    writeStepMark(root, 'bogus');
    expect(readStepMark(root)?.step).toBe('storyboard');
    expect(fs.existsSync(path.join(root, 'production', 'studio', 'step.json'))).toBe(true);
  });
});
