// 移植自 internal/cli/e2e_test.go（Go 版只在 darwin / linux 上编译，这里同样只在非 Windows 上跑）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as dialogue from '@am/engine/dialogue';
import { formatG } from '@am/engine/gofmt';
import { marshalIndent } from '@am/engine/gojson';
import { Buffer, hasFfmpeg, lookPath, makeClip, run, runIn, setenv, tempDir } from './testutil';
import { copyTree } from '@am/engine/plugins/cast';

const skip = !hasFfmpeg || process.platform === 'win32';

/**
 * 装一个假渲染工具：它不真的渲染，只把预先准备好的 mp4 拷到 scene.json 声明的产物路径，
 * 并输出一条阶段消息。被替换掉的只是「画面从哪来」，am 自己的那部分（契约、调度、校验、拼接）全部是真的在跑。
 */
function fakeRenderer(binDir: string, source: string): void {
  const script =
    "#!/bin/sh\nset -eu\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\"," +
    "\"text\":\"[[USER_MESSAGE]]视频已渲染完成\"}}'\n" +
    // 用绝对路径：安全模式下子进程的 PATH 是受控白名单，/bin 不在里面。
    `/bin/cp '${source}' out.mp4\n`;
  fs.writeFileSync(path.join(binDir, 'codex'), script, { mode: 0o755 });
}

