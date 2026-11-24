import type { ReactElement } from 'react';
import type { Prop, Walker } from './crewState';
import { P, type Pt, pts, seg, U } from './iso';
import { jointAt, type Pose, sipping } from './poses';

// ---- 制作人手上的东西 ----

/** 人自己坐标里的一点投影到画布。 */
function local(w: Walker, f: number, r: number, z: number): Pt {
  return P(w.x + f * Math.cos(w.a) - r * Math.sin(w.a), w.y + f * Math.sin(w.a) + r * Math.cos(w.a), z);
}

/** 场记板：举在胸前；收工时合上。 */
export function slateProp(w: Walker, shut: boolean, t: number): ReactElement {
  const z = 1.0 + Math.sin(t / 300) * 0.03;
  const o = 0.17;
  const board = [
    local(w, 0.32, o - 0.2, z),
    local(w, 0.32, o + 0.2, z),
    local(w, 0.32, o + 0.2, z + 0.28),
    local(w, 0.32, o - 0.2, z + 0.28),
  ];
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
export function scriptProp(w: Walker, t: number): ReactElement {
  const z = 1.08 + Math.sin(t / 600) * 0.02;
  const pageL = [
    local(w, 0.32, -0.16, z),
    local(w, 0.36, 0, z + 0.02),
    local(w, 0.4, 0, z + 0.23),
    local(w, 0.36, -0.16, z + 0.21),
  ];
  const pageR = [
    local(w, 0.36, 0, z + 0.02),
    local(w, 0.32, 0.16, z),
    local(w, 0.36, 0.16, z + 0.21),
    local(w, 0.4, 0, z + 0.23),
  ];
  return (
    <g>
      <polygon points={pts(pageL)} fill="#efe9dd" />
      <polygon points={pts(pageR)} fill="#cfc6b6" />
    </g>
  );
}

/** 想事情：头顶一串小圆点，一个一个冒出来。 */
export function thoughtDots(w: Walker, frame: number): ReactElement {
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

export function mark(w: Walker, text: string, color: string): ReactElement {
  const at = P(w.x, w.y, 2.0);
  return (
    <text x={at[0] + 9} y={at[1]} fill={color} fontSize={12} fontWeight={700} fontFamily="var(--mono)">
      {text}
    </text>
  );
}

// ---- 闲着时手上的东西 ----

/** 闲着时手上或头上的小东西：杯子、手机、打盹的 z、哼歌的音符。 */
export function idleProp(
  prop: Prop | undefined,
  x: number,
  y: number,
  a: number,
  pose: Pose,
  t: number,
): ReactElement | null {
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
        <rect
          x={cx - 1.7}
          y={cy - 2.5}
          width={3.4}
          height={4.8}
          fill="#c2bbae"
          opacity={0.75 + Math.sin(t / 400) * 0.15}
        />
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
export function steam(at: Pt, t: number): ReactElement {
  return (
    <g>
      {[0, 1].map((i) => {
        const phase = (((t / 1600 + i * 0.5) % 1) + 1) % 1;
        const x = at[0] + (i - 0.5) * 2.4;
        const y = at[1] - phase * 9;
        const s = Math.sin(phase * Math.PI * 2 + i) * 1.6;
        return (
          <path
            key={i}
            d={`M${x} ${y} q${s} -2.5 0 -5 q${-s} -2.5 0 -5`}
            fill="none"
            stroke="#efe9dd"
            strokeWidth={0.7}
            strokeLinecap="round"
            opacity={0.45 * Math.sin(phase * Math.PI)}
          />
        );
      })}
    </g>
  );
}

/** 选中的人脚下一圈光环，慢慢呼吸。 */
export function selectionRing([x, y]: Pt, t: number): ReactElement {
  const k = 1 + Math.sin(t / 420) * 0.06;
  return (
    <g pointerEvents="none">
      <ellipse
        cx={x}
        cy={y}
        rx={0.55 * U * k}
        ry={0.28 * U * k}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.6}
        opacity={0.9}
      />
      <ellipse cx={x} cy={y} rx={0.42 * U} ry={0.21 * U} fill="var(--accent)" opacity={0.18} />
    </g>
  );
}

/** 选中的人头顶一个上下浮动的小箭头。 */
export function selectionMarker([x, y]: Pt, t: number): ReactElement {
  const dy = Math.sin(t / 380) * 2;
  return (
    <path
      d={`M${x - 5} ${y - 6 + dy} L${x + 5} ${y - 6 + dy} L${x} ${y + 1 + dy} Z`}
      fill="var(--accent)"
      stroke="rgba(0,0,0,0.35)"
      strokeWidth={0.6}
      pointerEvents="none"
    />
  );
}
