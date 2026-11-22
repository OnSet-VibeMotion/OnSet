// 卡点的镜头块：scene.json 的 beat 字段，由卡点插件登记（index.ts）。
import path from 'node:path';
import fs from 'node:fs';
import * as beat from '../../beat';
import { verifyBlock, type SceneBlock } from '../../scene/block';
import { fromGoStruct } from '../../scene/jsondecode';
import { contained, sceneCanvas, type Canvas, type Scene } from '../../scene/scene';
import { VerificationError } from '../../scene/verification';

declare module '../../scene/scene' {
  interface Scene {
    /** 卡点镜头绑定的节拍网格区间，由 beat_cues 写入。 */
    beat: beat.Cue | null;
  }
}

function verification(s: Scene, problem: string): VerificationError {
  return new VerificationError(s.output, [problem]);
}

function verifyBeat(s: Scene): void {
  if (s.beat !== null) {
    let canvas: Canvas;
    try {
      canvas = sceneCanvas(s);
    } catch (err) {
      throw verification(s, (err as Error).message);
    }
    if (s.beat.fps !== canvas.fps) throw verification(s, '卡点镜头帧率与画幅不符，请重新 beat_cues()');
    try {
      beat.verifyCue(s.directory, s.id, s.beat, s.duration_seconds);
    } catch (err) {
      throw verification(s, (err as Error).message);
    }
    return;
  }
  let dir = path.resolve(s.directory);
  for (;;) {
    if (beat.enabled(dir)) throw verification(s, '卡点镜头缺少 beat 块，请运行 beat_cues()');
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export const beatBlock: SceneBlock<beat.Cue> = {
  key: 'beat',
  order: 30,
  type: fromGoStruct(beat.cueType),
  toJSON: beat.cueToJSON,
  excludes: { keys: ['song', 'cast'], message: '卡点镜头不能同时带 song 或 cast 块' },
  verifyInputs: verifyBeat,
  directorBrief: s => {
    const cue = s.beat;
    if (!cue) return '';
    const local = JSON.parse(fs.readFileSync(contained(s.directory, cue.data, '局部节拍'), 'utf8')) as beat.Local;
    const downbeats = local.beats.filter(hit => hit.downbeat).map(hit => hit.frame);
    return '\n本镜头节拍资料：\n' +
      `- 占第 ${cue.first_bar} 小节起连续 ${cue.bars} 小节。使用 ${cue.data} 中的 beats.frame（局部整数帧）编排；不从秒数或 BPM 重算。\n` +
      (downbeats.length > 0 && downbeats.length <= 16 ? `- 局部重拍帧：${downbeats.join('、')}。\n` : '');
  },
  timeline: { label: '卡点' },
  feature: { name: 'beat', description: '卡点模式' },
};

/**
 * 核对卡点镜头的 beat 块；渲染前与复用已有产物前都要过一遍。
 *
 * 项目启用了卡点模式（向上找到 beat.yaml）却没有 beat 块的镜头直接拒绝：
 * 没有 cue 的镜头时长不受网格约束，切点卡没卡上全凭运气。
 */
export function verifyBeatInputs(s: Scene): void {
  verifyBlock(beatBlock as SceneBlock, s);
}
