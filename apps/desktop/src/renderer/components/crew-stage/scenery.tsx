import type { ReactElement } from 'react';
import { box, type Look, looks, type Material, mat, P, type Pt, pts, seg } from '../Pet';
import type { StageKind } from './pace';

// ---- 路、门、片场的位置（世界坐标，单位与桌宠的房间相同，约一米） ----
//
// 镜头跟着人走：人总在取景框的同一个位置，世界往回退。路有 D 那么长，人走到哪按进度算，
// 所以路边的树、路灯、路面的虚线往后退的快慢就是下载的快慢；快到头时片场的大门才进画面。

export const D = 12;
export const roadY = 1.0;
export const roadHalf = 0.38;
export const homeX = -1.6;
export const gateX = D + 0.1;
/** 片场的楼在大门后、路的远侧，朝路的那面有窗。路一直通到楼的尽头。 */
export const studio = { x: D + 0.45, y: -1.95, w: 1.9, d: 1.6, h: 1.55 };
export const roadEnd = studio.x + studio.w + 1.2;

const subs: Look = {
  coat: '#c9b48f',
  coatShade: '#9c8a6b',
  trousers: '#3e3832',
  shoe: '#201c18',
  hair: '#2a2018',
  skin: '#e4c4a2',
  skinShade: '#c49d7a',
  hat: 'none',
  hatColor: '#000',
};
const porter: Look = { ...subs, coat: '#7d6a52', coatShade: '#5c4e3d', hat: 'cap', hatColor: '#d9a35f' };

export const lookOf: Record<StageKind, () => Look> = {
  render: () => looks.op1,
  media: () => looks.editor,
  voice: () => looks.voice,
  align: () => subs,
  carry: () => porter,
};

const crate: Material = ['#b9864a', '#94693a', '#755330'];

/** 路边的东西：树在路两边错开种，路灯在近的一边。世界坐标。 */
export const farTrees = Array.from({ length: 10 }, (_, i) => ({
  x: 0.4 + i * 1.3,
  y: -0.05 - (i % 2) * 0.3,
  s: 0.85 + (i % 3) * 0.12,
}));
export const nearTrees = Array.from({ length: 8 }, (_, i) => ({
  x: 0.9 + i * 1.75,
  y: 2.45 + (i % 2) * 0.3,
  s: 1 + (i % 2) * 0.15,
}));
export const lamps = Array.from({ length: 5 }, (_, i) => ({ x: 2.3 + i * 2.4, y: 1.72 }));

/** 抱在手里（或放在地上）的器材，以 c 为中心画。 */
export function gear(kind: StageKind, c: Pt, key: string): ReactElement {
  const [x, y] = c;
  switch (kind) {
    case 'render':
      return (
        <g key={key}>
          <rect
            x={x - 6}
            y={y - 7}
            width={11}
            height={7}
            rx={1.2}
            fill="#2a2520"
            stroke="rgba(0,0,0,0.4)"
            strokeWidth={0.5}
          />
          <rect x={x - 3} y={y - 9} width={5} height={2.2} rx={0.6} fill="#4a4239" />
          <circle cx={x - 5.8} cy={y - 3.6} r={2.4} fill="#4a4239" />
          <circle cx={x - 5.8} cy={y - 3.6} r={1.2} fill="#8a7f70" />
        </g>
      );
    case 'media':
      return (
        <g key={key}>
          <polygon
            points={pts([
              [x - 6, y - 2],
              [x + 4, y - 4],
              [x + 6, y - 2],
              [x - 4, y],
            ])}
            fill="#5a5148"
          />
          <polygon
            points={pts([
              [x - 6, y - 2],
              [x - 6, y - 9],
              [x + 4, y - 11],
              [x + 4, y - 4],
            ])}
            fill="#2a2520"
          />
          <polygon
            points={pts([
              [x - 5, y - 3],
              [x - 5, y - 8.3],
              [x + 3, y - 10],
              [x + 3, y - 4.7],
            ])}
            fill="#d9a35f"
            opacity={0.55}
          />
        </g>
      );
    case 'voice':
      return (
        <g key={key}>
          {seg(`${key}h`, [x, y], [x + 1.5, y - 6], '#3e3832', 2)}
          <ellipse cx={x + 2} cy={y - 8} rx={2.6} ry={3.2} fill="#6f6557" />
          <ellipse cx={x + 1.6} cy={y - 8.6} rx={1.4} ry={1.8} fill="#8a7f70" />
        </g>
      );
    case 'align':
      return (
        <g key={key}>
          <rect
            x={x - 4.5}
            y={y - 9}
            width={8}
            height={10}
            rx={0.8}
            fill="#efe9dd"
            stroke="#94693a"
            strokeWidth={0.8}
          />
          <rect x={x - 2} y={y - 10} width={3} height={1.8} rx={0.4} fill="#94693a" />
          {[0, 1, 2].map((i) => seg(`${key}l${i}`, [x - 3, y - 6 + i * 2.2], [x + 2, y - 6 + i * 2.2], '#8a8377', 0.8))}
        </g>
      );
    default:
      return (
        <rect
          key={key}
          x={x - 6}
          y={y - 8}
          width={12}
          height={9}
          rx={1}
          fill={crate[1]}
          stroke="rgba(0,0,0,0.3)"
          strokeWidth={0.5}
        />
      );
  }
}

