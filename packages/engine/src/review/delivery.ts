import type { Canvas } from '../scene';

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
