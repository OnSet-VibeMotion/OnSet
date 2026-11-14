/**
 * 修接缝（scene_seams）：镜头都渲染好以后，让约定了交接却没接顺的后一镜按前一镜的真实画面重做开头。
 *
 * 交接原本只是一段文字约定（scene-plan 的 handoff，抄进两侧的 timing），两侧渲染器互相看不到，各自照文字画，
 * 交界那一帧大致对上了、运动也常常断开：一边停住，另一边一开场就急甩（2026-11 实测）。修接缝把前一镜的
 * 末帧（plate.png）与最后几帧（prev-N.png）放进后一镜的 seam/ 目录，让渲染器只改开头 frames 帧：
 * 第 0 帧就是那张末帧，再顺着它的运动过渡到原来第 frames 帧的画面；之后的画面与末帧一律不动，
 * 所以下一道交界用的末帧不变，各道接缝可以并行修。
 *
 * onset 照帧核对（verifySeam）：第 0 帧对 plate.png、第 frames 帧以后对修之前的产物（before.mp4），
 * 对不上抛 VerificationError。渲染记录照常按镜头本来的输入记（指纹不含修接缝），修完的镜头不会被判 Stale。
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatFixed } from '../gofmt';
import * as mediaprobe from '../mediaprobe';
import { outputPath, type Scene } from './scene';
import { VerificationError } from './verification';

/** 修接缝的材料放在镜头目录的这个子目录里；合成会引用 plate.png，修完不删。 */
export const SeamDir = 'seam';
export const SeamPlate = 'plate.png';
export const SeamBefore = 'before.mp4';
/** 前一镜最后几帧，prev-1.png 最早，prev-N.png 就是末帧。 */
export const SeamTailFrames = 6;
/** 缺省改开头几秒。 */
export const SeamSeconds = 0.5;
/** 第 0 帧与末帧的差异上限（32×32 RGB 均值，口径同 review）：编码误差在 3 以内，留出余量。 */
export const SeamPlateTolerance = 10;
/** 第 frames 帧以后与修之前的差异上限：这一段不该改。 */
export const SeamKeepTolerance = 8;

export interface SeamRequest {
  /** 前一个镜头的 id。 */
  previous: string;
  /** 只改开头这么多帧。 */
  frames: number;
}

/**
 * 准备修接缝：把前一镜最后几帧抽进 seam/，把本镜头现在的产物留一份 before.mp4 对照。
 * 要在 scene.run 归档上一次产物之前调用（归档会把 out.mp4 挪走）。
 */
export function prepareSeam(s: Scene, toolchain: mediaprobe.Toolchain, previousOutput: string, fps: number): void {
  const dir = path.join(s.directory, SeamDir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = toolchain.countFrames(previousOutput);
  for (let i = 0; i < SeamTailFrames; i++) {
    const index = frames - SeamTailFrames + i;
    if (index < 0) continue;
    toolchain.extractFrame(previousOutput, index / fps, path.join(dir, `prev-${i + 1}.png`));
  }
  toolchain.extractFrame(previousOutput, (frames - 1) / fps, path.join(dir, SeamPlate));
  fs.copyFileSync(outputPath(s), path.join(dir, SeamBefore));
}

/** 修接缝时接在渲染提示词最后的一段：这一次不是从头做镜头，只改开头。 */
export function seamSection(s: Scene, req: SeamRequest, widthPx: number, heightPx: number): string {
  const enter = s.timing?.enter;
  const promise = enter && enter.device !== '' ? `${enter.device}：${enter.bridge}` : '（没有写明手法）';
  const plate = `${SeamDir}/${SeamPlate}`;
  return [
    '',
    '## 本次只修开头的衔接（优先于上面「从头制作」的要求）',
    '',
    `这个镜头已经渲染过，合成代码都在镜头目录里。这次不重做镜头，只改开头 ${req.frames} 帧（第 0 帧到第 ${req.frames - 1} 帧），让它从上一个镜头 ${req.previous} 的最后画面自然接过来：`,
    '',
    `- \`${plate}\` 是 ${req.previous} 的最后一帧（${widthPx}×${heightPx}）。本镜头第 0 帧必须和它看起来一模一样：最稳的做法是把它作为整幅图片放在最上层，第 0 帧完全不透明，在这 ${req.frames} 帧里过渡到你原来第 ${req.frames} 帧的画面（画面里的物件从图里的位置移到、变成你的位置，图逐渐淡出）。`,
    `- \`${SeamDir}/prev-1.png\` 到 \`prev-${SeamTailFrames}.png\` 是 ${req.previous} 最后 ${SeamTailFrames} 帧，按时间先后。看清它最后在怎么动，开头顺着这个方向和速度接下去：不要先停住再突然动，也不要一开场就急甩。`,
    `- 交接约定照旧：${promise}。`,
    `- 第 ${req.frames} 帧及以后的画面一律不改，最后一帧必须和改之前一样：下一个镜头接的就是它。\`${SeamDir}/${SeamBefore}\` 是改之前的产物，可以对照。`,
    `- 改完照常检查、渲染，产物仍是 ${s.output}。`,
    '',
    `渲染后会按帧核对：第 0 帧与 \`${plate}\` 的差异、第 ${req.frames} 帧以后与改之前的差异，对不上就算这次没做成。`,
    '',
  ].join('\n');
}

/** 照帧核对修接缝的结果，对不上抛 VerificationError（与产物校验同一条路，进记忆的校验器是 seam.*）。 */
export function verifySeam(s: Scene, req: SeamRequest, toolchain: mediaprobe.Toolchain, fps: number): void {
  const out = outputPath(s);
  const dir = path.join(s.directory, SeamDir);
  const problems: string[] = [];
  const checks: string[] = [];
  const head = toolchain.frameDifferenceBetween(out, 0, path.join(dir, SeamPlate), 0);
  if (head >= SeamPlateTolerance) {
    problems.push(`第 0 帧与 ${req.previous} 的末帧（${SeamDir}/${SeamPlate}）差异 ${formatFixed(head, 1)}，没有从它接过来`);
    checks.push('seam.head');
  }
  const frames = toolchain.countFrames(out);
  const before = path.join(dir, SeamBefore);
  const samples = [...new Set([req.frames, Math.floor((req.frames + frames - 1) / 2), frames - 1])].filter((f) => f >= req.frames && f < frames);
  for (const frame of samples) {
    const difference = toolchain.frameDifferenceBetween(out, frame / fps, before, frame / fps);
    if (difference >= SeamKeepTolerance) {
      problems.push(`第 ${frame} 帧与修之前差异 ${formatFixed(difference, 1)}：第 ${req.frames} 帧以后不该改${frame === frames - 1 ? '，最后一帧变了会让下一道交界接不上' : ''}`);
      checks.push('seam.keep');
    }
  }
  if (problems.length > 0) throw new VerificationError(out, problems, checks);
}
