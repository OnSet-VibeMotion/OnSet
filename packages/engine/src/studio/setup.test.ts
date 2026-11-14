import './testsupport';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSetupTask, splitStage } from './setup';
import { setEnv, startStudio, studioRequest, tempDir } from './testsupport';

async function waitIdle(s: ReturnType<typeof startStudio>): Promise<any> {
  for (let i = 0; i < 200; i++) {
    const { body } = await studioRequest(s, 'GET', '/api/setup');
    if (!body.task?.running) return body;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('安装没有结束');
}

describe('setup installer', () => {
  afterEach(() => resetSetupTask());

  it('splits the percentage off a stage line', () => {
    expect(splitStage('下载 ffmpeg 45%')).toEqual({ stage: '下载 ffmpeg', percent: 45 });
    expect(splitStage('安装 HyperFrames CLI')).toEqual({ stage: '安装 HyperFrames CLI' });
  });

  it('rejects unknown items and malformed proxies', async () => {
    const s = startStudio({ projectPath: tempDir(), configPath: path.join(tempDir(), 'projects.json') });
    expect((await studioRequest(s, 'POST', '/api/setup/run', JSON.stringify({ only: ['nope'] }))).status).toBe(400);
    expect((await studioRequest(s, 'POST', '/api/setup/run', JSON.stringify({ proxy: 'not a url' }))).status).toBe(400);
    expect((await studioRequest(s, 'GET', '/api/setup/run')).status).toBe(405);
  });

  // 端到端测试的开关打开时当作全部就绪：安装立即结束、没有要装的项，不联网。
  it('runs in the background and reports the task through GET /api/setup', async () => {
    setEnv('AM_STUDIO_SKIP_SKILL_INSTALL', '1');
    const s = startStudio({ projectPath: tempDir(), configPath: path.join(tempDir(), 'projects.json') });
    const started = await studioRequest(s, 'POST', '/api/setup/run', JSON.stringify({ only: ['ffmpeg'], proxy: 'http://127.0.0.1:7890' }));
    expect(started.status).toBe(202);
    const body = await waitIdle(s);
    expect(body.ready).toBe(true);
    expect(body.task.running).toBe(false);
    expect(body.task.items).toEqual({});
    expect(body.task.error).toBeUndefined();
    expect(body.task.log.endsWith('setup.log')).toBe(true);
  });

  it('lists the voice and alignment tools of the open project', async () => {
    const project = tempDir();
    const fs = await import('node:fs');
    fs.writeFileSync(path.join(project, 'article-to-motion.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\nTTS_PROVIDER=edge\nALIGN_PROVIDER=funasr\n');
    const s = startStudio({ projectPath: project, configPath: path.join(tempDir(), 'projects.json') });
    const { body } = await studioRequest(s, 'GET', '/api/setup');
    const ids = body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain('tts:edge');
    expect(ids).toContain('align:funasr');
  });

  // 安装页靠 later 把「以后可能用到」的项排成单独点装的卡片；接口漏了它，这几项缺着时打开只看到「已全部就位」。
  it('tells the page which items are installed only when needed, one card per film-style source', async () => {
    const s = startStudio({ projectPath: tempDir(), configPath: path.join(tempDir(), 'projects.json') });
    const { body } = await studioRequest(s, 'GET', '/api/setup');
    const later = (id: string) => body.items.find((item: { id: string }) => item.id === id)?.later;
    expect(later('beat')).toMatchObject({ title: expect.any(String) });
    expect(later('styles:lemo-opuscar').title).toBe('LemoLab 风格库');
    expect(later('styles:anidoodle').title).toBe('anidoodle 代码绘画');
    expect(later('ffmpeg')).toBeUndefined();
  });
});
