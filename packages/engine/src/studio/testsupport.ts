/**
 * Studio 测试的公共设置与辅助函数。每个 *.test.ts 第一行导入它（vitest 每个测试文件一个独立的模块环境）。
 *
 * 设置部分对应 Go 的 main_test.go TestMain：
 * - 把记忆库指到临时目录：渲染记忆默认打开，没设 AM_MEMORY_DIR 的测试会把经历与快照写进开发者真实的
 *   ~/.local/share/am/memory。
 * - 渲染前会确保 am 管理的 HyperFrames CLI 已装好；测试里换成假的，免得真的去 npm install。
 * - 新建项目会在后台装 HyperFrames 官方技能；测试里换成什么都不做。
 *
 * Go 测试经 httptest 起真服务；这里直接构造 Request 调 Server.handle。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach } from 'vitest';
import { CLIDirEnv } from '../hyperframes';
import { fakeCLI } from '../hyperframes/hftest';
import { setInstallOfficialSkills } from './skills';
import { Server, type Config } from './studio';

const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-memory-test-'));
process.env.AM_MEMORY_DIR = memoryDir;
const cli = path.join(memoryDir, 'hyperframes-cli');
fakeCLI(cli);
process.env[CLIDirEnv] = cli;
setInstallOfficialSkills(async () => {});

const temps: string[] = [];
const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

/** t.TempDir()：测试结束时删掉。返回 realpath 之前的路径（与 Go 一样，macOS 上是 /var/…）。 */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-studio-'));
  temps.push(dir);
  return dir;
}

/** t.Setenv：本条用例结束后还原。 */
export function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

export function writeStudioFile(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) writeStudioFile(path.join(root, rel), body);
}

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 写一张 width×height 的全透明 RGBA PNG（Go 测试用 png.Encode(image.NewRGBA(...))）。 */
export function writeStudioPNG(file: string, width = 2, height = 3): void {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  writeStudioFile(file, png);
}

export const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

/** 用 ffmpeg 造一张 width×height 的 JPEG（Go 测试用 image/jpeg 现编）。 */
export function writeStudioJPEG(file: string, width: number, height: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ran = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=1`, '-frames:v', '1', file]);
  if (ran.status !== 0) throw new Error('ffmpeg 造 JPEG 失败：' + ran.stderr.toString());
}

export function startStudio(cfg: Config): Server {
  return new Server(cfg);
}

const base = 'http://studio.test';

export interface JSONResult {
  status: number;
  body: any;
  headers: Headers;
}

/** 发一个请求并跟随 301（Go 的 http.Client 会跟）。 */
export async function send(s: Server, method: string, url: string, body?: string | FormData, headers: Record<string, string> = {}): Promise<Response> {
  let target = url;
  for (let i = 0; i < 5; i++) {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined && body !== '') {
      init.body = body;
      if (typeof body === 'string') (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    const res = await s.handle(new Request(base + target, init));
    if (res.status !== 301) return res;
    target = res.headers.get('Location')!;
  }
  throw new Error('重定向太多');
}

/** studioRequest：返回状态码与解析后的 JSON（空响应为 undefined）。 */
export async function studioRequest(s: Server, method: string, url: string, body = ''): Promise<JSONResult> {
  const res = await send(s, method, url, body);
  const text = await res.text();
  let parsed: unknown;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${url}: response is not JSON: ${JSON.stringify(text)}`);
    }
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export async function rawGet(s: Server, url: string): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await send(s, 'GET', url);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitStudioTask(s: Server, id: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { status, body } = await studioRequest(s, 'GET', '/api/tasks/' + id);
    if (status === 200 && ['succeeded', 'failed', 'cancelled'].includes(body.status)) return body;
    await sleep(10);
  }
  throw new Error(`task ${id} did not finish`);
}

/**
 * fakeClaude 是一个假的 claude：记下参数，按 --session-id / --resume 回报会话，
 * 改写 scenes/scene-001/prompt.md，输出一组 stream-json。
 *
 * 子进程环境按安全模式白名单构造，测试用的开关要经 AM_PASSTHROUGH_ENV 透传。
 */
