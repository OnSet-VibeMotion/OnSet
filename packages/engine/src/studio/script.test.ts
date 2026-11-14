import './testsupport';
import path from 'node:path';
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
    expect(body.change_log.content).toBe('- 新增开场');

    writeStudioFile(path.join(root, 'production', 'script-final.md'), '@{a}没闭合\n');
    ({ status, body } = await studioRequest(s, 'GET', '/api/script'));
    expect(status).toBe(200);
    expect(body.parse_error).toContain('第 1 行');
    expect(body.content).toBe('@{a}没闭合\n');
    expect(body.blocks).toBeUndefined();
  });
});
