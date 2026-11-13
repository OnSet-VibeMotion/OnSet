import { Buffer as NodeBuffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Buffer, hasFfmpeg, makeClip, run, tempDir } from './testutil';
import * as beat from '@am/engine/beat';
import * as scene from '@am/engine/scene';

/** media_test.go 的 makeSceneDir：建一个可被 scene.load 读取的镜头目录。 */
function makeSceneDir(root: string, id: string, duration: number, filter: string): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), `{"id":"${id}","duration_seconds":${duration},"output":"out.mp4","transcript":"transcript.srt","text":"hello"}`);
  makeClip(path.join(dir, 'out.mp4'), filter);
  return dir;
}

/**
 * beatProject 建一个已导入 6.5 秒音乐的卡点项目：120 BPM、4/4、弱起 0.5 秒，
 * 共 3 小节（重拍在 0.5、2.5、4.5 秒）。草稿网格直接写盘，代替需要 Python 的分析。
 */
async function beatProject(): Promise<string> {
  const root = tempDir();
  const exec = async (...args: string[]) => {
    const out = new Buffer();
    const errOut = new Buffer();
    const code = await run([...args, '--project-root', root], out, errOut);
    if (code !== 0) throw new Error(`${args.join(' ')} 失败：${errOut.text}`);
  };
  await exec('beat', 'init');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\nstyle_id: x\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  const music = path.join(tempDir(), 'loop.wav');
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6.5', music], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`生成音乐失败：${r.stderr}`);
  await exec('beat', 'import', music);
  const track = beat.loadTrack(root);
  const draft = beat.newGrid({ schema: 1, audio_sha256: track.audio_sha256, duration_seconds: track.duration_seconds, source: 'test' });
  draft.beats = [];
  for (let i = 0; i < 13; i++) draft.beats.push(i * 0.5);
  // 故意把重拍放错一拍，再用 regrid 纠正。
  draft.downbeats = [0, 2, 4, 6];
  beat.saveDraft(root, draft);
  await exec('beat', 'regrid', '--meter', '4', '--anchor', '1');
  await exec('beat', 'confirm');
  return root;
}

function writeBeatPlan(root: string, body: string): void {
  fs.writeFileSync(path.join(root, beat.PlanFile), body);
}

