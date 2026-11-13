// 移植自 internal/song/mureka_lyria_test.go。
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate } from './generate';
import { decodeLyria, newHosted, validateLyrics } from './hosted';
import { setDefaultTransport } from './http';
import { checkCredential, configure, platformGuide, providerInfo } from './platforms';
import { doctor } from './prepare';
import { candidateDir, loadCandidate, loadConfig, Store } from './store';
import { config } from './types';
import { Buf, cleanupTemps, fakeEnvironment, jsonBody, mockResponse, tempDir, walkFiles } from './testsupport';

afterEach(cleanupTemps);

const lyriaSuccess =
  '{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"provider lyrics must not replace source"},{"type":"audio","mime_type":"audio/mpeg","data":"YXVkaW8="}]}]}';

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Error,
  );
}

async function* bodyOf(text: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(text);
}

describe('Mureka and Lyria', () => {
  for (const id of ['mureka', 'lyria']) {
    it(`candidate lifecycle: ${id}`, async () => {
      const { root, env } = fakeEnvironment();
      configure(root, id, '', '', '');
      env[providerInfo(id).key] = 'secret-test';
      const lyrics = '[Verse]\n科学知识唱起来\n[Chorus]\n水汽遇冷凝成云\n水汽遇冷凝成云';
      fs.writeFileSync(path.join(root, 'lyrics.txt'), lyrics);
      let posts = 0;
      let polls = 0;
      let failPoll = id === 'mureka';
      const failures: string[] = [];
      const old = setDefaultTransport(async (r) => {
        const u = new URL(r.url);
        if (u.host === 'cdn.mureka.ai') {
          if (r.headers.Authorization) failures.push('leaked key on download');
          return mockResponse('audio');
        }
        if (id === 'mureka') {
          if (u.host !== 'api.mureka.ai' || r.headers.Authorization !== 'Bearer secret-test') failures.push('wrong Mureka auth/origin');
        } else if (u.host !== 'generativelanguage.googleapis.com' || r.headers['x-goog-api-key'] !== 'secret-test' || r.headers.Authorization) {
          failures.push('wrong Google auth/origin');
        }
        if (r.method === 'POST') {
          posts++;
          const b = jsonBody(r.body);
          if (id === 'mureka') {
            if (u.pathname !== '/v1/song/generate' || b.n !== 1 || b.lyrics !== lyrics || b.model !== 'mureka-9.5') failures.push(JSON.stringify(b));
            return mockResponse('{"id":"task-1","status":"preparing"}');
          }
          if (u.pathname !== '/v1beta/interactions' || b.model !== 'lyria-3.5' || b.store !== false || b.stream !== false || !String(b.input).includes(lyrics)) {
            failures.push(JSON.stringify(b));
          }
          return mockResponse(lyriaSuccess);
        }
        polls++;
        if (r.method !== 'GET' || u.pathname !== '/v1/song/query/task-1') failures.push(`${r.method} ${u.pathname}`);
        if (failPoll) throw new Error('network interrupted secret-test');
        return mockResponse('{"id":"task-1","status":"succeeded","choices":[{"url":"https://cdn.mureka.ai/song.mp3?signature=private"}]}');
      });
      try {
        const out = new Buf();
        await doctor(root, env, out);
        expect([posts, polls], 'doctor contacted provider').toEqual([0, 0]);
        let err = await rejects(generate(root, 1, 'first', env, out));
        if (id === 'mureka') {
          expect(err).not.toBeNull();
          expect(err!.message.includes('secret-test')).toBe(false);
          failPoll = false;
          err = await rejects(generate(root, 1, 'first', env, out));
        }
        expect(err).toBeNull();
        await generate(root, 1, 'first', env, out);
        expect(posts, 'resubmitted').toBe(1);
        expect(failures).toEqual([]);
        const dirs = fs.readdirSync(path.join(root, Store, 'candidates'));
        expect(dirs.length).toBe(1);
        const c = loadCandidate(root, dirs[0]);
        expect(c.provider).toBe(id);
        const dir = candidateDir(root, c.id);
        expect(fs.readFileSync(path.join(dir, c.lyrics), 'utf8'), 'changed lyrics').toBe(lyrics);
        expect(fs.existsSync(path.join(root, Store, 'selected.json')), 'selected automatically').toBe(false);
        for (const file of walkFiles(dir)) {
          const b = fs.readFileSync(file, 'utf8');
          for (const secret of ['secret-test', 'signature=private']) expect(b.includes(secret), `persisted secret ${file}`).toBe(false);
        }
      } finally {
        setDefaultTransport(old);
      }
    });
  }

  it('lyria malformed audio is atomic', async () => {
    const audio = '{"type":"audio","mime_type":"audio/mpeg","data":"YXVkaW8="}';
    for (const body of [
      '{"status":"failed"}',
      '{"steps":[]}',
      '{"steps":[{"type":"model_output","content":[' + audio + ',' + audio + ']}]}',
      lyriaSuccess.replace('audio/mpeg', 'audio/wav'),
      lyriaSuccess.replace('YXVkaW8=', 'YXVkaW8=!!!!'),
      lyriaSuccess.replace('YXVkaW8=', ''),
      lyriaSuccess + '{}',
    ]) {
      const dir = tempDir();
      const dest = path.join(dir, 'audio.mp3');
      fs.writeFileSync(dest, 'old');
      expect(await rejects(decodeLyria(bodyOf(body), dest)), `accepted malformed audio ${body}`).not.toBeNull();
      expect(fs.readFileSync(dest, 'utf8'), 'replaced old file').toBe('old');
      expect(fs.readdirSync(dir).length, 'left partial download').toBe(1);
    }
    async function* broken(): AsyncIterable<Uint8Array> {
      throw new Error('download interrupted');
    }
    expect(await rejects(decodeLyria(broken(), path.join(tempDir(), 'audio.mp3'))), 'ignored broken reader').not.toBeNull();
  });

  it('mureka validation and polling', async () => {
    const c = config({ provider: 'mureka', model: 'mureka-9.5', target_seconds: 120, style: 'rap', language: 'zh', bpm: 100 });
    expect(() => validateLyrics(c, '字'.repeat(5001)), 'long lyrics').toThrow();
    c.style = 'x'.repeat(1024);
    expect(() => validateLyrics(c, '词'), 'long prompt').toThrow();
    c.style = 'rap';
    for (const body of [
      '{"id":"other","status":"succeeded"}',
      '{"id":"task-1","status":"failed","failed_reason":"secret"}',
      '{"id":"task-1","status":"timeouted"}',
      '{"id":"task-1","status":"cancelled"}',
      '{"id":"task-1","status":"unknown"}',
      '{"id":"task-1","status":"succeeded","choices":[]}',
      '{"id":"task-1","status":"succeeded","choices":[{"url":"https://cdn.mureka.ai/one"},{"url":"https://cdn.mureka.ai/two"}]}',
    ]) {
      const h = newHosted(c, null);
      h.http.transport = async () => mockResponse(body);
      const err = await rejects(h.resume('task-1', 'unused'));
      expect(err, body).not.toBeNull();
      expect(err!.message.includes('secret')).toBe(false);
    }
    const h = newHosted(c, null);
    h.interval = 3600 * 1000;
    const ctl = new AbortController();
    ctl.abort();
    h.http.transport = async () => mockResponse('{"id":"task-1","status":"running"}');
    expect(await rejects(h.resume('task-1', 'unused', ctl.signal)), 'ignored cancellation').not.toBeNull();
    for (const ref of ['https://cdn.mureka.ai.evil.test/x', 'https://127.0.0.1/x', 'https://cdn.mureka.ai:8443/x']) {
      expect(await rejects(h.download(ref, 'unused')), ref).not.toBeNull();
    }
  });

  it('new provider configuration', () => {
    for (const id of ['mureka', 'lyria']) {
      const { root, env } = fakeEnvironment();
      configure(root, id, '', '', '');
      const c = loadConfig(root);
      expect(c.model).toBe(providerInfo(id).model);
      expect(() => checkCredential(c, env)).toThrow(providerInfo(id).key);
      const out = new Buf();
      platformGuide(out, id, { [providerInfo(id).key]: 'secret-test' });
      expect(out.text.includes('secret-test')).toBe(false);
      expect(out.text).toContain(providerInfo(id).key);
      expect(() => configure(root, id, 'invalid-model', '', ''), 'accepted unsupported model').toThrow();
      expect(() => configure(root, id, '', '', 'https://other.example'), 'accepted foreign endpoint').toThrow();
    }
  });

  it('lyria failure does not retry', async () => {
    const { root, env } = fakeEnvironment();
    configure(root, 'lyria', '', '', '');
    env.GEMINI_API_KEY = 'secret-test';
    let posts = 0;
    const old = setDefaultTransport(async () => {
      posts++;
      return mockResponse('secret-test', 403);
    });
    try {
      for (let i = 0; i < 2; i++) {
        const err = await rejects(generate(root, 1, 'failed', env, new Buf()));
        expect(err).not.toBeNull();
        expect(err!.message.includes('secret-test')).toBe(false);
      }
      expect(posts, 'duplicate POST').toBe(1);
    } finally {
      setDefaultTransport(old);
    }
  });
});
