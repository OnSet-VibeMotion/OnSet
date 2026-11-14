// 渲染中途异常退出后接着做（scene/resume.ts）：假的渲染工具与假的 HyperFrames CLI 代替画面从哪来，
// 判断接哪一层、续接的命令行与提示词、尝试记录都是真的在跑。只在非 Windows 上跑。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as hyperframes from '@onset/engine/hyperframes';
import { fakeCLI } from '@onset/engine/hyperframes/hftest';
import { Buffer, hasFfmpeg, lookPath, makeClip, run, setenv, tempDir } from './testutil';

const skip = !hasFfmpeg || process.platform === 'win32';

/**
 * 假 claude：按 mode 文件决定这一次怎么跑，命令行记进 calls.log、提示词存进 prompt-N.txt。
 *   crash-after-code 写好 index.html、报「代码已完成，开始渲染」后异常退出
 *   crash            说一句话后异常退出
 *   silent-on-resume 续接（--resume）时一句话不说就退出（会话找不到），新会话照常出片
 *   ok               照常出片
 */
function fakeClaude(binDir: string, modeFile: string, clip: string): void {
  const script = `#!/bin/sh
sid=""; resume=""; prev=""
for a; do
  if [ "$prev" = "--session-id" ]; then sid="$a"; fi
  if [ "$prev" = "--resume" ]; then sid="$a"; resume=1; fi
  prev="$a"; last="$a"
done
n=$(( $(/bin/cat calls.log 2>/dev/null | /usr/bin/wc -l) + 1 ))
printf '%s\\n' "resume=$resume sid=$sid" >> calls.log
printf '%s' "$last" > prompt-$n.txt
mode=$(/bin/cat '${modeFile}')
if [ "$mode" = "silent-on-resume" ] && [ -n "$resume" ]; then exit 1; fi
printf '{"type":"system","subtype":"init","session_id":"%s","model":"fake"}\\n' "$sid"
text() { printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\\n' "$1"; }
case "$mode" in
  crash-after-code) printf '<html></html>' > index.html; text "[[USER_MESSAGE]]代码已完成，开始渲染"; exit 1 ;;
  crash) text "写到一半"; exit 1 ;;
esac
/bin/cp '${clip}' out.mp4
text "[[USER_MESSAGE]]视频已渲染完成：out.mp4"
`;
  fs.writeFileSync(path.join(binDir, 'claude'), script, { mode: 0o755 });
}

/** 假 HyperFrames CLI：render --output X 把素材拷到 X，并记一笔。 */
function fakeRenderCLI(clip: string): string {
  const dir = tempDir();
  fakeCLI(dir);
  const script = `#!/bin/sh
if [ "$1" = --version ]; then echo ${hyperframes.PinnedVersion}; exit 0; fi
out=""; prev=""
for a; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done
echo "$*" >> direct.log
/bin/cp '${clip}' "$out"
`;
  fs.writeFileSync(hyperframes.cliBinary(dir), script, { mode: 0o755 });
  return dir;
}

function setup(): { root: string; scene: string; mode: string } {
  const root = tempDir();
  const clip = path.join(tempDir(), 'clip.mp4');
  makeClip(clip, 'testsrc=size=320x240:rate=30:duration=1');
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=claude\nRENDERER=claude\n');
  const scene = path.join(root, 'scenes', 'scene-001');
  fs.mkdirSync(scene, { recursive: true });
  fs.writeFileSync(path.join(scene, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
  fs.writeFileSync(path.join(scene, 'scene.json'), '{"id":"scene-001","duration_seconds":1,"output":"out.mp4","transcript":"transcript.srt","text":"内容"}');
  const binDir = tempDir();
  const mode = path.join(tempDir(), 'mode');
  fakeClaude(binDir, mode, clip);
  setenv(hyperframes.CLIDirEnv, fakeRenderCLI(clip));
  process.chdir(root);
  setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')) + path.delimiter + '/usr/bin:/bin');
  setenv('HOME', tempDir());
  return { root, scene, mode };
}

async function render(...extra: string[]): Promise<{ code: number; out: string }> {
  const out = new Buffer();
  const errOut = new Buffer();
  const code = await run(['scene', 'run', 'scenes/scene-001', ...extra], out, errOut);
  return { code, out: out.text + errOut.text };
}

const attempt = (scene: string) => JSON.parse(fs.readFileSync(path.join(scene, 'render-scene-001.attempt.json'), 'utf8'));
const calls = (scene: string) => fs.readFileSync(path.join(scene, 'calls.log'), 'utf8').trim().split('\n');

describe.skipIf(skip)('resume an interrupted render', () => {
  it('renders the finished composition itself, without the model', async () => {
    const { scene, mode } = setup();
    fs.writeFileSync(mode, 'crash-after-code');
    expect((await render()).code).toBe(1);
    const first = attempt(scene);
    expect(first.outcome).toBe('failed');
    expect(first.session_id).not.toBe('');
    const result = await render();
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('直接渲染出片');
    expect(attempt(scene).resumed).toBe('render');
    // 模型只被叫过一次（第一次），第二次是 onset 自己渲染的。
    expect(calls(scene)).toHaveLength(1);
    expect(fs.readFileSync(path.join(scene, 'direct.log'), 'utf8')).toContain('render --output out.mp4');
  });

  it('resumes the renderer session with a short prompt', async () => {
    const { scene, mode } = setup();
    fs.writeFileSync(mode, 'crash');
    expect((await render()).code).toBe(1);
    const sid = attempt(scene).session_id;
    fs.writeFileSync(mode, 'ok');
    const result = await render();
    expect(result.code, result.out).toBe(0);
    expect(calls(scene)[1]).toBe(`resume=1 sid=${sid}`);
    const prompt = fs.readFileSync(path.join(scene, 'prompt-2.txt'), 'utf8');
    expect(prompt).toContain('上一次渲染在中途中断了');
    expect(prompt).not.toContain('任务目标');
    expect(attempt(scene).resumed).toBe('session');
  });

  it('starts a new session from the files left behind when the old session is gone', async () => {
    const { scene, mode } = setup();
    fs.writeFileSync(mode, 'crash');
    fs.writeFileSync(path.join(scene, 'stage.js'), '// 写到一半');
    expect((await render()).code).toBe(1);
    fs.writeFileSync(mode, 'silent-on-resume');
    const result = await render();
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('原来的会话续不上');
    const log = calls(scene);
    expect(log[1]).toMatch(/^resume=1 /);
    expect(log[2]).toMatch(/^resume= sid=\S+/);
    const prompt = fs.readFileSync(path.join(scene, 'prompt-3.txt'), 'utf8');
    expect(prompt).toContain('任务目标');
    expect(prompt).toContain('接着上一次做');
    expect(prompt).toContain('stage.js');
    expect(prompt).toContain('写到一半');
    expect(attempt(scene).resumed).toBe('files');
  });

  it('starts over when asked to', async () => {
    const { scene, mode } = setup();
    fs.writeFileSync(mode, 'crash');
    expect((await render()).code).toBe(1);
    fs.writeFileSync(mode, 'ok');
    expect((await render('--fresh')).code).toBe(0);
    expect(calls(scene)[1]).toMatch(/^resume= /);
    expect(fs.readFileSync(path.join(scene, 'prompt-2.txt'), 'utf8')).not.toContain('接着上一次做');
    expect(attempt(scene).resumed).toBeUndefined();
  });
});