describe.skipIf(!hasFfmpeg)('beat (needs ffmpeg)', () => {
  it('cues write durations on downbeats', async () => {
    const root = await beatProject();
    const grid = beat.loadGrid(root);
    expect(grid.downbeats![0] === 0.5 && grid.downbeats!.length === 3, `regrid 后重拍应从 0.5 秒起：${grid.downbeats}`).toBe(true);
    const scenes = path.join(root, 'scenes');
    makeSceneDir(scenes, 'scene-001', 1, 'testsrc=size=320x240:rate=30:duration=1');
    makeSceneDir(scenes, 'scene-002', 1, 'testsrc=size=320x240:rate=30:duration=1');
    writeBeatPlan(root, '{"schema":1,"scenes":[{"id":"scene-001","bars":2},{"id":"scene-002","bars":1}]}');

    const out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['beat', 'cues', scenes, '--project-root', root], out, errOut), errOut.text).toBe(0);
    const body = fs.readFileSync(path.join(scenes, 'scene-001', 'scene.json'), 'utf8');
    const first = JSON.parse(body) as { duration_seconds: number; beat?: beat.Cue };
    // 弱起 + 2 小节：切点在第 3 小节的重拍 4.5 秒，即第 135 帧。
    expect(first.beat?.frames === 135 && first.duration_seconds === 4.5, `第一个镜头应到 4.5 秒的重拍：${body}`).toBe(true);
    const cues = fs.readFileSync(path.join(scenes, 'scene-002', beat.CueDataFile), 'utf8');
    const local = JSON.parse(cues) as beat.Local;
    expect(local.beats[0].frame === 0 && local.beats[0].downbeat && local.beats[0].bar === 3, `第二个镜头应从第 3 小节重拍起：${cues}`).toBe(true);

    errOut = new Buffer();
    expect(await run(['validate', 'beat', '--project-root', root], out, errOut), `校验应通过：${errOut.text}`).toBe(0);
    // 重跑是幂等的：内容不变时不动文件，避免 run-all 把镜头判为过期。
    const before = fs.statSync(path.join(scenes, 'scene-001', 'scene.json'), { bigint: true }).mtimeNs;
    await run(['beat', 'cues', scenes, '--project-root', root], out, errOut);
    const after = fs.statSync(path.join(scenes, 'scene-001', 'scene.json'), { bigint: true }).mtimeNs;
    expect(after, '内容不变的重跑不应改写 scene.json').toBe(before);

    // 手改镜头时长，切点离开重拍。
    const fields = JSON.parse(body) as Record<string, unknown>;
    fields.duration_seconds = 4.0;
    fs.writeFileSync(path.join(scenes, 'scene-001', 'scene.json'), JSON.stringify(fields));
    errOut = new Buffer();
    const code = await run(['validate', 'beat', '--project-root', root], out, errOut);
    expect(code === 1 && errOut.text.includes('不要手改'), `手改时长应被拦下：${code} ${errOut.text}`).toBe(true);
  });

  it('cues reject plan mismatch without writing', async () => {
    const root = await beatProject();
    const scenes = path.join(root, 'scenes');
    makeSceneDir(scenes, 'scene-001', 1, 'testsrc=size=320x240:rate=30:duration=1');
    makeSceneDir(scenes, 'scene-002', 1, 'testsrc=size=320x240:rate=30:duration=1');
    const original = fs.readFileSync(path.join(scenes, 'scene-001', 'scene.json'));
    const plans: Record<string, string> = {
      小节合计: '{"schema":1,"scenes":[{"id":"scene-001","bars":1},{"id":"scene-002","bars":1}]}',
      镜头顺序: '{"schema":1,"scenes":[{"id":"scene-002","bars":2},{"id":"scene-001","bars":1}]}',
    };
    for (const [name, plan] of Object.entries(plans)) {
      writeBeatPlan(root, plan);
      const out = new Buffer();
      const errOut = new Buffer();
      const code = await run(['beat', 'cues', scenes, '--project-root', root], out, errOut);
      expect(code === 1 && errOut.text.includes(name), `${name} 应报错并点名：${code} ${errOut.text}`).toBe(true);
      expect(NodeBuffer.compare(fs.readFileSync(path.join(scenes, 'scene-001', 'scene.json')), original), `${name} 校验失败时不应写任何镜头`).toBe(0);
    }
  });

  // 没确认网格之前，cues 不能用草稿切镜头。
  it('cues require a confirmed grid', async () => {
    const root = tempDir();
    const out = new Buffer();
    const errOut = new Buffer();
    await run(['beat', 'init', '--project-root', root], out, errOut);
    expect(await run(['beat', 'cues', path.join(root, 'scenes'), '--project-root', root], out, errOut), `没有正式网格时应失败：${errOut.text}`).toBe(1);
  });

  // 审查发现的两条旁路：抄另一个镜头的 beat 块、把 grid 指到别的项目。
  // 都必须在单镜头校验（渲染前那一道）就被拦下，而不只靠 run-all 的整体比对。
  it('verifyBeatInputs rejects borrowed or foreign cues', async () => {
    const root = await beatProject();
    const scenes = path.join(root, 'scenes');
    makeSceneDir(scenes, 'scene-001', 1, 'testsrc=size=320x240:rate=30:duration=1');
    makeSceneDir(scenes, 'scene-002', 1, 'testsrc=size=320x240:rate=30:duration=1');
    writeBeatPlan(root, '{"schema":1,"scenes":[{"id":"scene-001","bars":2},{"id":"scene-002","bars":1}]}');
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['beat', 'cues', scenes, '--project-root', root], out, errOut), errOut.text).toBe(0);
    const first = scene.load(path.join(scenes, 'scene-001'));
    const second = scene.load(path.join(scenes, 'scene-002'));
    expect(() => scene.verifyBeatInputs(first)).not.toThrow();

    const borrowed = { ...second, beat: first.beat, duration_seconds: first.duration_seconds };
    expect(() => scene.verifyBeatInputs(borrowed)).toThrow('属于镜头');

    const foreign = { ...first, beat: { ...first.beat!, grid: '../../../other/' + beat.GridFile } };
    expect(() => scene.verifyBeatInputs(foreign)).toThrow('beat.grid');
  });
});

it('init --delivery beat', async () => {
  const root = path.join(tempDir(), 'project');
  const out = new Buffer();
  const errOut = new Buffer();
  expect(await run(['init', root, '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'beat'], out, errOut), errOut.text).toBe(0);
  expect(() => beat.loadConfig(root), '应写出可用的 beat.yaml').not.toThrow();
  const bad = path.join(tempDir(), 'bad');
  expect(await run(['init', bad, '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'beat', '--narration', 'cast'], out, errOut), '卡点与多角色对话不应同时启用').not.toBe(0);
  expect(fs.existsSync(bad), '拒绝时不应留下半成品目录').toBe(false);
});
