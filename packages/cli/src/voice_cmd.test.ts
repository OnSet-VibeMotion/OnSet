import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allOps } from './ops/op';
import { describeTools, prepareCall } from './toolsmcp';
import { Buffer, hasFfmpeg, run, setenv, tempDir } from './testutil';

describe('voice ops', () => {
  it('gives the orchestrator list, get, save and default, but no way to delete a voice', () => {
    const names = allOps().map((op) => op.name).filter((name) => name.startsWith('voice_'));
    expect(names.sort()).toEqual(['voice_catalog', 'voice_default', 'voice_design', 'voice_get', 'voice_list', 'voice_save', 'voice_synthesize']);
  });

  it('voice_get without a default voice says how to get one', async () => {
    setenv('ONSET_VOICES_DIR', tempDir());
    const out = new Buffer();
    expect(await run(['voice', 'get'], out)).toBe(1);
    expect(out.text).toContain('voice_save()');
  });

  it('exposes creation parameters over MCP without raw commands or model paths', () => {
    const tools = describeTools('orchestrator');
    const op = tools.find((tool) => tool.name === 'voice_synthesize')!;
    expect(op).toBeDefined();
    expect(prepareCall(op, { text: '你好。', speed: 0.98, voice: 'speaker' })).toMatchObject({ text: '你好。', speed: '0.98' });
    for (const key of ['command', 'args', 'model', 'ref_audio', 'ref_text']) expect(op.inputSchema.properties).not.toHaveProperty(key);
    expect(describeTools('renderer').some((tool) => tool.name === 'voice_synthesize')).toBe(false);
  });

  it('rejects files outside the project before running a provider', async () => {
    const root = tempDir();
    process.chdir(root);
    setenv('TTS_PROVIDER', 'edge');
    const out = new Buffer();
    expect(await run(['voice', 'synthesize', '--text', '你好', '--output', '../outside.wav'], out)).toBe(1);
    expect(out.text).toContain('项目目录内');
  });
});

describe.skipIf(!hasFfmpeg)('voice ops with real ffmpeg', () => {
  it.skipIf(process.platform === 'win32')('runs a provider through the operation and publishes real 48kHz stereo audio without overwriting it', async () => {
    const root = tempDir();
    const bin = tempDir();
    const original = path.join(root, 'original.wav');
    expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=1', original]).status).toBe(0);
    fs.writeFileSync(path.join(bin, 'edge-tts'), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.copyFileSync(${JSON.stringify(original)},args[args.indexOf('--write-media')+1]);fs.writeFileSync(args[args.indexOf('--write-subtitles')+1],'1\\n00:00:00,000 --> 00:00:01,000\\n你好\\n');`, { mode: 0o755 });
    setenv('ONSET_BIN_DIR', bin);
    setenv('TTS_PROVIDER', 'edge');
    process.chdir(root);
    const out = new Buffer();
    const args = ['voice', 'synthesize', '--text', '你好', '--voice', 'zh-CN-YunxiNeural'];
    expect(await run(args, out), out.text).toBe(0);
    const audio = path.join(root, 'production/audio/voice.wav');
    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', audio], { encoding: 'utf8' }).stdout);
    expect(probe.streams[0]).toMatchObject({ codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 });
    const before = fs.readFileSync(audio);
    expect(await run(args, new Buffer())).toBe(1);
    expect(fs.readFileSync(audio)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'production/audio/voice.tts/001/raw.srt'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('decodes and joins Tencent responses using measured segment durations', async () => {
    const root = tempDir();
    const bin = tempDir();
    const original = path.join(root, 'original.wav');
    expect(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=1', original]).status).toBe(0);
    fs.writeFileSync(path.join(bin, 'tccli'), `#!${process.execPath}\nconst fs=require('node:fs');process.stdout.write(JSON.stringify({Response:{Audio:fs.readFileSync(${JSON.stringify(original)}).toString('base64'),Subtitles:[]}}));`, { mode: 0o755 });
    setenv('ONSET_BIN_DIR', bin);
    setenv('TTS_PROVIDER', 'tencent');
    process.chdir(root);
    const out = new Buffer();
    expect(await run(['voice', 'synthesize', '--text', '甲'.repeat(301), '--voice', '101001'], out), out.text).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'production/audio/voice.tts/report.json'), 'utf8'));
    expect(report.duration_seconds).toBeCloseTo(3, 3);
    expect(report.segments.map((s: { start_seconds: number }) => s.start_seconds)).toEqual([0, 1, 2]);
  });

  it('saves a project clip into the user library and hands back what Breeze needs to clone it', async () => {
    const library = tempDir();
    setenv('ONSET_VOICES_DIR', library);
    const project = tempDir();
    fs.mkdirSync(path.join(project, 'production', 'audio'), { recursive: true });
    const clip = path.join(project, 'production', 'audio', 'try-2.wav');
    expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=5', clip]).status).toBe(0);
    fs.writeFileSync(path.join(project, 'production', 'audio', 'try-text.txt'), '今天我们来聊聊，它为什么改变了整个行业。\n');
    process.chdir(project);

    const saved = new Buffer();
    expect(await run(['voice', 'save', '沉稳男声', '--audio', 'production/audio/try-2.wav', '--text-file', 'production/audio/try-text.txt'], saved), saved.text).toBe(0);
    expect(saved.text).toContain('是默认音色');

    const got = new Buffer();
    expect(await run(['voice', 'get'], got), got.text).toBe(0);
    expect(got.text).toContain(path.join(library, '沉稳男声', 'reference.wav'));
    expect(got.text).toContain('文字稿：今天我们来聊聊，它为什么改变了整个行业。');

    const both = new Buffer();
    expect(await run(['voice', 'save', 'x', '--audio', 'production/audio/try-2.wav'], both)).toBe(1);
    expect(both.text).toContain('text 与 text_file 要给且只给一个');
  });
});
