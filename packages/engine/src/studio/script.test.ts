import './testsupport';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as align from '../align';
import { goodSVG, goodYAML } from '../cast/fixtures';
import * as dialogue from '../dialogue';
import { recordFlow } from '../flow';
import { marshal } from '../gojson';
import { setEnv, startStudio, studioRequest, tempDir, writeStudioFile } from './testsupport';

describe('script', () => {
  it('keeps speaker labels out of spoken text and follows dialogue cues in order', async () => {
    const root = tempDir();
    const write = (file: string, content: string) => writeStudioFile(path.join(root, file), content);
    setEnv('TTS_PROVIDER', 'minimax');
    write('cast.yaml', 'schema: cast/v1\npacks: [cast/host, cast/guest]\ndefaults:\n  ground_y: 0.78\n');
    write('cast/host/character.yaml', goodYAML.replace('id: heiwa', 'id: host').replace('name: 黑娃', 'name: 主持人'));
    write('cast/host/rig.svg', goodSVG);
    write('cast/guest/character.yaml', goodYAML.replace('id: heiwa', 'id: guest').replace('v-1', 'v-guest'));
    write('cast/guest/rig.svg', goodSVG);
    const draft = '# 访谈\n\nhost: 你好。\nhost: <API|A P I>呢？\nguest：你好。';
    write('production/script-final.md', draft);
    write('production/audio/voice.wav', 'audio');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { body } = await studioRequest(s, 'GET', '/api/script');
    expect(body.dialogue).toMatchObject({
      provider: 'minimax',
      roles: [
        { id: 'host', name: '主持人', voice_id: 'v-1' },
        { id: 'guest', voice_id: 'v-guest' },
      ],
    });
    expect(body.blocks.slice(1).map((block: { speaker: string }) => block.speaker)).toEqual(['host', 'host', 'guest']);
    expect(body.stats.units).toBe(8);
    expect(body.voice).toBeUndefined();
    expect(align.loadProjectScript(root, path.join(root, 'production/script-final.md')).spokenText()).toBe(
      '你好。\nA P I呢？\n你好。\n',
    );

    const lines = [
      { srtIndex: 1, speaker: 'host', text: '你好。API呢？', startSeconds: 0, endSeconds: 2 },
      { srtIndex: 2, speaker: 'guest', text: '你好。', startSeconds: 3, endSeconds: 4 },
    ];
    dialogue.writeSRT(path.join(root, dialogue.SRTRelPath), lines);
    dialogue.writeResultJSON(
      {
        schema: dialogue.SchemaVersion,
        lines,
        segments: [
          {
            index: 0,
            speaker: 'host',
            voiceId: 'v-1',
            audio: 'first.wav',
            startSeconds: 0,
            endSeconds: 2,
            gapAfterMs: 1000,
          },
          {
            index: 1,
            speaker: 'guest',
            voiceId: 'v-guest',
            audio: 'second.wav',
            startSeconds: 3,
            endSeconds: 4,
            gapAfterMs: 0,
          },
        ],
      },
      path.join(root, dialogue.DialogueRelPath),
    );
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice).toMatchObject({ seconds: 4, timing: 'dialogue' });
    expect(body.blocks[1].time.start).toBe(0);
    expect(body.blocks[2].time.start).toBeGreaterThan(0);
    expect(body.blocks[3].time).toEqual({ start: 3, end: 4 });

    const host = path.join(root, 'cast/host/character.yaml');
    const originalHost = fs.readFileSync(host, 'utf8');
    fs.writeFileSync(host, originalHost.replace('v-1', 'v-new'));
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice).toBeUndefined();
    setEnv('TTS_PROVIDER', 'edge');
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice).toBeUndefined();
    setEnv('TTS_PROVIDER', 'minimax');
    fs.writeFileSync(host, originalHost);

    write('production/script-final.md', draft.replace('guest：你好', 'host：你好'));
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice).toBeUndefined();
    write('production/script-final.md', draft + '\n这行没有角色');
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.parse_error).toContain('第 6 行');
  });

  it.skipIf(process.platform === 'win32')(
    'recognizes a linked dialogue script when alignment resolves the link first',
    () => {
      const root = tempDir();
      writeStudioFile(path.join(root, 'cast.yaml'), 'schema: cast/v1\n');
      const draft = path.join(root, 'production/dialogue-draft.md');
      writeStudioFile(draft, 'host: 你好。');
      const link = path.join(root, 'production/script-final.md');
      fs.symlinkSync('dialogue-draft.md', link);
      expect(align.loadProjectScript(root, link).spokenText()).toBe('你好。\n');
      expect(align.loadProjectScript(root, fs.realpathSync(link)).spokenText()).toBe('你好。\n');
      const other = path.join(root, 'production/other.md');
      writeStudioFile(other, 'note: 你好。');
      expect(align.loadProjectScript(root, other).spokenText()).toBe('note: 你好。\n');
    },
  );

  it('offers conversion on a recorded speech project and keeps colon-prefixed solo text', async () => {
    const root = tempDir();
    recordFlow(root, { id: 'speech', canvas: 'vertical-3x4' });
    writeStudioFile(path.join(root, 'production/script-final.md'), 'note: 你好');
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { body } = await studioRequest(s, 'GET', '/api/script');
    expect(body.can_convert_to_dialogue).toBe(true);
    expect(body.blocks[0]).toEqual({ kind: 'para', nodes: [{ kind: 'text', text: 'note: 你好' }] });
    recordFlow(root, { id: 'song', canvas: 'vertical-3x4' });
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.can_convert_to_dialogue).toBeUndefined();
  });

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

    writeStudioFile(
      path.join(root, 'production', 'script-final.md'),
      '# 开场\n\n在<2025年|二零二五年>，@{cost}大模型很贵@{/cost}。\n',
    );
    writeStudioFile(path.join(root, 'production', 'script-change-log.md'), '- 新增开场');
    writeStudioFile(
      path.join(root, 'production', 'audio', 'voice.srt'),
      '1\n00:00:00,000 --> 00:00:03,500\n在2025年，大模型很贵。\n',
    );
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
    writeStudioFile(
      path.join(root, 'production/audio/voice-v02.tts/align.json'),
      JSON.stringify([
        { text: '你', start: 0.2, end: 0.5 },
        { text: '好', start: 0.6, end: 1 },
        { text: '二', start: 1.2, end: 1.4 },
        { text: '零', start: 1.4, end: 1.6 },
        { text: '二', start: 1.6, end: 1.8 },
        { text: '五', start: 1.8, end: 2 },
      ]),
    );
    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    let { body } = await studioRequest(s, 'GET', '/api/script');
    expect(body.voice.path).toBe('production/audio/voice-v02.wav');
    expect(body.voice.timing).toBe('aligned');
    expect(body.blocks[1].nodes[0].timings.slice(0, 2)).toEqual([
      { start: 0.2, end: 0.5 },
      { start: 0.6, end: 1 },
    ]);
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
    expect(body.audio_options.map((audio: { path: string }) => audio.path)).not.toContain(
      'production/audio/voice-outside.wav',
    );
  });

  it('accepts managed alignment written before audio, invalidates changed markup and rejects stale evidence', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'onset.conf'), '');
    const script = path.join(root, 'production/script-final.md');
    const audio = path.join(root, 'production/audio/voice.wav');
    const evidence = path.join(root, 'production/audio/voice.tts/align.json');
    writeStudioFile(script, '# 原标题\n\n你好');
    writeStudioFile(
      evidence,
      JSON.stringify([
        { text: '你', start: 0.2, end: 0.5 },
        { text: '好', start: 0.6, end: 1 },
      ]),
    );
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

  it('falls back to voice.srt and voice.tts/report.json timings and tolerates minor interpolated tokens', async () => {
    const root = tempDir();
    writeStudioFile(path.join(root, 'onset.conf'), '');
    const draft =
      '# 第一章\n\n在<2025年|二零二五年>，@{model}<R-CNN|R C N N>@{/model}开启了新阶段。\n\n第二段停顿后继续讲。';
    writeStudioFile(path.join(root, 'production/script-final.md'), draft);
    writeStudioFile(path.join(root, 'production/audio/voice.tts/audio.wav'), 'managed-wav');
    writeStudioFile(path.join(root, 'production/audio/voice.wav'), 'managed-wav');
    writeStudioFile(
      path.join(root, 'production/audio/voice.tts/report.json'),
      marshal({
        duration_seconds: 12.65,
        paragraph_pause_ms: 650,
        segments: [
          {
            audio: '001/audio.wav',
            text: '在二零二五年，R C N N开启了新阶段。',
            start_seconds: 0,
            duration_seconds: 6.0,
            pause_after_ms: 650,
          },
          { audio: '002/audio.wav', text: '第二段停顿后继续讲。', start_seconds: 6.65, duration_seconds: 6.0 },
        ],
      }),
    );

    const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
    // Tier 3：尚未跑对齐、也没有 voice.srt，但有同源 voice.tts/report.json → 按配音段落定时并扣除段间静音。
    let { body } = await studioRequest(s, 'GET', '/api/script');
    expect(body.voice.timing).toBe('segmented');
    const para1First = body.blocks[1].nodes[0].timings[0];
    const para2First = body.blocks[2].nodes[0].timings[0];
    expect(para1First.start).toBeCloseTo(0, 2);
    expect(para2First.start).toBeCloseTo(6.65, 2);

    // Tier 2：缺 align.json 但存在 voice.srt → 优先命中字幕句级时间。
    const srtPath = path.join(root, 'production/audio/voice.srt');
    writeStudioFile(
      srtPath,
      '1\n00:00:00,200 --> 00:00:05,800\n在2025年，R-CNN开启了新阶段。\n\n2\n00:00:07,100 --> 00:00:12,400\n第二段停顿后继续讲。\n',
    );
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(srtPath, future, future);
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice.timing).toBe('subtitled');
    expect(body.blocks[1].nodes[0].timings[0].start).toBeCloseTo(0.2, 2);
    expect(body.blocks[2].nodes[0].timings[0].start).toBeCloseTo(7.1, 2);

    // Tier 1：存在 align.json 且允许少量插值（<=5%）仍保持 aligned，不整篇退回估算。
    const longDraft = '一二三四五六七八九十一二三四五六七八九十';
    writeStudioFile(path.join(root, 'production/script-final.md'), longDraft);
    const alignPath = path.join(root, 'production/audio/align.json');
    const chars = [...longDraft];
    // 故意漏掉第 10 个字（1/20 = 5% 插值，match_rate = 0.95）。
    const entries = chars.filter((_, i) => i !== 9).map((ch, i) => ({ text: ch, start: i * 0.5, end: i * 0.5 + 0.4 }));
    writeStudioFile(alignPath, marshal(entries));
    const later = new Date(Date.now() + 4000);
    fs.utimesSync(alignPath, later, later);
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice.timing).toBe('aligned');
    expect(body.blocks[0].nodes[0].timings[0]).toEqual({ start: 0, end: 0.4 });
    expect(body.blocks[0].nodes[0].timings[9]).toBeNull();
    expect(body.blocks[0].nodes[0].timings[19]).toEqual({ start: 9, end: 9.4 });

    // 替换 voice.wav 后旧 voice.tts/report.json 不再同源：不能用旧报告的 12.65s 拒绝新的 58s 有效对齐。
    writeStudioFile(path.join(root, 'production/audio/voice.wav'), 'replaced-longer-wav');
    const longEntries = chars.map((ch, i) => ({ text: ch, start: i * 2.9, end: i * 2.9 + 2.8 }));
    writeStudioFile(alignPath, marshal(longEntries));
    const afterReplace = new Date(Date.now() + 5000);
    fs.utimesSync(alignPath, afterReplace, afterReplace);
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice.timing).toBe('aligned');
    expect(body.blocks[0].nodes[0].timings[19]).toEqual({ start: 55.1, end: 57.9 });

    // 严重残缺的 align.json（漏掉一半字）安全降级回 estimated。
    writeStudioFile(alignPath, marshal(entries.slice(0, 8)));
    const evenLater = new Date(Date.now() + 6000);
    fs.utimesSync(alignPath, evenLater, evenLater);
    ({ body } = await studioRequest(s, 'GET', '/api/script'));
    expect(body.voice.timing).toBe('estimated');
  });
});
