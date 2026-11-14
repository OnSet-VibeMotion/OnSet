import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CrewMood, CrewSignal, PetCommand } from './chat/crew';
import { Icon } from './Icon';
import { currentSkin, onSkin } from '../skin';
import type { SkinView } from '../types';
import '../pet.css';

/*
 * 桌宠窗口（main/pet.ts）：一间等距块面的微缩工作室。从斜上方平行投影看进去，家具都是有厚度的块，
 * 顶面最亮、朝左下的面次之、朝右下的面最暗（光从左上来）；人是实色的：衣服、皮肤、头发各有亮暗两面。
 *
 *   导演（编排工具）——在哪个部门干活就走到哪：读稿、写稿在剧本桌，排分镜在左墙的分镜板前，跑命令在导演台，拍摄时在机位旁，
 *       剪辑时站在剪辑师身后，配音时站在录音棚外；等批准、收工站到台前；想事情和待命坐在导演椅上。
 *   摄影 ×3（渲染器）——每个正在渲染的镜头一个人，从沙发走到摄影机后面扶着机器，脚下挂着镜头号。
 *   剪辑师——导演交来拼接、复查、抽帧、校验、字幕时间轴时盯着时间线打字，平时靠在椅背上伸懒腰。
 *   配音演员——导演跑配音命令、动音色库时站到话筒前，录音灯亮；平时坐着看稿。
 *
 * 谁在干活靠「东西亮起来」看：开机时柔光灯亮、影棚背景纸被照亮、摄影机录制灯闪；剪辑时时间线走；
 * 配音时录音灯亮、话筒有声波；导演台跑命令时屏幕滚字。
 *
 * 人是有骨架的小人：关节在人自己的坐标系里（向前、向右、向上）摆姿势，再按站位与朝向投影到等距空间，
 * 四肢按远近排先后，所以转身、背对、侧身都对。不是胶囊，也不是像素图——两种都被用户否过。
 * 状态由主窗口从会话事件推出后经主进程转来（chat/crew.ts），这里只负责画。全部是手写的矢量，不取现成素材。
 */

// ---- 投影 ----

/** 房间：x 沿后墙向右下、y 沿左墙向左下，单位约等于一米；墙高。 */
const RX = 8;
const RY = 6;
const WALL = 3;
/** 一个单位多少像素、画布大小、原点。 */
export const U = 32;
const CW = 400;
const CH = 326;
const OX = CW / 2 - ((RX - RY) / 2) * 0.866 * U;
const OY = 99;

