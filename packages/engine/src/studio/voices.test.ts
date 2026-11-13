import './testsupport';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasFfmpeg, newSessionFixture, rawGet, setEnv, studioRequest, tempDir } from './testsupport';

describe('voices API', () => {
  it('lists an empty library and 404s unknown voices', async () => {
    setEnv('AM_VOICES_DIR', tempDir());
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
    setEnv('AM_VOICES_DIR', library);
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
});
