import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACEClient } from './provider';
import { config } from './types';
import { cleanupTemps, readRequest, startServer, tempDir } from './testsupport';

afterEach(cleanupTemps);

async function rejects(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Error,
  );
}

describe('ACE-Step client', () => {
  it('protocol and download', async () => {
    let requests = 0;
    const problems: string[] = [];
    const srv = await startServer(async (req, res) => {
      if (req.headers.authorization !== 'Bearer private') problems.push('auth missing');
      const body = await readRequest(req);
      switch (new URL(req.url ?? '/', 'http://x').pathname) {
        case '/release_task': {
          requests++;
          const r = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          if (r.use_format !== false || r.sample_mode !== false || r.lyrics !== '歌词' || r.batch_size !== 1) problems.push(JSON.stringify(r));
          res.end('{"code":200,"data":{"task_id":"t1"}}');
          return;
        }
        case '/query_result':
          res.end('{"code":200,"data":[{"task_id":"t1","status":1,"result":"[{\\"file\\":\\"/v1/audio?path=a\\"}]"}]}');
          return;
        case '/v1/audio':
          res.end('audio');
          return;
        default:
          problems.push(req.url ?? '');
          res.end();
      }
    });
    try {
      const a = new ACEClient({ endpoint: srv.url, key: 'private', pollInterval: 1 });
      const id = await a.submit(config({ model: 'm', style: 's' }), '歌词');
      expect(id).toBe('t1');
      const dest = path.join(tempDir(), 'audio.mp3');
      await a.resume(id, dest);
      expect(fs.readFileSync(dest, 'utf8')).toBe('audio');
      expect(requests).toBe(1);
      expect(problems).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('rejects leak and failure', async () => {
    for (const body of ['{"code":500,"error":"private"}', '{"code":200,"data":{"task_id":""}}']) {
      const s = await startServer((_req, res) => res.end(body));
      try {
        const err = await rejects(new ACEClient({ endpoint: s.url, key: 'private' }).submit(config(), 'a'));
        expect(err).not.toBeNull();
        expect(err!.message.includes('private')).toBe(false);
      } finally {
        await s.close();
      }
    }
    const a = new ACEClient({ endpoint: 'http://example.test', key: 'private' });
    expect(await rejects(a.download('https://elsewhere.test/audio', path.join(tempDir(), 'a'))), 'cross origin').not.toBeNull();
    const ctl = new AbortController();
    ctl.abort();
    expect(await rejects(a.resume('t', path.join(tempDir(), 'a'), ctl.signal)), 'cancel').not.toBeNull();
  });

  it('interrupted download and redirect', async () => {
    let calls = 0;
    const srv = await startServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.setHeader('Content-Length', '100');
        res.write('short', () => res.socket?.destroy());
        return;
      }
      res.end('complete');
    });
    const dest = path.join(tempDir(), 'audio.mp3');
    let other: Awaited<ReturnType<typeof startServer>> | null = null;
    let redirect: Awaited<ReturnType<typeof startServer>> | null = null;
    try {
      let a = new ACEClient({ endpoint: srv.url });
      expect(await rejects(a.download('/audio', dest)), 'interrupted download accepted').not.toBeNull();
      expect(fs.existsSync(dest), 'partial file published').toBe(false);
      await a.download('/audio', dest);
      let otherCalls = 0;
      other = await startServer((_req, res) => {
        otherCalls++;
        res.end();
      });
      const otherURL = other.url;
      redirect = await startServer((_req, res) => {
        res.statusCode = 302;
        res.setHeader('Location', otherURL);
        res.end();
      });
      a = new ACEClient({ endpoint: redirect.url, key: 'private' });
      const err = await rejects(a.download('/audio', dest));
      expect(err).not.toBeNull();
      expect(err!.message.includes('private')).toBe(false);
      expect(otherCalls, 'credential-bearing redirect followed').toBe(0);
    } finally {
      await srv.close();
      await other?.close();
      await redirect?.close();
    }
  });
});