export type Pt = [number, number];
export const P = (x: number, y: number, z = 0): Pt => [OX + (x - y) * 0.866 * U, OY + (x + y) * 0.5 * U - z * U];
export const pts = (list: Pt[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** 动画节拍：每 50 毫秒走一步、动一下。走路速度（单位每步）。 */
const tickMs = 50;
const speed = 0.11;

// ---- 材质：顶面、朝左下的面、朝右下的面 ----

export type Material = readonly [string, string, string];
export const mat = {
  wood: ['#7a5e43', '#5c4632', '#46362a'],
  walnut: ['#5a4431', '#433224', '#33261c'],
  metal: ['#5a5148', '#3e3832', '#2e2924'],
  dark: ['#3e3832', '#2a2520', '#201c18'],
  canvas: ['#6b5537', '#54422b', '#433522'],
  brass: ['#e0ad6a', '#b9864a', '#94693a'],
  paper: ['#efe9dd', '#cfc6b6', '#aca393'],
  plant: ['#6f7b62', '#58634e', '#46503e'],
  pot: ['#8a7f70', '#6a6156', '#554d44'],
  lit: ['#f4e7cf', '#e9cf9f', '#d9b67a'],
  rec: ['#e39a8c', '#b9766a', '#965c52'],
  roof: ['#3a3128', '#2c251e', '#221d17'],
} satisfies Record<string, Material>;

/** 房间本身的颜色（地台三面、两面墙、墙头、影棚背景纸），皮肤能换（skin.PetRoom）。 */
const roomDefaults = {
  slab: '#3a3128',
  'slab-left': '#2a231c',
  'slab-right': '#211b16',
  'wall-left': '#221d18',
  'wall-back': '#2c261f',
  cap: '#4a3f33',
  backdrop: '#5a5247',
};
const room: Record<keyof typeof roomDefaults, string> = { ...roomDefaults };
const matDefaults: Record<string, Material> = { ...mat };

/** 等距的箱子：顶面、+y 面（朝左下）、+x 面（朝右下）三种明暗。 */
export function box(key: string, x: number, y: number, z: number, w: number, d: number, h: number, m: Material, edge = 'rgba(0,0,0,0.25)'): ReactElement {
  const top = [P(x, y, z + h), P(x + w, y, z + h), P(x + w, y + d, z + h), P(x, y + d, z + h)];
  const left = [P(x, y + d, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x, y + d, z + h)];
  const right = [P(x + w, y, z), P(x + w, y + d, z), P(x + w, y + d, z + h), P(x + w, y, z + h)];
  return (
    <g key={key}>
      <polygon points={pts(left)} fill={m[1]} stroke={edge} strokeWidth={0.5} strokeLinejoin="round" />
      <polygon points={pts(right)} fill={m[2]} stroke={edge} strokeWidth={0.5} strokeLinejoin="round" />
      <polygon points={pts(top)} fill={m[0]} stroke={edge} strokeWidth={0.5} strokeLinejoin="round" />
    </g>
  );
}

export const seg = (key: string, a: Pt, b: Pt, stroke: string, width = 1, extra: Record<string, string | number> = {}) => (
  <line key={key} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={stroke} strokeWidth={width} strokeLinecap="round" {...extra} />
);

/** 墙上的一块平面（x=0 的左墙或 y=0 的后墙）与墙上某一点。 */
export function wallQuad(on: 'left' | 'back', a: number, b: number, z0: number, z1: number): Pt[] {
  return on === 'left' ? [P(0.02, a, z0), P(0.02, b, z0), P(0.02, b, z1), P(0.02, a, z1)] : [P(a, 0.02, z0), P(b, 0.02, z0), P(b, 0.02, z1), P(a, 0.02, z1)];
}
export const wallAt = (on: 'left' | 'back', s: number, z: number): Pt => (on === 'left' ? P(0.03, s, z) : P(s, 0.03, z));

// ---- 人 ----

/** 人自己的坐标：f 向前、r 向右、z 向上。 */
type L3 = [number, number, number];
interface Body {
  hipL: L3;
  hipR: L3;
  kneeL: L3;
  kneeR: L3;
  footL: L3;
  footR: L3;
  shL: L3;
  shR: L3;
  elL: L3;
  elR: L3;
  haL: L3;
  haR: L3;
  head: L3;
}

export type Pose =
  | 'stand'
  | 'walk'
  | 'sit'
  | 'think'
  | 'type'
  | 'stretch'
  | 'operate'
  | 'read'
  | 'write'
  | 'point'
  | 'slate'
  | 'cheer'
  | 'slump'
  | 'cross'
  | 'mic'
  | 'script'
  // 闲着时的姿势：打盹、往后靠、看手机、端杯子喝、聊天、笑、背着手看、站着比划。
  | 'doze'
  | 'lean'
  | 'phone'
  | 'sitSip'
  | 'talk'
  | 'laugh'
  | 'look'
  | 'standTalk'
  // 安装页里赶路的人：抱着自己的器材走、跑，或站着抱着。
  | 'carry'
  | 'carryRun'
  | 'hold';

/** 坐着的姿势（气泡按坐着的头高放）。 */
const seatedPoses = new Set<Pose>(['sit', 'think', 'type', 'stretch', 'script', 'doze', 'lean', 'phone', 'sitSip', 'talk', 'laugh']);

function body(pose: Pose, t: number): Body {
  const b: Body = {
    hipL: [0, -0.09, 0.86],
    hipR: [0, 0.09, 0.86],
    kneeL: [0.03, -0.09, 0.46],
    kneeR: [0.03, 0.09, 0.46],
    footL: [0, -0.1, 0.04],
    footR: [0, 0.1, 0.04],
    shL: [0, -0.18, 1.3],
    shR: [0, 0.18, 1.3],
    elL: [0.02, -0.22, 1.03],
    elR: [0.02, 0.22, 1.03],
    haL: [0.06, -0.21, 0.8],
    haR: [0.06, 0.21, 0.8],
    head: [0, 0, 1.53],
  };
  const sway = Math.sin(t / 900) * 0.012;
  const seated = () => {
    b.hipL = [-0.05, -0.1, 0.5];
    b.hipR = [-0.05, 0.1, 0.5];
    b.kneeL = [0.36, -0.11, 0.5];
    b.kneeR = [0.36, 0.11, 0.5];
    b.footL = [0.4, -0.11, 0.04];
    b.footR = [0.4, 0.11, 0.04];
    b.shL = [-0.08, -0.18, 0.94];
    b.shR = [-0.08, 0.18, 0.94];
    b.elL = [0.08, -0.22, 0.7];
    b.elR = [0.08, 0.22, 0.7];
    b.haL = [0.28, -0.12, 0.62];
    b.haR = [0.28, 0.12, 0.62];
    b.head = [-0.06, 0, 1.17];
  };
  switch (pose) {
    case 'walk': {
      const s = Math.sin(t / 110);
      const c = Math.cos(t / 110);
      b.footL = [0.22 * s, -0.1, 0.04 + Math.max(0, 0.08 * c)];
      b.footR = [-0.22 * s, 0.1, 0.04 + Math.max(0, -0.08 * c)];
      b.kneeL = [0.12 * s + 0.05, -0.09, 0.46];
      b.kneeR = [-0.12 * s + 0.05, 0.09, 0.46];
      b.elL = [-0.08 * s, -0.22, 1.03];
      b.elR = [0.08 * s, 0.22, 1.03];
      b.haL = [-0.18 * s, -0.21, 0.82];
      b.haR = [0.18 * s, 0.21, 0.82];
      b.head = [0.02, 0, 1.53 + Math.abs(c) * 0.02];
      break;
    }
    case 'sit':
      seated();
      b.head = [-0.06, sway * 2, 1.17];
      break;
    case 'think':
      seated();
      b.elR = [0.26, 0.16, 0.86];
      b.haR = [0.1, 0.05, 1.06];
      b.head = [0.0, 0.02, 1.17];
      break;
    case 'script':
      seated();
      b.elL = [0.14, -0.2, 0.74];
      b.elR = [0.14, 0.2, 0.74];
      b.haL = [0.32, -0.1, 0.86];
      b.haR = [0.32, 0.1, 0.86];
      b.head = [0.0, 0, 1.15];
      break;
    case 'type': {
      seated();
      const k = Math.sin(t / 70);
      b.shL = [0.0, -0.18, 0.96];
      b.shR = [0.0, 0.18, 0.96];
      b.elL = [0.22, -0.22, 0.76];
      b.elR = [0.22, 0.22, 0.76];
      b.haL = [0.44, -0.1, 0.8 + Math.max(0, k) * 0.04];
      b.haR = [0.44, 0.1, 0.8 + Math.max(0, -k) * 0.04];
      b.head = [0.06, 0, 1.18];
      break;
    }
    case 'stretch':
      seated();
      b.elL = [-0.02, -0.3, 1.18];
      b.elR = [-0.02, 0.3, 1.18];
      b.haL = [-0.12, -0.08, 1.24];
      b.haR = [-0.12, 0.08, 1.24];
      b.head = [-0.08, 0, 1.17];
      break;
    case 'operate':
      b.elL = [0.22, -0.24, 1.15];
      b.elR = [0.22, 0.24, 1.15];
      b.haL = [0.42, -0.14, 1.3 + sway];
      b.haR = [0.42, 0.14, 1.3 - sway];
      b.head = [0.06, 0, 1.53];
      break;
    case 'read': {
      const flip = Math.sin(t / 600) * 0.02;
      b.elL = [0.12, -0.22, 1.02];
      b.elR = [0.12, 0.22, 1.02];
      b.haL = [0.32, -0.12, 1.1 + flip];
      b.haR = [0.32, 0.12, 1.1 - flip];
      b.head = [0.05, 0, 1.51];
      break;
    }
    case 'write': {
      const w = Math.sin(t / 140) * 0.06;
      b.shL = [0.05, -0.18, 1.27];
      b.shR = [0.05, 0.18, 1.27];
      b.elL = [0.22, -0.22, 1.02];
      b.elR = [0.24, 0.2, 1.0];
      b.haL = [0.42, -0.14, 0.9];
      b.haR = [0.44, 0.06 + w, 0.9];
      b.head = [0.12, 0, 1.46];
      break;
    }
    case 'point':
      b.elR = [0.24, 0.24, 1.32];
      b.haR = [0.5, 0.26, 1.46];
      break;
    case 'slate': {
      const bob = Math.sin(t / 300) * 0.03;
      b.elL = [0.16, -0.24, 1.18];
      b.elR = [0.16, 0.24, 1.18];
      b.elL = [0.14, -0.22, 0.98];
      b.elR = [0.16, 0.24, 1.0];
      b.haL = [0.3, 0.0, 1.06 + bob];
      b.haR = [0.3, 0.34, 1.06 + bob];
      break;
    }
    case 'cheer': {
      const up = Math.abs(Math.sin(t / 220));
      b.elL = [0.04, -0.3, 1.5];
      b.elR = [0.04, 0.3, 1.5];
      b.haL = [0.06, -0.26, 1.76 + up * 0.04];
      b.haR = [0.06, 0.26, 1.76 + up * 0.04];
      b.head = [0, 0, 1.55 + up * 0.03];
      break;
    }
    case 'slump':
      b.shL = [0.06, -0.17, 1.24];
      b.shR = [0.06, 0.17, 1.24];
      b.elL = [0.06, -0.2, 0.98];
      b.elR = [0.06, 0.2, 0.98];
      b.haL = [0.08, -0.18, 0.74];
      b.haR = [0.08, 0.18, 0.74];
      b.head = [0.16, 0, 1.38];
      break;
    case 'cross':
      b.elL = [0.14, -0.22, 1.08];
      b.elR = [0.14, 0.22, 1.08];
      b.haL = [0.16, 0.12, 1.14];
      b.haR = [0.16, -0.12, 1.12];
      b.head = [0.02, sway * 3, 1.53];
      break;
    case 'mic':
      b.elR = [0.16, 0.24, 1.08];
      b.haR = [0.2, 0.2, 1.3];
      b.head = [0.06, 0, 1.53];
      break;
    case 'doze': {
      seated();
      const nod = Math.sin(t / 1300) * 0.02;
      b.shL = [-0.1, -0.18, 0.92];
      b.shR = [-0.1, 0.18, 0.92];
      b.elL = [0.05, -0.22, 0.66];
      b.elR = [0.05, 0.22, 0.66];
      b.haL = [0.22, -0.08, 0.56];
      b.haR = [0.22, 0.08, 0.56];
      b.head = [0.06, 0.06, 1.08 + nod];
      break;
    }
    case 'lean':
      seated();
      b.shL = [-0.14, -0.18, 0.92];
      b.shR = [-0.14, 0.18, 0.92];
      b.elL = [-0.16, -0.36, 0.86];
      b.elR = [-0.16, 0.36, 0.86];
      b.haL = [-0.2, -0.48, 0.92];
      b.haR = [-0.2, 0.48, 0.92];
      b.head = [-0.12, sway * 2, 1.15];
      break;
    case 'phone':
      seated();
      b.elL = [0.1, -0.2, 0.7];
      b.elR = [0.1, 0.2, 0.7];
      b.haL = [0.28, -0.04, 0.84];
      b.haR = [0.28, 0.04, 0.84];
      b.head = [0.02, 0, 1.12];
      break;
    case 'sitSip': {
      seated();
      const up = sipping(t);
      b.elR = up ? [0.14, 0.2, 0.84] : [0.16, 0.22, 0.68];
      b.haR = up ? [0.1, 0.06, 1.08] : [0.3, 0.14, 0.8];
      b.head = up ? [-0.09, 0, 1.17] : [-0.06, 0, 1.17];
      break;
    }
    case 'talk': {
      seated();
      const g = Math.sin(t / 260);
      b.elR = [0.16, 0.26, 0.8];
      b.haR = [0.34, 0.22, 0.92 + g * 0.05];
      b.head = [-0.04, 0, 1.17 + Math.abs(g) * 0.012];
      break;
    }
    case 'laugh': {
      seated();
      const h = Math.abs(Math.sin(t / 140));
      b.shL = [-0.08, -0.18, 0.94 + h * 0.02];
      b.shR = [-0.08, 0.18, 0.94 + h * 0.02];
      b.elL = [0.06, -0.22, 0.72];
      b.elR = [0.06, 0.22, 0.72];
      b.haL = [0.16, -0.06, 0.7];
      b.haR = [0.16, 0.06, 0.7];
      b.head = [-0.12, 0, 1.17 + h * 0.03];
      break;
    }
    case 'look':
      b.elL = [-0.1, -0.22, 1.04];
      b.elR = [-0.1, 0.22, 1.04];
      b.haL = [-0.16, -0.06, 0.92];
      b.haR = [-0.16, 0.06, 0.92];
      b.head = [0.02, Math.sin(t / 1500) * 0.04, 1.53];
      break;
    case 'standTalk': {
      const g = Math.sin(t / 240);
      b.elR = [0.2, 0.26, 1.12];
      b.haR = [0.4, 0.24, 1.24 + g * 0.06];
      b.elL = [0.1, -0.24, 1.0];
      b.haL = [0.2, -0.2, 0.86];
      b.head = [0.02, 0, 1.53 + Math.abs(g) * 0.012];
      break;
    }
    case 'carry':
    case 'carryRun': {
      // 腿照走路摆（跑的时候步子大、抬腿高、身子前倾），胳膊抱在胸前。
      const run = pose === 'carryRun';
      const s = Math.sin(t / (run ? 85 : 110));
      const c = Math.cos(t / (run ? 85 : 110));
      const stride = run ? 0.32 : 0.22;
      const lift = run ? 0.16 : 0.08;
      const lean = run ? 0.08 : 0.02;
      b.footL = [stride * s, -0.1, 0.04 + Math.max(0, lift * c)];
      b.footR = [-stride * s, 0.1, 0.04 + Math.max(0, -lift * c)];
      b.kneeL = [stride * 0.55 * s + 0.05 + (run ? 0.06 * Math.max(0, c) : 0), -0.09, 0.46 + (run ? 0.06 * Math.max(0, c) : 0)];
      b.kneeR = [-stride * 0.55 * s + 0.05 + (run ? 0.06 * Math.max(0, -c) : 0), 0.09, 0.46 + (run ? 0.06 * Math.max(0, -c) : 0)];
      b.shL = [lean, -0.18, 1.3];
      b.shR = [lean, 0.18, 1.3];
      b.elL = [0.14 + lean, -0.22, 1.04];
      b.elR = [0.14 + lean, 0.22, 1.04];
      b.haL = [0.3 + lean, -0.09, 1.12];
      b.haR = [0.3 + lean, 0.09, 1.12];
      b.head = [0.03 + lean * 1.4, 0, 1.53 + Math.abs(c) * (run ? 0.04 : 0.02)];
      break;
    }
    case 'hold':
      b.elL = [0.14, -0.22, 1.04];
      b.elR = [0.14, 0.22, 1.04];
      b.haL = [0.3, -0.09, 1.12];
      b.haR = [0.3, 0.09, 1.12];
      b.head = [0.03, sway * 2, 1.53];
      break;
    default:
      b.head = [0, sway * 2, 1.53];
  }
  // 呼吸：不走路时肩和头跟着一起一伏，站着、坐着都不是僵住的。
  if (pose !== 'walk' && pose !== 'carry' && pose !== 'carryRun') {
    const br = Math.sin(t / 650) * 0.008;
    b.head = [b.head[0], b.head[1], b.head[2] + br];
    b.shL = [b.shL[0], b.shL[1], b.shL[2] + br * 0.6];
    b.shR = [b.shR[0], b.shR[1], b.shR[2] + br * 0.6];
  }
  return b;
}

/** 端着杯子的人此刻是不是举到嘴边。 */
const sipping = (t: number) => Math.sin(t / 1700) > 0.55;

/** 一个人身上某个关节此刻在画布上的位置（与 person 同一种投影），给手里的东西用。 */
export function jointAt(x: number, y: number, a: number, pose: Pose, t: number, j: keyof Body): Pt {
  const [f, r, z] = body(pose, t)[j];
  return P(x + f * Math.cos(a) - r * Math.sin(a), y + f * Math.sin(a) + r * Math.cos(a), z);
}

/** 一个人的样子：衣服亮暗、裤子、鞋、头发、皮肤，以及头上戴什么。 */
export interface Look {
  coat: string;
  coatShade: string;
  trousers: string;
  shoe: string;
  hair: string;
  skin: string;
  skinShade: string;
  hat: 'beret' | 'cap' | 'phones' | 'none';
  hatColor: string;
}

const skin = { skin: '#e4c4a2', skinShade: '#c49d7a' };
export const looks: Record<string, Look> = {
  director: { coat: '#e3dbcc', coatShade: '#b3a996', trousers: '#4a4239', shoe: '#2a2520', hair: '#5a4330', ...skin, hat: 'beret', hatColor: '#d9a35f' },
  op1: { coat: '#7d7262', coatShade: '#5c5348', trousers: '#34302b', shoe: '#201c18', hair: '#3a2c20', ...skin, hat: 'cap', hatColor: '#3a342d' },
  op2: { coat: '#a59a88', coatShade: '#7d7363', trousers: '#3f3a33', shoe: '#201c18', hair: '#2a2018', ...skin, hat: 'cap', hatColor: '#6b5038' },
  op3: { coat: '#5f564c', coatShade: '#463f37', trousers: '#2a2520', shoe: '#1a1714', hair: '#6b4a30', skin: '#c9a07c', skinShade: '#a8815f', hat: 'cap', hatColor: '#2a2520' },
  editor: { coat: '#3e3832', coatShade: '#2c2823', trousers: '#2a2520', shoe: '#1a1714', hair: '#2d241c', ...skin, hat: 'phones', hatColor: '#d9a35f' },
  voice: { coat: '#cfc6b6', coatShade: '#a1978a', trousers: '#4a4239', shoe: '#2a2520', hair: '#7a5a3c', ...skin, hat: 'phones', hatColor: '#6f6557' },
};

const looksDefaults: Record<string, Look> = Object.fromEntries(Object.entries(looks).map(([k, v]) => [k, { ...v }]));

/**
 * 按皮肤换工作室的颜色：先回到默认，再盖上皮肤写了的（材质、人的衣着、房间）。皮肤的值后端已校验过，只有颜色。
 * mat / looks / room 是模块里的共用表，画的时候现读，所以换完重画一次就生效。
 */
function applyPetSkin(sk: SkinView | null): void {
  const m = mat as Record<string, Material>;
  for (const [k, v] of Object.entries(matDefaults)) m[k] = v;
  for (const [k, v] of Object.entries(looksDefaults)) looks[k] = { ...v };
  Object.assign(room, roomDefaults);
  if (!sk) return;
  for (const [k, v] of Object.entries(sk.pet.materials)) if (k in m) m[k] = v;
  for (const [k, v] of Object.entries(sk.pet.crew)) if (looks[k]) looks[k] = { ...looks[k], ...v };
  for (const [k, v] of Object.entries(sk.pet.room)) if (k in room) room[k as keyof typeof room] = v;
}

/** 皮肤给整间工作室的调色，写成 CSS filter。 */
function petFilter(sk: SkinView | null): string | undefined {
  const f = sk?.pet.filter;
  if (!f) return undefined;
  const parts = [
    f.hue !== undefined ? `hue-rotate(${f.hue}deg)` : '',
    f.saturate !== undefined ? `saturate(${f.saturate})` : '',
    f.brightness !== undefined ? `brightness(${f.brightness})` : '',
    f.contrast !== undefined ? `contrast(${f.contrast})` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** 画一个人：站位 (x, y)、朝向角 a（弧度，0 朝 +x）、姿势与样子。四肢按远近排好先后。 */
export function person(key: string, x: number, y: number, a: number, pose: Pose, t: number, look: Look): ReactElement {
  const b = body(pose, t);
  const F: Pt = [Math.cos(a), Math.sin(a)];
  const R: Pt = [-Math.sin(a), Math.cos(a)];
  const world = ([f, r, z]: L3): [number, number, number] => [x + f * F[0] + r * R[0], y + f * F[1] + r * R[1], z];
  const proj = (l: L3) => {
    const [wx, wy, wz] = world(l);
    return P(wx, wy, wz);
  };
  const depth = (l: L3) => {
    const [wx, wy] = world(l);
    return wx + wy;
  };
  // 朝右下（+x）一侧的那条胳膊、腿用暗色，像光从左上照下来。
  const shaded = (l: L3) => {
    const [wx, wy] = world(l);
    return wx - wy > x - y;
  };
  type Part = { d: number; el: ReactElement };
  const leg = (k: string, hip: L3, knee: L3, foot: L3): Part => {
    const dark = shaded(knee);
    const f = proj(foot);
    return {
      d: (depth(hip) + depth(knee) + depth(foot)) / 3,
      el: (
        <g key={k}>
          <polyline points={pts([proj(hip), proj(knee), f])} fill="none" stroke={look.trousers} strokeWidth={0.13 * U} strokeLinecap="round" strokeLinejoin="round" opacity={dark ? 0.82 : 1} />
          <ellipse cx={f[0]} cy={f[1] + 0.5} rx={0.08 * U} ry={0.05 * U} fill={look.shoe} />
        </g>
      ),
    };
  };
  const arm = (k: string, sh: L3, el: L3, ha: L3): Part => {
    const h = proj(ha);
    return {
      d: (depth(sh) + depth(el) + depth(ha)) / 3,
      el: (
        <g key={k}>
          <polyline points={pts([proj(sh), proj(el), h])} fill="none" stroke={shaded(el) ? look.coatShade : look.coat} strokeWidth={0.1 * U} strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={h[0]} cy={h[1]} r={0.055 * U} fill={look.skin} />
        </g>
      ),
    };
  };
  // 躯干：肩、髋前后各一点的凸包，任何角度看都是一块有厚度的身子；按左右分亮暗两面。
  const torso: L3[] = [];
  for (const j of [b.shL, b.shR, b.hipL, b.hipR]) torso.push([j[0] + 0.11, j[1] * 1.15, j[2]], [j[0] - 0.11, j[1] * 1.15, j[2]]);
  const hull = convexHull(torso.map(proj));
  const midX = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const centre = depth([(b.shL[0] + b.hipL[0]) / 2, 0, 1]);
  const parts = [leg('lL', b.hipL, b.kneeL, b.footL), leg('lR', b.hipR, b.kneeR, b.footR), arm('aL', b.shL, b.elL, b.haL), arm('aR', b.shR, b.elR, b.haR)];
  const behind = parts.filter((p) => p.d < centre).sort((p, q) => p.d - q.d);
  const front = parts.filter((p) => p.d >= centre).sort((p, q) => p.d - q.d);
  const head = proj(b.head);
  const r = 0.155 * U;
  const neck = proj([b.head[0] * 0.6, 0, b.head[2] - 0.15]);
  const facingViewer = F[0] + F[1] > -0.2;
  const clip = `${key}-clip`;
  const foot = P(x, y, 0);
  // 头：皮肤一圈，右侧压一块暗面；头发正对时盖住头顶，背对时盖住大半个头。
  const hairPath = facingViewer
    ? `M${head[0] - r} ${head[1] - r * 0.05} A${r} ${r} 0 0 1 ${head[0] + r} ${head[1] - r * 0.05} Q${head[0]} ${head[1] - r * 0.55} ${head[0] - r} ${head[1] - r * 0.05} Z`
    : `M${head[0] - r} ${head[1] + r * 0.45} A${r} ${r} 0 1 1 ${head[0] + r} ${head[1] + r * 0.45} A${r} ${r} 0 0 1 ${head[0] - r} ${head[1] + r * 0.45} Z`;
  // 正面或侧面能看见脸时点两只眼睛，往朝向那边偏。
  const eyes: ReactElement[] = [];
  const frontness = (F[0] + F[1]) / Math.SQRT2;
  // 眨眼：每人错开一点，隔四秒多闭一下；打盹时一直闭着。
  let seed = 0;
  for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
  const closed = pose === 'doze' || (t + seed * 137) % 4300 < 140;
  if (frontness > 0.1 && !closed) {
    const cx = head[0] + (F[0] - F[1]) * 0.866 * r * 0.42;
    const spread = r * 0.34 * Math.max(0.35, frontness);
    for (const dx of [-spread, spread]) eyes.push(<circle key={`eye${dx}`} cx={cx + dx} cy={head[1] + r * 0.12} r={0.75} fill="#2a2520" />);
  }
  const hat: ReactElement[] = [];
  // 帽檐垫在头下面：侧身时伸出头外的那段看得见，正对我们时被脸挡住，不会在脸上划一道。
  const underHead: ReactElement[] = [];
  if (look.hat === 'beret') {
    hat.push(<ellipse key="beret" cx={head[0] - 0.8} cy={head[1] - r * 0.72} rx={r * 1.18} ry={r * 0.46} fill={look.hatColor} />);
    hat.push(<ellipse key="beretTop" cx={head[0] - 0.4} cy={head[1] - r * 0.86} rx={r * 0.9} ry={r * 0.3} fill="#e8ba78" opacity={0.7} />);
    hat.push(<circle key="nub" cx={head[0] + 0.4} cy={head[1] - r * 1.18} r={1.1} fill={look.hatColor} />);
  } else if (look.hat === 'cap') {
    const brim = proj([b.head[0] + 0.22, 0, b.head[2] + 0.05]);
    hat.push(<path key="cap" d={`M${head[0] - r} ${head[1] - r * 0.15} A${r} ${r} 0 0 1 ${head[0] + r} ${head[1] - r * 0.15} Z`} fill={look.hatColor} />);
    underHead.push(seg('brim', [head[0], head[1] - r * 0.2], brim, look.hatColor, 2.2));
  } else if (look.hat === 'phones') {
    const earL = proj([b.head[0], -0.16, b.head[2]]);
    const earR = proj([b.head[0], 0.16, b.head[2]]);
    hat.push(<path key="band" d={`M${earL[0]} ${earL[1]} Q${head[0]} ${head[1] - r * 2.2} ${earR[0]} ${earR[1]}`} fill="none" stroke={look.hatColor} strokeWidth={1.6} />);
    hat.push(<ellipse key="cupL" cx={earL[0]} cy={earL[1]} rx={2} ry={2.6} fill={look.hatColor} />);
    hat.push(<ellipse key="cupR" cx={earR[0]} cy={earR[1]} rx={2} ry={2.6} fill={look.hatColor} />);
  }
  return (
    <g key={key}>
      <ellipse cx={foot[0]} cy={foot[1]} rx={0.34 * U} ry={0.17 * U} className="pet-shadow" />
      {behind.map((p) => p.el)}
      <clipPath id={clip}>
        <polygon points={pts(hull)} />
      </clipPath>
      <polygon points={pts(hull)} fill={look.coat} />
      <rect x={midX + 0.6} y={Math.min(...hull.map((p) => p[1])) - 1} width={40} height={60} fill={look.coatShade} clipPath={`url(#${clip})`} />
      {seg('neck', proj([(b.shL[0] + b.shR[0]) / 2, 0, (b.shL[2] + b.shR[2]) / 2 + 0.02]), neck, look.skinShade, 0.08 * U)}
      {front.map((p) => p.el)}
      {underHead}
      <circle cx={head[0]} cy={head[1]} r={r} fill={look.skin} />
      <path d={`M${head[0] + r * 0.25} ${head[1] - r * 0.97} A${r} ${r} 0 0 1 ${head[0] + r * 0.25} ${head[1] + r * 0.97} A${r * 1.2} ${r * 1.2} 0 0 0 ${head[0] + r * 0.25} ${head[1] - r * 0.97} Z`} fill={look.skinShade} />
      {eyes}
      <path d={hairPath} fill={look.hair} />
      {hat}
    </g>
  );
}

function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ---- 位置 ----

/** 朝向：朝 +x、朝 -x、朝 -y（后墙）、正对我们。 */
const toward = { right: 0, left: Math.PI, wall: -Math.PI / 2, viewer: Math.PI / 4, leftWall: Math.PI };

type Spot = { x: number; y: number; a: number; via: Pt[] };

/** 走廊：后排（机位、剪辑台）与前排（剧本桌、录音棚、沙发）之间的一条线。 */
const aisle = 3.2;

const director: Record<string, Spot> = {
  chair: { x: 1.9, y: 2.85, a: toward.viewer, via: [[1.9, aisle]] },
  table: { x: 3.35, y: 3.45, a: toward.viewer, via: [[3.35, aisle]] },
  storyboard: { x: 0.95, y: 3.1, a: toward.leftWall, via: [[0.95, aisle]] },
  console: { x: 1.15, y: 1.2, a: toward.leftWall, via: [[1.15, aisle]] },
  filming: { x: 2.35, y: 2.05, a: -0.6, via: [[2.35, aisle]] },
  editing: { x: 6.3, y: 1.95, a: toward.wall, via: [[6.3, aisle]] },
  voicing: { x: 2.15, y: 5.15, a: toward.left, via: [[2.15, aisle]] },
  front: { x: 4.3, y: 5.0, a: toward.viewer, via: [[4.3, aisle]] },
};

const directorSpot: Record<CrewMood, keyof typeof director> = {
  idle: 'chair',
  thinking: 'chair',
  stopped: 'chair',
  reading: 'table',
  writing: 'table',
  storyboarding: 'storyboard',
  running: 'console',
  filming: 'filming',
  editing: 'editing',
  voicing: 'voicing',
  waiting: 'front',
  done: 'front',
  failed: 'front',
};

const directorPose: Record<CrewMood, Pose> = {
  idle: 'sit',
  thinking: 'think',
  stopped: 'sit',
  reading: 'read',
  writing: 'write',
  storyboarding: 'point',
  running: 'write',
  filming: 'point',
  editing: 'cross',
  voicing: 'stand',
  waiting: 'slate',
  done: 'cheer',
  failed: 'slump',
};

/** 摄影机（镜头朝后墙）与摄影的沙发座位、机位。 */
const cameras = [3.35, 4.35, 5.35];
const cameraY = 1.95;
const operators = [0, 1, 2].map((i) => ({
  seat: { x: 5.8 + i * 0.6, y: 4.85, a: Math.PI / 2, via: [[5.1, aisle], [5.1, 5.35], [5.8 + i * 0.6, 5.35]] } as Spot,
  camera: { x: cameras[i], y: cameraY + 0.7, a: toward.wall, via: [[cameras[i], aisle]] } as Spot,
}));

// ---- 闲着的时候 ----
//
// 没活的人不站桩：每人一张「闲着做什么」的表，到点按权重换一样。导演只在整个剧组待命时才闲逛
// （去翻剧本、看分镜板、到沙发边和摄影聊两句、坐回椅子喝咖啡或打个盹）；摄影、剪辑师、配音演员
// 只要自己手上没活就闲着，哪怕导演正在忙别的。闲着时的动作不改 data-active，标签也不挂。

type Prop = 'cup' | 'phone' | 'zzz' | 'notes' | 'script';
interface IdleAct {
  pose: Pose;
  /** 毫秒：到了位置之后待多久。 */
  dur: [number, number];
  weight: number;
  prop?: Prop;
  /** 导演：在哪做；摄影：'camera' 表示走到自己的机位前摆弄一下。 */
  at?: keyof typeof director | 'camera';
  /** 坐着时扭头、转椅子的角度（弧度）。 */
  turn?: number;
  swivel?: boolean;
}

/** 导演闲着时站在沙发左头，和沙发上的摄影聊天。 */
const chatSpot: Spot = { x: 4.85, y: 4.95, a: toward.right, via: [[4.85, aisle]] };

const directorIdle: Record<string, IdleAct> = {
  sit: { pose: 'sit', dur: [7000, 13000], weight: 3, at: 'chair' },
  coffee: { pose: 'sitSip', dur: [6000, 10000], weight: 2, at: 'chair', prop: 'cup' },
  doze: { pose: 'doze', dur: [6000, 11000], weight: 1, at: 'chair', prop: 'zzz' },
  script: { pose: 'read', dur: [5000, 9000], weight: 2, at: 'table', prop: 'script' },
  board: { pose: 'look', dur: [4000, 7000], weight: 2, at: 'storyboard' },
  chat: { pose: 'standTalk', dur: [6000, 10000], weight: 2 },
};

const operatorIdle: Record<string, IdleAct> = {
  sit: { pose: 'sit', dur: [5000, 10000], weight: 3 },
  lean: { pose: 'lean', dur: [5000, 9000], weight: 2 },
  phone: { pose: 'phone', dur: [5000, 10000], weight: 2, prop: 'phone' },
  coffee: { pose: 'sitSip', dur: [5000, 8000], weight: 1, prop: 'cup' },
  doze: { pose: 'doze', dur: [6000, 10000], weight: 1, prop: 'zzz' },
  talk: { pose: 'talk', dur: [4000, 7000], weight: 2, turn: 0.7 },
  check: { pose: 'operate', dur: [3000, 5000], weight: 1, at: 'camera' },
};

const editorIdle: Record<string, IdleAct> = {
  lean: { pose: 'lean', dur: [5000, 9000], weight: 3 },
  stretch: { pose: 'stretch', dur: [2500, 4000], weight: 1 },
  tinker: { pose: 'type', dur: [3000, 6000], weight: 1 },
  coffee: { pose: 'sitSip', dur: [5000, 8000], weight: 1, prop: 'cup' },
  doze: { pose: 'doze', dur: [6000, 10000], weight: 1, prop: 'zzz' },
  swivel: { pose: 'sit', dur: [4000, 7000], weight: 1, swivel: true },
};

const voiceIdle: Record<string, IdleAct> = {
  script: { pose: 'script', dur: [6000, 11000], weight: 3 },
  hum: { pose: 'script', dur: [4000, 7000], weight: 2, prop: 'notes' },
  water: { pose: 'sitSip', dur: [4000, 7000], weight: 1, prop: 'cup' },
};

interface Idler {
  act: string;
  /** 什么时候换下一样；走在路上时为 null，到了才开始计时。 */
  until: number | null;
}

const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);

/** 按权重挑下一样，不重复刚才那样；刚离开默认那样的，一半机会回去。 */
function nextAct(table: Record<string, IdleAct>, current: string, home: string, allowed: (k: string) => boolean = () => true): string {
  if (current !== home && Math.random() < 0.5) return home;
  const options = Object.entries(table).filter(([k]) => k !== current && allowed(k));
  const total = options.reduce((n, [, a]) => n + a.weight, 0);
  let r = Math.random() * total;
  for (const [k, a] of options) {
    r -= a.weight;
    if (r <= 0) return k;
  }
  return home;
}

interface Walker {
  x: number;
  y: number;
  a: number;
  spot: Spot;
  path: Pt[];
  travelled: number;
}

const newWalker = (spot: Spot): Walker => ({ x: spot.x, y: spot.y, a: spot.a, spot, path: [], travelled: 0 });

/** 换目的地：先按来路退回走廊，再沿走廊横过去，最后按新位置的路线走进去。 */
function retarget(w: Walker, spot: Spot, teleport: boolean): void {
  if (w.spot === spot) return;
  const out: Pt[] = w.path.length === 0 ? [...w.spot.via].reverse() : [[w.x, aisle]];
  w.path = [...out, ...spot.via, [spot.x, spot.y]];
  w.spot = spot;
  if (teleport) {
    w.x = spot.x;
    w.y = spot.y;
    w.a = spot.a;
    w.path = [];
  }
}

function advance(w: Walker): void {
  let budget = speed;
  while (budget > 0 && w.path.length > 0) {
    const [tx, ty] = w.path[0];
    const dx = tx - w.x;
    const dy = ty - w.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1e-6) w.a = Math.atan2(dy, dx);
    if (dist <= budget) {
      w.x = tx;
      w.y = ty;
      w.path.shift();
      budget -= dist;
      w.travelled += dist;
    } else {
      w.x += (dx / dist) * budget;
      w.y += (dy / dist) * budget;
      w.travelled += budget;
      budget = 0;
    }
  }
  if (w.path.length === 0) w.a = w.spot.a;
}

// ---- 房间 ----

/** 不会变的部分：地台、两面墙（带墙头）、墙上的海报与钟、影棚的卷纸背景。 */
function roomShell(): ReactElement {
  const out: ReactElement[] = [];
  // 地台：一块有厚度的板子，房间像放在桌上的模型。
  out.push(box('slab', 0, 0, -0.32, RX, RY, 0.32, [room.slab, room['slab-left'], room['slab-right']], 'rgba(0,0,0,0.3)'));
  for (let i = 0; i < RX; i++) {
    for (let j = 0; j < RY; j++) {
      if ((i + j) % 2 === 0) continue;
      out.push(<polygon key={`t${i}-${j}`} points={pts([P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)])} fill="rgba(255,240,220,0.025)" />);
    }
  }
  // 两面墙：墙面加一条墙头，墙根一道暗影。
  out.push(<polygon key="wl" points={pts([P(0, 0), P(0, RY), P(0, RY, WALL), P(0, 0, WALL)])} fill={room['wall-left']} />);
  out.push(<polygon key="wb" points={pts([P(0, 0), P(RX, 0), P(RX, 0, WALL), P(0, 0, WALL)])} fill={room['wall-back']} />);
  out.push(<polygon key="wlcap" points={pts([P(-0.15, -0.15, WALL), P(0, 0, WALL), P(0, RY, WALL), P(-0.15, RY, WALL)])} fill={room.cap} />);
  out.push(<polygon key="wbcap" points={pts([P(-0.15, -0.15, WALL), P(RX, -0.15, WALL), P(RX, 0, WALL), P(0, 0, WALL)])} fill={room.cap} />);
  out.push(<polygon key="wlend" points={pts([P(-0.15, RY, -0.32), P(0, RY, -0.32), P(0, RY, WALL), P(-0.15, RY, WALL)])} fill="#1a1612" />);
  out.push(<polygon key="wbend" points={pts([P(RX, -0.15, -0.32), P(RX, 0, -0.32), P(RX, 0, WALL), P(RX, -0.15, WALL)])} fill="#1f1a15" />);
  out.push(<polygon key="aol" points={pts([P(0, 0), P(0.35, 0.35), P(0.35, RY), P(0, RY)])} fill="rgba(0,0,0,0.18)" />);
  out.push(<polygon key="aob" points={pts([P(0, 0), P(RX, 0), P(RX, 0.35), P(0.35, 0.35)])} fill="rgba(0,0,0,0.18)" />);
  // 影棚：卷纸背景从后墙垂下来铺到地上，上面一根卷轴。
  out.push(<polygon key="paper" points={pts(wallQuad('back', 2.9, 5.8, 0, 2.7))} fill={room.backdrop} />);
  out.push(<polygon key="sweep" points={pts([P(2.9, 0), P(5.8, 0), P(5.8, 1.15), P(2.9, 1.15)])} fill={room.backdrop} />);
  out.push(<polygon key="sweepFade" points={pts([P(2.9, 0.85), P(5.8, 0.85), P(5.8, 1.15), P(2.9, 1.15)])} fill="rgba(0,0,0,0.14)" />);
  out.push(box('roll', 2.75, 0.02, 2.72, 3.2, 0.12, 0.12, mat.metal));
  // 后墙的海报（一个太阳、两行字），在导演台上方。
  out.push(<polygon key="poster" points={pts(wallQuad('back', 1.0, 1.9, 1.3, 2.5))} fill="#2a2520" stroke="#6f6557" strokeWidth={1.4} />);
  const pc = wallAt('back', 1.45, 2.06);
  out.push(<ellipse key="sun" cx={pc[0]} cy={pc[1]} rx={4.6} ry={5.6} fill="#d9a35f" />);
  out.push(seg('pt1', wallAt('back', 1.15, 1.6), wallAt('back', 1.75, 1.6), '#8a8377', 1.4));
  out.push(seg('pt2', wallAt('back', 1.25, 1.48), wallAt('back', 1.65, 1.48), '#5d574d', 1.4));
  // 后墙的钟。
  const ck = wallAt('back', 7.3, 2.45);
  out.push(<ellipse key="clock" cx={ck[0]} cy={ck[1]} rx={6.5} ry={7.5} fill="#efe9dd" stroke="#6f6557" strokeWidth={1.4} />);
  return <g>{out}</g>;
}

/** 后墙的钟走的是真实时间：时针、分针，外加一根一秒一跳的秒针。 */
function clockHands(now: Date): ReactElement {
  const ck = wallAt('back', 7.3, 2.45);
  const hand = (turns: number, len: number): Pt => [ck[0] + Math.sin(turns * 2 * Math.PI) * len * 0.87, ck[1] - Math.cos(turns * 2 * Math.PI) * len];
  const sec = now.getSeconds() / 60;
  const min = (now.getMinutes() + sec) / 60;
  const hour = ((now.getHours() % 12) + min) / 12;
  return (
    <g key="clockHands">
      {seg('hh', ck, hand(hour, 3.6), '#2a2520', 1.3)}
      {seg('hm', ck, hand(min, 5.4), '#2a2520', 1)}
      {seg('hs', ck, hand(sec, 5.8), '#c0705f', 0.6)}
    </g>
  );
}

/** 屏幕：墙上一块深色，里面若干行字或片段条。 */
function screen(key: string, on: 'left' | 'back', a: number, b: number, z0: number, z1: number, rows: { from: number; to: number; z: number; color: string }[]): ReactElement {
  return (
    <g key={key}>
      <polygon points={pts(wallQuad(on, a - 0.05, b + 0.05, z0 - 0.06, z1 + 0.06))} fill="#3e3832" />
      <polygon points={pts(wallQuad(on, a, b, z0, z1))} fill="#0b0a09" />
      {rows.map((row, i) => seg(`${key}${i}`, wallAt(on, row.from, row.z), wallAt(on, row.to, row.z), row.color, 2))}
    </g>
  );
}

/** 左墙的分镜板：软木板上两排卡片。排分镜时卡片亮起来，正在排的那张是黄铜色，一张张换过去。 */
function storyboardWall(active: boolean, frame: number): ReactElement {
  const out: ReactElement[] = [
    <polygon key="sbframe" points={pts(wallQuad('left', 2.05, 4.2, 0.85, 2.45))} fill="#5c4632" />,
    <polygon key="sbcork" points={pts(wallQuad('left', 2.12, 4.13, 0.92, 2.38))} fill="#6b5537" />,
  ];
  const cols = 4;
  const current = frame % (cols * 2);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const a = 2.22 + col * 0.48;
      const z1 = 2.27 - row * 0.7;
      const card = active && i === current ? '#d9a35f' : active ? '#efe9dd' : '#a9a294';
      out.push(<polygon key={`card${i}`} points={pts(wallQuad('left', a, a + 0.4, z1 - 0.55, z1))} fill={card} />);
      out.push(<polygon key={`img${i}`} points={pts(wallQuad('left', a + 0.05, a + 0.35, z1 - 0.35, z1 - 0.05))} fill={active && i === current ? '#94693a' : '#5a5247'} />);
      out.push(seg(`txt${i}`, wallAt('left', a + 0.06, z1 - 0.45), wallAt('left', a + 0.3, z1 - 0.45), '#8a8377', 1));
      const pin = wallAt('left', a + 0.2, z1 - 0.02);
      out.push(<circle key={`pin${i}`} cx={pin[0]} cy={pin[1]} r={1.3} fill="#e39a8c" />);
    }
  }
  return <g key="storyboard">{out}</g>;
}

