// 移植自 internal/scene/frames.go。
import { formatFixed, formatG, goRound } from '../gofmt';
import { sceneCanvas, type Scene } from './scene';
import { VerificationError } from './verification';

/**
 * 判定「时长 × 帧率」为整数时允许的帧误差。
 *
 * 取 1/1000 帧：精确到 6 位小数的 N/fps 时长（如 14.366667）误差约 1e-5 帧，
 * 能通过；3 位小数的近似值（如 14.367 → 431.01 帧）会被拦下。
 */
export const frameAlignmentTolerance = 1e-3;

/**
 * 要求镜头时长正好是整数帧。
 *
 * 渲染器按 ceil(时长 × fps) 出帧：14.367 秒在 30fps 下是 431.01 帧，会渲出
 * 432 帧，镜头比时间轴长一帧，拼接后整片与配音错开。这类错误是确定性的，
 * 重跑只会得到同样的产物，所以抛 VerificationError 走不重试的路径。
 */
export function verifyFrameAlignment(s: Scene): void {
  const canvas = sceneCanvas(s);
  const fps = canvas.fps;
  const frames = s.duration_seconds * fps;
  if (Math.abs(frames - goRound(frames)) <= frameAlignmentTolerance) return;
  const lower = Math.floor(frames);
  const upper = Math.ceil(frames);
  throw new VerificationError(s.output, [
    `镜头 ${s.id} 时长 ${formatG(s.duration_seconds)} 秒 × ${canvas.fps}fps = ${formatFixed(frames, 2)} 帧，不是整数帧；渲染器会向上取整多出一帧。` +
      `请改成 ${formatFixed(lower / fps, 6)} 秒（${lower} 帧）或 ${formatFixed(upper / fps, 6)} 秒（${upper} 帧），并同步调整相邻镜头，保持总帧数不变`,
  ]);
}