/** 一棵块面的小树：树干加两层树冠。 */
export function tree(key: string, x: number, y: number, s = 1): ReactElement {
  const base = P(x, y, 0);
  const top = P(x, y, 0.55 * s);
  return (
    <g key={key}>
      <ellipse cx={base[0]} cy={base[1]} rx={6 * s} ry={3 * s} className="pet-shadow" />
      {seg(`${key}t`, base, top, '#4a3a2a', 2.2)}
      <ellipse cx={top[0]} cy={top[1] - 5 * s} rx={8 * s} ry={9 * s} fill={mat.plant[1]} />
      <ellipse cx={top[0] - 2 * s} cy={top[1] - 7 * s} rx={5 * s} ry={5.5 * s} fill={mat.plant[0]} />
    </g>
  );
}

/** 路灯：一根杆、一个灯头，地上一圈暖光。 */
export function lamp(key: string, x: number, y: number): ReactElement {
  const base = P(x, y, 0);
  const top = P(x, y, 1.45);
  return (
    <g key={key}>
      <ellipse cx={base[0]} cy={base[1]} rx={14} ry={6} className="stage-lamplight" />
      {seg(`${key}p`, base, top, '#4a4239', 1.6)}
      <rect x={top[0] - 2.5} y={top[1] - 2} width={5} height={3} rx={1} fill="#f4e7cf" />
    </g>
  );
}

/** 出发的家：一个小块房子加斜屋顶，门口一盏灯。x 是房子在镜头里的位置。 */
export function home(x: number, lit: boolean): ReactElement {
  const hy = -0.15;
  const roof = [P(x, hy, 0.75), P(x + 0.9, hy, 0.75), P(x + 0.9, hy + 0.45, 1.15), P(x, hy + 0.45, 1.15)];
  const roof2 = [P(x, hy + 0.9, 0.75), P(x + 0.9, hy + 0.9, 0.75), P(x + 0.9, hy + 0.45, 1.15), P(x, hy + 0.45, 1.15)];
  const door = [
    P(x + 0.9, hy + 0.5, 0),
    P(x + 0.9, hy + 0.75, 0),
    P(x + 0.9, hy + 0.75, 0.5),
    P(x + 0.9, hy + 0.5, 0.5),
  ];
  const light = P(x + 0.9, hy + 0.42, 0.58);
  return (
    <g key="home">
      {box('house', x, hy, 0, 0.9, 0.9, 0.75, mat.canvas)}
      <polygon points={pts(roof)} fill="#4a3a2a" />
      <polygon points={pts(roof2)} fill="#5c4632" />
      <polygon points={pts(door)} fill={lit ? '#e9cf9f' : '#2a2520'} />
      {lit && <circle cx={light[0]} cy={light[1]} r={1.8} fill="#f4e7cf" />}
    </g>
  );
}