/** 导演台的显示器：跑命令时字往上滚，最后一行闪光标。 */
function consoleScreen(active: boolean, frame: number): ReactElement {
  const widths = [0.7, 0.45, 0.85, 0.35, 0.6, 0.75];
  const rows = [0, 1, 2, 3].map((i) => {
    const w = widths[(i + (active ? frame : 0)) % widths.length];
    return { from: 0.75, to: 0.75 + w * 0.9, z: 1.95 - i * 0.18, color: active ? '#c2bbae' : '#2a2520' };
  });
  if (active && frame % 2 === 0) rows.push({ from: 0.75, to: 0.85, z: 1.23, color: '#d9a35f' });
  return screen('console', 'left', 0.65, 1.85, 1.1, 2.1, rows);
}

/** 剪辑台的两块屏：左边时间线（片段条与走动的播放头），右边是画面。 */
function editScreens(active: boolean, frame: number): ReactElement[] {
  const c = (on: string) => (active ? on : '#2a2520');
  const head = 6.3 + ((frame % 20) / 20) * 0.8;
  const left = (
    <g key="edl">
      {screen('edl1', 'back', 6.2, 7.2, 1.15, 1.95, [
        { from: 6.3, to: 6.65, z: 1.75, color: c('#d9a35f') },
        { from: 6.7, to: 7.1, z: 1.75, color: c('#c2bbae') },
        { from: 6.3, to: 6.9, z: 1.55, color: c('#8a7f70') },
        { from: 6.95, to: 7.1, z: 1.55, color: c('#d9a35f') },
        { from: 6.3, to: 7.1, z: 1.35, color: '#2a2520' },
      ])}
      {active ? seg('playhead', wallAt('back', head, 1.9), wallAt('back', head, 1.22), '#e39a8c', 1.2) : null}
    </g>
  );
  const pic = wallAt('back', 7.62, 1.55);
  const right = (
    <g key="edr">
      {screen('edr1', 'back', 7.3, 7.95, 1.15, 1.95, [])}
      {active ? <ellipse cx={pic[0]} cy={pic[1]} rx={4} ry={4.6} fill="#d9a35f" /> : null}
    </g>
  );
  return [left, right];
}

