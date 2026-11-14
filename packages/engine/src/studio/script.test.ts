import './testsupport';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { startStudio, studioRequest, tempDir, writeStudioFile } from './testsupport';

describe('script', () => {
  // 口播稿页：终稿优先于原稿；解析成段落与标记，附估算时长、配音时长与修改记录；
  // 标记写错时给出位置并带回原文，不让页面空着。
  it('script endpoint', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'onset.conf'), '');
    writeStudioFile(path.join(root, 'SCRIPT.md'), '原稿');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });

    let { status, body } = await studioRequest(s, 'GET', '/api/script');
    expect(status).toBe(200);
    expect(body.path).toBe('SCRIPT.md');
    expect(body.final).toBe(false);
    expect(body.blocks, '只有原稿时原样给出').toBeUndefined();

    writeStudioFile(path.join(root, 'production', 'script-final.md'), '# 开场\n\n在<2025年|二零二五年>，@{cost}大模型很贵@{/cost}。\n');
    writeStudioFile(path.join(root, 'production', 'script-change-log.md'), '- 新增开场');
    writeStudioFile(path.join(root, 'production', 'audio', 'voice.srt'), '1\n00:00:00,000 --> 00:00:03,500\n在2025年，大模型很贵。\n');
    expect((await studioRequest(s, 'GET', '/api/script')).body.voice, '字幕不等于可播放的音频').toBeUndefined();
    writeStudioFile(path.join(root, 'production/audio/voice.wav'), 'audio');
    ({ status, body } = await studioRequest(s, 'GET', '/api/script'));
    expect(status).toBe(200);
    expect(body.path).toBe('production/script-final.md');
    expect(body.final).toBe(true);
    expect(body.parse_error).toBeUndefined();
    expect(body.blocks).toHaveLength(2);
    expect(body.blocks[0].kind).toBe('heading');
    expect(body.stats.phrases).toBe(1);
    expect(body.stats.units).toBeGreaterThanOrEqual(10);
    expect(body.estimate_seconds).toBeGreaterThan(0);
    expect(body.voice.seconds).toBe(3.5);
    expect(body.voice.path).toBe('production/audio/voice.wav');
    expect(body.change_log.content).toBe('- 新增开场');

    writeStudioFile(path.join(root, 'production', 'script-final.md'), '@{a}没闭合\n');
    ({ status, body } = await studioRequest(s, 'GET', '/api/script'));
    expect(status).toBe(200);
    expect(body.parse_error).toContain('第 1 行');
    expect(body.content).toBe('@{a}没闭合\n');
    expect(body.blocks).toBeUndefined();
  });

  it('finds versioned audio without subtitles, maps aligned words and never reads outside the project', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'onset.conf'), '');
    writeStudioFile(path.join(root, 'production/script-final.md'), '# 开场\n\n你好，@{year}<2025|二零二五>@{/year}。');
    writeStudioFile(path.join(root, 'production/audio/voice-v02.wav'), 'audio');
    writeStudioFile(path.join(root, 'production/audio/voice-v02.tts/align.json'), JSON.stringify([
      { text: '你', start: 0.2, end: 0.5 }, { text: '好', start: 0.6, end: 1 },
      { text: '二', start: 1.2, end: 1.4 }, { text: '零', start: 1.4, end: 1.6 },
      { text: '二', start: 1.6, end: 1.8 }, { text: '五', start: 1.8, end: 2 },
    ]));
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { body } = await studioRequest(s, 'GET', '/api/script');
    expect(body.voice.path).toBe('production/audio/voice-v02.wav');
    expect(body.voice.timing).toBe('aligned');
    expect(body.blocks[1].nodes[0].timings.slice(0, 2)).toEqual([{ start: 0.2, end: 0.5 }, { start: 0.6, end: 1 }]);
    expect(body.blocks[1].nodes[1].children[0].timings).toHaveLength(4);
    writeStudioFile(path.join(root, 'production/audio/voice.wav'), 'canonical');
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice.path).toBe('production/audio/voice.wav');
    ({ body } = await studioRequest(s, 'GET', '/api/script?audio=production%2Faudio%2Fvoice-v02.wav'));
    expect(body.voice.path).toBe('production/audio/voice-v02.wav');
    const outside = path.join(tempDir(), 'outside.wav');
    fs.writeFileSync(outside, 'private');
    fs.symlinkSync(outside, path.join(root, 'production/audio/voice-outside.wav'));
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.audio_options.map((audio: { path: string }) => audio.path)).not.toContain('production/audio/voice-outside.wav');
  });

  it('accepts managed alignment written before audio, invalidates changed markup and rejects stale evidence', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'onset.conf'), '');
    const script = path.join(root, 'production/script-final.md');
    const audio = path.join(root, 'production/audio/voice.wav');
    const evidence = path.join(root, 'production/audio/voice.tts/align.json');
    writeStudioFile(script, '# 原标题\n\n你好');
    writeStudioFile(evidence, JSON.stringify([{ text: '你', start: 0.2, end: 0.5 }, { text: '好', start: 0.6, end: 1 }]));
    fs.utimesSync(evidence, 1000, 1000);
    writeStudioFile(path.join(root, 'production/audio/voice.tts/audio.wav'), 'same-audio');
    writeStudioFile(audio, 'same-audio');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { body } = await studioRequest(s, 'GET', '/api/script');
    expect(body.voice.timing).toBe('aligned');
    writeStudioFile(script, '# 新标题\n\n@{hello}你好@{/hello}');
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.blocks[0].text).toBe('新标题');
    expect(body.blocks[1].nodes[0].id).toBe('hello');
    expect(body.blocks[1].nodes[0].children[0].timings[0].start).toBe(0.2);
    writeStudioFile(audio, 'other-take');
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice.timing).toBe('estimated');
    expect(body.blocks[1].nodes[0].children[0].timings).toBeUndefined();
    fs.utimesSync(evidence, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    writeStudioFile(script, '完全不同的文稿');
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice.timing).toBe('estimated');
  });
});
