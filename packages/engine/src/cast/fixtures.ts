// 测试共用的角色包夹具（Go 测试里分散在 pack_test.go 与 rig_test.go 的常量）。不进 index。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Rig } from './pack';

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onset-cast-'));

export function writePack(body: string): string {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'character.yaml'), body);
  return dir;
}

export const goodYAML = `schema: cast/v1
id: heiwa
name: 黑娃
summary: 面无表情，认真做一件荒诞但成立的事
voice:
  minimax: { voiceId: "v-1", speed: 0.98, pitch: 0 }
  bailian: { voiceId: "v-2", rate: 0.98, instruction: "平静、真诚的语气" }
rig:
  file: rig.svg
  viewBox: [0, 0, 400, 520]
  baselineY: 512
  joints:
    head:     { pivot: [200, 168], rotate: [-18, 18] }
    frontLeg: { pivot: [176, 330], rotate: [-40, 55] }
scale:
  heightRatio: [0.22, 0.32]
poses:
  idle: {}
  pointing: { frontLeg: 48, head: -6 }
`;

export const viewsYAML =
  goodYAML +
  `views:
  three-quarter:
    file: rig-tq.svg
    viewBox: [0, 0, 400, 520]
    baselineY: 512
    joints:
      head:     { pivot: [186, 170], rotate: [-22, 22] }
      frontLeg: { pivot: [168, 332], rotate: [-40, 55] }
  side:
    file: rig-side.svg
    viewBox: [0, 0, 400, 520]
    baselineY: 512
    joints:
      head:     { pivot: [172, 174], rotate: [-26, 26] }
      frontLeg: { pivot: [160, 334], rotate: [-45, 60] }
turns:
  front->side: { via: [three-quarter], durationMs: 200 }
`;

export const goodSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 520">
  <g id="j-head"><circle cx="200" cy="168" r="60" fill="#fff" stroke="#000" stroke-width="6"/></g>
  <g id="j-frontLeg"><path d="M176 330 L176 420" stroke="#000" stroke-width="6"/></g>
</svg>`;

export const goodRig: Rig = {
  file: 'rig.svg',
  viewBox: [0, 0, 400, 520],
  baselineY: 512,
  joints: {
    head: { pivot: [200, 168], rotate: [-18, 18] },
    frontLeg: { pivot: [176, 330], rotate: [-40, 55] },
  },
};