/** 片场的楼：朝我们的两面各两扇窗；人到了全亮。x 是楼在镜头里的位置。 */
export function studioBlock(x: number, lit: boolean): ReactElement {
  const { y, w, d, h } = studio;
  const win = (k: string, quad: Pt[]) => (
    <polygon
      key={k}
      points={pts(quad)}
      fill={lit ? '#e9cf9f' : '#1a1714'}
      className={lit ? 'stage-window' : undefined}
    />
  );
  const front = (a: number, b: number) => [
    P(x + a, y + d, 0.55),
    P(x + b, y + d, 0.55),
    P(x + b, y + d, 1.05),
    P(x + a, y + d, 1.05),
  ];
  const side = (a: number, b: number) => [
    P(x + w, y + a, 0.55),
    P(x + w, y + b, 0.55),
    P(x + w, y + b, 1.05),
    P(x + w, y + a, 1.05),
  ];
  const sign = P(x + w * 0.35, y + d * 0.5, h + 0.3);
  const door = [
    P(x + w * 0.62, y + d, 0),
    P(x + w * 0.82, y + d, 0),
    P(x + w * 0.82, y + d, 0.85),
    P(x + w * 0.62, y + d, 0.85),
  ];
  return (
    <g key="studio">
      {box('sb', x, y, 0, w, d, h, mat.walnut)}
      {box('sroof', x - 0.05, y - 0.05, h, w + 0.1, d + 0.1, 0.08, mat.roof)}
      {win('w1', front(0.15, 0.5))}
      {win('w2', front(0.65, 1.0))}
      <polygon points={pts(door)} fill={lit ? '#f4e7cf' : '#2a2520'} className={lit ? 'stage-window' : undefined} />
      {win('w3', side(0.25, 0.7))}
      {win('w4', side(0.9, 1.35))}
      {/* 屋顶上一块场记板做招牌。 */}
      <rect x={sign[0] - 10} y={sign[1] - 5} width={20} height={10} rx={1} fill="#2a2520" />
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={`clap${i}`}
          x={sign[0] - 10 + i * 5.2}
          y={sign[1] - 8.5}
          width={3}
          height={3.5}
          fill={i % 2 ? '#2a2520' : '#efe9dd'}
        />
      ))}
    </g>
  );
}

/** 片场大门：两根柱子、一根横梁；人到了横梁上的灯串亮。x 是门在镜头里的位置。 */
export function gatePart(which: 'far' | 'near' | 'beam', x: number, lit: boolean, t: number): ReactElement {
  const ya = roadY - roadHalf - 0.14;
  const yb = roadY + roadHalf + 0.14;
  const top = 2.0;
  if (which === 'far') return <g key="gfar">{box('gpf', x - 0.07, ya - 0.07, 0, 0.14, 0.14, top, mat.dark)}</g>;
  if (which === 'near') return <g key="gnear">{box('gpn', x - 0.07, yb - 0.07, 0, 0.14, 0.14, top, mat.dark)}</g>;
  const bulbs: ReactElement[] = [];
  for (let i = 0; i <= 7; i++) {
    const q = P(x, ya + ((yb - ya) * i) / 7, top - 0.1);
    const on = lit && (Math.floor(t / 300) + i) % 3 !== 0;
    bulbs.push(<circle key={`b${i}`} cx={q[0]} cy={q[1] + 2} r={on ? 1.7 : 1.1} fill={on ? '#f4e7cf' : '#4a3f33'} />);
  }
  return (
    <g key="gbeam">
      {box('gb', x - 0.09, ya - 0.12, top, 0.18, yb - ya + 0.24, 0.16, mat.dark)}
      {bulbs}
    </g>
  );
}
