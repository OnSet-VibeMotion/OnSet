// 移植自 internal/song/hosted_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from './generate';
import { newHosted, saveAudio, validateLyrics } from './hosted';
import { setDefaultTransport, type HttpRequest, type HttpResponse } from './http';
import { checkCredential, configure, platformGuide, providerInfo } from './platforms';
import { DefaultConfig, loadConfig, Store } from './store';
import { config } from './types';
import { Buf, cleanupTemps, fakeEnvironment, jsonBody, mockResponse, tempDir, walkFiles } from './testsupport';

afterEach(cleanupTemps);

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Error,
  );
}

describe('hosted providers', () => {
  for (const id of ['bailian', 'elevenlabs', 'fal']) {
    it(id, async () => {
      const c = config({ provider: id, model: providerInfo(id).model, workspace: 'workspace', style: 'Mandarin rap', bpm: 100, target_seconds: 180 });
      const h = newHosted(c, { [providerInfo(id).key]: 'secret-test' });
      h.interval = 1;
      const lyrics = '科学知识唱起来\n水汽遇冷凝成云';
      let posts = 0;
      let downloads = 0;
      const failures: string[] = [];
      h.http.transport = async (r: HttpRequest): Promise<HttpResponse> => {
        const u = new URL(r.url);
        if (u.host === 'storage.googleapis.com' || u.host.endsWith('.oss-cn-beijing.aliyuncs.com')) {
          downloads++;
          if (r.headers.Authorization || r.headers['xi-api-key']) failures.push('key sent to download host');
          if (u.protocol !== 'https:') failures.push('not TLS');
          return mockResponse('audio-bytes');
        }
        if (id === 'elevenlabs') {
          if (r.headers['xi-api-key'] !== 'secret-test') failures.push('missing ElevenLabs key');
        } else {
          const want = id === 'fal' ? 'Key secret-test' : 'Bearer secret-test';
          if (r.headers.Authorization !== want) failures.push('wrong auth');
        }
        if (r.method === 'POST') {
          posts++;
          const b = jsonBody(r.body);
          switch (id) {
            case 'bailian': {
              if (u.pathname !== '/api/v1/services/audio/music/generation') failures.push(u.pathname);
              const input = b.input as Record<string, unknown>;
              if (input.lyrics !== lyrics || input.prompt !== undefined || input.is_instrumental !== false) failures.push(JSON.stringify(b));
              return mockResponse('{"request_id":"req-1","output":{"audio":{"url":"http://result.oss-cn-beijing.aliyuncs.com/song.mp3?signature=secret"}}}');
            }
            case 'elevenlabs': {
              if (u.pathname !== '/v1/music' || b.prompt !== undefined || b.model_id !== 'music_v2_5') failures.push(JSON.stringify(b));
              const chunks = (b.composition_plan as { chunks: Array<{ duration_ms: number; text: string }> }).chunks;
              const total = chunks.reduce((s, ch) => s + ch.duration_ms, 0);
              if (total !== 180000 || chunks.map((ch) => ch.text).join('\n') !== lyrics) failures.push(JSON.stringify(chunks));
              const res = mockResponse('audio-bytes');
              (res.headers as Headers).set('song-id', 'song-1');
              return res;
            }
            case 'fal':
              if (b.lyrics !== lyrics || b.tags !== c.style || u.pathname !== '/fal-ai/ace-step') failures.push(JSON.stringify(b));
              return mockResponse('{"request_id":"task-1"}');
          }
        }
        if (u.pathname.endsWith('/status')) return mockResponse('{"status":"COMPLETED"}');
        if (u.pathname !== '/fal-ai/ace-step/requests/task-1') failures.push(u.pathname);
        return mockResponse('{"audio":{"url":"https://storage.googleapis.com/falserverless/song.wav"}}');
      };
      const dest = path.join(tempDir(), 'audio.mp3');
      if (id === 'fal') {
        const task = await h.submit(c, lyrics);
        await h.resume(task, dest);
      } else {
        const task = await h.generate(lyrics, dest);
        expect(task).not.toBe('');
      }
      expect(failures).toEqual([]);
      expect(fs.readFileSync(dest, 'utf8')).toBe('audio-bytes');
      expect(posts).toBe(1);
      if (id !== 'elevenlabs') expect(downloads).toBe(1);
    });
  }

  it('errors and downloads', async () => {
    const c = config({ provider: 'fal', model: 'fal-ai/ace-step' });
    const h = newHosted(c, { FAL_KEY: 'super-secret' });
    let calls = 0;
    h.http.transport = async () => {
      calls++;
      return mockResponse('super-secret', 403);
    };
    const err = await rejects(h.submit(c, 'lyrics'));
    expect(err).not.toBeNull();
    expect(err!.message.includes('super-secret')).toBe(false);
    expect(err!.message).toContain('403');
    expect(calls).toBe(1);
    for (const url of ['http://127.0.0.1/', 'https://fal.media.evil.test/x', 'https://user:secret@fal.media/x', 'file:///tmp/x', 'https://fal.media:8443/x']) {
      expect(await rejects(h.download(url, 'unused')), url).not.toBeNull();
    }
    expect(calls, 'untrusted downloads issued requests').toBe(1);
    const ctl = new AbortController();
    ctl.abort();
    h.interval = 3600 * 1000;
    h.http.transport = async () => mockResponse('{"status":"IN_QUEUE"}');
    expect(await rejects(h.resume('task-1', 'unused', ctl.signal)), 'ignored cancellation').not.toBeNull();
  });

  it('atomic hosted download', async () => {
    const dir = tempDir();
    const dest = path.join(dir, 'audio.mp3');
    fs.writeFileSync(dest, 'old');
    async function* broken(): AsyncIterable<Uint8Array> {
      throw new Error('download interrupted');
    }
    expect(await rejects(saveAudio(broken(), dest)), 'accepted partial download').not.toBeNull();
    expect(fs.readFileSync(dest, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir).length).toBe(1);
  });

  it('platform configuration and secrets', () => {
    const root = tempDir();
    const file = path.join(root, 'song.yaml');
    const original = DefaultConfig + '# user comment\n';
    fs.writeFileSync(file, original);
    expect(() => configure(root, 'bailian', '', 'bad/workspace', ''), 'bad workspace').toThrow();
    expect(fs.readFileSync(file, 'utf8'), 'failed configure changed file').toBe(original);
    configure(root, 'bailian', '', 'workspace-1', '');
    let c = loadConfig(root);
    expect(c.model).toBe('fun-music-v1');
    expect(c.lyrics).toBe('lyrics.txt');
    let err: Error | null = null;
    try {
      checkCredential(c, { DASHSCOPE_API_KEY: 'sk-sp-private' });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message.includes('private')).toBe(false);
    configure(root, 'fal', '', '', '');
    c = loadConfig(root);
    expect(c.model).toBe('fal-ai/ace-step');
    expect(c.workspace).toBe('');
    expect(fs.readFileSync(file, 'utf8'), 'lost comments').toContain('# user comment');
    const out = new Buf();
    platformGuide(out, '', { FAL_KEY: 'super-secret' });
    expect(out.text.includes('super-secret')).toBe(false);
    expect(out.text).toContain('已设置');
    expect(() => checkCredential(c, null)).toThrow('song_providers({"args": ["fal"]})');
  });

  it('lyrics limits', () => {
    expect(() => validateLyrics(config({ provider: 'bailian' }), '字'.repeat(351)), 'long Chinese lyrics').toThrow();
    expect(() => validateLyrics(config({ provider: 'elevenlabs', target_seconds: 10 }), 'a'.repeat(201)), 'long line').toThrow();
    expect(() => validateLyrics(config({ provider: 'elevenlabs', target_seconds: 10 }), 'a\n'.repeat(200)), 'too many short sections').toThrow();
  });

  // Exercise the actual candidate state machine: no paid POST on continuation,
  // no submission marker for missing credentials, no retry of ambiguous sync calls.
  for (const id of ['bailian', 'elevenlabs', 'fal']) {
    it(`candidate lifecycle: ${id}`, async () => {
      const { root, env } = fakeEnvironment();
      configure(root, id, '', id === 'bailian' ? 'workspace' : '', '');
      fs.writeFileSync(path.join(root, 'lyrics.txt'), '科学知识唱起来\n水汽遇冷凝成云');
      const out = new Buf();
      expect(await rejects(generate(root, 1, 'first', env, out)), 'missing key accepted').not.toBeNull();
      expect(fs.existsSync(path.join(root, Store, 'candidates')), 'created candidate without credentials').toBe(false);
      env[providerInfo(id).key] = 'do-not-persist';
      let posts = 0;
      let fail = true;
      const old = setDefaultTransport(async (r) => {
        const u = new URL(r.url);
        if (r.method === 'POST') {
          posts++;
          if (id === 'fal') return mockResponse('{"request_id":"task-1"}');
          if (fail) throw new Error('network failure do-not-persist');
          return mockResponse('audio');
        }
        if (fail) throw new Error('poll interrupted do-not-persist');
        if (u.pathname.endsWith('/status')) return mockResponse('{"status":"COMPLETED"}');
        if (u.pathname.includes('/requests/')) return mockResponse('{"audio":{"url":"https://fal.media/song.wav"}}');
        return mockResponse('audio');
      });
      try {
        let err = await rejects(generate(root, 1, 'first', env, out));
        expect(err).not.toBeNull();
        expect(err!.message.includes('do-not-persist')).toBe(false);
        fail = false;
        err = await rejects(generate(root, 1, 'first', env, out));
        if (id === 'fal') {
          expect(err).toBeNull();
          await generate(root, 1, 'first', env, out);
        } else {
          expect(err, 'retried ambiguous submission').not.toBeNull();
        }
        expect(posts, 'duplicate generation').toBe(1);
        for (const file of walkFiles(path.join(root, Store))) {
          expect(fs.readFileSync(file, 'utf8').includes('do-not-persist'), `persisted key ${file}`).toBe(false);
        }
      } finally {
        setDefaultTransport(old);
      }
    });
  }

  it('configure rejects multiple documents', () => {
    const root = tempDir();
    const file = path.join(root, 'song.yaml');
    const original = DefaultConfig + '---\nprovider: minimax\n';
    fs.writeFileSync(file, original);
    expect(() => configure(root, 'fal', '', '', ''), 'accepted multiple documents').toThrow();
    expect(fs.readFileSync(file, 'utf8'), 'changed invalid configuration').toBe(original);
  });
});