/** 摄影机：三脚架上的机身，镜头朝后墙。在拍时录制灯闪。 */
function cameraRig(key: string, cx: number, active: boolean, frame: number): ReactElement {
  const head = P(cx, cameraY + 0.12, 1.3);
  const feet: Pt[] = [P(cx - 0.32, cameraY + 0.35), P(cx + 0.3, cameraY + 0.3), P(cx, cameraY - 0.3)];
  const rec = P(cx + 0.25, cameraY - 0.02, 1.78);
  return (
    <g key={key}>
      {feet.map((f, i) => seg(`${key}f${i}`, head, f, '#4a4239', 2))}
      {box(`${key}b`, cx - 0.25, cameraY - 0.12, 1.3, 0.5, 0.42, 0.42, mat.dark)}
      {box(`${key}l`, cx - 0.1, cameraY - 0.4, 1.38, 0.22, 0.28, 0.24, mat.metal)}
      {box(`${key}r`, cx - 0.18, cameraY - 0.02, 1.72, 0.36, 0.22, 0.12, mat.metal)}
      {active && frame % 16 < 9 ? <circle cx={rec[0]} cy={rec[1]} r={2} fill="#e39a8c" /> : <circle cx={rec[0]} cy={rec[1]} r={1.6} fill="#4a3a35" />}
    </g>
  );
}

function softbox(key: string, x: number, on: boolean): ReactElement {
  return (
    <g key={key}>
      {seg(`${key}p`, P(x, 0.55, 0), P(x, 0.55, 2.2), '#3e3832', 2)}
      {seg(`${key}a`, P(x - 0.25, 0.75, 0), P(x, 0.55, 0.25), '#3e3832', 1.6)}
      {seg(`${key}b`, P(x + 0.25, 0.75, 0), P(x, 0.55, 0.25), '#3e3832', 1.6)}
      {box(`${key}h`, x - 0.3, 0.45, 2.15, 0.6, 0.22, 0.42, on ? mat.lit : mat.dark)}
    </g>
  );
}

export function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 没有对话在跑时的那一份。 */
const idleSignal: CrewSignal = { mood: 'idle', line: '待命', project: '', rendering: [], asks: [], choices: [], question: '', running: false, canSend: false, plan: [], turnStarted: '', renderSince: {}, recent: [] };

const send = (command: PetCommand) => window.onset?.pet?.(command);

