import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { CrewMood, CrewSignal } from './chat/crew';
import '../pet.css';

/*
 * 桌宠窗口（main/pet.ts）：一间等距块面的微缩工作室。从斜上方平行投影看进去，家具都是有厚度的块，
 * 顶面最亮、朝左下的面次之、朝右下的面最暗（光从左上来）；人是实色的：衣服、皮肤、头发各有亮暗两面。
 *
 *   导演（编排工具）——在哪个部门干活就走到哪：读稿、写稿在剧本桌，跑命令在导演台，拍摄时在机位旁，
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
const U = 32;
const CW = 400;
const CH = 326;
const OX = CW / 2 - ((RX - RY) / 2) * 0.866 * U;
const OY = 99;
/** 画布在卡片里的内边距（像素），与 pet.css 的 .pet-card 对应。 */
const inset = 7;

type Pt = [number, number];
const P = (x: number, y: number, z = 0): Pt => [OX + (x - y) * 0.866 * U, OY + (x + y) * 0.5 * U - z * U];
const pts = (list: Pt[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** 动画节拍：每 50 毫秒走一步、动一下。走路速度（单位每步）。 */
const tickMs = 50;
const speed = 0.11;

// ---- 材质：顶面、朝左下的面、朝右下的面 ----

type Material = readonly [string, string, string];
const mat = {
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

/** 等距的箱子：顶面、+y 面（朝左下）、+x 面（朝右下）三种明暗。 */
function box(key: string, x: number, y: number, z: number, w: number, d: number, h: number, m: Material, edge = 'rgba(0,0,0,0.25)'): ReactElement {
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

const seg = (key: string, a: Pt, b: Pt, stroke: string, width = 1, extra: Record<string, string | number> = {}) => (
  <line key={key} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={stroke} strokeWidth={width} strokeLinecap="round" {...extra} />
);

/** 墙上的一块平面（x=0 的左墙或 y=0 的后墙）与墙上某一点。 */
function wallQuad(on: 'left' | 'back', a: number, b: number, z0: number, z1: number): Pt[] {
  return on === 'left' ? [P(0.02, a, z0), P(0.02, b, z0), P(0.02, b, z1), P(0.02, a, z1)] : [P(a, 0.02, z0), P(b, 0.02, z0), P(b, 0.02, z1), P(a, 0.02, z1)];
}
const wallAt = (on: 'left' | 'back', s: number, z: number): Pt => (on === 'left' ? P(0.03, s, z) : P(s, 0.03, z));

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

type Pose = 'stand' | 'walk' | 'sit' | 'think' | 'type' | 'stretch' | 'operate' | 'read' | 'write' | 'point' | 'slate' | 'cheer' | 'slump' | 'cross' | 'mic' | 'script';

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
    default:
      b.head = [0, sway * 2, 1.53];
  }
  return b;
}

/** 一个人的样子：衣服亮暗、裤子、鞋、头发、皮肤，以及头上戴什么。 */
interface Look {
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
const looks: Record<string, Look> = {
  director: { coat: '#e3dbcc', coatShade: '#b3a996', trousers: '#4a4239', shoe: '#2a2520', hair: '#5a4330', ...skin, hat: 'beret', hatColor: '#d9a35f' },
  op1: { coat: '#7d7262', coatShade: '#5c5348', trousers: '#34302b', shoe: '#201c18', hair: '#3a2c20', ...skin, hat: 'cap', hatColor: '#3a342d' },
  op2: { coat: '#a59a88', coatShade: '#7d7363', trousers: '#3f3a33', shoe: '#201c18', hair: '#2a2018', ...skin, hat: 'cap', hatColor: '#6b5038' },
  op3: { coat: '#5f564c', coatShade: '#463f37', trousers: '#2a2520', shoe: '#1a1714', hair: '#6b4a30', skin: '#c9a07c', skinShade: '#a8815f', hat: 'cap', hatColor: '#2a2520' },
  editor: { coat: '#3e3832', coatShade: '#2c2823', trousers: '#2a2520', shoe: '#1a1714', hair: '#2d241c', ...skin, hat: 'phones', hatColor: '#d9a35f' },
  voice: { coat: '#cfc6b6', coatShade: '#a1978a', trousers: '#4a4239', shoe: '#2a2520', hair: '#7a5a3c', ...skin, hat: 'phones', hatColor: '#6f6557' },
};

/** 画一个人：站位 (x, y)、朝向角 a（弧度，0 朝 +x）、姿势与样子。四肢按远近排好先后。 */
function person(key: string, x: number, y: number, a: number, pose: Pose, t: number, look: Look): ReactElement {
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
  if (frontness > 0.1) {
    const cx = head[0] + (F[0] - F[1]) * 0.866 * r * 0.42;
    const spread = r * 0.34 * Math.max(0.35, frontness);
    for (const dx of [-spread, spread]) eyes.push(<circle key={`eye${dx}`} cx={cx + dx} cy={head[1] + r * 0.12} r={0.75} fill="#2a2520" />);
  }
  const hat: ReactElement[] = [];
  if (look.hat === 'beret') {
    hat.push(<ellipse key="beret" cx={head[0] - 0.8} cy={head[1] - r * 0.72} rx={r * 1.18} ry={r * 0.46} fill={look.hatColor} />);
    hat.push(<ellipse key="beretTop" cx={head[0] - 0.4} cy={head[1] - r * 0.86} rx={r * 0.9} ry={r * 0.3} fill="#e8ba78" opacity={0.7} />);
    hat.push(<circle key="nub" cx={head[0] + 0.4} cy={head[1] - r * 1.18} r={1.1} fill={look.hatColor} />);
  } else if (look.hat === 'cap') {
    const brim = proj([b.head[0] + 0.22, 0, b.head[2] + 0.05]);
    hat.push(<path key="cap" d={`M${head[0] - r} ${head[1] - r * 0.15} A${r} ${r} 0 0 1 ${head[0] + r} ${head[1] - r * 0.15} Z`} fill={look.hatColor} />);
    hat.push(seg('brim', [head[0], head[1] - r * 0.2], brim, look.hatColor, 2.2));
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
  out.push(box('slab', 0, 0, -0.32, RX, RY, 0.32, ['#3a3128', '#2a231c', '#211b16'], 'rgba(0,0,0,0.3)'));
  for (let i = 0; i < RX; i++) {
    for (let j = 0; j < RY; j++) {
      if ((i + j) % 2 === 0) continue;
      out.push(<polygon key={`t${i}-${j}`} points={pts([P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)])} fill="rgba(255,240,220,0.025)" />);
    }
  }
  // 两面墙：墙面加一条墙头，墙根一道暗影。
  out.push(<polygon key="wl" points={pts([P(0, 0), P(0, RY), P(0, RY, WALL), P(0, 0, WALL)])} fill="#221d18" />);
  out.push(<polygon key="wb" points={pts([P(0, 0), P(RX, 0), P(RX, 0, WALL), P(0, 0, WALL)])} fill="#2c261f" />);
  out.push(<polygon key="wlcap" points={pts([P(-0.15, -0.15, WALL), P(0, 0, WALL), P(0, RY, WALL), P(-0.15, RY, WALL)])} fill="#4a3f33" />);
  out.push(<polygon key="wbcap" points={pts([P(-0.15, -0.15, WALL), P(RX, -0.15, WALL), P(RX, 0, WALL), P(0, 0, WALL)])} fill="#55493b" />);
  out.push(<polygon key="wlend" points={pts([P(-0.15, RY, -0.32), P(0, RY, -0.32), P(0, RY, WALL), P(-0.15, RY, WALL)])} fill="#1a1612" />);
  out.push(<polygon key="wbend" points={pts([P(RX, -0.15, -0.32), P(RX, 0, -0.32), P(RX, 0, WALL), P(RX, -0.15, WALL)])} fill="#1f1a15" />);
  out.push(<polygon key="aol" points={pts([P(0, 0), P(0.35, 0.35), P(0.35, RY), P(0, RY)])} fill="rgba(0,0,0,0.18)" />);
  out.push(<polygon key="aob" points={pts([P(0, 0), P(RX, 0), P(RX, 0.35), P(0.35, 0.35)])} fill="rgba(0,0,0,0.18)" />);
  // 影棚：卷纸背景从后墙垂下来铺到地上，上面一根卷轴。
  out.push(<polygon key="paper" points={pts(wallQuad('back', 2.9, 5.8, 0, 2.7))} fill="#5a5247" />);
  out.push(<polygon key="sweep" points={pts([P(2.9, 0), P(5.8, 0), P(5.8, 1.15), P(2.9, 1.15)])} fill="#5a5247" />);
  out.push(<polygon key="sweepFade" points={pts([P(2.9, 0.85), P(5.8, 0.85), P(5.8, 1.15), P(2.9, 1.15)])} fill="rgba(0,0,0,0.14)" />);
  out.push(box('roll', 2.75, 0.02, 2.72, 3.2, 0.12, 0.12, mat.metal));
  // 左墙的海报（一个太阳、两行字）。
  out.push(<polygon key="poster" points={pts(wallQuad('left', 2.3, 3.2, 1.2, 2.4))} fill="#2a2520" stroke="#6f6557" strokeWidth={1.4} />);
  const pc = wallAt('left', 2.75, 1.98);
  out.push(<ellipse key="sun" cx={pc[0]} cy={pc[1]} rx={4.6} ry={5.6} fill="#d9a35f" />);
  out.push(seg('pt1', wallAt('left', 2.45, 1.52), wallAt('left', 3.05, 1.52), '#8a8377', 1.4));
  out.push(seg('pt2', wallAt('left', 2.55, 1.4), wallAt('left', 2.95, 1.4), '#5d574d', 1.4));
  // 后墙的钟。
  const ck = wallAt('back', 7.3, 2.45);
  out.push(<ellipse key="clock" cx={ck[0]} cy={ck[1]} rx={6.5} ry={7.5} fill="#efe9dd" stroke="#6f6557" strokeWidth={1.4} />);
  out.push(seg('h1', ck, [ck[0], ck[1] - 4.6], '#2a2520', 1.2));
  out.push(seg('h2', ck, [ck[0] + 3.6, ck[1] + 1.2], '#2a2520', 1.2));
  return <g>{out}</g>;
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

function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 没有对话在跑时的那一份。 */
const idleSignal: CrewSignal = { mood: 'idle', line: '待命', project: '', rendering: [] };

export function Pet() {
  const [signal, setSignal] = useState<CrewSignal>(idleSignal);
  const [, setTick] = useState(0);
  const still = prefersStill();
  const start = useRef(Date.now());

  useEffect(() => window.am?.onCrew?.((next) => setSignal(next ?? idleSignal)), []);

  const walkers = useRef<{ director: Walker; ops: Walker[] } | null>(null);
  if (!walkers.current) walkers.current = { director: newWalker(director.chair), ops: operators.map((o) => newWalker(o.seat)) };
  const mood = signal.mood;
  // 前三个在渲染的镜头各给一位摄影；导演在等渲染、却还没有镜头标成渲染中时，先开一台。
  const shooting = signal.rendering.length > 0 ? signal.rendering : mood === 'filming' ? [''] : [];
  useEffect(() => {
    const w = walkers.current!;
    retarget(w.director, director[directorSpot[mood]], still);
    w.ops.forEach((op, i) => retarget(op, i < shooting.length ? operators[i].camera : operators[i].seat, still));
    setTick((t) => t + 1);
  }, [mood, shooting.length, still]);

  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(() => {
      const w = walkers.current!;
      advance(w.director);
      w.ops.forEach(advance);
      setTick((t) => t + 1);
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [still]);

  const t = still ? 0 : Date.now() - start.current;
  const frame = Math.floor(t / 280);
  const w = walkers.current;
  const arrived = (walker: Walker) => walker.path.length === 0;
  const dirArrived = arrived(w.director);
  const filmingOps = w.ops.map((op, i) => i < shooting.length && arrived(op));
  const anyFilming = filmingOps.some(Boolean);
  const editing = mood === 'editing';
  const voicing = mood === 'voicing';
  const shell = useMemo(() => roomShell(), []);

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

  // 剪辑台与剪辑师：干活时打字，平时靠在椅背上伸懒腰。
  add(6.9, box('edesk', 6.1, 0.05, 0, 1.85, 0.65, 0.78, mat.walnut));
  add(7.0, box('ekbd', 6.55, 0.4, 0.78, 0.8, 0.22, 0.04, mat.dark));
  add(
    8.2,
    <g key="editor" data-who="editor" data-active={editing ? 'true' : 'false'}>
      {person('ed', 6.95, 1.2, toward.wall, editing ? 'type' : 'stretch', t, looks.editor)}
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
        {voicing ? person('va', 0.55, 5.2, 0.1, 'mic', t, looks.voice) : person('va', 0.6, 5.45, Math.PI / 4, 'script', t, looks.voice)}
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
    </g>,
  );
  add(
    13.5,
    <g key="plant">
      {box('ppot', 7.45, 5.45, 0, 0.35, 0.35, 0.38, mat.pot)}
      <ellipse cx={P(7.62, 5.62, 0.75)[0]} cy={P(7.62, 5.62, 0.75)[1]} rx={9} ry={11} fill={mat.plant[1]} />
      <ellipse cx={P(7.62, 5.62, 0.85)[0] - 2} cy={P(7.62, 5.62, 0.85)[1] - 2} rx={6} ry={7.5} fill={mat.plant[0]} />
    </g>,
  );

  // 人：导演与三位摄影，按站位排进去。
  const dPose: Pose = dirArrived ? directorPose[mood] : 'walk';
  add(
    w.director.x + w.director.y + 0.05,
    <g key="director" data-who="director" data-walking={dirArrived ? 'false' : 'true'}>
      {person('dir', w.director.x, w.director.y, w.director.a, dPose, t, looks.director)}
      {dirArrived && (mood === 'waiting' || mood === 'done') ? slateProp(w.director, mood === 'done' && frame % 4 < 2, t) : null}
      {dirArrived && mood === 'reading' ? scriptProp(w.director, t) : null}
      {dirArrived && mood === 'thinking' ? thoughtDots(w.director, frame) : null}
      {dirArrived && mood === 'failed' ? mark(w.director, '×', '#e39a8c') : null}
      {dirArrived && mood === 'stopped' ? mark(w.director, '‖', '#a9a294') : null}
    </g>,
  );
  w.ops.forEach((op, i) => {
    const moving = !arrived(op);
    const pose: Pose = moving ? 'walk' : filmingOps[i] ? 'operate' : 'sit';
    add(
      op.x + op.y + 0.04,
      <g key={`op${i}`} data-who={`op${i + 1}`} data-active={filmingOps[i] ? 'true' : 'false'} data-walking={moving ? 'true' : 'false'}>
        {person(`op${i}`, op.x, op.y, op.a, pose, t + i * 400, looks[`op${i + 1}`])}
      </g>,
    );
  });
  items.sort((a, b) => a.k - b.k);

  // 标签挂在脚下（头顶归导演的气泡）：开机的摄影写镜头号，干活的剪辑、配音写部门名。
  const tags: { key: string; text: string; title: string; at: Pt }[] = [];
  w.ops.forEach((op, i) => {
    if (!filmingOps[i] || !shooting[i]) return;
    const short = shooting[i].replace(/^scene-/, '');
    const text = i === 2 && shooting.length > 3 ? `${short}+${shooting.length - 3}` : short;
    tags.push({ key: `op${i + 1}`, text, title: shooting.slice(i, i === 2 ? undefined : i + 1).join('、'), at: P(op.x + 0.15, op.y + 0.15) });
  });
  if (editing) tags.push({ key: 'editor', text: '剪辑', title: '剪辑', at: P(7.3, 1.6) });
  if (voicing) tags.push({ key: 'voice', text: '配音', title: '配音', at: P(1.5, RY) });

  // 导演的气泡：夹在卡片里，尾巴指着导演的头。
  const bubble = useRef<HTMLDivElement>(null);
  const [bubbleWidth, setBubbleWidth] = useState(0);
  useLayoutEffect(() => setBubbleWidth(bubble.current?.offsetWidth ?? 0), [signal.line]);
  const seated = dirArrived && ['sit', 'think'].includes(dPose);
  const headAt = P(w.director.x, w.director.y, seated ? 1.45 : 1.95);
  const cardWidth = CW + inset * 2;
  const center = headAt[0] + inset;
  const bubbleLeft = Math.min(Math.max(center - bubbleWidth / 2, 6), cardWidth - 6 - bubbleWidth);
  const tail = Math.min(Math.max(center - bubbleLeft, 12), Math.max(12, bubbleWidth - 12));
  const bubbleTop = Math.max(4, headAt[1] + inset - 34 - (mood === 'thinking' && dirArrived ? 14 : 0));
  const filmingCount = shooting.filter(Boolean).length;

  return (
    <div className="pet" id="crew" data-mood={mood} data-walking={dirArrived ? 'false' : 'true'} role="status" aria-live="polite" aria-label={signal.line}>
      <div className="pet-card" onDoubleClick={() => window.am?.pet?.('focus')} title="双击回到客户端">
        <svg className="pet-room" viewBox={`0 0 ${CW} ${CH}`} width={CW} height={CH} aria-hidden="true">
          <defs>
            <radialGradient id="pet-glow">
              <stop offset="0" className="pet-glow-stop" stopOpacity="0.4" />
              <stop offset="1" className="pet-glow-stop" stopOpacity="0" />
            </radialGradient>
          </defs>
          {shell}
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
          {items.map((item) => item.el)}
        </svg>
        {tags.map((tag) => (
          <span key={tag.key} className="pet-tag" data-tag={tag.key} title={tag.title} style={{ left: tag.at[0] + inset, top: tag.at[1] + inset + 2 }}>
            {tag.text}
          </span>
        ))}
        <div ref={bubble} className="pet-bubble" style={{ left: bubbleLeft, top: bubbleTop, ['--tail' as string]: `${tail}px` }}>
          <span className="pet-line">{signal.line}</span>
        </div>
        <div className="pet-foot">
          <span className="pet-project">{signal.project || 'ArticleToMotion'}</span>
          <span className="pet-legend">{filmingCount > 0 ? `${filmingCount} 个镜头在拍` : ''}</span>
          <button className="pet-close" title="收起桌宠（菜单「窗口 → 场记桌宠」再打开）" onClick={() => window.am?.pet?.('hide')}>
            ×
          </button>
        </div>
      </div>
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