export const fakeClaude = `#!/bin/sh
printf '%s' "$*" | tr '\\n' ' ' >> "$FAKE_ARGS_LOG"; echo >> "$FAKE_ARGS_LOG"
printf '%s\\n' "$RENDERER" > "$FAKE_ARGS_LOG.renderer"
sid=""; prev=""; resume=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ]; then sid="$a"; fi
  if [ "$prev" = "--resume" ]; then sid="$a"; resume=1; fi
  prev="$a"
done
if [ -n "$resume" ] && [ -n "$FAKE_FAIL_RESUME" ]; then echo "No conversation found with session ID: $sid" >&2; exit 1; fi
printf '{"type":"system","subtype":"init","session_id":"%s","model":"claude-fake"}\\n' "$sid"
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "$FAKE_VIEW" ] && [ -n "$AM_STUDIO_INBOX" ]; then mkdir -p "$AM_STUDIO_INBOX"; printf '%s' "$FAKE_VIEW" > "$AM_STUDIO_INBOX/1.json"; fi
printf '%s\\n' "\${FAKE_CONTENT:-edited}" > scenes/scene-001/prompt.md
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Write","input":{"file_path":"scenes/scene-001/prompt.md"}}]}}\\n'
printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}\\n'
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"改好了"}]}}\\n'
printf '{"type":"result","subtype":"success","is_error":false,"result":"改好了","usage":{"input_tokens":3,"output_tokens":4},"total_cost_usd":0.01,"num_turns":1}\\n'
`;

export interface SessionFixture {
  root: string;
  argsLog: string;
  s: Server;
}

export function newSessionFixture(): SessionFixture {
  const root = tempDir();
  writeTree(root, {
    'article-to-motion.conf': 'ORCHESTRATOR=claude\nRENDERER=claude\n',
    'PROMPT.md': '整片制作提示词',
    'scenes/scene-001/scene.json': '{"id":"scene-001","duration_seconds":1,"output":"out.mp4"}',
    'scenes/scene-001/prompt.md': 'original',
    'scenes/scene-001/index.html': '<html>composition</html>',
    'scenes/scene-001/.env': 'NOTE=1',
    '.env': 'NOTE=1',
    '.agents/skills/scene-kit/SKILL.md': 'skill',
    '.agents/skills/hyperframes-upstream.json': '{"commit":"abc"}',
  });
  const bin = tempDir();
  fs.writeFileSync(path.join(bin, 'claude'), fakeClaude, { mode: 0o755 });
  const argsLog = path.join(tempDir(), 'args.log');
  setEnv('PATH', bin + path.delimiter + (process.env.PATH ?? ''));
  setEnv('ORCHESTRATOR', 'claude');
  setEnv('RENDERER', 'claude');
  setEnv('FAKE_ARGS_LOG', argsLog);
  setEnv('FAKE_SLEEP', '');
  setEnv('FAKE_FAIL_RESUME', '');
  setEnv('FAKE_CONTENT', '');
  setEnv('FAKE_VIEW', '');
  setEnv('AM_PASSTHROUGH_ENV', 'FAKE_ARGS_LOG,FAKE_SLEEP,FAKE_FAIL_RESUME,FAKE_CONTENT,FAKE_VIEW');
  const s = startStudio({ projectPath: root, configPath: path.join(tempDir(), 'projects.json') });
  // 服务端按 realpath 后的路径区分项目（macOS 的 /var → /private/var），测试要用同一个。
  return { root: s.currentProject().path, argsLog, s };
}

export async function waitIdle(f: SessionFixture, sessionID: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { status, body } = await studioRequest(f.s, 'GET', '/api/sessions/' + sessionID);
    if (status !== 200) throw new Error(`status = ${status} (${JSON.stringify(body)})`);
    if (body.session.running_turn === undefined && f.s.busyHolder(f.root) === '') return body;
    await sleep(20);
  }
  throw new Error('对话没有结束');
}

export function args(f: SessionFixture): string[] {
  return fs.readFileSync(f.argsLog, 'utf8').trim().split('\n');
}

export function readScenePrompt(f: SessionFixture): string {
  try {
    return fs.readFileSync(path.join(f.root, 'scenes', 'scene-001', 'prompt.md'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function lastTurn(detail: Record<string, any>): Record<string, any> {
  const turns = detail.turns as Record<string, any>[];
  return turns[turns.length - 1];
}
