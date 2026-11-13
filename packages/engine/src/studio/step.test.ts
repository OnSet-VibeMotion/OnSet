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
    expect(step(project({}))).toEqual({});
    expect(step(project({ 'production/script-final.md': 'x' }))).toEqual({ step: 'script' });
    expect(step(project({ 'beat.yaml': 'x', 'production/beat/grid.json': '{}' }))).toEqual({ step: 'beat' });
    expect(step(project({ 'production/scene-plan.json': '{}' }))).toEqual({ step: 'storyboard' });
    expect(step(project({ 'production/scene-plan.json': '{}', 'scenes/scene-001/scene.json': scene }))).toEqual({ step: 'storyboard' });
    expect(step(project({ 'scenes/scene-001/scene.json': scene, 'scenes/scene-001/out.mp4': 'x' }))).toEqual({ step: 'final' });
    expect(step(project({ 'scenes/scene-001/scene.json': scene, 'scenes/scene-001/out.mp4': 'x', 'final.mp4': 'x', 'publish.md': 'x' }))).toEqual({ step: 'publish' });
  });

  it('prefers what the orchestrator marked, and ignores unknown steps', () => {
    const root = project({ 'final.mp4': 'x' });
    writeStepMark(root, 'storyboard');
    expect(step(root)).toEqual({ step: 'storyboard', step_marked: true });
    writeStepMark(root, 'bogus');
    expect(readStepMark(root)?.step).toBe('storyboard');
    expect(fs.existsSync(path.join(root, 'production', 'studio', 'step.json'))).toBe(true);
  });
});
