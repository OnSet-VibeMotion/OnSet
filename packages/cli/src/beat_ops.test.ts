import { Buffer as NodeBuffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import '@onset/engine/plugin';
import * as beat from '@onset/engine/beat';
import { verifyBeatInputs } from '@onset/engine/plugins/beat';
import * as scene from '@onset/engine/scene';
import { describe, expect, it } from 'vitest';
import { Buffer, hasFfmpeg, makeClip, run, tempDir, writeFrameFor } from './testutil';

/** media_test.go 的 makeSceneDir：建一个可被 scene.load 读取的镜头目录。 */
function makeSceneDir(root: string, id: string, duration: number, filter: string): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    `{"id":"${id}","duration_seconds":${duration},"output":"out.mp4","transcript":"transcript.srt","text":"hello"}`,
  );
  writeFrameFor(dir, filter);
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
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  const music = path.join(tempDir(), 'loop.wav');
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=6.5', music],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`生成音乐失败：${r.stderr}`);
  await exec('beat', 'import', music);
  const track = beat.loadTrack(root);
  const draft = beat.newGrid({
    schema: 1,
    audio_sha256: track.audio_sha256,
    duration_seconds: track.duration_seconds,
    source: 'test',
  });
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
    expect(
      grid.downbeats![0] === 0.5 && grid.downbeats!.length === 3,
      `regrid 后重拍应从 0.5 秒起：${grid.downbeats}`,
    ).toBe(true);
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
    expect(first.beat?.frames === 135 && first.duration_seconds === 4.5, `第一个镜头应到 4.5 秒的重拍：${body}`).toBe(
      true,
    );
    const cues = fs.readFileSync(path.join(scenes, 'scene-002', beat.CueDataFile), 'utf8');
    const local = JSON.parse(cues) as beat.Local;
    expect(
      local.beats[0].frame === 0 && local.beats[0].downbeat && local.beats[0].bar === 3,
      `第二个镜头应从第 3 小节重拍起：${cues}`,
    ).toBe(true);

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
      expect(
        NodeBuffer.compare(fs.readFileSync(path.join(scenes, 'scene-001', 'scene.json')), original),
        `${name} 校验失败时不应写任何镜头`,
      ).toBe(0);
    }
  });

  // 没确认网格之前，cues 不能用草稿切镜头。
  it('cues require a confirmed grid', async () => {
    const root = tempDir();
    const out = new Buffer();
    const errOut = new Buffer();
    await run(['beat', 'init', '--project-root', root], out, errOut);
    expect(
      await run(['beat', 'cues', path.join(root, 'scenes'), '--project-root', root], out, errOut),
      `没有正式网格时应失败：${errOut.text}`,
    ).toBe(1);
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
    expect(() => verifyBeatInputs(first)).not.toThrow();

    const borrowed = { ...second, beat: first.beat, duration_seconds: first.duration_seconds };
    expect(() => verifyBeatInputs(borrowed)).toThrow('属于镜头');

    const foreign = { ...first, beat: { ...first.beat!, grid: '../../../other/' + beat.GridFile } };
    expect(() => verifyBeatInputs(foreign)).toThrow('beat.grid');
  });

  it('cues slice anchors.json into beat-cues.json and validates anchor staleness', async () => {
    const root = await beatProject();
    const scenes = path.join(root, 'scenes');
    makeSceneDir(scenes, 'scene-001', 1, 'testsrc=size=320x240:rate=30:duration=1');
    makeSceneDir(scenes, 'scene-002', 1, 'testsrc=size=320x240:rate=30:duration=1');
    writeBeatPlan(root, '{"schema":1,"scenes":[{"id":"scene-001","bars":2},{"id":"scene-002","bars":1}]}');
    const anchorsPath = path.join(root, beat.AnchorsFile);
    fs.writeFileSync(
      anchorsPath,
      JSON.stringify({
        schema: 1,
        anchors: [
          { id: 'intro_hit', type: 'action', beat: 3 }, // 1.5s -> frame 45 -> scene-001 local 45
          { id: 'bar3_cut', type: 'cut', beat: 9, scene: 'scene-002' }, // 4.5s -> frame 135 -> scene-002 local 0
          { id: 'tail_hit', type: 'action', at: 5.5, scene: 'scene-002' }, // 5.5s -> frame 165 -> scene-002 local 30
        ],
      }),
    );

    const out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['beat', 'cues', scenes, '--project-root', root], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('3 个命名锚点');

    const local1 = JSON.parse(fs.readFileSync(path.join(scenes, 'scene-001', beat.CueDataFile), 'utf8')) as beat.Local;
    const local2 = JSON.parse(fs.readFileSync(path.join(scenes, 'scene-002', beat.CueDataFile), 'utf8')) as beat.Local;
    expect(local1.anchors).toEqual({ intro_hit: 45 });
    expect(local2.anchors).toEqual({ bar3_cut: 0, tail_hit: 30 });

    errOut = new Buffer();
    expect(await run(['validate', 'beat', '--project-root', root], out, errOut), errOut.text).toBe(0);

    // 修改 anchors.json 后，validate beat 应立刻拦截过期局部锚点
    fs.writeFileSync(
      anchorsPath,
      JSON.stringify({ schema: 1, anchors: [{ id: 'intro_hit', type: 'action', beat: 4 }] }),
    );
    errOut = new Buffer();
    expect(await run(['validate', 'beat', '--project-root', root], out, errOut)).toBe(1);
    expect(errOut.text).toContain('beat_cues()');
  });

  it('runs beat av-backtest CLI op and writes av-backtest.json', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
    const music = path.join(root, 'music.wav');
    const video = path.join(root, 'candidate.mp4');
    // 生成含 1.0s 强音频瞬态与黑底画面（静帧）的测试成片，验证 CLI 诚实输出 unverified 与报告落盘
    const a = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        "aevalsrc='if(between(t,0.98,1.02),0.8*sin(2*PI*660*t),0)':s=48000:d=2",
        music,
      ],
      { encoding: 'utf8' },
    );
    if (a.status !== 0) throw new Error(a.stderr);
    const v = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x240:r=30:d=2',
        '-i',
        music,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        video,
      ],
      { encoding: 'utf8' },
    );
    if (v.status !== 0) throw new Error(v.stderr);
    const anchorsFile = path.join(root, 'anchors.json');
    fs.writeFileSync(
      anchorsFile,
      JSON.stringify({
        schema: 1,
        anchors: [
          {
            id: 'a1',
            type: 'action',
            at: 1.0,
            visual: { metric: 'brightness', roi: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } },
          },
        ],
      }),
    );
    const outPath = path.join(root, 'av-backtest.json');
    const out = new Buffer();
    const errOut = new Buffer();
    const code = await run(
      [
        'beat',
        'av-backtest',
        video,
        '--source-music',
        music,
        '--anchors',
        anchorsFile,
        '--out',
        outPath,
        '--project-root',
        root,
      ],
      out,
      errOut,
    );
    expect(code, errOut.text).toBe(0);
    expect(out.text).toContain('verdict=unverified');
    const saved = JSON.parse(fs.readFileSync(outPath, 'utf8')) as {
      verdict: string;
      anchors: Array<{ music: { verified: boolean }; visual: { verified: boolean } }>;
    };
    expect(saved.verdict).toBe('unverified');
    expect(saved.anchors[0].music.verified).toBe(true);
    expect(saved.anchors[0].visual.verified).toBe(false);

    // 显式传入缺失的 --cue-sheet 应直接报错而非静默忽略
    const errBadCue = new Buffer();
    const badCueCode = await run(
      [
        'beat',
        'av-backtest',
        video,
        '--source-music',
        music,
        '--anchors',
        anchorsFile,
        '--cue-sheet',
        path.join(root, 'missing-cue-sheet.json'),
        '--project-root',
        root,
      ],
      new Buffer(),
      errBadCue,
    );
    expect(badCueCode).toBe(1);
    expect(errBadCue.text).toContain('找不到指定的 cue sheet');
  });
});

it('init --delivery beat', async () => {
  const root = path.join(tempDir(), 'project');
  const out = new Buffer();
  const errOut = new Buffer();
  expect(
    await run(['init', root, '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'beat'], out, errOut),
    errOut.text,
  ).toBe(0);
  expect(() => beat.loadConfig(root), '应写出可用的 beat.yaml').not.toThrow();
  const bad = path.join(tempDir(), 'bad');
  expect(
    await run(
      ['init', bad, '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'beat', '--narration', 'cast'],
      out,
      errOut,
    ),
    '卡点与多角色对话不应同时启用',
  ).not.toBe(0);
  expect(fs.existsSync(bad), '拒绝时不应留下半成品目录').toBe(false);
});
