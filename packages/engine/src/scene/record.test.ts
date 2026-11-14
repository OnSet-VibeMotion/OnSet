import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as mediaprobe from '../mediaprobe';
import { parse as parseMedia } from '../mediaprobe/mediaprobe';
import { newConfig } from '../config';
import { attemptLog, OutcomeFailed, OutcomeSucceeded, OutcomeVerificationFailed, parseAttempt, type Attempt } from './attempt';
import { changedInputs, fingerprint, loadRecord, writeRecord } from './record';
import { run } from './run';
import { load, outputPath, streamLog, withRenderWorkers, withRetryNote, type Scene } from './scene';
import { HyperFramesSkillName } from './skills';
import { executable, fakeFfprobe, Sink, tempDir, writeScene } from './testsupport';

/** 跑一次假渲染：吐出一条用量事件、写出产物，返回 run 的结果。 */
async function runFakeCodex(s: Scene, exitCode: string): Promise<unknown> {
  const bin = tempDir();
  let restoreProbe = () => {};
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'codex.cjs'), `console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:2,output_tokens:5}}));require('node:fs').writeFileSync('out.mp4','video');process.exit(${Number(exitCode)});`);
    // 与真实 npm 包装相同，由 windowsCommand 解析为 Node + JS，支持多行提示词。
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\codex.cjs" %*\r\n');
    const probe = new mediaprobe.Toolchain('fixture', bin, {});
    probe.probe = (file) => parseMedia('{"streams":[{"codec_type":"video","codec_name":"h264","width":1080,"height":1440,"r_frame_rate":"30/1","duration":"1.000"}],"format":{"duration":"1.000"}}', file);
    probe.countFrames = () => 30;
    const spy = vi.spyOn(mediaprobe, 'newToolchain').mockReturnValue(probe);
    restoreProbe = () => spy.mockRestore();
  } else executable(
    bin,
    'codex',
    `
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":12,"cached_input_tokens":2,"output_tokens":5}}'
printf video > out.mp4
exit ${exitCode}
`,
  );
  fakeFfprobe(bin, {});
  const cfg = newConfig({ orchestrator: 'claude', renderer: 'codex', ttsProvider: 'minimax' });
  try {
    await run(s, cfg, false, { PATH: bin, HOME: tempDir() }, new Sink(), 0.15);
    return null;
  } catch (err) {
    return err;
  } finally {
    restoreProbe();
  }
}

function readAttempt(file: string): Attempt {
  return parseAttempt(fs.readFileSync(file));
}

const plainScene = '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}';

