/**
 * 双跑对照的用例。每个用例：
 *   name      名字（命令行可按子串过滤）
 *   setup     用 Go 版 am 建样例项目的步骤（在空目录里依次执行）
 *   prepare   可选：建好后再手工写入的文件（函数，参数是项目目录）
 *   commands  要两边各跑一遍、逐字节比对的命令
 *   ignore    可选：不参与文件比对的路径（正则，相对项目根），例如带时间戳的日志
 *
 * 只收确定性的命令：输出里不带当前时间、随机数，不调用外部 AI CLI。
 * 随移植进度逐步补充；每移植一组命令就在这里加上它们的用例。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cases as beatSongCast } from './cases-beat-song-cast.mjs';
import { cases as cuesUsage } from './cases-cues-usage.mjs';
import { cases as mediaReviewReads } from './cases-media-review-reads.mjs';
import { cases as sceneRunValidate } from './cases-scene-run-validate.mjs';

const goAm = process.env.AM_GO || path.join(os.homedir(), '.local/bin/am');
const fixtures = path.join(import.meta.dirname, 'fixtures');

/** 用 fixtures 里的合成终稿（标记写法与真实项目相同）造一份逐字对齐结果：每字 0.2 秒，故意漏两个字、多一个字，覆盖漏读、多读与插值。 */
function alignFixture(base) {
  fs.mkdirSync(path.join(base, 'production', 'audio'), { recursive: true });
  fs.copyFileSync(path.join(fixtures, 'script-final.md'), path.join(base, 'production', 'script-final.md'));
  spawnSync(goAm, ['align', 'text'], { cwd: base });
  const chars = [...fs.readFileSync(path.join(base, 'production', 'audio', 'tts-text.txt'), 'utf8')].filter((c) => !/[\s，。：、；！？,.!?]/.test(c));
  const items = [];
  let t = 0.3;
  chars.forEach((c, i) => {
    if (i === 10 || i === 57) return;
    if (i === 30) {
      items.push({ text: '嗯', start: Number(t.toFixed(3)), end: Number((t + 0.15).toFixed(3)) });
      t += 0.15;
    }
    items.push({ text: c, start: Number(t.toFixed(3)), end: Number((t + 0.2).toFixed(3)) });
    t += 0.2;
  });
  fs.writeFileSync(path.join(base, 'production', 'audio', 'align.json'), JSON.stringify(items));
}

/** 合成配音：0.5–1.5 秒与 2.0–3.2 秒有声，其余静音；第二条字幕故意提前 0.6 秒。 */
function voiceFixture(base) {
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.5,1.5)+between(t,2.0,3.2),0.5*sin(2*PI*440*t),0)':s=16000:d=4", path.join(base, 'voice.wav')]);
  fs.writeFileSync(path.join(base, 'voice.srt'), '1\n00:00:00,500 --> 00:00:01,500\n第一句\n\n2\n00:00:01,400 --> 00:00:03,200\n第二句\n');
  fs.writeFileSync(path.join(base, 'good.srt'), '1\n00:00:00,500 --> 00:00:01,500\n第一句\n\n2\n00:00:02,000 --> 00:00:03,200\n第二句\n');
}

export const cases = [
  {
    name: 'setup',
    commands: [['setup', '--help'], ['setup', '--check'], ['setup', '--check', '--only', 'cli'], ['setup', '--only', 'nope'], ['setup', 'extra']],
  },
  {
    name: 'film-style outside a project',
    commands: [['film-style', '--help'], ['film-style', 'list'], ['film-style', 'list', '--json'], ['film-style', 'list', '--source', 'nope'], ['film-style', 'show']],
  },
  {
    name: 'film-style in a project',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [['film-style', 'show'], ['film-style', 'show', '--json'], ['film-style', 'remove'], ['film-style', 'use', 'no-such-style'], ['film-style', 'use']],
  },
  {
    name: 'hyperframes help',
    commands: [['hyperframes', '--version']],
  },
  {
    name: 'init variants',
    commands: [
      ['init', '--help'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'vertical-9x16', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'landscape-16x9', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--narration', 'cast'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'song'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--delivery', 'beat'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--style', 'pixel-arcade-v1'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--style', 'custom', '--style-brief', '暖色胶片，手写标注'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--skip-hyperframes', '--film-style', 'lemo-opuscar/impasto'],
      ['init', 'p', '--canvas', 'vertical-3x4'],
      ['init', 'p', '--canvas', 'square-1x1', '--skip-hyperframes'],
      ['init', 'p', '--skip-hyperframes'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--delivery', 'beat', '--narration', 'cast'],
      ['init', 'p', '--canvas', 'vertical-3x4', '--style', 'pixel-arcade-v1', '--style-brief', 'x'],
      ['init', 'a', 'b'],
    ],
    ignore: [/am-film-style\.json$/],
  },
  {
    name: 'config',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [['config', '--help'], ['config', 'get', '--help'], ['config', 'get', 'RENDERER'], ['config', 'get', 'ORCHESTRATOR'], ['config', 'get', 'TTS_PROVIDER'], ['config', 'get', 'ALIGN_PROVIDER'], ['config', 'get', 'NOPE'], ['config', 'get']],
  },
  {
    name: 'archive',
    commands: [['archive', '--help'], ['archive', '--dry-run'], ['archive', 'x']],
  },
  {
    name: 'align',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    prepare: alignFixture,
    commands: [
      ['align', '--help'],
      ['align', 'build', '--help'],
      ['align', 'text'],
      ['align', 'build', '--fps', '30'],
      ['align', 'build', '--fps', '25'],
      ['align', 'build'],
      ['align', 'build', '--fps', '30', '--align', 'production/audio/align.json@0.5'],
      ['align', 'build', '--fps', '30', '--align', 'missing.json'],
    ],
  },
  {
    name: 'audio check',
    prepare: voiceFixture,
    commands: [
      ['audio', '--help'],
      ['audio', 'check', '--help'],
      ['audio', 'check', '--audio', 'voice.wav', '--srt', 'good.srt', '--report-json', 'report.json'],
      ['audio', 'check', '--audio', 'voice.wav', '--srt', 'voice.srt', '--report-json', 'report.json'],
      ['audio', 'check', '--audio', 'voice.wav'],
      ['audio', 'check', '--audio', 'voice.wav', '--srt', 'good.srt', '--tolerance', '-1'],
      ['audio', 'check', '--audio', 'voice.wav', '--srt', 'good.srt', '--tolerance', 'abc'],
    ],
  },
  {
    name: 'style fonts',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [
      ['style', '--help'],
      ['style', 'fonts'],
      ['style', 'add-font', 'lxgw wenkai'],
      ['style', 'add-font', 'Fredoka', '--weight', '700'],
      ['style', 'add-font', 'Fredoka', '--weight', '500'],
      ['style', 'add-font', 'Nope'],
      ['style', 'add-font', 'Fredoka', '--project-root', 'nowhere'],
    ],
  },
  {
    name: 'studio show',
    setup: [['init', '--canvas', 'vertical-3x4', '--skip-hyperframes']],
    commands: [
      ['studio', 'show', '--help'],
      ['studio', 'show', 'script', '--note', '看一遍'],
      ['studio', 'show', 'nope'],
      ['studio', 'show', 'scene'],
      ['studio', 'show', 'file', 'PROMPT.md'],
      ['studio', 'show'],
    ],
  },
  ...sceneRunValidate,
  ...beatSongCast,
  ...mediaReviewReads,
  ...cuesUsage,
];
