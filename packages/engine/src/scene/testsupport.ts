// 本包测试共用的辅助，对应 Go 测试文件里的包级辅助（scene_test.go、run_test.go、timing_test.go、
// scenedata_test.go、filmstyle_test.go、main_test.go）。不从 index.ts 导出。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import { goRound } from '../gofmt';
import * as hyperframes from '../hyperframes';
import { fakeBrowser, fakeCLI } from '../hyperframes/hftest';
import { load, type Scene } from './scene';
import { PhraseCopyFile } from './timing';
import { writeShellFixture } from '../testsupport/windowsfixtures';

// main_test.go 的 TestMain：渲染前会确保 onset 管理的 HyperFrames CLI 已装好，测试里换成假的，
// 免得真的去 npm install。导入本文件即生效。
const fakeCLIDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-hyperframes-cli-test-'));
fakeCLI(fakeCLIDir);
process.env.ONSET_BROWSER = fakeBrowser(fakeCLIDir);
// onset setup 下载的工具目录指到空目录：开发机上 ~/.local/share/onset/bin 里真实的 ffmpeg、mmx 不能混进测试。
process.env.ONSET_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-bin-test-'));
process.env[hyperframes.CLIDirEnv] = fakeCLIDir;

/** t.TempDir()：测试结束时删掉。 */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-scene-'));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 镜头目录里放一份 3:4 的 frame.md（画幅只从 frame.md 取，没有它镜头读不出画幅）。 */
export function writeScene(payload: string): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'frame.md'), frameWithCanvas(1080, 1440));
  fs.writeFileSync(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\ntest\n');
  fs.writeFileSync(path.join(dir, 'scene.json'), payload);
  return dir;
}

/** 加载镜头，失败时让测试直接失败（Go 测试里的 `s, _ := Load(dir)` 都假定能加载）。 */
export function mustLoad(dir: string): Scene {
  return load(dir);
}

export function quote(value: string): string {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}

/** 最小 frame.md：buildPrompt 只读 canvas 这一段。 */
export function frameWithCanvas(width: number, height: number): string {
  return `---\ncanvas:\n  width_px: ${width}\n  height_px: ${height}\n  fps: 30\n  orientation: vertical\n---\n正文\n`;
}

export function containsString(list: readonly string[] | undefined, value: string): boolean {
  return (list ?? []).includes(value);
}

/** 写一个可执行的 sh 脚本。 */
export function executable(dir: string, name: string, body: string): void {
  writeShellFixture(path.join(dir, name), '#!/bin/sh\nset -eu\n' + body);
}

/**
 * 假 ffprobe 要汇报的规格。零值就是「合规的默认画幅镜头产物」：
 * 1080x1440、30fps、无音轨，正是默认画幅期望的样子。
 */
export interface ProbeReply {
  widthPx?: number;
  heightPx?: number;
  fpsNum?: number;
  duration?: string;
  audio?: boolean;
  /** 逐帧解码统计（-count_frames）汇报的帧数；0 表示按时长 × 帧率推出。 */
  frames?: number;
}

/**
 * 装一个按 mediaprobe 的调用方式输出 JSON 的假 ffprobe。
 *
 * 这里必须输出真 JSON 而不是一个数字：verifyOutput 走 mediaprobe 的解析路径，
 * 假工具的输出格式偏离真实 ffprobe 的话，测试就只是在验证测试自己。
 */
export function fakeFfprobe(dir: string, reply: ProbeReply): void {
  const widthPx = reply.widthPx || 1080;
  const heightPx = reply.heightPx || 1440;
  const fpsNum = reply.fpsNum || 30;
  const duration = reply.duration || '1.000';
  const frames = reply.frames || goRound(Number(duration) * fpsNum);
  const audio = reply.audio ? ',{"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}' : '';
  // 只能用 shell 内建：安全模式下子进程的 PATH 就是这个临时目录，
  // cat / echo 之类的外部命令都不在里面。
  const json =
    '{"streams":[{"codec_type":"video","codec_name":"h264",' +
    `"width":${widthPx},"height":${heightPx},"pix_fmt":"yuv420p","r_frame_rate":"${fpsNum}/1",` +
    `"nb_frames":"30","nb_read_frames":"${frames}","duration":"${duration}"}${audio}],"format":{"duration":"${duration}"}}`;
  executable(dir, 'ffprobe', "printf '%s\\n' '" + json + "'\n");
}

export const testPlanSHA = 'a'.repeat(64);

export const dataSRT = `1
00:00:03,000 --> 00:00:04,500
上一镜的字幕

2
00:00:04,500 --> 00:00:06,000
跨过起点的字幕

3
00:00:07,000 --> 00:00:08,000
本镜头内

4
00:00:09,500 --> 00:00:11,000
跨过终点

5
00:00:12,000 --> 00:00:13,000
下一镜
`;

export const dataFrame = `---
canvas:
  width_px: 1080
  height_px: 1920
  fps: 30
safe_area:
  main_content: {left_px: 88, right_px: 88, top_px: 120, bottom_px: 100}
  subtitles: {left_px: 88, right_px: 180, top_px: 990, bottom_px: 260}
subtitles:
  required: false
  max_lines: 2
  line_height: {min: 1.30, max: 1.40}
---
正文
`;

export const dataPhrases = `{"schema":1,"fps":30,"phrases":[
{"phrase_id":"p-1","source_text":"上一镜","start_frame":90,"end_frame_exclusive":135},
{"phrase_id":"p-2","source_text":"GPU 跑满了","start_frame":140,"end_frame_exclusive":200},
{"phrase_id":"p-3","source_text":"下一镜","start_frame":300,"end_frame_exclusive":330}]}`;

/** 镜头覆盖全局 [150, 300)：5 到 10 秒。 */
export function dataScene(): Scene {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'transcript.srt'), dataSRT);
  fs.writeFileSync(path.join(dir, 'frame.md'), dataFrame);
  fs.writeFileSync(path.join(dir, PhraseCopyFile), dataPhrases);
  fs.writeFileSync(
    path.join(dir, 'scene.json'),
    `{"id":"scene-002","duration_seconds":5.000000,"output":"out.mp4","transcript":"transcript.srt","text":"hello",
"timing":{"fps":30,"start_frame":150,"end_frame_exclusive":300,"plan":"${testPlanSHA}","phrases":"${PhraseCopyFile}"}}`,
  );
  return load(dir);
}

/** 写给用户看的输出，收集成字符串（Go 的 bytes.Buffer）。 */
export class Sink {
  text = '';
  write(chunk: string): void {
    this.text += chunk;
  }
}
