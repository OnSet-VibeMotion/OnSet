import path from 'node:path';
import { expect, it } from 'vitest';
import { compareProtectedFrames } from './frame-window';
import { ffmpeg, hasFfmpeg, tempDir, toolchain } from './testutil';

it.skipIf(!hasFfmpeg)('checks every protected frame, including a single local change between the old sampling points', async () => {
  const dir = tempDir();
  const baseline = path.join(dir, 'before.mp4');
  const candidate = path.join(dir, 'after.mp4');
  const source = ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=192x108:r=10:d=1'];
  ffmpeg(...source, '-c:v', 'libx264', baseline);
  ffmpeg(...source, '-vf', "drawbox=x=24:y=18:w=24:h=18:c=white:t=fill:enable='eq(n,3)'", '-c:v', 'libx264', candidate);
  await expect(compareProtectedFrames(toolchain(), baseline, candidate, [{ start_frame: 1, end_frame_exclusive: 3 }], 8))
    .resolves.toMatchObject({ frame: 3 });
  await expect(compareProtectedFrames(toolchain(), baseline, candidate, [{ start_frame: 3, end_frame_exclusive: 4 }], 8))
    .resolves.toBeNull();
});
