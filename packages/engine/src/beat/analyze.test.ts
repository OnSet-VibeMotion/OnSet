import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { envMap, lookPath } from '../envutil';
import { newToolchain } from '../mediaprobe';
import { analyze } from './analyze';
import { readDraft, summarize, summaryString } from './grid';
import { ClickFile, ConfigFile, DraftFile } from './store';
import { importTrack } from './track';

const python = process.env.ONSET_TEST_BEAT_PYTHON ?? '';

function which(name: string): string | null {
  try {
    return lookPath(name, process.env.PATH ?? '');
  } catch {
    return null;
  }
}

/**
 * 真跑一遍分析。需要装好 beat-this 的 Python：
 *
 *	ONSET_TEST_BEAT_PYTHON=/path/to/venv/bin/python npx vitest run src/beat -t RealBeatThis
 *
 * 素材是 120 BPM 的合成鼓点（每 0.5 秒一下底鼓），只断言普通拍的间隔——
 * 这么单调的信号里重拍落在哪一拍本来就没有定论。
 * 未设置 ONSET_TEST_BEAT_PYTHON 或本机没有 ffmpeg 时跳过。
 */
it.skipIf(python === '' || which('ffmpeg') === null)('analyze with RealBeatThis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-beat-'));
  fs.writeFileSync(path.join(root, ConfigFile), `schema: 1\ncheckpoint: small0\npython: ${python}\n`);
  const music = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onset-beat-')), 'kick.wav');
  const kick = 'aevalsrc=sin(2*PI*(50+80*exp(-30*mod(t\\,0.5)))*mod(t\\,0.5))*exp(-12*mod(t\\,0.5)):s=44100:d=16';
  const made = spawnSync(which('ffmpeg')!, ['-v', 'error', '-y', '-f', 'lavfi', '-i', kick, music], { encoding: 'utf8' });
  if (made.status !== 0) throw new Error(`生成鼓点失败：${made.stderr}`);
  const media = newToolchain(envMap());
  importTrack(root, music, media, false);
  const grid = await analyze(root, envMap(), media, { write: () => true });
  const s = summarize(grid);
  expect(Math.abs(s.bpm - 120) <= 2 && grid.beats!.length >= 25, `应测出约 120 BPM：${summaryString(s)}，${grid.beats!.length} 拍`).toBe(true);
  expect(fs.existsSync(path.join(root, ClickFile)), '应生成试听轨').toBe(true);
  readDraft(path.join(root, DraftFile));
}, 600_000);
