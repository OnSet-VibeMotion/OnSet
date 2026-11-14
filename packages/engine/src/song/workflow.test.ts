import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { newToolchain } from '../mediaprobe';
import { generate, importSong } from './generate';
import { exportPhrases } from './phrases';
import { doctor, prepare } from './prepare';
import { ACEClient } from './provider';
import { hashFile, loadCandidate, loadConfig, localPath, readCandidate, readJSON, select, Store, withLock, writeJSON, bytesHash, enabled } from './store';
import { loadTimeline, slice, verifyCue } from './timeline';
import { timelineToJSON, type Cue } from './types';
import { Buf, cleanupTemps, fakeEnvironment, startServer, tempDir } from './testsupport';

afterEach(cleanupTemps);

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Error,
  );
}

function sortedDirs(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

describe('song workflow', () => {
  it('minimax prepare and cue lifecycle', async () => {
    const { root, env } = fakeEnvironment();
    const out = new Buf();
    await doctor(root, env, out);
    await generate(root, 2, 'first', env, out);
    await generate(root, 2, 'first', env, out);
    expect(out.text).toContain('复用候选');
    const dirs = sortedDirs(path.join(root, Store, 'candidates'));
    expect(dirs.length).toBe(2);
    expect(await rejects(prepare(root, '', false, env, out)), 'selection required').not.toBeNull();
    select(root, dirs[0]);
    await prepare(root, '', false, env, out);
    let tl = loadTimeline(root);
    expect(tl.reviewed).toBe(false);
    expect(tl.beats?.length).toBe(3);
    await prepare(root, path.join(root, Store, 'timeline.json'), true, env, out);
    tl = loadTimeline(root);
    exportPhrases(root, 30);
    const phrases = readJSON<Record<string, unknown>>(path.join(root, 'production', 'phrase-timeline.json'));
    expect(phrases.total_frames).toBe(300);
    const dir = path.join(root, 'scenes', '001');
    fs.mkdirSync(dir, { recursive: true });
    const data = slice(tl, 0, 10);
    writeJSON(path.join(dir, 'song-cues.json'), timelineToJSON(data));
    const sha = hashFile(path.join(root, Store, 'timeline.json'));
    const dh = hashFile(path.join(dir, 'song-cues.json'));
    const cue: Cue = { fps: 30, timeline: '../../production/song/timeline.json', sha256: sha, start_seconds: 0, data: 'song-cues.json', data_sha256: dh };
    verifyCue(dir, cue, 10);
    expect(() => verifyCue(dir, { ...cue, sha256: 'old' }, 10), 'stale global').toThrow();
    expect(() => verifyCue(dir, { ...cue, data_sha256: 'old' }, 10), 'stale local').toThrow();
    expect(() => verifyCue(dir, { ...cue, start_seconds: -1 }, 10), 'bad start').toThrow();
    data.lines![0].start = 0;
    writeJSON(path.join(dir, cue.data), timelineToJSON(data));
    const tampered = { ...cue, data_sha256: hashFile(path.join(dir, cue.data)) };
    expect(() => verifyCue(dir, tampered, 10), 'tampered local timing').toThrow();
    select(root, dirs[1]);
    expect(() => loadTimeline(root), 'new candidate must invalidate timeline even for identical audio').toThrow();
  });

  it('import and errors', async () => {
    const { root, env } = fakeEnvironment();
    const media = newToolchain(env);
    const source = path.join(tempDir(), 'song.mp3');
    fs.writeFileSync(source, 'audio');
    const c = importSong(root, source, path.join(root, 'lyrics.txt'), media);
    loadCandidate(root, c.id);
    fs.writeFileSync(source, 'other');
    loadCandidate(root, c.id); // import didn't copy 时这里会失败
    expect(() => importSong(root, 'missing', path.join(root, 'lyrics.txt'), media), 'missing source').toThrow();
    fs.writeFileSync(path.join(root, 'empty.txt'), '');
    expect(() => importSong(root, source, path.join(root, 'empty.txt'), media), 'empty lyrics').toThrow();
    expect(() => withLock(root, () => withLock(root, () => null)), 'concurrent mutation').toThrow();
    expect(await rejects(generate(root, 0, 'x', env, new Buf())), 'count').not.toBeNull();
    expect(await rejects(generate(root, 1, '../x', env, new Buf())), 'batch').not.toBeNull();
    fs.writeFileSync(path.join(env.PATH, 'mmx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await rejects(generate(root, 1, 'failed', env, new Buf())), 'provider failure').not.toBeNull();
    const err = await rejects(generate(root, 1, 'failed', env, new Buf()));
    expect(err?.message).toContain('状态不明');
  });

  it('ACE generation resumes without resubmitting', async () => {
    const { root, env } = fakeEnvironment();
    let submits = 0;
    let queries = 0;
    const server = await startServer((req, res) => {
      switch (new URL(req.url ?? '/', 'http://x').pathname) {
        case '/health':
          res.end('{}');
          return;
        case '/release_task':
          submits++;
          res.end('{"code":200,"data":{"task_id":"task"}}');
          return;
        case '/query_result':
          queries++;
          if (queries === 1) {
            res.statusCode = 503;
            res.end();
            return;
          }
          res.end('{"code":200,"data":[{"task_id":"task","status":1,"result":"[{\\"file\\":\\"/audio\\"}]"}]}');
          return;
        case '/audio':
          res.end('audio');
          return;
      }
      res.end();
    });
    try {
      const cfg = loadConfig(root);
      // yaml.Marshal(cfg)：model 为空（omitempty 省略），workspace 为空也省略。
      const doc = {
        schema: cfg.schema,
        provider: 'acestep',
        endpoint: server.url,
        lyrics: cfg.lyrics,
        style: cfg.style,
        language: cfg.language,
        target_seconds: cfg.target_seconds,
        bpm: cfg.bpm,
        python: cfg.python,
      };
      fs.writeFileSync(path.join(root, 'song.yaml'), stringify(doc));
      await doctor(root, env, new Buf());
      expect(await rejects(generate(root, 1, 'resume', env, new Buf())), 'poll failure').not.toBeNull();
      await generate(root, 1, 'resume', env, new Buf());
      expect([submits, queries]).toEqual([1, 2]);
    } finally {
      await server.close();
    }
  });

  it('prepare reports and degrades', async () => {
    const { root, env } = fakeEnvironment();
    const out = new Buf();
    await generate(root, 1, 'ok', env, out).catch(() => {});
    const dirs = sortedDirs(path.join(root, Store, 'candidates'));
    select(root, dirs[0]);
    expect(await rejects(prepare(root, '', true, env, out)), 'review on fresh automatic alignment').not.toBeNull();
    const script = path.join(env.PATH, 'python3');
    let body = fs.readFileSync(script, 'utf8');
    body = body.split("echo '[1,2,3]'; exit 0").join('exit 1');
    fs.writeFileSync(script, body, { mode: 0o755 });
    await prepare(root, '', false, env, out);
    const tl = loadTimeline(root);
    expect((tl.warnings ?? []).length).toBeGreaterThan(0);
    expect((tl.beats ?? []).length).toBe(0);
    body = body.split('"start":1,"end":8,"status":"aligned"').join('"start":null,"end":8,"status":"missing_timestamps"');
    fs.writeFileSync(script, body, { mode: 0o755 });
    const err = await rejects(prepare(root, '', false, env, out));
    expect(err?.message).toContain('人工修正');
    const alignment = path.join(root, Store, 'alignment');
    const reports = fs.readdirSync(alignment).filter((d) => fs.existsSync(path.join(alignment, d, 'issues.json')));
    expect(reports.length).toBe(2);
    fs.writeFileSync(script, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(await rejects(prepare(root, '', false, env, out)), 'version mismatch').not.toBeNull();
    expect(await rejects(doctor(root, env, out)), 'doctor failure').not.toBeNull();
  });

  it('boundary and atomic JSON', async () => {
    const root = tempDir();
    const outside = tempDir();
    fs.symlinkSync(outside, path.join(root, 'link'));
    for (const p of ['', '../x', '/absolute', 'link/a']) expect(() => localPath(root, p), p).toThrow();
    writeJSON(path.join(root, 'x.json'), { a: 1 });
    const before = fs.statSync(path.join(root, 'x.json')).mtimeMs;
    await new Promise((r) => setTimeout(r, 5));
    writeJSON(path.join(root, 'x.json'), { a: 1 });
    const after = fs.statSync(path.join(root, 'x.json')).mtimeMs;
    expect(after, 'unchanged state touched').toBe(before);
    for (const b of ['{"extra":1}', '{} {}', 'not json']) {
      fs.writeFileSync(path.join(root, 'bad'), b);
      expect(() => readCandidate(path.join(root, 'bad')), b).toThrow();
    }
    expect(bytesHash(Buffer.from('a'))).not.toBe(bytesHash(Buffer.from('b')));
    expect(enabled(root), 'mode detection').toBe(false);
  });

  it('ACE polling states', async () => {
    for (const status of [2, 3]) {
      const srv = await startServer((_req, res) => res.end(JSON.stringify({ code: 200, data: [{ status, task_id: 'id' }] }) + '\n'));
      try {
        const err = await rejects(new ACEClient({ endpoint: srv.url }).resume('id', path.join(tempDir(), 'a')));
        expect(err, String(status)).not.toBeNull();
      } finally {
        await srv.close();
      }
    }
    const srv = await startServer((_req, res) => res.end('{"code":200,"data":[{"task_id":"id","status":0}]}'));
    try {
      const err = await rejects(new ACEClient({ endpoint: srv.url, pollInterval: 1 }).resume('id', 'unused', AbortSignal.timeout(20)));
      expect(err, 'timeout').not.toBeNull();
    } finally {
      await srv.close();
    }
  });

  it('downloaded minimax candidate is verified without new request', async () => {
    const { root, env } = fakeEnvironment();
    const probe = path.join(env.PATH, 'ffprobe');
    const working = fs.readFileSync(probe);
    fs.writeFileSync(probe, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const out = new Buf();
    expect(await rejects(generate(root, 1, 'verify', env, out)), 'probe failure').not.toBeNull();
    fs.writeFileSync(probe, working, { mode: 0o755 });
    // Any attempt to re-call the provider now fails.
    fs.writeFileSync(path.join(env.PATH, 'mmx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await generate(root, 1, 'verify', env, out);
    expect(out.text).toContain('已验证本地候选');
  });
});

