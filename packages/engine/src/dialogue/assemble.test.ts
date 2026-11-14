import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lookPath } from '../envutil';
import { atomicWrite } from '../fsutil';
import { goQuote } from '../gofmt';
import { marshalIndent } from '../gojson';
import { assemble } from './assemble';
import { planToJSON, SchemaVersion, type Plan } from './plan';
import { hasMediaTools, tone } from './testsupport';

const temps: string[] = [];
let savedPath: string | undefined;
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-dialogue-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (savedPath !== undefined) {
    process.env.PATH = savedPath;
    savedPath = undefined;
  }
});

function writePlan(audioDir: string, plan: Plan): string {
  const planPath = path.join(audioDir, 'plan.json');
  atomicWrite(planPath, marshalIndent(planToJSON(plan)), 0o644);
  return planPath;
}

/** writePlanProject 生成一个可装配的最小项目：两段真实音频 + plan.json。 */
function writePlanProject(declaredSecondForFirst: number): { root: string; planPath: string } {
  const root = tempDir();
  const audioDir = path.join(root, 'production', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  tone(audioDir, 'seg-001-heiwa.wav', 1.0);
  tone(audioDir, 'seg-002-zhaocai.wav', 0.5);
  const planPath = writePlan(audioDir, {
    schema: SchemaVersion,
    segments: [
      { index: 1, speaker: 'heiwa', voiceId: 'v-1', audio: 'production/audio/seg-001-heiwa.wav', gapAfterMs: 200, lines: [{ text: '第一句', startSeconds: 0, endSeconds: declaredSecondForFirst }] },
      { index: 2, speaker: 'zhaocai', voiceId: 'v-2', audio: 'production/audio/seg-002-zhaocai.wav', gapAfterMs: 0, lines: [{ text: '等一下', startSeconds: 0, endSeconds: 0.5 }] },
    ],
  });
  return { root, planPath };
}

/** 生成一个只有一段的最小项目，用来精确控制「声明时长」与「实际音频时长」之间的差值。 */
function writeSingleSegmentProject(declaredSeconds: number, actualAudioSeconds: number): { root: string; planPath: string } {
  const root = tempDir();
  const audioDir = path.join(root, 'production', 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  tone(audioDir, 'seg-001-heiwa.wav', actualAudioSeconds);
  const planPath = writePlan(audioDir, {
    schema: SchemaVersion,
    segments: [
      { index: 1, speaker: 'heiwa', voiceId: 'v-1', audio: 'production/audio/seg-001-heiwa.wav', gapAfterMs: 0, lines: [{ text: '第一句', startSeconds: 0, endSeconds: declaredSeconds }] },
    ],
  });
  return { root, planPath };
}

/**
 * gapPatchingFfmpeg 在临时目录放一个叫 ffmpeg 的转发脚本，除了「生成静音」那次调用之外一律
 * 原样转发给真 ffmpeg；生成静音时把 -t 的时长换成 overrideSeconds。
 *
 * 为什么要造这个替身：插入的静音和 rebuild 里累加的间隔都来自 plan 的同一个 gapAfterMs 字段，
 * 正常输入下两边恒等，构造不出「逐段都吻合、只有总时长对不上」的场景。而这正是总时长断言
 * 存在的意义——它拦的是拼接管道自身的逻辑 bug。
 */
function gapPatchingFfmpeg(overrideSeconds: string): string {
  const real = lookPath('ffmpeg', process.env.PATH ?? '');
  const dir = tempDir();
  // 逐个弹出再压回队尾地重排位置参数：这样能在保持顺序的前提下改掉 -t 后面那一个值。
  const script =
    '#!/bin/sh\n' +
    'real=' + goQuote(real) + '\n' +
    'case " $* " in *anullsrc*) ;; *) exec "$real" "$@" ;; esac\n' +
    'count=$#\n' +
    'swap=0\n' +
    'i=0\n' +
    'while [ $i -lt $count ]; do\n' +
    '  a="$1"; shift\n' +
    '  if [ "$swap" = 1 ]; then a=' + goQuote(overrideSeconds) + '; swap=0\n' +
    '  elif [ "$a" = "-t" ]; then swap=1; fi\n' +
    '  set -- "$@" "$a"\n' +
    '  i=$((i+1))\n' +
    'done\n' +
    'exec "$real" "$@"\n';
  fs.writeFileSync(path.join(dir, 'ffmpeg'), script, { mode: 0o755 });
  return dir;
}

describe.skipIf(!hasMediaTools)('assemble', () => {
  it('produces three artifacts', async () => {
    const { root, planPath } = writePlanProject(1.0);
    const result = await assemble({ root, planPath });
    for (const rel of ['production/audio/voice.wav', 'transcription-production.srt', 'production/dialogue.json']) {
      expect(fs.existsSync(path.join(root, rel)), `缺产物 ${rel}`).toBe(true);
    }
    expect(result.lines!.length).toBe(2);
    expect(result.lines![1].speaker).toBe('zhaocai');
    expect(fs.readFileSync(path.join(root, 'transcription-production.srt'), 'utf8').startsWith('1\n00:00:00,000 --> ')).toBe(true);
  });

  // 漂移断言：plan 声明的时长与实测严重不符时必须失败，而不是产出错的成片。
  it('fails on drift', async () => {
    const { root, planPath } = writePlanProject(1.0);
    tone(path.join(root, 'production', 'audio'), 'seg-001-heiwa.wav', 3.0);
    await expect(assemble({ root, planPath, expectTotalSeconds: 1.7 })).rejects.toThrow('漂移');
  });

  // 某段实际音频跟 plan 声明的时长差出好几倍（文件拿错，或 TTS 输出被截断/重复）时，
  // 必须在装配阶段自己拦住，而且要在还没写出 voice.wav 之前就失败。
  it('fails when segment audio contradicts declared duration', async () => {
    const { root, planPath } = writePlanProject(1.0);
    tone(path.join(root, 'production', 'audio'), 'seg-001-heiwa.wav', 3.0);
    const err = await assemble({ root, planPath }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain('第 1 段');
    expect(err!.message).toContain('seg-001-heiwa.wav');
    expect(fs.existsSync(path.join(root, 'production', 'audio', 'voice.wav')), '不应该产出 voice.wav').toBe(false);
  });

  // 总时长漂移断言（第 2 道防线）：逐段都吻合，只有段间静音被替身换成 900ms。
  it('fails on total drift when segments all match', async () => {
    const { root, planPath } = writePlanProject(1.0);
    savedPath = process.env.PATH;
    process.env.PATH = gapPatchingFfmpeg('0.900') + path.delimiter + (savedPath ?? '');
    const err = await assemble({ root, planPath }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err, '段间静音与声明的 gapAfterMs 不符时，总时长漂移断言必须失败').not.toBeNull();
    // "按分段推算" 是精确子串：只有总时长漂移那条断言会这么说。
    expect(err!.message).toContain('按分段推算');
    expect(err!.message).not.toContain('段时间轴漂移');
  });

  // 阈值内侧：声明 3.0 秒，容差 = max(0.20, 3.0*0.10) = 0.30 秒；实际 3.300 秒，差异恰好等于容差，必须通过。
  it('segment drift at tolerance boundary passes', async () => {
    const { root, planPath } = writeSingleSegmentProject(3.0, 3.3);
    await expect(assemble({ root, planPath })).resolves.toBeTruthy();
  });

  // 阈值外侧：实际 3.310 秒，差异刚好越界 10 毫秒，必须失败。
  it('segment drift just over tolerance fails', async () => {
    const { root, planPath } = writeSingleSegmentProject(3.0, 3.31);
    await expect(assemble({ root, planPath })).rejects.toThrow('漂移');
  });
});
