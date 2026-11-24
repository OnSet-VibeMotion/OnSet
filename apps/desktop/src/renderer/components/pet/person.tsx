import type { ReactElement } from 'react';
import type { SkinView } from '../../types';
import { convexHull, type Material, mat, matDefaults, P, type Pt, pts, room, roomDefaults, seg, U } from './iso';
import { body, type L3, type Pose } from './poses';

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
  director: {
    coat: '#e3dbcc',
    coatShade: '#b3a996',
    trousers: '#4a4239',
    shoe: '#2a2520',
    hair: '#5a4330',
    ...skin,
    hat: 'beret',
    hatColor: '#d9a35f',
  },
  op1: {
    coat: '#7d7262',
    coatShade: '#5c5348',
    trousers: '#34302b',
    shoe: '#201c18',
    hair: '#3a2c20',
    ...skin,
    hat: 'cap',
    hatColor: '#3a342d',
  },
  op2: {
    coat: '#a59a88',
    coatShade: '#7d7363',
    trousers: '#3f3a33',
    shoe: '#201c18',
    hair: '#2a2018',
    ...skin,
    hat: 'cap',
    hatColor: '#6b5038',
  },
  op3: {
    coat: '#5f564c',
    coatShade: '#463f37',
    trousers: '#2a2520',
    shoe: '#1a1714',
    hair: '#6b4a30',
    skin: '#c9a07c',
    skinShade: '#a8815f',
    hat: 'cap',
    hatColor: '#2a2520',
  },
  editor: {
    coat: '#3e3832',
    coatShade: '#2c2823',
    trousers: '#2a2520',
    shoe: '#1a1714',
    hair: '#2d241c',
    ...skin,
    hat: 'phones',
    hatColor: '#d9a35f',
  },
  voice: {
    coat: '#cfc6b6',
    coatShade: '#a1978a',
    trousers: '#4a4239',
    shoe: '#2a2520',
    hair: '#7a5a3c',
    ...skin,
    hat: 'phones',
    hatColor: '#6f6557',
  },
};

const looksDefaults: Record<string, Look> = Object.fromEntries(Object.entries(looks).map(([k, v]) => [k, { ...v }]));

/**
 * 按皮肤换工作室的颜色：先回到默认，再盖上皮肤写了的（材质、人的衣着、房间）。皮肤的值后端已校验过，只有颜色。
 * mat / looks / room 是模块里的共用表，画的时候现读，所以换完重画一次就生效。
 */
export function applyPetSkin(sk: SkinView | null): void {
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
export function petFilter(sk: SkinView | null): string | undefined {
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
          <polyline
            points={pts([proj(hip), proj(knee), f])}
            fill="none"
            stroke={look.trousers}
            strokeWidth={0.13 * U}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={dark ? 0.82 : 1}
          />
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
          <polyline
            points={pts([proj(sh), proj(el), h])}
            fill="none"
            stroke={shaded(el) ? look.coatShade : look.coat}
            strokeWidth={0.1 * U}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx={h[0]} cy={h[1]} r={0.055 * U} fill={look.skin} />
        </g>
      ),
    };
  };
  // 躯干：肩、髋前后各一点的凸包，任何角度看都是一块有厚度的身子；按左右分亮暗两面。
  const torso: L3[] = [];
  for (const j of [b.shL, b.shR, b.hipL, b.hipR]) {
    torso.push([j[0] + 0.11, j[1] * 1.15, j[2]], [j[0] - 0.11, j[1] * 1.15, j[2]]);
  }
  const hull = convexHull(torso.map(proj));
  const midX = hull.reduce((s, p) => s + p[0], 0) / hull.length;
  const centre = depth([(b.shL[0] + b.hipL[0]) / 2, 0, 1]);
  const parts = [
    leg('lL', b.hipL, b.kneeL, b.footL),
    leg('lR', b.hipR, b.kneeR, b.footR),
    arm('aL', b.shL, b.elL, b.haL),
    arm('aR', b.shR, b.elR, b.haR),
  ];
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
    for (const dx of [-spread, spread]) {
      eyes.push(<circle key={`eye${dx}`} cx={cx + dx} cy={head[1] + r * 0.12} r={0.75} fill="#2a2520" />);
    }
  }
  const hat: ReactElement[] = [];
  // 帽檐垫在头下面：侧身时伸出头外的那段看得见，正对我们时被脸挡住，不会在脸上划一道。
  const underHead: ReactElement[] = [];
  if (look.hat === 'beret') {
    hat.push(
      <ellipse
        key="beret"
        cx={head[0] - 0.8}
        cy={head[1] - r * 0.72}
        rx={r * 1.18}
        ry={r * 0.46}
        fill={look.hatColor}
      />,
    );
    hat.push(
      <ellipse
        key="beretTop"
        cx={head[0] - 0.4}
        cy={head[1] - r * 0.86}
        rx={r * 0.9}
        ry={r * 0.3}
        fill="#e8ba78"
        opacity={0.7}
      />,
    );
    hat.push(<circle key="nub" cx={head[0] + 0.4} cy={head[1] - r * 1.18} r={1.1} fill={look.hatColor} />);
  } else if (look.hat === 'cap') {
    const brim = proj([b.head[0] + 0.22, 0, b.head[2] + 0.05]);
    hat.push(
      <path
        key="cap"
        d={`M${head[0] - r} ${head[1] - r * 0.15} A${r} ${r} 0 0 1 ${head[0] + r} ${head[1] - r * 0.15} Z`}
        fill={look.hatColor}
      />,
    );
    underHead.push(seg('brim', [head[0], head[1] - r * 0.2], brim, look.hatColor, 2.2));
  } else if (look.hat === 'phones') {
    const earL = proj([b.head[0], -0.16, b.head[2]]);
    const earR = proj([b.head[0], 0.16, b.head[2]]);
    hat.push(
      <path
        key="band"
        d={`M${earL[0]} ${earL[1]} Q${head[0]} ${head[1] - r * 2.2} ${earR[0]} ${earR[1]}`}
        fill="none"
        stroke={look.hatColor}
        strokeWidth={1.6}
      />,
    );
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
      <rect
        x={midX + 0.6}
        y={Math.min(...hull.map((p) => p[1])) - 1}
        width={40}
        height={60}
        fill={look.coatShade}
        clipPath={`url(#${clip})`}
      />
      {seg(
        'neck',
        proj([(b.shL[0] + b.shR[0]) / 2, 0, (b.shL[2] + b.shR[2]) / 2 + 0.02]),
        neck,
        look.skinShade,
        0.08 * U,
      )}
      {front.map((p) => p.el)}
      {underHead}
      <circle cx={head[0]} cy={head[1]} r={r} fill={look.skin} />
      <path
        d={`M${head[0] + r * 0.25} ${head[1] - r * 0.97} A${r} ${r} 0 0 1 ${head[0] + r * 0.25} ${head[1] + r * 0.97} A${r * 1.2} ${r * 1.2} 0 0 0 ${head[0] + r * 0.25} ${head[1] - r * 0.97} Z`}
        fill={look.skinShade}
      />
      {eyes}
      <path d={hairPath} fill={look.hair} />
      {hat}
    </g>
  );
}
