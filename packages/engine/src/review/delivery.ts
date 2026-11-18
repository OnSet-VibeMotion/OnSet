import crypto from 'node:crypto';
import { goRound } from '../gofmt';
import { marshal } from '../gojson';
import type { Canvas, Scene } from '../scene';
import type { Segment } from './review';

export function deliverySpec(canvas: Canvas, frames: number, silent: boolean) {
  return {
    width_px: canvas.widthPx,
    height_px: canvas.heightPx,
    fps: canvas.fps,
    frames,
    codec: 'h264',
    pixel_format: 'yuv420p',
    audio_required: !silent,
    sample_rate: silent ? 0 : 48_000,
    channels: silent ? 0 : 2,
  };
}

export type DeliverySpec = ReturnType<typeof deliverySpec>;

export function reviewSegments(scenes: readonly Scene[], fps: number): Segment[] {
  return scenes.map((scene) => ({
    id: scene.id,
    frames: goRound(scene.duration_seconds * fps),
    handoff: scene.timing?.enter.device,
    crossChapter: scene.timing?.enter.cross_chapter,
  }));
}

/** 顺序、镜头边界和复查时采用的交接约定。 */
export function scenePlanDigest(segments: readonly Segment[]): string | undefined {
  if (!segments.length) return undefined;
  return crypto.createHash('sha256').update(marshal(segments.map((s) => [
    s.id, s.frames, s.handoff ?? '', s.crossChapter ?? false,
  ]))).digest('hex');
}
