// memory 操作的测试，外加整理者用量记进记忆库的用例
// （整理者的用量记在记忆库的账本里，要 onset memory consolidate）。
// 记忆库与 HOME 一律指到临时目录：绝不写开发者真实的 ~/.local/share/onset/memory。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as ledger from '@onset/engine/ledger';
import * as memory from '@onset/engine/memory';
import * as scene from '@onset/engine/scene';
import { Buffer, hasFfmpeg, lookPath, makeClip, run as execute, setenv, tempDir } from './testutil';

function writeScene(project: string, sceneJSON: string): string {
  const dir = path.join(project, 'scenes', 'scene-001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcription.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  fs.writeFileSync(path.join(dir, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n正文\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), sceneJSON);
  return dir;
}

describe('memory', () => {
  // 串起记忆的主链路：召回段真的进了渲染工具收到的提示词、每次尝试都写成经历、记忆一变镜头被判
  // Stale 且说明原因，以及整理、反馈、状态这几条命令在真实项目里能跑通。
  it.skipIf(!hasFfmpeg)('recall reaches renderer and episodes are recorded', async () => {
    const project = tempDir();
    const binDir = tempDir();
    const memoryDir = tempDir();
    const source = path.join(tempDir(), 'source.mp4');
    makeClip(source, 'testsrc=size=320x240:rate=30:duration=1');
    const script = "#!/bin/sh\nset -eu\nprintf '%s' \"$*\" > prompt.txt\n/bin/cp '" + source + "' out.mp4\n";
    fs.writeFileSync(path.join(binDir, 'codex'), script, { mode: 0o755 });
    fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\nMEMORY=on\n');
    const dir = writeScene(
      project,
      '{"id":"scene-001","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文内容"}',
    );

    const store = memory.open(memoryDir);
    const rule = memory.newMemory({
      kind: memory.KindLesson,
      name: 'cjk-font-local',
      description: '中文字体用本地文件',
      status: memory.StatusActive,
      applies_when: memory.newApplies({ features: ['cjk_text'] }),
      checked_by: ['determinism.remote-font'],
      body: '字体随镜头目录提供。\n\n反例：\n    在线字体\n\n正例：\n    本地 woff2',
    });
    store.write(rule);
    store.takeSnapshot(memory.EventManualEdit, '初始', true);

    process.chdir(project);
    setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')));
    setenv('HOME', tempDir());
    setenv('ONSET_MEMORY_DIR', memoryDir);

    const run = async (...args: string[]): Promise<string> => {
      const out = new Buffer();
      const errOut = new Buffer();
      const code = await execute(args, out, errOut);
      if (code !== 0) throw new Error(`onset ${args.join(' ')} 退出 ${code}\nstdout: ${out.text}\nstderr: ${errOut.text}`);
      return out.text;
    };
    const reportPath = path.join(project, 'report.json');
    await run('scene', 'run-all', 'scenes/', '--retries', '0');
    const prompt = fs.readFileSync(path.join(dir, 'prompt.txt'), 'utf8');
    expect(prompt, '召回段没有进渲染提示词').toContain('【cjk-font-local】');
    let episodes = store.episodes();
    expect(episodes.length, '渲染应当写下一段通过的经历并记下召回').toBe(1);
    expect(memory.passed(episodes[0])).toBe(true);
    expect(episodes[0].recalled?.[0]).toBe('cjk-font-local');
    expect(episodes[0].snapshot).toBe(1);

    // 记忆没变：已有合格产物直接跳过。
    await run('scene', 'run-all', 'scenes/', '--report-json', reportPath);
    expect(fs.readFileSync(reportPath, 'utf8'), '记忆未变时应当复用产物').toContain('输入指纹一致');
    // 记忆变了：Stale，原因点名召回的记忆。
    const extra = { ...rule, name: 'cjk-numbers', description: '中文里的数字用等宽字体', checked_by: ['output.resolution'] };
    store.write(extra);
    store.takeSnapshot(memory.EventManualEdit, '加一条', true);
    await execute(['scene', 'run-all', 'scenes/', '--report-json', reportPath], new Buffer(), new Buffer());
    expect(fs.readFileSync(reportPath, 'utf8'), '召回的记忆变化应当让镜头 Stale 并说明原因').toContain('召回的记忆变了');

    let text = await run('memory', 'report');
    expect(text, '批次报告应当列出第一批').toContain('run-');
    expect(text).toContain('1（100%）');
    text = await run('memory', 'recall', 'scenes/scene-001');
    expect(text, 'recall 预览应当列出记忆与匹配的特征').toContain('cjk-font-local');
    expect(text).toContain('cjk_text');
    await run('memory', 'feedback', 'scenes/scene-001', '--down', '--note', '颜色太刺眼', '--region', '0.1,0.1,0.5,0.5');
    episodes = store.episodes();
    expect(episodes.length, '反馈应当写成经历').toBe(2);
    expect(episodes[1].feedback?.verdict).toBe('down');

    const drafts = tempDir();
    fs.mkdirSync(path.join(drafts, 'preferences'), { recursive: true });
    const feedbackID = store.episodes()[1].id;
    const pref = memory.newMemory({
      kind: memory.KindPreference,
      name: 'calm-palette',
      description: '配色克制，避免高饱和撞色',
      status: memory.StatusTrial,
      checked_by: ['human'],
      from_episodes: [feedbackID],
      body: '主色不超过两种高饱和色。',
    });
    fs.writeFileSync(path.join(drafts, 'preferences', 'calm-palette.md'), memory.format(pref));
    expect(await run('memory', 'consolidate', '--drafts', drafts), '现成草稿应当被收录').toContain('calm-palette');
    await run('memory', 'promote', 'calm-palette');
    const statusPath = path.join(project, 'status.json');
    await run('memory', 'status', '--report-json', statusPath);
    const body = fs.readFileSync(statusPath, 'utf8');
    const status = JSON.parse(body) as { counts: Record<string, number>; snapshot: number };
    expect(status.counts['preference/active'], body).toBe(1);
    expect(status.snapshot, body).toBe(3);
    text = await run('memory', 'list');
    expect(text, '列表应当标出偏好并给出效果统计').toContain('未经机器验证');
    expect(text).toContain('codex：召回 1 次，一次通过 1 次');
    text = await run('memory', 'timeline');
    expect(text, '时间线不完整').toContain('promote');
    expect(text).toContain('episode');
    await run('memory', 'rollback', '--to', '1');
    expect(await run('memory', 'recall', 'scenes/scene-001', '--json'), '回退到快照 #1 后不该再召回后加的记忆').not.toContain('cjk-numbers');
    expect(await run('memory', 'remember', '--name', 'slow-pacing', '节奏慢一点，每个画面多停一秒'), 'remember 默认只对本项目成立').toContain('本项目');
    text = await run('memory', 'recall', 'scenes/scene-001');
    expect(text, '亲口说的偏好应当立刻被召回，且预览写明模型').toContain('slow-pacing');
    expect(text).toContain('模型 ');
  });

  // 显式 MEMORY=off 时不召回、不写经历，也不建记忆库目录。
  it.skipIf(!hasFfmpeg)('memory off leaves store untouched', async () => {
    const project = tempDir();
    const binDir = tempDir();
    const memoryDir = path.join(tempDir(), 'memory');
    const source = path.join(tempDir(), 'source.mp4');
    makeClip(source, 'testsrc=size=320x240:rate=30:duration=1');
    const script =
      "#!/bin/sh\nset -eu\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\"," +
      "\"text\":\"[[USER_MESSAGE]]视频已渲染完成\"}}'\n" +
      `/bin/cp '${source}' out.mp4\n`;
    fs.writeFileSync(path.join(binDir, 'codex'), script, { mode: 0o755 });
    fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\nMEMORY=off\n');
    writeScene(
      project,
      '{"id":"scene-001","duration_seconds":1.0,"output":"out.mp4","transcript":"transcription.srt","text":"中文"}',
    );
    process.chdir(project);
    setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')));
    setenv('HOME', tempDir());
    setenv('ONSET_MEMORY_DIR', memoryDir);
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await execute(['scene', 'run', 'scenes/scene-001'], out, errOut), `渲染失败：${errOut.text}`).toBe(0);
    expect(fs.existsSync(memoryDir), 'MEMORY=off 时不该建记忆库').toBe(false);
  });

  // 阅读时间问题按 scene_id 记到对应镜头，不改变检查命令本身的退出码。
  it('validate reads records findings per scene', async () => {
    const project = tempDir();
    const memoryDir = tempDir();
    fs.writeFileSync(path.join(project, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
    for (const id of ['scene-001', 'scene-002']) {
      const dir = path.join(project, 'scenes', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
      fs.writeFileSync(path.join(dir, 'scene.json'), `{"id":"${id}","duration_seconds":2,"output":"out.mp4","transcript":"transcript.srt","text":"中文"}`);
    }
    fs.mkdirSync(path.join(project, 'production'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'production', 'visible-event-inventory.json'),
      `{"schema":1,"fps":30,"events":[
		{"event_id":"e1","scene_id":"scene-002","text":"一句很长很长很长很长的标题","role":"title","enter_frame":0,"readable_start_frame":0,"readable_end_frame_exclusive":6,"exit_end_frame":6}]}`,
    );
    process.chdir(project);
    setenv('HOME', tempDir());
    setenv('ONSET_MEMORY_DIR', memoryDir);
    const out = new Buffer();
    expect(await execute(['validate', 'reads'], out, out), `阅读时间不够应当失败：${out.text}`).not.toBe(0);
    const episodes = memory.open(memoryDir).episodes();
    expect(episodes.length, '问题应当记到 scene-002').toBe(1);
    expect(episodes[0].scene_id).toBe('scene-002');
    expect(episodes[0].source).toBe(memory.SourceCheck);
    expect(episodes[0].checks?.[0]).toBe('reads.duration');
  });

  // 整理者不属于哪个项目，用量记在记忆库的账本里。
  it('consolidate records drafter usage in memory store', async () => {
    const memoryDir = tempDir();
    const store = memory.open(memoryDir);
    const sceneDir = path.join(tempDir(), 'scene-001');
    fs.mkdirSync(sceneDir, { recursive: true });
    store.recordAttempt(
      scene.newScene({ id: 'scene-001', directory: sceneDir, renderer: 'codex' }),
      scene.newAttempt({
        scene_id: 'scene-001',
        renderer: 'codex',
        outcome: scene.OutcomeVerificationFailed,
        problems: ['多出 1 帧'],
        checks: [scene.CheckOutputFrames],
      }),
      { source: memory.SourceRender, run: 'run-1' },
    );
    const bin = tempDir();
    const script = "#!/bin/sh\ncat > /dev/null\necho '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":70,\"output_tokens\":7}}'\n";
    fs.writeFileSync(path.join(bin, 'codex'), script, { mode: 0o755 });
    process.chdir(tempDir());
    setenv('PATH', bin + path.delimiter + process.env.PATH);
    setenv('HOME', tempDir());
    setenv('ORCHESTRATOR', 'codex');
    setenv('ONSET_MEMORY_DIR', memoryDir);
    const out = new Buffer();
    expect(await execute(['memory', 'consolidate', '--min-count', '1', '--all'], out, out), out.text).toBe(0);
    const entries = ledger.read(ledger.memoryFile(memoryDir)) ?? [];
    expect(entries.length, out.text).toBe(1);
    expect(entries[0].source).toBe(ledger.SourceConsolidate);
    expect(entries[0].usage?.input_tokens).toBe(70);
  });
});
