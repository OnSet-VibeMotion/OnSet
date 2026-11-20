// 渲染中途异常退出后接着做（scene/resume.ts）：假的渲染工具与假的 HyperFrames CLI 代替画面从哪来，
// 判断接哪一层、续接的命令行与提示词、尝试记录都是真的在跑。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as hyperframes from '@onset/engine/hyperframes';
import { fakeCLI } from '@onset/engine/hyperframes/hftest';
import { Buffer, hasFfmpeg, lookPath, makeClip, run, setenv, tempDir } from './testutil';

const skip = !hasFfmpeg;

/**
 * 假 claude：按 mode 文件决定这一次怎么跑，命令行记进 calls.log、提示词存进 prompt-N.txt。
 *   crash-after-code 写好 index.html、报「代码已完成，开始渲染」后异常退出
 *   crash            说一句话后异常退出
 *   silent-on-resume 续接（--resume）时一句话不说就退出（会话找不到），新会话照常出片
 *   ok               照常出片
 */
function fakeClaude(binDir: string, modeFile: string, clip: string): void {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'claude.cmd'), '@echo off\r\nnode "%~dp0\\claude-fake.cjs" %*\r\n');
    fs.writeFileSync(path.join(binDir, 'claude-fake.cjs'), `
const fs = require('node:fs');
const args = process.argv.slice(2), resumed = args.includes('--resume');
const sid = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1] || '';
const calls = fs.existsSync('calls.log') ? fs.readFileSync('calls.log','utf8').trim().split('\\n').filter(Boolean).length : 0;
fs.appendFileSync('calls.log','resume=' + (resumed ? '1' : '') + ' sid=' + sid + '\\n');
fs.writeFileSync('prompt-' + (calls + 1) + '.txt',args.at(-1));
const mode = fs.readFileSync(${JSON.stringify(modeFile)},'utf8');
if (mode === 'silent-on-resume' && resumed) process.exit(1);
console.log(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:'fake'}));
const text = value => console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:value}]}}));
if (mode === 'crash-after-code') { fs.writeFileSync('index.html','<html></html>'); text('[[USER_MESSAGE]]代码已完成，开始渲染'); process.exit(1); }
if (mode === 'crash') { text('写到一半'); process.exit(1); }
if (mode === 'handoff' || mode === 'handoff-failed') {
  fs.writeFileSync('index.html','<html></html>');
  if (resumed) fs.rmSync('fail-direct', { force: true });
  text('[[USER_MESSAGE]]画面自查通过，交给片场渲染');
  if (mode === 'handoff') console.log(JSON.stringify({ type: 'result', is_error: false, num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: resumed ? 0.015 : 0.01 }));
  process.exit(mode === 'handoff' ? 0 : 1);
}
fs.copyFileSync(${JSON.stringify(clip)},'out.mp4'); text('[[USER_MESSAGE]]视频已渲染完成：out.mp4');
`);
    return;
  }
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
  handoff|handoff-failed)
    printf '<html></html>' > index.html
    if [ -n "$resume" ]; then /bin/rm -f fail-direct; fi
    text "[[USER_MESSAGE]]画面自查通过，交给片场渲染"
    if [ "$mode" = handoff ]; then
      cost=0.01
      if [ -n "$resume" ]; then cost=0.015; fi
      printf '{"type":"result","is_error":false,"num_turns":1,"usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":%s}\\n' "$cost"
      exit 0
    fi
    exit 1
    ;;
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
  if (process.platform === 'win32') {
    const entry = path.join(dir, 'node_modules/hyperframes/cli.cjs');
    fs.writeFileSync(entry, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('${hyperframes.PinnedVersion}'); process.exit(0); }
const output = args[args.indexOf('--output') + 1];
fs.appendFileSync('direct.log', args.join(' ') + '\\n');
if (fs.existsSync('fail-direct')) { fs.writeFileSync(output, 'partial'); console.error('test encoder failed'); process.exit(42); }
fs.copyFileSync(${JSON.stringify(clip)}, output);
`);
    return dir;
  }
  const script = `#!/bin/sh
if [ "$1" = --version ]; then echo ${hyperframes.PinnedVersion}; exit 0; fi
out=""; prev=""
for a; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done
echo "$*" >> direct.log
if [ -f fail-direct ]; then printf partial > "$out"; echo 'test encoder failed' >&2; exit 42; fi
/bin/cp '${clip}' "$out"
`;
  fs.writeFileSync(hyperframes.cliBinary(dir), script, { mode: 0o755 });
  return dir;
}

function setup(): { root: string; scene: string; mode: string } {
  const root = tempDir();
  const clip = path.join(root, 'clip.mp4');
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
  setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')) + path.delimiter + (process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin'));
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
  function handoffProject() {
    const fixture = setup();
    fs.writeFileSync(path.join(fixture.root, 'onset.flow.json'), '{"version":1,"production":{"id":"speech","canvas":"landscape-16x9","render_prompt":4}}');
    fs.writeFileSync(fixture.mode, 'handoff');
    return fixture;
  }

  it('renders a checked composition after a successful handoff with one model invocation', async () => {
    const { scene } = handoffProject();
    const result = await render();
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('视频已渲染完成：out.mp4');
    expect(calls(scene)).toHaveLength(1);
    expect(attempt(scene).outcome).toBe('succeeded');
  });

  it.each(['within', 'outside', 'cancel'])('publishes or restores a local repair (%s)', async mode => {
    const { root, scene } = handoffProject();
    const video = path.join(scene, 'out.mp4');
    const record = path.join(scene, '.onset-render.json');
    const entry = path.join(scene, 'index.html');
    const baseline = await render();
    expect(baseline.code, baseline.out).toBe(0);
    const before = fs.readFileSync(video);
    const oldRecord = fs.readFileSync(record);
    const source = '<html><!-- original composition --></html>';
    fs.writeFileSync(entry, source);
    const changedFrame = mode === 'outside' ? 3 : 8;
    const candidate = path.join(root, 'candidate.mp4');
    makeClip(candidate, 'testsrc=size=320x240:rate=30:duration=1', '-vf',
      `drawbox=x=24:y=18:w=90:h=66:c=white:t=fill:enable='eq(n,${changedFrame})'`);
    setenv(hyperframes.CLIDirEnv, fakeRenderCLI(candidate));
    fs.writeFileSync('request.json', JSON.stringify({
      issues: [{ start_frame: 7, end_frame_exclusive: 10, problem: '标题遮挡', acceptance: '标题完整可读' }],
    }));
    const out = new Buffer(), controller = new AbortController();
    const code = await run(['scene', 'repair', 'scenes/scene-001', '--request', 'request.json'], {
      write(message) {
        out.write(message);
        if (mode === 'cancel' && message === '代码已完成，开始渲染\n') controller.abort();
      },
    }, out, controller.signal);
    if (mode === 'within') {
      expect(code, out.text).toBe(0);
      expect(fs.readFileSync(video)).toEqual(fs.readFileSync(candidate));
      expect(fs.readFileSync(entry, 'utf8')).not.toEqual(source);
      expect(fs.readFileSync(path.join(scene, 'prompt-2.txt'), 'utf8')).toContain('标题完整可读');
      expect(attempt(scene).outcome).toBe('succeeded');
    } else {
      expect(code, out.text).not.toBe(0);
      expect(fs.readFileSync(video)).toEqual(before);
      expect(fs.readFileSync(record)).toEqual(oldRecord);
      expect(fs.readFileSync(entry, 'utf8')).toEqual(source);
      expect(attempt(scene).outcome).toBe(mode === 'cancel' ? 'interrupted' : 'verification_failed');
      expect(attempt(scene).local_repair).toBe(true);
      if (mode === 'outside') expect(out.text).toContain('第 3 帧不在返修区间');
    }
  });

  it('returns a direct-render error to the same session for one repair', async () => {
    const { scene } = handoffProject();
    fs.writeFileSync(path.join(scene, 'fail-direct'), '');
    const result = await render();
    expect(result.code, result.out).toBe(0);
    expect(calls(scene)).toHaveLength(2);
    expect(calls(scene)[1]).toMatch(/^resume=1 /);
    const prompt = fs.readFileSync(path.join(scene, 'prompt-2.txt'), 'utf8');
    expect(prompt).toContain('test encoder failed');
    expect(prompt).not.toContain('任务目标');
    expect(fs.readdirSync(scene).some(name => name.startsWith('.onset-encode-'))).toBe(false);
    expect(attempt(scene).usage).toMatchObject({ input_tokens: 20, output_tokens: 4, turns: 2, cost_usd: 0.015 });
  });

  it('does not render a handoff emitted by a renderer that then fails', async () => {
    const { scene, mode } = handoffProject();
    fs.writeFileSync(mode, 'handoff-failed');
    expect((await render()).code).toBe(1);
    expect(fs.existsSync(path.join(scene, 'direct.log'))).toBe(false);
  });

  it('reports a render log write failure and cleans up without asking the model to repair', async () => {
    const { scene } = handoffProject();
    fs.writeFileSync(path.join(scene, 'fail-direct'), '');
    const write = fs.writeSync;
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation((fd, value, ...args) => {
      if (typeof value === 'string' && value.includes('test encoder failed')) throw new Error('ENOSPC');
      return Reflect.apply(write, fs, [fd, value, ...args]);
    });
    try {
      const result = await render();
      expect(result.code, result.out).toBe(1);
      expect(attempt(scene).error).toContain('写入 HyperFrames 渲染日志失败：ENOSPC');
      expect(calls(scene)).toHaveLength(1);
      expect(fs.readdirSync(scene).some(name => name.startsWith('.onset-encode-'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not publish an output or ask for model repair after cancellation', async () => {
    const { scene } = handoffProject();
    const cancel = new AbortController();
    const out = new Buffer();
    const code = await run(['scene', 'run', 'scenes/scene-001'], {
      write(chunk) {
        out.write(chunk);
        if (chunk === '代码已完成，开始渲染\n') cancel.abort();
      },
    }, out, cancel.signal);
    expect(code).not.toBe(0);
    expect(attempt(scene).outcome).toBe('interrupted');
    expect(calls(scene)).toHaveLength(1);
    expect(fs.existsSync(path.join(scene, 'out.mp4'))).toBe(false);
  });

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