export function Pet() {
  const [signal, setSignal] = useState<CrewSignal>(idleSignal);
  const [composing, setComposing] = useState(false);
  // 界面皮肤：换工作室的颜色，或整个换成插件的页面（pet.page_url）。
  const [skin, setSkin] = useState<SkinView | null>(() => {
    const sk = currentSkin();
    applyPetSkin(sk);
    return sk;
  });
  useEffect(
    () =>
      onSkin((sk) => {
        applyPetSkin(sk);
        setSkin(sk);
      }),
    [],
  );
  const pageURL = skin?.pet.page_url ?? '';
  const [, setTick] = useState(0);
  // 换成插件页面时自己的工作室不画，也不必按帧推着人走。
  const still = prefersStill();
  const paused = still || pageURL !== '';
  const start = useRef(Date.now());

  // 旧版主窗口发来的状态可能缺新字段，按空补上。
  useEffect(() => window.onset?.onCrew?.((next) => setSignal(next ? { ...idleSignal, ...next } : idleSignal)), []);

  const walkers = useRef<{ director: Walker; ops: Walker[] } | null>(null);
  if (!walkers.current) walkers.current = { director: newWalker(director.chair), ops: operators.map((o) => newWalker(o.seat)) };
  const idlers = useRef<{ director: Idler; ops: Idler[]; editor: Idler; voice: Idler }>({
    director: { act: 'sit', until: null },
    ops: operators.map(() => ({ act: 'sit', until: null })),
    editor: { act: 'lean', until: null },
    voice: { act: 'script', until: null },
  });
  const mood = signal.mood;
  // 前三个在渲染的镜头各给一位摄影；导演在等渲染、却还没有镜头标成渲染中时，先开一台。
  const shooting = signal.rendering.length > 0 ? signal.rendering : mood === 'filming' ? [''] : [];
  const live = useRef({ mood, shooting: shooting.length });
  live.current = { mood, shooting: shooting.length };
  useEffect(() => {
    const w = walkers.current!;
    const idle = idlers.current;
    // 一有活就放下手里的闲事；回到待命先坐回导演椅，过一会儿再起来溜达。
    idle.director = { act: 'sit', until: null };
    retarget(w.director, director[directorSpot[mood]], still);
    w.ops.forEach((op, i) => {
      if (i >= shooting.length && idle.ops[i].act === 'check') idle.ops[i] = { act: 'sit', until: null };
      retarget(op, i < shooting.length ? operators[i].camera : operators[i].seat, still);
    });
    setTick((t) => t + 1);
  }, [mood, shooting.length, still]);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => {
      const w = walkers.current!;
      const idle = idlers.current;
      const { mood: m, shooting: n } = live.current;
      const now = Date.now();
      // 到了位置才开始计时；时间到了换下一样，要挪地方的就走过去。
      const due = (who: Idler, table: Record<string, IdleAct>, walker?: Walker) => {
        if (walker && walker.path.length > 0) return false;
        if (who.until === null) who.until = now + between(table[who.act].dur);
        return now > who.until;
      };
      if (m === 'idle' && due(idle.director, directorIdle, w.director)) {
        const sofaFree = n < operators.length;
        const act = nextAct(directorIdle, idle.director.act, 'sit', (k) => k !== 'chat' || sofaFree);
        idle.director = { act, until: null };
        const at = directorIdle[act].at;
        retarget(w.director, at && at !== 'camera' ? director[at] : chatSpot, false);
      }
      w.ops.forEach((op, i) => {
        if (i < n || !due(idle.ops[i], operatorIdle, op)) return;
        const act = nextAct(operatorIdle, idle.ops[i].act, 'sit');
        idle.ops[i] = { act, until: null };
        retarget(op, operatorIdle[act].at === 'camera' ? operators[i].camera : operators[i].seat, false);
      });
      if (m !== 'editing' && due(idle.editor, editorIdle)) idle.editor = { act: nextAct(editorIdle, idle.editor.act, 'lean'), until: null };
      if (m !== 'voicing' && due(idle.voice, voiceIdle)) idle.voice = { act: nextAct(voiceIdle, idle.voice.act, 'script'), until: null };
      advance(w.director);
      w.ops.forEach(advance);
      setTick((t) => t + 1);
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [paused]);

  const t = still ? 0 : Date.now() - start.current;
  const frame = Math.floor(t / 280);
  const w = walkers.current;
  const arrived = (walker: Walker) => walker.path.length === 0;
  const dirArrived = arrived(w.director);
  const filmingOps = w.ops.map((op, i) => i < shooting.length && arrived(op));
  const anyFilming = filmingOps.some(Boolean);
  const editing = mood === 'editing';
  const voicing = mood === 'voicing';
  const shell = useMemo(() => roomShell(), [skin]);

  // 按「离我们多远」（x + y）排先后：远的先画，近的盖在上面。
  const items: { k: number; el: ReactElement }[] = [];
  const add = (k: number, el: ReactElement) => items.push({ k, el });

  // 导演区：左墙的导演台、导演椅、剧本桌。
  add(1.3, box('desk', 0.05, 0.55, 0, 0.75, 1.3, 0.78, mat.walnut));
  add(1.4, box('kbd', 0.3, 0.85, 0.78, 0.25, 0.7, 0.04, mat.dark));
  add(
    4.0,
    <g key="dchair">
      {seg('dl1', P(1.63, 3.12, 0), P(2.17, 2.58, 0.45), '#5c4632', 2)}
      {seg('dl2', P(2.17, 3.12, 0), P(1.63, 2.58, 0.45), '#5c4632', 2)}
      {box('dseat', 1.6, 2.55, 0.42, 0.6, 0.6, 0.08, mat.brass)}
      {box('dback', 1.55, 2.5, 0.72, 0.08, 0.7, 0.45, mat.brass)}
    </g>,
  );
  add(
    7.4,
    <g key="table">
      {box('tbl', 2.7, 3.75, 0, 1.3, 0.6, 0.82, mat.wood)}
      {box('pages1', 2.85, 3.85, 0.82, 0.4, 0.3, 0.02, mat.paper)}
      {box('pages2', 3.4, 3.88, 0.82, 0.36, 0.28, 0.06, mat.paper)}
      {box('lamp', 3.85, 3.85, 0.82, 0.08, 0.08, 0.3, mat.brass)}
    </g>,
  );

  // 影棚：两盏柔光灯、小景台（上面一盆小树）、三台摄影机。
  add(3.2, softbox('sbl', 2.7, anyFilming));
  add(6.6, softbox('sbr', 6.05, anyFilming));
  add(
    4.9,
    <g key="prop">
      {box('stool', 4.1, 0.4, 0, 0.46, 0.46, 0.55, mat.paper)}
      {box('pot', 4.21, 0.51, 0.55, 0.24, 0.24, 0.2, mat.pot)}
      <ellipse cx={P(4.33, 0.63, 1.02)[0]} cy={P(4.33, 0.63, 1.02)[1]} rx={7} ry={6.5} fill={mat.plant[1]} />
      <ellipse cx={P(4.33, 0.63, 1.08)[0] - 1.5} cy={P(4.33, 0.63, 1.08)[1] - 1.5} rx={4.5} ry={4} fill={mat.plant[0]} />
    </g>,
  );
  cameras.forEach((cx, i) => add(cx + cameraY, cameraRig(`cam${i}`, cx, filmingOps[i], frame + i * 3)));

  // 剪辑台与剪辑师：干活时打字；闲着时往后靠、伸懒腰、转椅子、喝咖啡、打盹。
  const idle = idlers.current;
  const edAct = editorIdle[idle.editor.act];
  const edPose: Pose = editing ? 'type' : edAct.pose;
  const edAngle = toward.wall + (!editing && edAct.swivel ? Math.sin(t / 1400) * 0.9 : 0);
  add(6.9, box('edesk', 6.1, 0.05, 0, 1.85, 0.65, 0.78, mat.walnut));
  add(7.0, box('ekbd', 6.55, 0.4, 0.78, 0.8, 0.22, 0.04, mat.dark));
  add(
    8.2,
    <g key="editor" data-who="editor" data-active={editing ? 'true' : 'false'}>
      {person('ed', 6.95, 1.2, edAngle, edPose, t, looks.editor)}
      {!editing ? idleProp(edAct.prop, 6.95, 1.2, edAngle, edPose, t) : null}
    </g>,
  );
  add(
    8.4,
    <g key="echair">
      {box('eseat', 6.7, 1.0, 0.42, 0.5, 0.5, 0.08, mat.dark)}
      {box('eback', 6.65, 1.42, 0.5, 0.6, 0.1, 0.45, mat.dark)}
    </g>,
  );

  // 录音棚在左前角：地面与后面先画，配音演员在里面，玻璃最后盖上去。
  const bx = 1.5;
  const by = 4.4;
  const bh = 2.0;
  const mic = P(1.08, 5.15, 1.4);
  add(
    6.0,
    <g key="booth">
      <polygon points={pts([P(0, by), P(bx, by), P(bx, RY), P(0, RY)])} fill="#2a2520" />
      <polygon points={pts([P(0.02, by, 0), P(0.02, RY, 0), P(0.02, RY, bh), P(0.02, by, bh)])} fill="#3a322a" />
      <polygon points={pts([P(0, by, 0), P(bx, by, 0), P(bx, by, bh), P(0, by, bh)])} fill="#332c25" />
      {[0, 1, 2, 3].map((i) => (
        <polygon key={`foam${i}`} points={pts([P(0.03, by + 0.2 + i * 0.38, 0.4), P(0.03, by + 0.5 + i * 0.38, 0.4), P(0.03, by + 0.5 + i * 0.38, 1.7), P(0.03, by + 0.2 + i * 0.38, 1.7)])} fill="#2a241e" />
      ))}
      {seg('micstand', P(1.08, 5.15, 0), P(1.08, 5.15, 1.32), '#6f6557', 1.6)}
      <g data-who="voice" data-active={voicing ? 'true' : 'false'}>
        {voicing ? person('va', 0.55, 5.2, 0.1, 'mic', t, looks.voice) : person('va', 0.6, 5.45, Math.PI / 4, voiceIdle[idle.voice.act].pose, t, looks.voice)}
        {voicing ? null : idleProp(voiceIdle[idle.voice.act].prop, 0.6, 5.45, Math.PI / 4, voiceIdle[idle.voice.act].pose, t)}
      </g>
      <ellipse cx={mic[0]} cy={mic[1]} rx={3} ry={3.8} fill="#3e3832" />
      {voicing
        ? [0, 1, 2].map((i) => {
            const r = 5 + i * 4 + (frame % 3) * 1.3;
            return <path key={`wave${i}`} d={`M${mic[0] + r * 0.7} ${mic[1] - r * 0.7} A${r} ${r} 0 0 1 ${mic[0] + r * 0.7} ${mic[1] + r * 0.7}`} fill="none" stroke="#d9a35f" strokeWidth={1.2} opacity={0.85 - i * 0.22} />;
          })
        : null}
      <polygon points={pts([P(0, RY, 0), P(bx, RY, 0), P(bx, RY, bh), P(0, RY, bh)])} className="pet-glass" />
      <polygon points={pts([P(bx, by, 0), P(bx, RY, 0), P(bx, RY, bh), P(bx, by, bh)])} className="pet-glass-dark" />
      {seg('post1', P(bx, RY, 0), P(bx, RY, bh), '#6f6557', 1.6)}
      {seg('post2', P(bx, by, 0), P(bx, by, bh), '#6f6557', 1.6)}
      {seg('post3', P(0, RY, 0), P(0, RY, bh), '#6f6557', 1.6)}
      {box('roofb', 0, by, bh, bx, RY - by, 0.14, mat.roof)}
      {box('onair', 0.45, 5.05, bh + 0.14, 0.6, 0.2, 0.18, voicing ? mat.rec : mat.dark)}
    </g>,
  );

  const leafSway = Math.sin(t / 1900) * 0.9;
  // 休息区：右前方的沙发，坐着闲着的摄影；茶几上一杯咖啡。
  add(
    9.6,
    <g key="sofa">
      {box('sback', 5.4, 4.3, 0, 2.0, 0.25, 0.9, mat.canvas)}
      {box('sseat', 5.4, 4.55, 0, 2.0, 0.6, 0.42, mat.canvas)}
      {box('sarmL', 5.25, 4.3, 0, 0.15, 0.85, 0.6, mat.canvas)}
    </g>,
  );
  add(12.3, box('sarmR', 7.4, 4.3, 0, 0.15, 0.85, 0.6, mat.canvas));
  add(
    12.7,
    <g key="coffee">
      {box('ctable', 5.75, 5.5, 0, 1.3, 0.35, 0.36, mat.walnut)}
      {box('cup', 6.1, 5.6, 0.36, 0.12, 0.12, 0.12, mat.paper)}
      {still ? null : steam(P(6.16, 5.66, 0.52), t)}
    </g>,
  );
  add(
    13.5,
    <g key="plant">
      {box('ppot', 7.45, 5.45, 0, 0.35, 0.35, 0.38, mat.pot)}
      <ellipse cx={P(7.62, 5.62, 0.75)[0] + leafSway * 0.5} cy={P(7.62, 5.62, 0.75)[1]} rx={9} ry={11} fill={mat.plant[1]} />
      <ellipse cx={P(7.62, 5.62, 0.85)[0] - 2 + leafSway} cy={P(7.62, 5.62, 0.85)[1] - 2} rx={6} ry={7.5} fill={mat.plant[0]} />
    </g>,
  );

  // 人：导演与三位摄影，按站位排进去。
  const dIdle = mood === 'idle' ? directorIdle[idle.director.act] : null;
  const dPose: Pose = !dirArrived ? 'walk' : dIdle ? dIdle.pose : directorPose[mood];
  const chatting = dIdle !== null && idle.director.act === 'chat' && dirArrived;
  add(
    w.director.x + w.director.y + 0.05,
    <g key="director" data-who="director" data-walking={dirArrived ? 'false' : 'true'}>
      {person('dir', w.director.x, w.director.y, w.director.a, dPose, t, looks.director)}
      {dirArrived && (mood === 'waiting' || mood === 'done') ? slateProp(w.director, mood === 'done' && frame % 4 < 2, t) : null}
      {dirArrived && (mood === 'reading' || dIdle?.prop === 'script') ? scriptProp(w.director, t) : null}
      {dirArrived && dIdle && dIdle.prop !== 'script' ? idleProp(dIdle.prop, w.director.x, w.director.y, w.director.a, dPose, t) : null}
      {dirArrived && mood === 'thinking' ? thoughtDots(w.director, frame) : null}
      {dirArrived && mood === 'failed' ? mark(w.director, '×', '#e39a8c') : null}
      {dirArrived && mood === 'stopped' ? mark(w.director, '‖', '#a9a294') : null}
    </g>,
  );
  w.ops.forEach((op, i) => {
    const moving = !arrived(op);
    const act = operatorIdle[idle.ops[i].act];
    const onSofa = !moving && !filmingOps[i] && op.spot === operators[i].seat;
    // 导演过来聊天时，沙发上的人都转过脸去，一个说一个笑。
    const listening = chatting && onSofa;
    const pose: Pose = moving ? 'walk' : filmingOps[i] ? 'operate' : listening ? (i % 2 === 0 ? 'laugh' : 'talk') : act.pose;
    // 自己聊天时朝旁边的人扭头（最右边那位朝左，其余朝右）；听导演说话时都朝左边的导演。
    const turn = !onSofa ? 0 : listening ? 0.8 : act.turn ? (i === operators.length - 1 ? act.turn : -act.turn) : 0;
    const angle = op.a + turn;
    const ot = t + i * 400;
    add(
      op.x + op.y + 0.04,
      <g key={`op${i}`} data-who={`op${i + 1}`} data-active={filmingOps[i] ? 'true' : 'false'} data-walking={moving ? 'true' : 'false'}>
        {person(`op${i}`, op.x, op.y, angle, pose, ot, looks[`op${i + 1}`])}
        {onSofa && !listening ? idleProp(act.prop, op.x, op.y, angle, pose, ot) : null}
      </g>,
    );
  });
  items.sort((a, b) => a.k - b.k);

  // 标签挂在脚下（头顶归导演的气泡）：开机的摄影写镜头号，干活的剪辑、配音写部门名。坐标是画布上的，画的时候换成屏幕上的。
  const tags: { key: string; text: string; title: string; at: Pt }[] = [];
  w.ops.forEach((op, i) => {
    if (!filmingOps[i] || !shooting[i]) return;
    const short = shooting[i].replace(/^scene-/, '');
    const text = i === 2 && shooting.length > 3 ? `${short}+${shooting.length - 3}` : short;
    tags.push({ key: `op${i + 1}`, text, title: shooting.slice(i, i === 2 ? undefined : i + 1).join('、'), at: P(op.x + 0.15, op.y + 0.15) });
  });
  if (editing) tags.push({ key: 'editor', text: '剪辑', title: '剪辑', at: P(7.3, 1.6) });
  if (voicing) tags.push({ key: 'voice', text: '配音', title: '配音', at: P(1.5, RY) });
  const filmingCount = shooting.filter(Boolean).length;

  // 每个人此刻站在哪（画布坐标的脚下一点），选中、热区、环形菜单都按它。
  const voiceAt: [number, number] = voicing ? [0.55, 5.2] : [0.6, 5.45];
  const footOf = (who: Who): [number, number] =>
    who === 'director' ? [w.director.x, w.director.y] : who === 'editor' ? [6.95, 1.2] : who === 'voice' ? voiceAt : [w.ops[opIndex(who)].x, w.ops[opIndex(who)].y];

  // 每个人的状态面板：在做什么、需求条、心情、动作队列，都从真实的会话与镜头数据算。
  const nowMs = Date.now();
  const crewMood = crewMoodOf(signal);
  const info = (who: Who): CrewInfo => {
    if (who === 'director') {
      const elapsed = signal.running && signal.turnStarted ? nowMs - Date.parse(signal.turnStarted) : 0;
      const done = signal.plan.filter((p) => p.status === 'completed').length;
      const doing = dIdle && mood === 'idle' ? idleLabels.director[idle.director.act] ?? '待命' : signal.line;
      return {
        name: '导演',
        role: '编排',
        doing,
        mood: crewMood,
        needs: [
          { label: '精力', value: signal.running ? clamp(1 - elapsed / (40 * 60_000), 0.12, 1) : 1, note: signal.running ? `这一轮 ${duration(elapsed)}` : '歇着' },
          ...(signal.plan.length > 0 ? [{ label: '进度', value: done / signal.plan.length, note: `${done} / ${signal.plan.length}` }] : []),
        ],
        queue: signal.plan.map((p) => ({ text: p.text, state: p.status })),
      };
    }
    if (who === 'editor' || who === 'voice') {
      const working = who === 'editor' ? editing : voicing;
      const act = who === 'editor' ? idleLabels.editor[idle.editor.act] : idleLabels.voice[idle.voice.act];
      return {
        name: who === 'editor' ? '剪辑师' : '配音演员',
        role: who === 'editor' ? '拼接、复查、字幕' : '配音',
        doing: working ? signal.line : act ?? '闲着',
        mood: working ? '专注' : crewMood === '低落' ? '低落' : '悠闲',
        needs: [{ label: '精力', value: working ? 0.7 : 1, note: working ? '在忙' : '歇着' }],
        queue: working ? [{ text: signal.line, state: 'in_progress' }] : [],
      };
    }
    const i = opIndex(who);
    const scenes = i === 2 ? shooting.slice(2) : shooting[i] !== undefined ? [shooting[i]] : [];
    const filming = filmingOps[i] && scenes.length > 0 && scenes[0] !== '';
    const since = filming ? signal.renderSince[scenes[0]] : '';
    const elapsed = since ? nowMs - Date.parse(since) : 0;
    return {
      name: `摄影 ${i + 1}`,
      role: '渲染镜头',
      doing: filming ? `在拍 ${scenes.join('、')}` : idleLabels.operator[idle.ops[i].act] ?? '闲着',
      mood: filming ? '专注' : crewMood === '低落' ? '低落' : '悠闲',
      needs: filming
        ? [
            { label: '已拍', value: clamp(elapsed / (15 * 60_000), 0.04, 1), note: since ? duration(elapsed) : '刚开机', kind: 'time' as const },
            { label: '精力', value: clamp(1 - elapsed / (30 * 60_000), 0.2, 1), note: '' },
          ]
        : [{ label: '精力', value: 1, note: '歇着' }],
      queue: scenes.filter(Boolean).map((id, k) => ({ text: `拍 ${id}`, state: k === 0 ? 'in_progress' : 'pending' })),
      scene: filming ? scenes[0] : '',
    };
  };

  // 点人弹出的环形菜单：都是真能做的事。
  const pieFor = (who: Who): PieItem[] => {
    if (who === 'director') {
      return [
        { label: '看制作路线', command: { kind: 'open', page: 'progress' } },
        { label: '对他说一句', compose: true },
        ...(signal.running ? [{ label: '停下这一轮', command: { kind: 'stop' } as PetCommand }] : []),
        { label: '回到对话', command: { kind: 'focus' } },
      ];
    }
    if (who === 'editor') {
      return [
        { label: '看成片', command: { kind: 'open', page: 'final' } },
        { label: '看复查', command: { kind: 'open', page: 'review' } },
        ...(signal.canSend && !signal.running ? [{ label: '叫他拼成片', command: { kind: 'say', text: '把镜头拼成成片，拼好后做一遍复查' } as PetCommand }] : []),
      ];
    }
    if (who === 'voice') {
      return [
        { label: '看口播稿', command: { kind: 'open', page: 'script' } },
        { label: '音色库', command: { kind: 'open', page: 'voice' } },
      ];
    }
    const sc = info(who).scene ?? '';
    return sc
      ? [
          { label: `看 ${sc}`, command: { kind: 'open', page: 'scene', target: sc } },
          { label: '全部镜头', command: { kind: 'open', page: 'scene' } },
        ]
      : [{ label: '看镜头', command: { kind: 'open', page: 'scene' } }];
  };

  // 取景：画布按视口大小缩放，滚轮捏合缩放、拖动平移，都在视口里算，不动画布本身的坐标。
  const viewRef = useRef<HTMLDivElement>(null);
  const [viewSize, setViewSize] = useState({ w: CW, h: CH });
  useLayoutEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const measure = () => setViewSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pageURL]);
  const [cam, setCam] = useState({ zoom: 1, x: 0, y: 0 });
  const fit = Math.min(viewSize.w / CW, viewSize.h / CH);
  const scale = fit * cam.zoom;
  const tx = (viewSize.w - CW * scale) / 2 + cam.x;
  const ty = (viewSize.h - CH * scale) / 2 + cam.y;
  const toScreen = ([x, y]: Pt): Pt => [tx + x * scale, ty + y * scale];
  const zoomAt = (factor: number, mx = viewSize.w / 2, my = viewSize.h / 2) =>
    setCam((c) => {
      const zoom = clamp(c.zoom * factor, 0.6, 3);
      const s0 = fit * c.zoom;
      const s1 = fit * zoom;
      const t0x = (viewSize.w - CW * s0) / 2 + c.x;
      const t0y = (viewSize.h - CH * s0) / 2 + c.y;
      const cx = (mx - t0x) / s0;
      const cy = (my - t0y) / s0;
      return clampCam({ zoom, x: mx - cx * s1 - (viewSize.w - CW * s1) / 2, y: my - cy * s1 - (viewSize.h - CH * s1) / 2 }, CW * s1, CH * s1);
    });
  const panBy = (dx: number, dy: number) => setCam((c) => clampCam({ ...c, x: c.x + dx, y: c.y + dy }, CW * fit * c.zoom, CH * fit * c.zoom));
  const panning = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);

  // 选中谁、环形菜单开着没有。
  const [selected, setSelected] = useState<Who | null>(null);
  const [pie, setPie] = useState<Who | null>(null);
  useEffect(() => {
    if (!signal.project) {
      setSelected(null);
      setPie(null);
    }
  }, [signal.project]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPie(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const choose = (who: Who) => {
    setSelected(who);
    setPie((open) => (open === who ? null : who));
  };

  // 导演的气泡：挂在头上，换成屏幕坐标后夹在视口里。
  const bubble = useRef<HTMLDivElement>(null);
  const [bubbleWidth, setBubbleWidth] = useState(0);
  useLayoutEffect(() => setBubbleWidth(bubble.current?.offsetWidth ?? 0), [signal.line]);
  const seated = dirArrived && seatedPoses.has(dPose);
  const headAt = toScreen(P(w.director.x, w.director.y, seated ? 1.45 : 1.95));
  const bubbleLeft = Math.min(Math.max(headAt[0] - bubbleWidth / 2, 6), viewSize.w - 6 - bubbleWidth);
  const tail = Math.min(Math.max(headAt[0] - bubbleLeft, 12), Math.max(12, bubbleWidth - 12));
  const bubbleTop = Math.max(4, headAt[1] - 30 - (mood === 'thinking' && dirArrived ? 14 : 0));

  // 热区：点人选中并弹出环形菜单；分镜板直接打开分镜。
  const people: Who[] = ['editor', 'voice', 'op1', 'op2', 'op3', 'director'];
  const spots: Spot2[] = [
    { key: 'storyboard', label: '分镜板 · 看分镜', ...area(P(0.03, 1.9, 2.4), P(0.03, 3.4, 0.7)) },
    ...people.map((who) => ({ key: who, label: `${info(who).name} · ${info(who).doing}`, ...figure(...footOf(who)) })),
  ];

  // 昼夜：按这台电脑的时间给整间工作室一层光。
  const light = ambient(new Date());
  const sel = selected ? info(selected) : null;
  const selFoot = selected ? P(...footOf(selected)) : null;
  const pieAt = pie ? toScreen(P(...footOf(pie), 1.0)) : null;
  const pieItems = pie ? pieFor(pie) : [];

  return (
    <div className="pet" id="crew" data-mood={mood} data-project={signal.project ? 'open' : 'none'} data-walking={dirArrived ? 'false' : 'true'} data-daypart={light.part} role="status" aria-live="polite" aria-label={signal.line}>
      <div className="pet-card" onDoubleClick={() => send({ kind: 'focus' })} title="双击边框回到客户端">
        <div
          className="pet-view"
          ref={viewRef}
          onDoubleClick={(event) => event.stopPropagation()}
          onWheel={(event) => {
            if (pageURL) return;
            const box = viewRef.current!.getBoundingClientRect();
            // 触控板捏合（带 ctrl）缩放，两指滑动平移。
            if (event.ctrlKey) zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top);
            else panBy(-event.deltaX, -event.deltaY);
          }}
          onPointerDown={(event) => {
            if (pageURL || event.button !== 0 || (event.target as Element).closest('button, input, .pet-panel, .pet-desk-wrap')) return;
            panning.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
            (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const p = panning.current;
            if (!p || p.id !== event.pointerId) return;
            const dx = event.clientX - p.x;
            const dy = event.clientY - p.y;
            if (!p.moved && Math.hypot(dx, dy) < 3) return;
            p.moved = true;
            p.x = event.clientX;
            p.y = event.clientY;
            panBy(dx, dy);
          }}
          onPointerUp={(event) => {
            const p = panning.current;
            panning.current = null;
            // 点在空地上（没拖）：收起环形菜单。
            if (p && !p.moved && !(event.target as Element).closest('.pet-spot')) setPie(null);
          }}
          data-panning={panning.current?.moved ? 'true' : 'false'}
        >
          {pageURL ? (
            <PetPage url={pageURL} signal={signal} skin={skin!} />
          ) : (
            <>
              <div className="pet-stage" style={{ width: CW, height: CH, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}>
                <svg className="pet-room" viewBox={`0 0 ${CW} ${CH}`} width={CW} height={CH} aria-hidden="true" style={{ filter: petFilter(skin) }}>
                  <defs>
                    <radialGradient id="pet-glow">
                      <stop offset="0" className="pet-glow-stop" stopOpacity="0.4" />
                      <stop offset="1" className="pet-glow-stop" stopOpacity="0" />
                    </radialGradient>
                    <radialGradient id="pet-lamp">
                      <stop offset="0" stopColor="#ffd9a0" stopOpacity="0.55" />
                      <stop offset="1" stopColor="#ffd9a0" stopOpacity="0" />
                    </radialGradient>
                  </defs>
                  {shell}
                  {clockHands(new Date())}
                  {storyboardWall(mood === 'storyboarding' && dirArrived, frame)}
                  {consoleScreen(mood === 'running' && dirArrived, frame)}
                  {editScreens(editing, frame)}
                  {anyFilming ? (
                    <g className="pet-light">
                      <polygon points={pts(wallQuad('back', 2.9, 5.8, 0, 2.7))} className="pet-lit-paper" />
                      <polygon points={pts([P(2.7, 0.55, 2.35), P(3.7, 0.2, 0), P(4.9, 1.0, 0)])} />
                      <polygon points={pts([P(6.05, 0.55, 2.35), P(5.0, 0.2, 0), P(3.8, 1.0, 0)])} />
                      <ellipse cx={P(4.35, 0.65)[0]} cy={P(4.35, 0.65)[1]} rx={1.9 * U} ry={0.95 * U} fill="url(#pet-glow)" />
                    </g>
                  ) : null}
                  <ellipse cx={P(w.director.x, w.director.y)[0]} cy={P(w.director.x, w.director.y)[1]} rx={0.9 * U} ry={0.45 * U} fill="url(#pet-glow)" />
                  {selFoot ? selectionRing(selFoot, t) : null}
                  {items.map((item) => item.el)}
                  {selected ? selectionMarker(P(...footOf(selected), 2.35), t) : null}
                  {/* 昼夜：一层整体的光，夜里台灯与屏幕亮起来。 */}
                  <rect x={0} y={0} width={CW} height={CH} fill={light.color} opacity={light.opacity} style={{ mixBlendMode: 'multiply' }} pointerEvents="none" />
                  {light.lamps ? (
                    <g pointerEvents="none" style={{ mixBlendMode: 'screen' }}>
                      <ellipse cx={P(3.9, 3.9, 1.1)[0]} cy={P(3.9, 3.9, 1.1)[1]} rx={1.6 * U} ry={1.1 * U} fill="url(#pet-lamp)" />
                      <ellipse cx={P(0.4, 1.2, 1.2)[0]} cy={P(0.4, 1.2, 1.2)[1]} rx={1.2 * U} ry={0.9 * U} fill="url(#pet-lamp)" opacity={0.6} />
                      <ellipse cx={P(6.7, 0.3, 1.6)[0]} cy={P(6.7, 0.3, 1.6)[1]} rx={1.2 * U} ry={0.8 * U} fill="url(#pet-lamp)" opacity={0.5} />
                    </g>
                  ) : null}
                </svg>
                {signal.project
                  ? spots.map((spot) => (
                      <button
                        key={spot.key}
                        className="pet-spot"
                        data-spot={spot.key}
                        data-selected={spot.key === selected ? 'true' : 'false'}
                        title={spot.label}
                        aria-label={spot.label}
                        style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }}
                        onClick={() => (spot.key === 'storyboard' ? send({ kind: 'open', page: 'storyboard' }) : choose(spot.key as Who))}
                      />
                    ))
                  : null}
              </div>
              {tags.map((tag) => {
                const [x, y] = toScreen(tag.at);
                return (
                  <span key={tag.key} className="pet-tag" data-tag={tag.key} title={tag.title} style={{ left: x, top: y + 2 }}>
                    {tag.text}
                  </span>
                );
              })}
              <div ref={bubble} className="pet-bubble" hidden={pie !== null} style={{ left: bubbleLeft, top: bubbleTop, ['--tail' as string]: `${tail}px` }}>
                <span className="pet-line">{signal.line}</span>
              </div>
              {pie && pieAt ? (
                <div className="pet-pie" data-who={pie} style={{ left: pieAt[0], top: pieAt[1] }} role="menu" aria-label={`${info(pie).name}能做的事`}>
                  {pieItems.map((item, k) => {
                    const angle = -Math.PI / 2 + ((k - (pieItems.length - 1) / 2) * Math.PI) / Math.max(4, pieItems.length + 1) * 1.6;
                    const r = 62;
                    return (
                      <button
                        key={item.label}
                        className="pet-pie-item"
                        role="menuitem"
                        style={{ left: Math.cos(angle) * r * 1.35, top: Math.sin(angle) * r, animationDelay: `${k * 30}ms` }}
                        onClick={() => {
                          setPie(null);
                          if (item.compose) setComposing(true);
                          else if (item.command) send(item.command);
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {sel && selected ? <CrewPanel info={sel} who={selected} onClose={() => { setSelected(null); setPie(null); }} /> : null}
              <div className="pet-cam" onDoubleClick={(event) => event.stopPropagation()}>
                <button title="放大" aria-label="放大" onClick={() => zoomAt(1.25)}>+</button>
                <button title="缩小" aria-label="缩小" onClick={() => zoomAt(0.8)}>−</button>
                <button title="回到全景" aria-label="回到全景" data-cam="reset" onClick={() => setCam({ zoom: 1, x: 0, y: 0 })}>⌂</button>
              </div>
              <span className="pet-clock" title="工作室的光跟着这台电脑的时间走">{light.label}</span>
            </>
          )}
          <Desk signal={signal} composing={composing} onCompose={setComposing} />
        </div>
        <div className="pet-foot">
          <span className="pet-project">{signal.project || '片场'}</span>
          <span className="pet-legend">{filmingCount > 0 ? `${filmingCount} 个镜头在拍` : ''}</span>
          {signal.project ? (
            <span className="pet-actions" onDoubleClick={(event) => event.stopPropagation()}>
              {signal.running ? (
                <button className="pet-act" data-act="stop" title="停下这一轮" aria-label="停下这一轮" onClick={() => send({ kind: 'stop' })}>
                  <Icon name="stop" size={11} />
                </button>
              ) : null}
              <button
                className="pet-act"
                data-act="say"
                data-on={composing ? 'true' : 'false'}
                title="对导演说一句"
                aria-label="对导演说一句"
                onClick={() => setComposing((open) => !open)}
              >
                <Icon name="edit" size={11} />
              </button>
              <button className="pet-act" data-act="focus" title="回到客户端" aria-label="回到客户端" onClick={() => send({ kind: 'focus' })}>
                <Icon name="panel" size={11} />
              </button>
            </span>
          ) : null}
          <button className="pet-close" title="收起桌宠（菜单「窗口 → 场记桌宠」再打开）" onClick={() => send({ kind: 'hide' })}>
            ×
          </button>
          <span
            className="pet-grip"
            title="拖动改大小"
            aria-hidden="true"
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
              send({ kind: 'resize', phase: 'start' });
            }}
            onPointerUp={() => send({ kind: 'resize', phase: 'end' })}
            onPointerCancel={() => send({ kind: 'resize', phase: 'end' })}
          />
        </div>
      </div>
    </div>
  );
}

// ---- 选中、面板、环形菜单、昼夜 ----

type Who = 'director' | 'op1' | 'op2' | 'op3' | 'editor' | 'voice';
const opIndex = (who: Who) => Number(who.slice(2)) - 1;

interface CrewInfo {
  name: string;
  role: string;
  doing: string;
  mood: string;
  /** 需求条；kind 为 time 的是计时（越长越满），不按「低了不好」标红。 */
  needs: { label: string; value: number; note: string; kind?: 'time' }[];
  queue: { text: string; state: string }[];
  scene?: string;
}

interface PieItem {
  label: string;
  command?: PetCommand;
  /** 打开「说一句」的输入框。 */
  compose?: boolean;
}

/** 闲着时在做什么的说法（与各人的闲事表一一对应）。 */
const idleLabels = {
  director: { sit: '坐着琢磨', coffee: '喝咖啡', doze: '打盹', script: '翻剧本', board: '看分镜板', chat: '找摄影聊天' } as Record<string, string>,
  operator: { sit: '坐着', lean: '往后靠着', phone: '看手机', coffee: '喝咖啡', doze: '打盹', talk: '聊天', check: '摆弄机器' } as Record<string, string>,
  editor: { lean: '靠着椅背', stretch: '伸懒腰', tinker: '随手剪着玩', coffee: '喝咖啡', doze: '打盹', swivel: '转椅子' } as Record<string, string>,
  voice: { script: '看稿', hum: '哼歌', water: '喝水' } as Record<string, string>,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 取景不让整间屋子跑出视口：最多挪出去大半，总有一块留在里面。 */
function clampCam(c: { zoom: number; x: number; y: number }, w: number, h: number) {
  return { zoom: c.zoom, x: clamp(c.x, -w * 0.6, w * 0.6), y: clamp(c.y, -h * 0.6, h * 0.6) };
}

/** 剧组的心情：按此刻在做什么与最近几轮的结果。 */
function crewMoodOf(signal: CrewSignal): string {
  switch (signal.mood) {
    case 'waiting':
      return '焦急';
    case 'failed':
      return '沮丧';
    case 'stopped':
      return '无奈';
    case 'done':
      return '满意';
    case 'idle': {
      const failed = signal.recent.filter((r) => r === 'failed').length;
      if (failed >= 2) return '低落';
      return signal.recent.length > 0 && signal.recent[signal.recent.length - 1] === 'done' ? '舒心' : '悠闲';
    }
    default:
      return '专注';
  }
}

const moodTone: Record<string, 'good' | 'mid' | 'bad'> = { 满意: 'good', 舒心: 'good', 悠闲: 'good', 专注: 'mid', 焦急: 'mid', 无奈: 'bad', 沮丧: 'bad', 低落: 'bad' };

/** 选中的人的状态面板：在做什么、心情、需求条、动作队列。 */
function CrewPanel({ info, who, onClose }: { info: CrewInfo; who: Who; onClose: () => void }) {
  return (
    <aside className="pet-panel" data-who={who} aria-label={`${info.name}的状态`} onDoubleClick={(event) => event.stopPropagation()}>
      <header>
        <strong>{info.name}</strong>
        <span className="pet-panel-role">{info.role}</span>
        <span className="pet-mood" data-tone={moodTone[info.mood] ?? 'mid'}>
          {info.mood}
        </span>
        <button className="pet-panel-close" aria-label="取消选中" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="pet-panel-doing">{info.doing}</p>
      <ul className="pet-needs">
        {info.needs.map((n) => (
          <li key={n.label}>
            <span>{n.label}</span>
            <i>
              <b style={{ width: `${Math.round(n.value * 100)}%` }} data-kind={n.kind ?? 'need'} data-low={!n.kind && n.value < 0.3 ? 'true' : 'false'} />
            </i>
            <em>{n.note}</em>
          </li>
        ))}
      </ul>
      {info.queue.length > 0 ? (
        <ol className="pet-queue" aria-label="接下来要做的">
          {info.queue.slice(0, 5).map((q, k) => (
            <li key={k} data-state={q.state}>
              {q.text}
            </li>
          ))}
          {info.queue.length > 5 ? <li data-state="more">还有 {info.queue.length - 5} 件</li> : null}
        </ol>
      ) : null}
    </aside>
  );
}

/** 选中的人脚下一圈光环，慢慢呼吸。 */
function selectionRing([x, y]: Pt, t: number): ReactElement {
  const k = 1 + Math.sin(t / 420) * 0.06;
  return (
    <g pointerEvents="none">
      <ellipse cx={x} cy={y} rx={0.55 * U * k} ry={0.28 * U * k} fill="none" stroke="var(--accent)" strokeWidth={1.6} opacity={0.9} />
      <ellipse cx={x} cy={y} rx={0.42 * U} ry={0.21 * U} fill="var(--accent)" opacity={0.18} />
    </g>
  );
}

/** 选中的人头顶一个上下浮动的小箭头。 */
function selectionMarker([x, y]: Pt, t: number): ReactElement {
  const dy = Math.sin(t / 380) * 2;
  return <path d={`M${x - 5} ${y - 6 + dy} L${x + 5} ${y - 6 + dy} L${x} ${y + 1 + dy} Z`} fill="var(--accent)" stroke="rgba(0,0,0,0.35)" strokeWidth={0.6} pointerEvents="none" />;
}

/** 昼夜的光：清晨偏冷、白天不加、傍晚偏暖、夜里压暗偏蓝并亮起台灯。 */
function ambient(now: Date): { part: string; label: string; color: string; opacity: number; lamps: boolean } {
  const h = now.getHours() + now.getMinutes() / 60;
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const at = `${hh}:${mm}`;
  if (h >= 21 || h < 5) return { part: 'night', label: `夜 ${at}`, color: '#1b2b55', opacity: 0.42, lamps: true };
  if (h < 7) return { part: 'dawn', label: `清晨 ${at}`, color: '#8fa6d6', opacity: 0.22, lamps: true };
  if (h < 17) return { part: 'day', label: `白天 ${at}`, color: '#ffffff', opacity: 0, lamps: false };
  if (h < 19) return { part: 'dusk', label: `傍晚 ${at}`, color: '#f2a65a', opacity: 0.22, lamps: false };
  return { part: 'evening', label: `晚上 ${at}`, color: '#4a4f8a', opacity: 0.3, lamps: true };
}

// ---- 插件页面换掉的工作室 ----

/**
 * 皮肤用插件页面整个换掉工作室：页面在沙箱 iframe 里（不给 allow-same-origin，后端另有 pageCSP 不许连网）。
 * 宿主把桌宠的全部状态（含等批准的调用、上一轮的选项）与皮肤的颜色 postMessage 过去；页面能做宿主桌宠能做的
 * 一切（答批准、发话、停下、切页、回到客户端、收起），动作原样交给主进程，形状由 main/pet.ts 的 petCommand 校验。
 * 不像插件页面那样要用户在宿主上再确认一次：用皮肤换桌宠就是把桌宠交给这个插件（用户的决定）。
 */
function PetPage({ url, signal, skin }: { url: string; signal: CrewSignal; skin: SkinView }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const message = useMemo(() => ({ onset: 'pet', signal, skin: { scheme: skin.scheme, tokens: skin.tokens } }), [signal, skin]);
  const post = () => frame.current?.contentWindow?.postMessage(message, '*');
  useEffect(post, [message]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { onset?: unknown; phase?: unknown; command?: unknown } | null;
      // 宿主插进页面的拖动脚本（studio/stations.ts 的 petDragScript）：按住空白处挪动就拖窗口。
      if (data?.onset === 'pet-drag' && (data.phase === 'start' || data.phase === 'end')) {
        send({ kind: 'drag', phase: data.phase });
        return;
      }
      if (!data || data.onset !== 'pet-command' || !data.command || typeof data.command !== 'object') return;
      send(data.command as PetCommand);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return <iframe ref={frame} className="pet-frame" title="桌宠" src={url} sandbox="allow-scripts" width={CW} height={CH} onLoad={post} />;
}

// ---- 桌宠上能做的事 ----

interface Spot2 {
  key: string;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一个站着的人在画布上占的那一块（脚到头顶，左右各留一点）。 */
function figure(x: number, y: number): { left: number; top: number; width: number; height: number } {
  const foot = P(x, y, 0);
  const head = P(x, y, 1.95);
  return { left: foot[0] - 13, top: head[1] - 4, width: 26, height: foot[1] - head[1] + 8 };
}

/** 两点围出的一块。 */
function area(a: Pt, b: Pt): { left: number; top: number; width: number; height: number } {
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  return { left, top, width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
}

/**
 * 盖在工作室下沿的一块小桌面：有批准请求时先答批准，上一轮回复带选项时列出选项，点了「说一句」时是输入框。
 * 三样都只是把动作交回主窗口（main/pet.ts 转交），桌宠自己不调接口。
 */
function Desk(props: { signal: CrewSignal; composing: boolean; onCompose: (open: boolean) => void }) {
  const { signal, composing, onCompose } = props;
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // 打开输入框时先请主进程把桌宠设成键盘窗口，再把光标放进去。
  useEffect(() => {
    if (!composing) return;
    send({ kind: 'type' });
    const timer = window.setTimeout(() => input.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [composing]);
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(false), 1800);
    return () => window.clearTimeout(timer);
  }, [sent]);
  // 离开项目时收起输入框。
  useEffect(() => {
    if (!signal.project) onCompose(false);
  }, [signal.project, onCompose]);

  const ask = signal.asks[0];
  const say = () => {
    const text = draft.trim();
    if (!text || !signal.canSend) return;
    send({ kind: 'say', text });
    setDraft('');
    setSent(true);
    onCompose(false);
  };

  let body: ReactElement | null = null;
  if (ask) {
    body = (
      <div className="pet-desk" data-desk="ask">
        <div className="pet-desk-head">
          <span>导演想执行</span>
          {signal.asks.length > 1 ? <span className="pet-desk-more">还有 {signal.asks.length - 1} 件</span> : null}
        </div>
        <code className="pet-desk-cmd" title={ask.text}>
          {ask.text}
        </code>
        <div className="pet-desk-row">
          <button className="pet-btn primary" onClick={() => send({ kind: 'answer', id: ask.id, decision: 'allow' })}>
            允许
          </button>
          {ask.always ? (
            <button className="pet-btn" onClick={() => send({ kind: 'answer', id: ask.id, decision: 'always' })}>
              以后都允许
            </button>
          ) : null}
          <button className="pet-btn quiet" onClick={() => send({ kind: 'answer', id: ask.id, decision: 'deny' })}>
            拒绝
          </button>
        </div>
      </div>
    );
  } else if (composing) {
    body = (
      <form
        className="pet-desk"
        data-desk="say"
        onSubmit={(event) => {
          event.preventDefault();
          say();
        }}
      >
        <div className="pet-desk-row">
          <input
            ref={input}
            className="pet-input"
            value={draft}
            placeholder={signal.canSend ? (signal.running ? '说一句，排到这一轮之后' : '对导演说一句') : '项目正忙，稍后再说'}
            disabled={!signal.canSend}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCompose(false);
            }}
          />
          <button className="pet-btn primary icon" type="submit" disabled={!draft.trim() || !signal.canSend} aria-label="发送" title="发送">
            <Icon name="send" size={11} />
          </button>
        </div>
      </form>
    );
  } else if (signal.choices.length > 0) {
    body = (
      <div className="pet-desk" data-desk="choices">
        {signal.question ? (
          <div className="pet-desk-head" title={signal.question}>
            <span className="pet-desk-q">{signal.question}</span>
          </div>
        ) : null}
        <div className="pet-desk-row wrap">
          {signal.choices.slice(0, 4).map((choice) => (
            <button key={choice} className="pet-btn choice" title={choice} onClick={() => send({ kind: 'say', text: choice })}>
              {choice}
            </button>
          ))}
          {signal.choices.length > 4 ? (
            <button className="pet-btn quiet" onClick={() => send({ kind: 'focus' })}>
              更多…
            </button>
          ) : null}
        </div>
      </div>
    );
  } else if (sent) {
    body = (
      <div className="pet-desk" data-desk="sent">
        <span className="pet-desk-note">已经交给导演</span>
      </div>
    );
  }
  if (!body) return null;
  return (
    <div className="pet-desk-wrap" onDoubleClick={(event) => event.stopPropagation()}>
      {body}
    </div>
  );
}

// ---- 导演手上的东西 ----

/** 人自己坐标里的一点投影到画布。 */
function local(w: Walker, f: number, r: number, z: number): Pt {
  return P(w.x + f * Math.cos(w.a) - r * Math.sin(w.a), w.y + f * Math.sin(w.a) + r * Math.cos(w.a), z);
}

/** 场记板：举在胸前；收工时合上。 */
function slateProp(w: Walker, shut: boolean, t: number): ReactElement {
  const z = 1.0 + Math.sin(t / 300) * 0.03;
  const o = 0.17;
  const board = [local(w, 0.32, o - 0.2, z), local(w, 0.32, o + 0.2, z), local(w, 0.32, o + 0.2, z + 0.28), local(w, 0.32, o - 0.2, z + 0.28)];
  const hinge = local(w, 0.32, o - 0.2, z + 0.3);
  const tip = shut ? local(w, 0.32, o + 0.2, z + 0.32) : local(w, 0.32, o + 0.14, z + 0.5);
  return (
    <g>
      <polygon points={pts(board)} fill="#2a2520" />
      {seg('sl1', local(w, 0.32, o - 0.13, z + 0.09), local(w, 0.32, o + 0.13, z + 0.09), '#efe9dd', 1.2)}
      {seg('sl2', local(w, 0.32, o - 0.13, z + 0.18), local(w, 0.32, o + 0.04, z + 0.18), '#efe9dd', 1.2)}
      {seg('stick', hinge, tip, '#efe9dd', 3)}
      {seg('stickStripe', hinge, tip, '#2a2520', 3, { strokeDasharray: '2.5 2.5', strokeLinecap: 'butt' })}
    </g>
  );
}

/** 剧本：摊开在两手之间。 */
function scriptProp(w: Walker, t: number): ReactElement {
  const z = 1.08 + Math.sin(t / 600) * 0.02;
  const pageL = [local(w, 0.32, -0.16, z), local(w, 0.36, 0, z + 0.02), local(w, 0.4, 0, z + 0.23), local(w, 0.36, -0.16, z + 0.21)];
  const pageR = [local(w, 0.36, 0, z + 0.02), local(w, 0.32, 0.16, z), local(w, 0.36, 0.16, z + 0.21), local(w, 0.4, 0, z + 0.23)];
  return (
    <g>
      <polygon points={pts(pageL)} fill="#efe9dd" />
      <polygon points={pts(pageR)} fill="#cfc6b6" />
    </g>
  );
}

/** 想事情：头顶一串小圆点，一个一个冒出来。 */
function thoughtDots(w: Walker, frame: number): ReactElement {
  const n = (frame % 4) + 1;
  const base = P(w.x, w.y, 1.45);
  const dots = [
    [7, -4, 1.6],
    [11, -10, 2.3],
    [16, -18, 3.2],
  ].slice(0, Math.min(3, n));
  return (
    <g>
      {dots.map(([dx, dy, r], i) => (
        <circle key={i} cx={base[0] + dx} cy={base[1] + dy} r={r} fill="#ecc890" />
      ))}
    </g>
  );
}

function mark(w: Walker, text: string, color: string): ReactElement {
  const at = P(w.x, w.y, 2.0);
  return (
    <text x={at[0] + 9} y={at[1]} fill={color} fontSize={12} fontWeight={700} fontFamily="var(--mono)">
      {text}
    </text>
  );
}

// ---- 闲着时手上的东西 ----

/** 闲着时手上或头上的小东西：杯子、手机、打盹的 z、哼歌的音符。 */
function idleProp(prop: Prop | undefined, x: number, y: number, a: number, pose: Pose, t: number): ReactElement | null {
  if (!prop || prop === 'script') return null;
  const head = jointAt(x, y, a, pose, t, 'head');
  if (prop === 'zzz' || prop === 'notes') {
    const glyphs = prop === 'zzz' ? ['z', 'z', 'Z'] : ['♪', '♫'];
    const period = prop === 'zzz' ? 2400 : 1800;
    return (
      <g>
        {glyphs.map((g, i) => {
          const phase = ((t + (i * period) / glyphs.length) % period) / period;
          return (
            <text
              key={i}
              x={head[0] + 6 + phase * 8 + (prop === 'notes' ? Math.sin(phase * 6) * 2 : 0)}
              y={head[1] - 6 - phase * 16}
              fontSize={prop === 'zzz' ? 6 + phase * 3 : 8}
              fill={prop === 'zzz' ? '#c2bbae' : '#d9a35f'}
              opacity={Math.sin(phase * Math.PI)}
              fontFamily="var(--mono)"
            >
              {g}
            </text>
          );
        })}
      </g>
    );
  }
  const hand = jointAt(x, y, a, pose, t, 'haR');
  if (prop === 'phone') {
    const other = jointAt(x, y, a, pose, t, 'haL');
    const cx = (hand[0] + other[0]) / 2;
    const cy = (hand[1] + other[1]) / 2 - 2;
    return (
      <g>
        <rect x={cx - 2.4} y={cy - 3.2} width={4.8} height={6.4} rx={1} fill="#201c18" />
        <rect x={cx - 1.7} y={cy - 2.5} width={3.4} height={4.8} fill="#c2bbae" opacity={0.75 + Math.sin(t / 400) * 0.15} />
      </g>
    );
  }
  // 杯子：举到嘴边时冒一缕热气。
  return (
    <g>
      <rect x={hand[0] - 2} y={hand[1] - 4.5} width={4} height={4.6} rx={0.8} fill="#efe9dd" />
      <rect x={hand[0] - 2} y={hand[1] - 4.5} width={4} height={1} fill="#94693a" />
      {pose === 'sitSip' && !sipping(t) ? steam([hand[0], hand[1] - 5], t) : null}
    </g>
  );
}

/** 一缕热气：两道细弯线往上飘、慢慢淡掉。 */
function steam(at: Pt, t: number): ReactElement {
  return (
    <g>
      {[0, 1].map((i) => {
        const phase = ((t / 1600 + i * 0.5) % 1 + 1) % 1;
        const x = at[0] + (i - 0.5) * 2.4;
        const y = at[1] - phase * 9;
        const s = Math.sin(phase * Math.PI * 2 + i) * 1.6;
        return <path key={i} d={`M${x} ${y} q${s} -2.5 0 -5 q${-s} -2.5 0 -5`} fill="none" stroke="#efe9dd" strokeWidth={0.7} strokeLinecap="round" opacity={0.45 * Math.sin(phase * Math.PI)} />;
      })}
    </g>
  );
}
