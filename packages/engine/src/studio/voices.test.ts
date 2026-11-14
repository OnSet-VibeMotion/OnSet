import './testsupport';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultTTSProvider } from '../config';
import { hasFfmpeg, newSessionFixture, rawGet, setEnv, studioRequest, tempDir } from './testsupport';

describe('voices API', () => {
  it('lists an empty library and 404s unknown voices', async () => {
    setEnv('ONSET_VOICES_DIR', tempDir());
    const f = newSessionFixture();
    const { status, body } = await studioRequest(f.s, 'GET', '/api/voices');
    expect(status).toBe(200);
    expect(body.voices).toEqual([]);
    expect(body.default).toBe('');
    expect((await studioRequest(f.s, 'GET', '/api/voices/nobody/reference.wav')).status).toBe(404);
    expect((await studioRequest(f.s, 'DELETE', '/api/voices/..')).status).toBe(404);
  });

  it.skipIf(!hasFfmpeg)('saves an uploaded take, plays it, switches the default and deletes', async () => {
    const library = tempDir();
    setEnv('ONSET_VOICES_DIR', library);
    const f = newSessionFixture();
    const upload = 'production/studio/uploads/me.m4a';
    fs.mkdirSync(path.dirname(path.join(f.root, upload)), { recursive: true });
    expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=180:duration=5', path.join(f.root, upload)]).status).toBe(0);

    let { status, body } = await studioRequest(f.s, 'POST', '/api/voices', JSON.stringify({ name: '我的声音', text: '大家好，欢迎来到今天的节目。', upload }));
    expect(status, JSON.stringify(body)).toBe(201);
    expect(body.is_default).toBe(true);
    expect(body.source).toBe('recorded');

    const played = await rawGet(f.s, '/api/voices/我的声音/reference.wav');
    expect(played.status).toBe(200);
    expect(played.headers.get('Content-Type')).toBe('audio/wav');

    // 路径不能逃出项目。
    ({ status } = await studioRequest(f.s, 'POST', '/api/voices', JSON.stringify({ name: 'x', text: 'y', upload: '../outside.wav' })));
    expect(status).toBe(400);

    ({ status } = await studioRequest(f.s, 'POST', '/api/voices', JSON.stringify({ name: '第二个', text: '你好', upload })));
    expect(status).toBe(201);
    ({ status, body } = await studioRequest(f.s, 'POST', '/api/voices/第二个/default'));
    expect(status).toBe(200);
    expect(body.is_default).toBe(true);
    ({ body } = await studioRequest(f.s, 'GET', '/api/voices'));
    expect(body.voices.map((v: { name: string }) => v.name)).toEqual(['第二个', '我的声音']);

    ({ status, body } = await studioRequest(f.s, 'DELETE', '/api/voices/第二个'));
    expect(status).toBe(200);
    expect(body.default).toBe('我的声音');
    expect(fs.existsSync(path.join(library, '第二个'))).toBe(false);
  });

  it('tells the page what to read and whether Breeze is here to design with', async () => {
    setEnv('ONSET_VOICES_DIR', tempDir());
    const f = newSessionFixture();
    const { body } = await studioRequest(f.s, 'GET', '/api/voices');
    expect(body.sample_text).toContain('大家好');
    // 项目配音本来就是 Breeze（Apple Silicon 上的缺省）时，安装页里就是配音那一项。
    expect(body.design.install_id).toBe(defaultTTSProvider() === 'breeze' ? 'tts:breeze' : 'voice:breeze');
    expect(typeof body.design.ready).toBe('boolean');
    // 没写描述时不起任何进程，直接说要写什么。
    const { status, body: err } = await studioRequest(f.s, 'POST', '/api/voice-design', JSON.stringify({ instruction: '' }));
    expect(status).toBe(400);
    expect(err.message).toMatch(/先写一句描述|Breeze/);
    expect((await studioRequest(f.s, 'GET', '/api/voice-drafts/d-000000000000.wav')).status).toBe(404);
  });

  it.skipIf(!hasFfmpeg)('saves a microphone take without going through any project', async () => {
    const library = tempDir();
    setEnv('ONSET_VOICES_DIR', library);
    const f = newSessionFixture();
    const take = path.join(tempDir(), 'take.m4a');
    expect(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=8', take]).status).toBe(0);
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(take)], { type: 'audio/mp4' }), 'take.m4a');
    form.append('name', '我的声音');
    form.append('text', '大家好，欢迎来到今天的节目。');
    form.append('make_default', 'false');
    const res = await f.s.handle(new Request('http://studio.test/api/voice-record', { method: 'POST', body: form }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ name: '我的声音', source: 'recorded', is_default: true });
    expect(fs.existsSync(path.join(library, '我的声音', 'reference.wav'))).toBe(true);
    expect(fs.existsSync(path.join(f.root, 'production', 'studio', 'uploads'))).toBe(false);
  });
});
