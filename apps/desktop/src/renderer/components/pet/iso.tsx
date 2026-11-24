import type { ReactElement } from 'react';

// ---- 投影 ----

/** 房间：x 沿后墙向右下、y 沿左墙向左下，单位约等于一米；墙高。 */
export const RX = 8;
export const RY = 6;
export const WALL = 3;
/** 一个单位多少像素、画布大小、原点。 */
export const U = 32;
export const CW = 400;
export const CH = 326;
export const OX = CW / 2 - ((RX - RY) / 2) * 0.866 * U;
export const OY = 99;

export type Pt = [number, number];
export const P = (x: number, y: number, z = 0): Pt => [OX + (x - y) * 0.866 * U, OY + (x + y) * 0.5 * U - z * U];
export const pts = (list: Pt[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

/** 动画节拍：每 50 毫秒走一步、动一下。走路速度（单位每步）。 */
export const tickMs = 50;
export const speed = 0.11;

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
export const roomDefaults = {
  slab: '#3a3128',
  'slab-left': '#2a231c',
  'slab-right': '#211b16',
  'wall-left': '#221d18',
  'wall-back': '#2c261f',
  cap: '#4a3f33',
  backdrop: '#5a5247',
};
export const room: Record<keyof typeof roomDefaults, string> = { ...roomDefaults };
export const matDefaults: Record<string, Material> = { ...mat };

/** 等距的箱子：顶面、+y 面（朝左下）、+x 面（朝右下）三种明暗。 */
export function box(
  key: string,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: number,
  m: Material,
  edge = 'rgba(0,0,0,0.25)',
): ReactElement {
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

export const seg = (
  key: string,
  a: Pt,
  b: Pt,
  stroke: string,
  width = 1,
  extra: Record<string, string | number> = {},
) => (
  <line
    key={key}
    x1={a[0]}
    y1={a[1]}
    x2={b[0]}
    y2={b[1]}
    stroke={stroke}
    strokeWidth={width}
    strokeLinecap="round"
    {...extra}
  />
);

/** 墙上的一块平面（x=0 的左墙或 y=0 的后墙）与墙上某一点。 */
export function wallQuad(on: 'left' | 'back', a: number, b: number, z0: number, z1: number): Pt[] {
  return on === 'left'
    ? [P(0.02, a, z0), P(0.02, b, z0), P(0.02, b, z1), P(0.02, a, z1)]
    : [P(a, 0.02, z0), P(b, 0.02, z0), P(b, 0.02, z1), P(a, 0.02, z1)];
}

export const wallAt = (on: 'left' | 'back', s: number, z: number): Pt =>
  on === 'left' ? P(0.03, s, z) : P(s, 0.03, z);

export function convexHull(points: Pt[]): Pt[] {
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

export function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
