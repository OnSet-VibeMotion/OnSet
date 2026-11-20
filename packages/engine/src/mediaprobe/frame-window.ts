import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { Toolchain } from './toolchain';

export interface FrameWindow {
  start_frame: number;
  end_frame_exclusive: number;
}

const width = 96;
const height = 54;
const tileWidth = 12;
const tileHeight = 9;
const frameBytes = width * height * 3;

/** Compare tile means so a change to a small label cannot hide in the whole-frame average. */
function largestTileDifference(before: Buffer, after: Buffer): number {
  let highest = 0;
  for (let top = 0; top < height; top += tileHeight) {
    for (let left = 0; left < width; left += tileWidth) {
      let sum = 0;
      for (let y = top; y < top + tileHeight; y++) {
        const start = (y * width + left) * 3;
        for (let i = start; i < start + tileWidth * 3; i++) sum += Math.abs(before[i]! - after[i]!);
      }
      highest = Math.max(highest, sum / (tileWidth * tileHeight * 3));
    }
  }
  return highest;
}

/** Decode each video once, then compare every frame outside the editable windows. */
export async function compareProtectedFrames(
  toolchain: Toolchain, baseline: string, candidate: string, windows: readonly FrameWindow[],
  tolerance: number, signal?: AbortSignal,
): Promise<{ frame: number; difference: number } | null> {
  const ffmpeg = toolchain.ffmpegPath();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'onset-frame-window-'));
  const before = path.join(work, 'before.rgb'), after = path.join(work, 'after.rgb');
  try {
    // Wait for both decoders even if either fails so the temp directory is never removed during a write.
    const decoded = await Promise.all([
      [baseline, before], [candidate, after],
    ].map(([file, target]) => toolchain.runAsync(ffmpeg, [
      '-v', 'error', '-nostdin', '-i', file!, '-map', '0:v:0', '-vf', `scale=${width}:${height}:flags=area`,
      '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', target!,
    ], { signal, captureStderr: true })));
    signal?.throwIfAborted();
    const failed = decoded.find(result => result.error);
    if (failed) throw new Error('无法逐帧比较返修产物：' + (failed.stderr.toString('utf8').trim() || failed.error));
    const bytes = fs.statSync(before).size;
    if (!bytes || bytes % frameBytes !== 0 || bytes !== fs.statSync(after).size) {
      throw new Error('返修改变了视频总帧数，无法保留区间外的画面');
    }
    const a = fs.openSync(before, 'r');
    try {
      const b = fs.openSync(after, 'r');
      try {
        const aa = Buffer.allocUnsafe(frameBytes), bb = Buffer.allocUnsafe(frameBytes);
        for (let frame = 0; frame < bytes / frameBytes; frame++) {
          if (frame % 128 === 0) await setImmediate();
          signal?.throwIfAborted();
          if (windows.some(w => w.start_frame <= frame && frame < w.end_frame_exclusive)) continue;
          const position = frame * frameBytes;
          if (fs.readSync(a, aa, 0, frameBytes, position) !== frameBytes || fs.readSync(b, bb, 0, frameBytes, position) !== frameBytes) {
            throw new Error('逐帧比较结果意外截断');
          }
          const difference = largestTileDifference(aa, bb);
          if (difference >= tolerance) return { frame, difference };
        }
      } finally { fs.closeSync(b); }
    } finally { fs.closeSync(a); }
    return null;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