/** cast_test.go 的 dialogueTone：生成一段指定秒数的测试音频。 */
function dialogueTone(file: string, seconds: number): void {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds.toFixed(3)}`, '-ar', '22050', '-ac', '2', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`生成测试音频失败：${r.stderr}`);
}

/** runCLI 的变体：返回输出与是否失败（Go 测试里 `out, err := runCLI(...)` 两个都要看）。 */
async function tryCLI(root: string, ...args: string[]): Promise<{ out: string; failed: boolean }> {
  const { code, out } = await runIn(root, args);
  return { out, failed: code !== 0 };
}

describe.skipIf(skip)('end to end', () => {
  // 把 am 自己负责的四段串起来跑一遍：调度 → 产物校验 → 抽帧 → 拼接 → 成片验收。
  it('render, verify, concat, validate', async () => {
    const project = tempDir();
    const binDir = tempDir();
    // 一段合规素材，供假渲染器拷贝：320x240、30fps、1 秒、无音轨。
    const source = path.join(tempDir(), 'source.mp4');
    makeClip(source, 'testsrc=size=320x240:rate=30:duration=1');
    fakeRenderer(binDir, source);
    // 项目级视觉规范，让画幅从 frame.md 反查而不是靠命令行传。
    fs.writeFileSync(path.join(project, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n视觉规范正文\n');
    fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    // 两条字幕，跨度 2 秒，正好等于两个 1 秒镜头之和。
    fs.writeFileSync(path.join(project, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\n第一句\n\n2\n00:00:01,000 --> 00:00:02,000\n第二句\n');
    const scenes = path.join(project, 'scenes');
    for (const id of ['scene-001', 'scene-002']) {
      const dir = path.join(scenes, id);
      fs.mkdirSync(dir, { recursive: true });
      for (const name of ['transcription.srt', 'frame.md']) fs.copyFileSync(path.join(project, name), path.join(dir, name));
      fs.writeFileSync(
        path.join(dir, 'scene.json'),
        `{"id":"${id}","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"内容","style_guide":"frame.md"}`,
      );
    }
    process.chdir(project);
    const ffmpegDir = path.dirname(lookPath('ffmpeg'));
    setenv('PATH', binDir + path.delimiter + ffmpegDir);
    setenv('HOME', tempDir());

    // 1. 调度：带覆盖校验，两镜合计 2 秒对上字幕跨度 2 秒。
    let out = new Buffer();
    let errOut = new Buffer();
    const reportPath = path.join(project, 'run-report.json');
    let code = await run(['scene', 'run-all', 'scenes/', '--srt', 'transcription.srt', '--strict-coverage', '--jobs', '2', '--retries', '0', '--report-json', reportPath], out, errOut);
    expect(code, `stdout: ${out.text}\nstderr: ${errOut.text}`).toBe(0);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { counts: Record<string, number> };
    expect(report.counts.succeeded).toBe(2);

    // 2. 抽帧：产物有内容，不该被判空白。
    out = new Buffer();
    errOut = new Buffer();
    expect(await run(['scene', 'frames', 'scenes/scene-001', '--at', '0,end', '--check-blank'], out, errOut), errOut.text).toBe(0);

    // 3. 拼接：画幅从项目 frame.md 反查，不显式传 --canvas。
    const master = path.join(project, 'production', 'silent-master.mp4');
    out = new Buffer();
    errOut = new Buffer();
    code = await run(['concat', 'scenes/', '--out', master], out, errOut);
    expect(code, `stdout: ${out.text}\nstderr: ${errOut.text}`).toBe(0);

    // 4. 成片验收：母版应当是 60 帧、无音轨、可完整解码。
    out = new Buffer();
    errOut = new Buffer();
    expect(await run(['validate', 'video', master, '--silent', '--decode', '--expect-frames', '60'], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('校验通过');
  });

  // 覆盖校验真的在渲染前拦住：用一个会写入标记文件的假渲染器证明它一次都没被调起来。
  it('coverage mismatch stops before rendering', async () => {
    const project = tempDir();
    const binDir = tempDir();
    const marker = path.join(project, 'renderer-was-called');
    fs.writeFileSync(path.join(binDir, 'codex'), `#!/bin/sh\nset -eu\n: > '${marker}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    // 字幕跨度 10 秒，镜头只声明了 1 秒——少了 9 秒。
    fs.writeFileSync(path.join(project, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:10,000\n很长的一句\n');
    const dir = path.join(project, 'scenes', 'scene-001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:10,000\nx\n');
    fs.writeFileSync(path.join(dir, 'scene.json'), '{"id":"scene-001","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"内容"}');
    process.chdir(project);
    setenv('PATH', binDir);
    setenv('HOME', tempDir());

    let out = new Buffer();
    let errOut = new Buffer();
    expect(await run(['scene', 'run-all', 'scenes/', '--srt', 'transcription.srt', '--strict-coverage'], out, errOut), errOut.text).toBe(1);
    expect(errOut.text).toContain('字幕跨度');
    expect(fs.existsSync(marker), '渲染器被调起来了：覆盖校验必须在渲染之前拦住').toBe(false);

    // 不加 --strict-coverage 时只警告，仍然会去渲染。--retries 0：不必真的等两轮退避。
    out = new Buffer();
    errOut = new Buffer();
    await run(['scene', 'run-all', 'scenes/', '--srt', 'transcription.srt', '--retries', '0'], out, errOut);
    expect(errOut.text).toContain('警告');
    expect(fs.existsSync(marker), '不加 --strict-coverage 时应当照常渲染').toBe(true);
  });

  // 多角色叙事项目的整条链路：初始化 → 建角色 → 校验角色包 → 装配对白 → 声明镜头节拍 → 项目级一致性校验。
  it('cast narration validate', async () => {
    const project = tempDir();
    // 1. 初始化多角色项目：必须传 --skip-hyperframes，否则会联网安装。
    let r = await tryCLI(project, 'init', '--canvas', 'vertical-3x4', '--narration', 'cast', '--skip-hyperframes');
    expect(r.failed, `init 失败：${r.out}`).toBe(false);
    // 2. 生成角色骨架。
    r = await tryCLI(project, 'cast', 'new', 'heiwa');
    expect(r.failed, `cast new 失败：${r.out}`).toBe(false);
    // 手填 voiceId：cast new 留空的骨架过得了自洽校验，但过不了音色校验。
    const characterYAMLPath = path.join(project, 'cast', 'heiwa', 'character.yaml');
    const body = fs.readFileSync(characterYAMLPath, 'utf8');
    const filled = body.replaceAll('voiceId: ""', 'voiceId: "v-heiwa"');
    expect(filled, '骨架里找不到待填的 voiceId 占位符').not.toBe(body);
    fs.writeFileSync(characterYAMLPath, filled);
    // cast new 自己就把 cast/heiwa 登记进了班底。
    const rosterBody = fs.readFileSync(path.join(project, 'cast.yaml'), 'utf8');
    expect(rosterBody).toContain('cast/heiwa');
    // 3. 校验角色包：改完 character.yaml 必须重新跑一次。
    r = await tryCLI(project, 'cast', 'validate');
    expect(r.failed, `cast validate 失败：${r.out}`).toBe(false);

    // 4. 两段音频与 plan.json：都是 heiwa 说的，一段 1.0 秒、一段 0.5 秒，段间静音 200ms。
    const audioDir = path.join(project, 'production', 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    dialogueTone(path.join(audioDir, 'seg-001-heiwa.wav'), 1.0);
    dialogueTone(path.join(audioDir, 'seg-002-heiwa.wav'), 0.5);
    const plan: dialogue.Plan = {
      schema: dialogue.SchemaVersion,
      segments: [
        { index: 1, speaker: 'heiwa', voiceId: 'v-heiwa', audio: 'production/audio/seg-001-heiwa.wav', gapAfterMs: 200, lines: [{ text: '第一句', startSeconds: 0, endSeconds: 1.0 }] },
        { index: 2, speaker: 'heiwa', voiceId: 'v-heiwa', audio: 'production/audio/seg-002-heiwa.wav', gapAfterMs: 0, lines: [{ text: '第二句', startSeconds: 0, endSeconds: 0.5 }] },
      ],
    };
    fs.writeFileSync(path.join(audioDir, 'plan.json'), marshalIndent(dialogue.planToJSON(plan)));

    // 5. 装配对白。
    r = await tryCLI(project, 'dialogue', 'assemble');
    expect(r.failed, `dialogue assemble 失败：${r.out}`).toBe(false);

    // 6. 带 cast 块、但不含 beats 的 scene.json；pack_dir 指向镜头目录内自带的一份角色包拷贝。
    const sceneDir = path.join(project, 'scenes', 'scene-001');
    fs.mkdirSync(sceneDir, { recursive: true });
    fs.writeFileSync(path.join(sceneDir, 'transcript.txt'), '占位字幕');
    copyTree(path.join(project, 'cast', 'heiwa'), path.join(sceneDir, 'cast', 'heiwa'));
    const sceneJSON = `{
  "id": "scene-001",
  "duration_seconds": 1.7,
  "output": "out.mp4",
  "transcript": "transcript.txt",
  "text": "黑娃说两句话",
  "cast": {
    "pack_dir": "cast",
    "ground_y": 0.78,
    "on_stage": [
      {"id": "heiwa", "x": 0.5, "pose": "idle", "facing": "right"}
    ]
  }
}
`;
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), sceneJSON);

    // 7. 还没重算节拍时 validate cast 必然报台词行未被覆盖。
    r = await tryCLI(project, 'validate', 'cast');
    expect(r.failed, `还没重算节拍时 validate cast 不该通过：${r.out}`).toBe(true);
    expect(r.out).toContain('没有被任何镜头的 cast.beats 覆盖');

    r = await tryCLI(project, 'dialogue', 'beats');
    expect(r.failed, `dialogue beats 失败：${r.out}`).toBe(false);

    const sceneBody = fs.readFileSync(path.join(sceneDir, 'scene.json'), 'utf8');
    const written = JSON.parse(sceneBody) as { cast: { pack_dir: string; beats: { speaker: string; start: number; end: number }[] } };
    expect(written.cast.pack_dir).toBe('cast');
    expect(written.cast.beats.length).toBe(2);
    // 全局时间轴是 [0, 1.0] 与 [1.2, 1.7]，镜头起点为 0；实测时长有几十毫秒出入，用 30ms 容差。
    for (const [i, want] of [
      [0, 1.0],
      [1.2, 1.7],
    ].entries()) {
      const got = written.cast.beats[i];
      expect(got.speaker).toBe('heiwa');
      expect(Math.abs(got.start - want[0]) <= 0.03 && Math.abs(got.end - want[1]) <= 0.03, `第 ${i + 1} 拍应约为 [${want}]，得到 [${got.start}, ${got.end}]`).toBe(true);
    }

    // 8. 项目级一致性校验。
    r = await tryCLI(project, 'validate', 'cast');
    expect(r.failed, `validate cast 应当通过：${r.out}`).toBe(false);
    expect(r.out).toContain('通过');

    // 9. 死锁回归：把 scene-001 的时长改小、另起一个 scene-002 吸收剩下的时间，旧节拍越界；
    // am dialogue beats 必须仍然跑得通，跑完之后校验重新通过。
    const total = written.cast.beats[1].end;
    const shrunk = sceneBody.replace('"duration_seconds": 1.7', '"duration_seconds": 1');
    expect(shrunk).not.toBe(sceneBody);
    fs.writeFileSync(path.join(sceneDir, 'scene.json'), shrunk);
    const secondDir = path.join(project, 'scenes', 'scene-002');
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(secondDir, 'transcript.txt'), '占位字幕');
    copyTree(path.join(project, 'cast', 'heiwa'), path.join(secondDir, 'cast', 'heiwa'));
    const secondJSON = `{
  "id": "scene-002",
  "duration_seconds": ${formatG(total - 1)},
  "output": "out.mp4",
  "transcript": "transcript.txt",
  "text": "黑娃把话说完",
  "cast": {
    "pack_dir": "cast",
    "ground_y": 0.78,
    "on_stage": [
      {"id": "heiwa", "x": 0.5, "pose": "idle", "facing": "right"}
    ]
  }
}
`;
    fs.writeFileSync(path.join(secondDir, 'scene.json'), secondJSON);

    r = await tryCLI(project, 'validate', 'cast');
    expect(r.failed, `旧节拍越界时 validate cast 不该通过：${r.out}`).toBe(true);
    expect(r.out).toContain('超出镜头时长');
    r = await tryCLI(project, 'dialogue', 'beats');
    expect(r.failed, `越界的旧节拍不该挡住重算：${r.out}`).toBe(false);
    r = await tryCLI(project, 'validate', 'cast');
    expect(r.failed, `重算之后 validate cast 应当通过：${r.out}`).toBe(false);
  });

  // RunAll 并发跑 N 个镜头，每个 scene.Run 都往同一个 writer 写阶段消息：一条不能丢也不能被切开。
  it('concurrent scenes do not race on shared output', async () => {
    const project = tempDir();
    const binDir = tempDir();
    const source = path.join(tempDir(), 'source.mp4');
    makeClip(source, 'testsrc=size=320x240:rate=30:duration=1');
    fakeRenderer(binDir, source);
    fs.writeFileSync(path.join(project, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n');
    fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    const scenes = path.join(project, 'scenes');
    // 镜头数明显多于并发数，确保 worker 之间真的会同时写。
    for (const id of ['scene-001', 'scene-002', 'scene-003', 'scene-004', 'scene-005', 'scene-006']) {
      const dir = path.join(scenes, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
      // 必须带 style_guide：不声明就按默认画幅 1080x1440 校验，素材是 320x240 会被正确拦下。
      fs.copyFileSync(path.join(project, 'frame.md'), path.join(dir, 'frame.md'));
      fs.writeFileSync(path.join(dir, 'scene.json'), `{"id":"${id}","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"内容","style_guide":"frame.md"}`);
    }
    process.chdir(project);
    const ffmpegDir = path.dirname(lookPath('ffmpeg'));
    setenv('PATH', binDir + path.delimiter + ffmpegDir);
    setenv('HOME', tempDir());
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['scene', 'run-all', 'scenes/', '--jobs', '6', '--retries', '0'], out, errOut), errOut.text).toBe(0);
    expect(out.text.split('视频已渲染完成').length - 1, out.text).toBe(6);
  });
});
