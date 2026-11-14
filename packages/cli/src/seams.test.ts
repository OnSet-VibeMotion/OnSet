// scene_seams 端到端：假渲染器代替画面从哪来，修接缝的准备、提示词、按帧核对、恢复都是真的在跑。只在非 Windows 上跑。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as mediaprobe from '@onset/engine/mediaprobe';
import { Buffer, hasFfmpeg, lookPath, makeClip, run, setenv, tempDir } from './testutil';

const skip = !hasFfmpeg;

/**
 * 修接缝的假渲染器。good：开头 10 帧换成 seam/plate.png，其余照搬修之前的产物（seam/before.mp4），正是修接缝要的样子；
 * 否则原样照搬修之前的产物，第 0 帧接不上，onset 应当判它没做成。另把收到的提示词存一份。
 */
function seamRenderer(binDir: string, good: boolean): void {
  if (process.platform === 'win32') {
    const args = ['-v','error','-y','-f','lavfi','-i','color=c=red:s=320x240:r=30:d=0.333333','-i','seam/before.mp4','-filter_complex','[0:v]scale=320:240,format=yuv420p,trim=end_frame=10,setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=10,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p','-an','out.mp4'];
    fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@echo off\r\nnode "%~dp0\\codex-fake.cjs" %*\r\n');
    fs.writeFileSync(path.join(binDir, 'codex-fake.cjs'), `const fs=require('node:fs');fs.writeFileSync('prompt.txt',process.argv.at(-1));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'[[USER_MESSAGE]]视频已渲染完成'}}));${good ? `require('node:child_process').execFileSync(${JSON.stringify(lookPath('ffmpeg'))},${JSON.stringify(args)},{windowsHide:true});` : "fs.copyFileSync('seam/before.mp4','out.mp4');"}\n`);
    return;
  }
  const ffmpeg = lookPath('ffmpeg');
  const make = good
    ? `'${ffmpeg}' -v error -y -loop 1 -framerate 30 -i seam/plate.png -i seam/before.mp4 -filter_complex "[0:v]scale=320:240,format=yuv420p,trim=end_frame=10,setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=10,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[v]" -map "[v]" -c:v libx264 -pix_fmt yuv420p -an out.mp4`
    : `/bin/cp seam/before.mp4 out.mp4`;
  const script =
    '#!/bin/sh\nset -eu\n' +
    'for a; do last="$a"; done\nprintf \'%s\' "$last" > prompt.txt\n' +
    "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"[[USER_MESSAGE]]视频已渲染完成\"}}'\n" +
    make +
    '\n';
  fs.writeFileSync(path.join(binDir, 'codex'), script, { mode: 0o755 });
}

/** 红 → 蓝两个 1 秒镜头，后一个约定了 match 交接：两边颜色完全不同，是一道没接上的交界。 */
function project(): { root: string; scenes: string; second: string } {
  const root = tempDir();
  fs.writeFileSync(path.join(root, 'frame.md'), '---\ncanvas:\n  width_px: 320\n  height_px: 240\n  fps: 30\n---\n');
  fs.writeFileSync(path.join(root, 'onset.conf'), 'ORCHESTRATOR=codex\nRENDERER=codex\n');
  const scenes = path.join(root, 'scenes');
  const colors: Record<string, string> = { 'scene-001': 'red', 'scene-002': 'blue' };
  for (const [index, id] of ['scene-001', 'scene-002'].entries()) {
    const dir = path.join(scenes, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n');
    const scene: Record<string, unknown> = { id, duration_seconds: 1, output: 'out.mp4', transcript: 'transcript.srt', text: '内容' };
    if (index === 1) {
      scene.timing = { fps: 30, start_frame: 30, end_frame_exclusive: 60, plan: 'a'.repeat(64), phrases: '', chapter: 'c', enter: { peer: 'scene-001', device: 'match', bridge: '红色铺满画面' } };
    }
    fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(scene));
    makeClip(path.join(dir, 'out.mp4'), `color=c=${colors[id]}:size=320x240:rate=30:duration=1`);
  }
  return { root, scenes, second: path.join(scenes, 'scene-002') };
}

describe.skipIf(skip)('scene seams', () => {
  const toolchain = () => mediaprobe.newToolchain(process.env as Record<string, string>);

  it('redoes the head of the next scene from the real last frame of the previous one', async () => {
    const { root, second } = project();
    const binDir = tempDir();
    seamRenderer(binDir, true);
    process.chdir(root);
    setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')));
    setenv('HOME', tempDir());
    const out = new Buffer();
    const errOut = new Buffer();
    const code = await run(['scene', 'seams', 'scenes/', '--frames', '10'], out, errOut);
    expect(code, `stdout: ${out.text}\nstderr: ${errOut.text}`).toBe(0);
    expect(out.text).toContain('scene-001 → scene-002：修好了');
    // 渲染器拿到的是修接缝的要求，材料都在 seam/ 里。
    const prompt = fs.readFileSync(path.join(second, 'prompt.txt'), 'utf8');
    expect(prompt).toContain('本次只修开头的衔接');
    expect(prompt).toContain('seam/plate.png');
    for (const name of ['plate.png', 'prev-6.png', 'before.mp4']) expect(fs.existsSync(path.join(second, 'seam', name)), name).toBe(true);
    // 第 0 帧就是前一镜的末帧（红），第 10 帧以后还是原来的蓝。
    const tc = toolchain();
    const red = path.join(root, 'scenes', 'scene-001', 'out.mp4');
    expect(tc.frameDifferenceBetween(red, 29 / 30, path.join(second, 'out.mp4'), 0)).toBeLessThan(5);
    expect(tc.frameDifferenceBetween(path.join(second, 'seam', 'before.mp4'), 20 / 30, path.join(second, 'out.mp4'), 20 / 30)).toBeLessThan(5);
  });

  it('puts the scene back when the head is not redone', async () => {
    const { root, second } = project();
    const binDir = tempDir();
    seamRenderer(binDir, false);
    process.chdir(root);
    setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')));
    setenv('HOME', tempDir());
    const original = fs.readFileSync(path.join(second, 'out.mp4'));
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['scene', 'seams', 'scenes/', '--frames', '10'], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('没修成，已恢复原产物');
    expect(out.text).toContain('第 0 帧与 scene-001 的末帧');
    // 两次都没修成：产物恢复成修之前的那一份，逐字节相同。
    expect(fs.readFileSync(path.join(second, 'out.mp4')).equals(original)).toBe(true);
  });

  it('leaves joined seams alone', async () => {
    const { root, scenes } = project();
    // 两边都换成同一种颜色：交界已经接上。
    makeClip(path.join(scenes, 'scene-002', 'out.mp4'), 'color=c=red:size=320x240:rate=30:duration=1');
    const binDir = tempDir();
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    process.chdir(root);
    setenv('PATH', binDir + path.delimiter + path.dirname(lookPath('ffmpeg')));
    const out = new Buffer();
    const errOut = new Buffer();
    expect(await run(['scene', 'seams', 'scenes/'], out, errOut), errOut.text).toBe(0);
    expect(out.text).toContain('已经接上');
    expect(fs.existsSync(path.join(scenes, 'scene-002', 'seam'))).toBe(false);
  });
});