describe('render record', () => {
  it('run writes the record and the attempt on success', async () => {
    const s = load(writeScene(plainScene));
    expect(await runFakeCodex(s, '0')).toBeNull();
    const record = loadRecord(s);
    expect(record, '通过校验后应写下渲染记录').not.toBeNull();
    expect(record!.fingerprint).not.toBe('');
    expect(record!.parts!['file:scene.json']).toBeTruthy();
    expect(record!.parts!.prompt).toBeTruthy();
    const attempt = readAttempt(attemptLog(s));
    expect(attempt.outcome).toBe(OutcomeSucceeded);
    expect(attempt.fingerprint).toBe(record!.fingerprint);
    expect(attempt.exit_code).toBe(0);
    expect(attempt.usage?.input_tokens, '应从输出流读到用量').toBe(12);
    expect(attempt.usage?.output_tokens).toBe(5);
  });

  // 手动重跑镜头不能抹掉上一次的日志与产物。
  it('run archives the previous attempt', async () => {
    const dir = writeScene(plainScene);
    const s = load(dir);
    expect(await runFakeCodex(s, '0')).toBeNull();
    fs.writeFileSync(streamLog(s), '第一次的现场\n');
    const err = (await runFakeCodex(s, '3')) as Error;
    expect(err?.message, '应报渲染器退出码').toContain('退出码 3');
    expect(fs.readFileSync(path.join(dir, 'attempts', 'attempt-01', path.basename(streamLog(s))), 'utf8'), '上一次的日志应归档').toBe('第一次的现场\n');
    expect(fs.existsSync(path.join(dir, 'attempts', 'attempt-01', 'out.mp4')), '上一次的产物应一起归档').toBe(true);
    expect(loadRecord(s), '失败的重渲染不应留下可用的渲染记录').toBeNull();
    const attempt = readAttempt(attemptLog(s));
    expect(attempt.outcome).toBe(OutcomeFailed);
    expect(attempt.exit_code).toBe(3);
  });

  it('run records a verification failure', async () => {
    const s = load(writeScene('{"id":"scene-001","duration_seconds":2,"output":"out.mp4","transcript":"transcript.srt","text":"hello"}'));
    expect(await runFakeCodex(s, '0'), '时长不符应当失败').not.toBeNull();
    const attempt = readAttempt(attemptLog(s));
    expect(attempt.outcome, '校验失败应单独记录').toBe(OutcomeVerificationFailed);
    expect(attempt.problems?.length ?? 0).toBeGreaterThan(0);
  });

  it('fingerprint tracks declared inputs', () => {
    const dir = writeScene(plainScene);
    const s = load(dir);
    const skills = tempDir();
    fs.writeFileSync(path.join(skills, 'SKILL.md'), 'v1');
    const resolved = { [HyperFramesSkillName]: skills };
    const base = fingerprint(s, 'codex', resolved);
    // 重试说明与 worker 数是调度层临时填的，不算输入。
    const again = fingerprint(withRenderWorkers(withRetryNote(s, '上次失败'), 4), 'codex', resolved);
    expect(again.fingerprint, `重试说明不应改变指纹：${changedInputs(again, base)}`).toBe(base.fingerprint);
    // 渲染器在镜头目录里写的合成代码不是输入。
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>');
    expect(fingerprint(s, 'codex', resolved).fingerprint, '渲染器自己的产出不应改变指纹').toBe(base.fingerprint);
    fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\n改过\n');
    const changed = fingerprint(s, 'codex', resolved);
    expect(changedInputs(changed, base), '应只报字幕变了').toEqual(['file:transcript.srt']);
    expect(changedInputs(fingerprint(s, 'claude', resolved), base), '换渲染工具应改变指纹').toContain('renderer');
    // 挪动技能目录不算变化，改技能内容才算。
    const moved = tempDir();
    fs.writeFileSync(path.join(moved, 'SKILL.md'), 'v1');
    const relocated = fingerprint(s, 'codex', { [HyperFramesSkillName]: moved });
    expect(changedInputs(relocated, changed), '技能目录换位置不应改变指纹').not.toContain('prompt');
    expect(relocated.fingerprint).toBe(changed.fingerprint);
    const edited = tempDir();
    fs.writeFileSync(path.join(edited, 'SKILL.md'), 'v2');
    const updated = fingerprint(s, 'codex', { [HyperFramesSkillName]: edited });
    expect(changedInputs(updated, changed), '技能内容变化应单独报出').toEqual(['skill:' + HyperFramesSkillName]);
  });

  // 记录描述的是那一个文件，产物被换掉后不能再替新文件作保。
  it('loadRecord rejects a replaced output', () => {
    const s = load(writeScene(plainScene));
    fs.writeFileSync(outputPath(s), 'video');
    writeRecord(s, { fingerprint: 'abc', parts: { prompt: 'x' } });
    expect(loadRecord(s), '刚写下的记录应当可用').not.toBeNull();
    fs.writeFileSync(outputPath(s), 'other');
    expect(loadRecord(s), '产物被替换后记录不应再适用').toBeNull();
  });

  // TS 额外：写出的渲染记录与 Go 的 json.MarshalIndent 逐字节一致（parts 按键排序）。
  it('writes the record in Go layout', () => {
    const s = load(writeScene(plainScene));
    fs.writeFileSync(outputPath(s), 'video');
    writeRecord(s, { fingerprint: 'abc', parts: { prompt: 'x', onset: 'y', 'file:<a>': 'z' } });
    const sha = crypto.createHash('sha256').update('video').digest('hex');
    expect(fs.readFileSync(path.join(s.directory, '.onset-render.json'), 'utf8')).toBe(
      '{\n  "schema": 2,\n  "output": "out.mp4",\n  "output_size": 5,\n' +
        `  "output_sha256": "${sha}",\n  "fingerprint": "abc",\n` +
        '  "parts": {\n    "file:\\u003ca\\u003e": "z",\n    "onset": "y",\n    "prompt": "x"\n  }\n}\n',
    );
  });
});
