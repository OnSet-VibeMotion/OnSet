import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { envMap, windowsPython } from '../envutil';
import { downloadSource, sourceLinks, sourceOutput, type DownloadOptions } from './sources';

const runtime = windowsPython(envMap());
const enabled = process.platform === 'win32' && runtime !== '';
const temps: string[] = [];
let base = '';
let requests = 0;
const zip = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64');
const server = http.createServer((req, res) => {
  requests++;
  if (req.url === '/old.zip' || req.url === '/work.html') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><a href="/download-link/public">Download</a><script>fetch("pieces.json")</script></html>');
  } else if (req.url === '/download-link/public') {
    if (req.headers.referer !== base + '/old.zip' && req.headers.referer !== base + '/work.html') { res.writeHead(403); res.end('referer required'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: base + '/archive.zip' }));
  } else if (req.url === '/archive.zip') {
    res.setHeader('Content-Type', 'application/zip'); res.end(zip);
  } else if (req.url === '/pieces.json') {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ isrc: 'DEMO001', title: '演示曲目' }]));
  } else if (req.url === '/audio.mp3') {
    res.setHeader('Content-Type', 'text/html'); res.end('<html>Download page</html>');
  } else if (req.url === '/large') {
    res.end(Buffer.alloc(1024, 1));
  } else {
    res.writeHead(404); res.end('missing');
  }
});
beforeAll(async () => {
  if (!enabled) return;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (enabled) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const temp of temps) fs.rmSync(temp, { recursive: true, force: true });
});

function fixture(overrides: Partial<DownloadOptions> = {}): DownloadOptions {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-source-test-'));
  temps.push(temp);
  const root = path.join(temp, '视频 项目');
  fs.mkdirSync(root);
  return { root, url: base + '/old.zip', output: 'production/audio/source/package.zip', kind: 'zip',
    env: { ...envMap(), XDG_DATA_HOME: path.join(temp, '中文工具'), PATH: path.dirname(runtime) + ';' + (envMap().PATH ?? ''), NO_PROXY: '127.0.0.1,localhost' }, ...overrides };
}

it('discovers dynamic JSON and real download links without running scripts', () => {
  const links = sourceLinks('<a href="/download-link/public">ZIP</a><script>fetch("pieces.json")</script>', 'https://example.org/music/work.html');
  expect(links).toEqual({ downloads: ['https://example.org/download-link/public'], json: ['https://example.org/music/pieces.json'] });
  expect(sourceLinks('<button data-endpoint="/download-link/public">Download</button>', 'https://example.org/work').downloads).toEqual(['https://example.org/download-link/public']);
  expect(sourceLinks('<a data-download-id="abc123">Download</a><script>fetch("https://example.org/download-link/" + id)</script>', 'https://example.org/work').downloads).toEqual(['https://example.org/download-link/abc123']);
});

it('limits source outputs to project source directories', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-source-path-'));
  temps.push(temp);
  for (const relative of ['production/audio/voice.wav', 'scenes/scene-001/video.mp4', 'production/approvals/cover.json', 'production/sources/../../outside', 'production/sources/audio.wav:alternate', 'production/sources/NUL.mp3', 'production/sources/audio.']) expect(() => sourceOutput(temp, relative)).toThrow();
  expect(sourceOutput(temp, 'production/sources/page.html')).toBe(path.join(temp, 'production/sources/page.html'));
});

describe.skipIf(!enabled)('Windows source downloads through a real prepared Python', () => {
  it('resolves an HTML download page and JSON endpoint to a valid ZIP; repeated requests reuse verified bytes', async () => {
    const opts = fixture();
    const result = await downloadSource(opts);
    expect(result.final_url).toBe(base + '/archive.zip');
    expect(fs.readFileSync(path.join(opts.root, opts.output))).toEqual(zip);
    const before = requests;
    expect((await downloadSource(opts)).reused).toBe(true);
    expect(requests).toBe(before);
    fs.writeFileSync(path.join(opts.root, opts.output), 'changed-by-another-writer');
    await expect(downloadSource(opts)).rejects.toThrow('已保留原文件');
    expect(fs.readFileSync(path.join(opts.root, opts.output), 'utf8')).toBe('changed-by-another-writer');
  });

  it('rejects HTML disguised as audio and failed requests without leaving target files', async () => {
    for (const [url, message] of [['/audio.mp3', '音频文件签名'], ['/missing', 'HTTPError']] as const) {
      const opts = fixture({ url: base + url, kind: 'audio', output: 'production/audio/source/music.mp3' });
      await expect(downloadSource(opts)).rejects.toThrow(message);
      expect(fs.existsSync(path.join(opts.root, opts.output))).toBe(false);
      expect(fs.existsSync(path.join(opts.root, opts.output + '.source.json'))).toBe(false);
    }
  });

  it('uses the explicitly supplied public work page for protected download endpoints', async () => {
    const opts = fixture({ url: base + '/download-link/public', workURL: base + '/work.html' });
    expect((await downloadSource(opts)).final_url).toBe(base + '/archive.zip');
  });

  it('binds dynamic-page JSON records to both the unique identifier and title', async () => {
    const opts = fixture({ url: base + '/pieces.json', kind: 'json', output: 'production/sources/pieces.json', recordField: 'isrc', recordValue: 'DEMO001', recordTitle: '演示曲目' });
    expect((await downloadSource(opts)).record).toEqual({ isrc: 'DEMO001', title: '演示曲目' });
    const mismatch = fixture({ url: base + '/pieces.json', kind: 'json', output: 'production/sources/pieces.json', recordField: 'isrc', recordValue: 'DEMO001', recordTitle: '另一个曲目' });
    await expect(downloadSource(mismatch)).rejects.toThrow('条目 ID/标题');
    expect(fs.existsSync(path.join(mismatch.root, mismatch.output))).toBe(false);
    expect(fs.existsSync(path.join(opts.root, opts.output))).toBe(true);
  });

  it('checks body limits and hashes before publication and preserves pre-existing files', async () => {
    const limited = fixture({ url: base + '/large', kind: 'json', output: 'production/sources/large.json', maxBytes: 10 });
    await expect(downloadSource(limited)).rejects.toThrow('byte limit');
    expect(fs.existsSync(path.join(limited.root, limited.output))).toBe(false);
    const wrongHash = fixture({ sha256: '0'.repeat(64) });
    await expect(downloadSource(wrongHash)).rejects.toThrow('SHA-256');
    expect(fs.existsSync(path.join(wrongHash.root, wrongHash.output))).toBe(false);
    const existing = fixture();
    fs.mkdirSync(path.dirname(path.join(existing.root, existing.output)), { recursive: true });
    fs.writeFileSync(path.join(existing.root, existing.output), 'approved source');
    await expect(downloadSource(existing)).rejects.toThrow('已保留原文件');
    expect(fs.readFileSync(path.join(existing.root, existing.output), 'utf8')).toBe('approved source');
  });
});
