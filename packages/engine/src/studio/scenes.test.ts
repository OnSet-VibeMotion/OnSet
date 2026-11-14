import crypto from 'node:crypto';
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
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-scenes-')));
  dirs.push(root);
  return root;
}

function writeScene(root: string, rel: string, id: string): void {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify({ id, duration_seconds: 3, output: id + '.mp4' }));
}

describe('discoverScenes', () => {
  it('Windows excludes a whole-film QA copy unless the scene plan explicitly selects it', () => {
    const root = project();
    writeScene(root, 'scenes/scene-001', 'scene-001');
    writeScene(root, 'production/visual-qc/candidate-source', 'candidate-qc');
    expect(discoverScenes(root, 'win32').map(s => s.id)).toEqual(['scene-001']);
    // 其它平台保持原来的发现规则。
    expect(discoverScenes(root, 'darwin').map(s => s.id)).toEqual(['candidate-qc','scene-001']);
    fs.writeFileSync(path.join(root, 'production/scene-plan.json'), JSON.stringify({scenes:[{id:'candidate-qc',dir:'production/visual-qc/candidate-source'}]}));
    expect(discoverScenes(root, 'win32').map(s => s.id)).toEqual(['candidate-qc','scene-001']);
  });
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

  it('does not call a scene stale when cues rewrote the same scene.json', () => {
    const root = project();
    writeScene(root, 'scenes/scene-001', 'scene-001');
    const dir = path.join(root, 'scenes/scene-001');
    const sceneFile = path.join(dir, 'scene.json');
    fs.writeFileSync(path.join(dir, 'scene-001.mp4'), 'video');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, 'scene-001.mp4'), old, old);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(sceneFile)).digest('hex');
    const record = (sceneDigest: string, size = 5) =>
      fs.writeFileSync(path.join(dir, '.onset-render.json'), JSON.stringify({ schema: 1, output: 'scene-001.mp4', output_size: size, parts: { 'file:scene.json': sceneDigest } }));

    // 没有渲染记录：只能按修改时间。
    expect(discoverScenes(root)[0].stale).toBe(true);
    // 记录里的 scene.json 与现在逐字节相同：只是被原样重写了一遍。
    record(digest);
    expect(discoverScenes(root)[0].stale).toBe(false);
    // 记录是别的产物的（大小对不上）：不算数。
    record(digest, 99);
    expect(discoverScenes(root)[0].stale).toBe(true);
    // scene.json 真的改了。
    record(digest);
    fs.writeFileSync(sceneFile, JSON.stringify({ id: 'scene-001', duration_seconds: 4, output: 'scene-001.mp4' }));
    expect(discoverScenes(root)[0].stale).toBe(true);
  });
});
