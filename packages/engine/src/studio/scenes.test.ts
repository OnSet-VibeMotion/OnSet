import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverScenes } from './scenes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'am-scenes-')));
  dirs.push(root);
  return root;
}

function writeScene(root: string, rel: string, id: string): void {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({ id, duration_seconds: 3, output: id + '.mp4' }));
}

describe('discoverScenes', () => {
  it('lists each scene once when an older plan was archived with the same ids', () => {
    const root = project();
    // 重做分镜后旧的一套挪进 production/v1/scenes/ 留底，id 与新的一套相同。
    writeScene(root, 'production/v1/scenes/scene-001', 'scene-001');
    writeScene(root, 'production/v1/scenes/scene-002', 'scene-002');
    writeScene(root, 'scenes/scene-001', 'scene-001');
    writeScene(root, 'scenes/scene-002', 'scene-002');
    const scenes = discoverScenes(root);
    expect(scenes.map((s) => path.relative(root, s.directory))).toEqual([
      path.join('scenes', 'scene-001'),
      path.join('scenes', 'scene-002'),
    ]);
  });

  it('prefers the directory the scene plan points to', () => {
    const root = project();
    writeScene(root, 'scenes/scene-001', 'scene-001');
    writeScene(root, 'production/v2/scene-001', 'scene-001');
    fs.writeFileSync(
      path.join(root, 'production', 'scene-plan.json'),
      JSON.stringify({ schema: 1, scenes: [{ id: 'scene-001', dir: 'production/v2/scene-001' }] }),
    );
    const scenes = discoverScenes(root);
    expect(scenes.map((s) => path.relative(root, s.directory))).toEqual([path.join('production', 'v2', 'scene-001')]);
  });

  it('keeps archived scenes whose ids are not reused', () => {
    const root = project();
    writeScene(root, 'production/v1/scenes/scene-009', 'scene-009');
    writeScene(root, 'scenes/scene-001', 'scene-001');
    expect(discoverScenes(root).map((s) => s.id)).toEqual(['scene-001', 'scene-009']);
  });

  it('stamps each scene by its own output so other changes do not reload it', () => {
    const root = project();
    writeScene(root, 'scenes/scene-001', 'scene-001');
    writeScene(root, 'scenes/scene-002', 'scene-002');
    const out1 = path.join(root, 'scenes/scene-001/scene-001.mp4');
    const out2 = path.join(root, 'scenes/scene-002/scene-002.mp4');
    fs.writeFileSync(out1, 'a');
    fs.writeFileSync(out2, 'b');
    const before = discoverScenes(root);
    expect(before[0].output_stamp).toBeTruthy();

    // 改了第二个镜头的产物：第一个镜头的指纹不变，第二个变了。
    fs.writeFileSync(out2, 'bb');
    fs.utimesSync(out2, new Date(), new Date(Date.now() + 5000));
    const after = discoverScenes(root);
    expect(after[0].output_stamp).toBe(before[0].output_stamp);
    expect(after[1].output_stamp).not.toBe(before[1].output_stamp);

    // 没有产物的镜头没有指纹，界面退回全局版本号。
    fs.rmSync(out2);
    expect(discoverScenes(root)[1].output_stamp).toBeUndefined();
  });
});
