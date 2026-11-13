// 本包测试共用的辅助（对应 workflow_test.go 的 fakeEnvironment、hosted_test.go 的 mockResponse）。
// 不从 index.ts 导出。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HttpResponse } from './http';
import { DefaultConfig } from './store';

const temps: string[] = [];

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-song-'));
  temps.push(dir);
  return dir;
}

export function cleanupTemps(): void {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** 收集写出内容的 Writer，对应 bytes.Buffer。 */
export class Buf {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
  toString(): string {
    return this.text;
  }
}

/** 假的 ffprobe / ffmpeg / mmx / python3 与一个带默认 song.yaml 的项目。 */
export function fakeEnvironment(): { root: string; env: Record<string, string> } {
  const root = tempDir();
  const bin = tempDir();
  const scripts: Record<string, string> = {
    ffprobe: `#!/bin/sh
printf '%s' '{"format":{"duration":"10"},"streams":[{"codec_type":"audio","sample_rate":"48000","channels":2}]}'
`,
    ffmpeg: `#!/bin/sh
for arg do last="$arg"; done
case "$last" in *.wav) printf 'wav' > "$last";; esac
`,
    mmx: `#!/bin/sh
case "$*" in *--help*) echo --lyrics-file; exit 0;; esac
while [ "$#" -gt 0 ]; do
 if [ "$1" = --out ]; then shift; printf 'audio' > "$1"; exit 0; fi
 shift
done
exit 1
`,
    python3: `#!/bin/sh
case "$*" in
 *beat_track*) echo '[1,2,3]'; exit 0;;
 *' align '*)
 while [ "$#" -gt 0 ]; do
 if [ "$1" = --output-dir ]; then shift; out="$1"; fi
 shift
 done
 printf '%s' '{"lines":[{"index":0,"text":"歌词","start":1,"end":8,"status":"aligned","tokens":[{"text":"歌词","start":1,"end":8}]}]}' > "$out/alignment.json"
 printf '{}' > "$out/report.json"
 exit 0;;
 *) exit 0;;
esac
`,
  };
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'song.yaml'), DefaultConfig);
  fs.writeFileSync(path.join(root, 'lyrics.txt'), '[Verse]\n歌词\n');
  return { root, env: { PATH: bin, HOME: tempDir() } };
}

async function* bodyOf(data: Uint8Array): AsyncIterable<Uint8Array> {
  if (data.length > 0) yield data;
}

/** mockResponse：200 与给定正文。 */
export function mockResponse(body: string, status = 200): HttpResponse {
  return { status, headers: new Headers(), body: bodyOf(Buffer.from(body)) };
}

/** 读完请求体并按 JSON 解析（Go 测试里 json.NewDecoder(r.Body).Decode(&b)）。 */
export function jsonBody(body: Buffer | null): Record<string, unknown> {
  return JSON.parse((body ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>;
}

/** httptest.NewServer 的对应物：起一个回环 HTTP 服务。 */
export async function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 读完 Node 请求体。 */
export function readRequest(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 递归列出目录下的文件。 */
export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}
