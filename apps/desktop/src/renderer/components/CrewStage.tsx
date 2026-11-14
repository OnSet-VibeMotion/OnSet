import { useEffect, useRef, useState, type ReactElement } from 'react';
import { P, box, jointAt, looks, mat, person, prefersStill, pts, seg, type Look, type Material, type Pose, type Pt } from './Pet';

/*
 * 安装页每个组的小景：下载一个组，就是这个组的人赶来片场的路上。与场记桌宠同一套等距块面的微缩模型
 * （同一个 person、box、投影）。
 *
 * 镜头跟着人走（跟拍）：人抱着自己的器材在路中间赶路，路边的树、路灯、路面虚线往后退——
 *   摄影抱着摄影机、剪辑师抱着笔记本、配音演员拿着话筒、字幕员夹着稿板、其余（风格库、节拍环境……）的搬运工抱着箱子。
 *
 *   走了多远——下载进度：整条路从家门口到片场大门，人在路上的位置就是进度，走过的路面亮起来；快到头时大门和片场才进画面。
 *   走多快——下载速度（最近几秒进度涨得多快）：路边的东西往后退得多快、腿迈得多快都跟它走；快了跑起来、脚下扬起尘土；
 *           好几秒没涨就停下来，头上冒一个「…」。
 *   排队中——人在家门口等着出发；还没请——家门口空着、灯也没开。
 *   就位——穿过大门，门上的灯串亮起来、片场灯全亮，人欢呼一下再抱着胳膊站好。
 *   暂停——停在半路；没成功——在半路垂头丧气，器材放在地上。
 */

export type StageKind = 'render' | 'media' | 'voice' | 'align' | 'carry';
export type StageState = 'ready' | 'missing' | 'waiting' | 'working' | 'failed' | 'paused';

// ---- 路、门、片场的位置（世界坐标，单位与桌宠的房间相同，约一米） ----
//
// 镜头跟着人走：人总在取景框的同一个位置，世界往回退。路有 D 那么长，人走到哪按进度算，
// 所以路边的树、路灯、路面的虚线往后退的快慢就是下载的快慢；快到头时片场的大门才进画面。

const D = 12;
const roadY = 1.0;
const roadHalf = 0.38;
const homeX = -1.6;
const gateX = D + 0.1;
/** 片场的楼在大门后、路的远侧，朝路的那面有窗。路一直通到楼的尽头。 */
const studio = { x: D + 0.45, y: -1.95, w: 1.9, d: 1.6, h: 1.55 };
const roadEnd = studio.x + studio.w + 1.2;

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

const lookOf: Record<StageKind, () => Look> = {
  render: () => looks.op1,
  media: () => looks.editor,
  voice: () => looks.voice,
  align: () => subs,
  carry: () => porter,
};

const crate: Material = ['#b9864a', '#94693a', '#755330'];

/** 抱在手里（或放在地上）的器材，以 c 为中心画。 */
function gear(kind: StageKind, c: Pt, key: string): ReactElement {
  const [x, y] = c;
  switch (kind) {
    case 'render':
      return (
        <g key={key}>
          <rect x={x - 6} y={y - 7} width={11} height={7} rx={1.2} fill="#2a2520" stroke="rgba(0,0,0,0.4)" strokeWidth={0.5} />
          <rect x={x - 3} y={y - 9} width={5} height={2.2} rx={0.6} fill="#4a4239" />
          <circle cx={x - 5.8} cy={y - 3.6} r={2.4} fill="#4a4239" />
          <circle cx={x - 5.8} cy={y - 3.6} r={1.2} fill="#8a7f70" />
        </g>
      );
    case 'media':
      return (
        <g key={key}>
          <polygon points={pts([[x - 6, y - 2], [x + 4, y - 4], [x + 6, y - 2], [x - 4, y]])} fill="#5a5148" />
          <polygon points={pts([[x - 6, y - 2], [x - 6, y - 9], [x + 4, y - 11], [x + 4, y - 4]])} fill="#2a2520" />
          <polygon points={pts([[x - 5, y - 3], [x - 5, y - 8.3], [x + 3, y - 10], [x + 3, y - 4.7]])} fill="#d9a35f" opacity={0.55} />
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
          <rect x={x - 4.5} y={y - 9} width={8} height={10} rx={0.8} fill="#efe9dd" stroke="#94693a" strokeWidth={0.8} />
          <rect x={x - 2} y={y - 10} width={3} height={1.8} rx={0.4} fill="#94693a" />
          {[0, 1, 2].map((i) => seg(`${key}l${i}`, [x - 3, y - 6 + i * 2.2], [x + 2, y - 6 + i * 2.2], '#8a8377', 0.8))}
        </g>
      );
    default:
      return <rect key={key} x={x - 6} y={y - 8} width={12} height={9} rx={1} fill={crate[1]} stroke="rgba(0,0,0,0.3)" strokeWidth={0.5} />;
  }
}

/** 一棵块面的小树：树干加两层树冠。 */
function tree(key: string, x: number, y: number, s = 1): ReactElement {
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
function lamp(key: string, x: number, y: number): ReactElement {
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
function home(x: number, lit: boolean): ReactElement {
  const hy = -0.15;
  const roof = [P(x, hy, 0.75), P(x + 0.9, hy, 0.75), P(x + 0.9, hy + 0.45, 1.15), P(x, hy + 0.45, 1.15)];
  const roof2 = [P(x, hy + 0.9, 0.75), P(x + 0.9, hy + 0.9, 0.75), P(x + 0.9, hy + 0.45, 1.15), P(x, hy + 0.45, 1.15)];
  const door = [P(x + 0.9, hy + 0.5, 0), P(x + 0.9, hy + 0.75, 0), P(x + 0.9, hy + 0.75, 0.5), P(x + 0.9, hy + 0.5, 0.5)];
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
function studioBlock(x: number, lit: boolean): ReactElement {
  const { y, w, d, h } = studio;
  const win = (k: string, quad: Pt[]) => <polygon key={k} points={pts(quad)} fill={lit ? '#e9cf9f' : '#1a1714'} className={lit ? 'stage-window' : undefined} />;
  const front = (a: number, b: number) => [P(x + a, y + d, 0.55), P(x + b, y + d, 0.55), P(x + b, y + d, 1.05), P(x + a, y + d, 1.05)];
  const side = (a: number, b: number) => [P(x + w, y + a, 0.55), P(x + w, y + b, 0.55), P(x + w, y + b, 1.05), P(x + w, y + a, 1.05)];
  const sign = P(x + w * 0.35, y + d * 0.5, h + 0.3);
  const door = [P(x + w * 0.62, y + d, 0), P(x + w * 0.82, y + d, 0), P(x + w * 0.82, y + d, 0.85), P(x + w * 0.62, y + d, 0.85)];
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
        <rect key={`clap${i}`} x={sign[0] - 10 + i * 5.2} y={sign[1] - 8.5} width={3} height={3.5} fill={i % 2 ? '#2a2520' : '#efe9dd'} />
      ))}
    </g>
  );
}

/** 片场大门：两根柱子、一根横梁；人到了横梁上的灯串亮。x 是门在镜头里的位置。 */
function gatePart(which: 'far' | 'near' | 'beam', x: number, lit: boolean, t: number): ReactElement {
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

// ---- 速度 ----

/**
 * 赶路的速度。rate 是动画用的快慢（大约「每秒涨几个百分点」那一档：0.3 以下慢慢走，1.5 以上跑），
 * 没有样本时为 null；stalled 是好一会儿没有动静；bytesRate 是按字节量到的下载速度（字节/秒），
 * creep 为真时这一步没有百分比（只知道下了多少字节），人的位置不按速度往前推。
 */
export interface Pace {
  rate: number | null;
  stalled: boolean;
  bytesRate?: number | null;
  creep?: boolean;
}

/** 按字节的下载速度换成动画的快慢：0.2 MB/s 以下慢慢走，1–2 MB/s 快步，2 MB/s 以上跑。 */
function bytesToRate(perSecond: number): number {
  const mb = perSecond / 1_048_576;
  return mb < 0.2 ? mb * 1.5 : Math.min(3, 0.3 + mb * 0.6);
}

/**
 * 按进度（百分比或字节数）的变化算速度：只看最近 8 秒。quiet 是后端说的「多少秒没有动静」，
 * 有它时 15 秒没动静算停住；没有时（演示页）按本地看到的最后一次变化：百分比 4 秒、字节 15 秒。
 * active 为假时清空。
 */
export function usePace(value: number, active: boolean, unit: 'percent' | 'bytes' = 'percent', quiet?: number): Pace {
  const samples = useRef<{ at: number; v: number; unit: string }[]>([]);
  const [, setTick] = useState(0);
  // 停住要靠时间流逝才判断得出来：在路上时每秒看一次。
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active) {
    if (samples.current.length) samples.current = [];
    return { rate: null, stalled: false };
  }
  // 换了一种量法（上一步有百分比、这一步只有字节）就重新量。
  if (samples.current.length && samples.current[0].unit !== unit) samples.current = [];
  const list = samples.current;
  const t = performance.now();
  if (list.length === 0 || list[list.length - 1].v !== value) list.push({ at: t, v: value, unit });
  while (list.length > 2 && t - list[1].at > 8000) list.shift();
  const last = list[list.length - 1];
  const stalled = quiet !== undefined ? quiet >= 15 : t - last.at > (unit === 'bytes' ? 15000 : 4000);
  const creep = unit === 'bytes';
  if (list.length < 2) return { rate: null, stalled, creep, bytesRate: null };
  const first = list[0];
  const span = (last.at - first.at) / 1000;
  if (span <= 0) return { rate: null, stalled, creep, bytesRate: null };
  const perSecond = (last.v - first.v) / span;
  if (unit === 'bytes') return { rate: bytesToRate(perSecond), stalled, creep, bytesRate: perSecond };
  return { rate: perSecond, stalled, creep };
}

/** 给人看的速度：接在「在路上」后面。 */
export function paceWord(pace: Pace): string {
  if (pace.stalled) return '等网络';
  if (pace.rate === null) return '';
  if (pace.rate < 0.3) return '慢慢走';
  if (pace.rate < 1.5) return '快步赶路';
  return '一路小跑';
}

// ---- 小景 ----

/** 取景框：人站在 (0, roadY)，框住他身前多一点、身后少一点。 */
const viewBox = (() => {
  const c = P(0, roadY, 0.8);
  const w = 210;
  const h = 124;
  return `${c[0] - w * 0.45} ${c[1] - h * 0.52} ${w} ${h}`;
})();

const still = () => typeof window !== 'undefined' && prefersStill();

/** 一个共用的钟：每 50 毫秒走一下（与桌宠同一个节拍）；偏好减少动态时停住。 */
function useClock(): number {
  const [t, setT] = useState(() => performance.now());
  useEffect(() => {
    if (still()) return;
    const id = window.setInterval(() => setT(performance.now()), 50);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

/** 路边的东西：树在路两边错开种，路灯在近的一边。世界坐标。 */
const farTrees = Array.from({ length: 10 }, (_, i) => ({ x: 0.4 + i * 1.3, y: -0.05 - (i % 2) * 0.3, s: 0.85 + (i % 3) * 0.12 }));
const nearTrees = Array.from({ length: 8 }, (_, i) => ({ x: 0.9 + i * 1.75, y: 2.45 + (i % 2) * 0.3, s: 1 + (i % 2) * 0.15 }));
const lamps = Array.from({ length: 5 }, (_, i) => ({ x: 2.3 + i * 2.4, y: 1.72 }));

let stages = 0;

/**
 * percent：这个组的下载进度（0–100），决定人在路上走到了哪；pace：下载速度，决定人迈步的快慢。
 * 不给 pace 时自己按 percent 的变化算。
 */
export function CrewStage(props: { kind: StageKind; state: StageState; percent?: number; pace?: Pace }) {
  const t = useClock();
  // 人身上的 clipPath 按 key 起 id：同一页上有好几个小景，不分开的话暗面会裁到别人身上。
  const [id] = useState(() => `stage${++stages}-`);
  const own = usePace(props.percent ?? 0, props.state === 'working' && !props.pace);
  const pace = props.pace ?? own;
  const { kind, state } = props;

  // 刚就位：欢呼 1.6 秒再站好。第一次画出来就已经是就位的不欢呼。
  const last = useRef(state);
  const cheerUntil = useRef(0);
  if (last.current !== state) {
    if (state === 'ready') cheerUntil.current = performance.now() + 1600;
    last.current = state;
  }
  const cheering = state === 'ready' && t < cheerUntil.current;

  const working = state === 'working';
  const stopped = working && pace.stalled;
  const running = working && !stopped && (pace.rate ?? 0) >= 1.5;

  // 走到哪：进度每秒才报一次，中间按当前速度往前挪，落后了再追上去，不超过报来的进度。
  const target = (props.percent ?? 0) / 100;
  const shown = useRef(target);
  const lastT = useRef(t);
  const dt = Math.max(0, Math.min(200, t - lastT.current));
  lastT.current = t;
  if (still()) shown.current = target;
  else {
    // 只有按百分比量速度时才按速度往前推；只知道字节数时位置由调用方给（见 SetupGuide 的 walkPercent）。
    if (working && !stopped && pace.rate && !pace.creep) shown.current += (pace.rate / 100) * (dt / 1000);
    if (shown.current > target + 0.01 || target - shown.current > 0.03) shown.current += (target - shown.current) * 0.08;
  }

  // 步子：按速度走快走慢；停住时不迈步。
  const cadence = !working || stopped ? 0 : pace.rate === null ? 1 : Math.min(2.4, Math.max(0.55, 0.55 + pace.rate * 0.6));
  const phase = useRef(0);
  phase.current += dt * cadence;

  const look = lookOf[kind]();
  const ready = state === 'ready';
  const away = state === 'missing';
  const onRoad = working || state === 'paused' || state === 'failed';
  // 人（也就是镜头）在世界里的位置：在家门口等、在路上、到了大门里。
  // 在路上最多走到大门前 1.3 处（再近门柱就挡在人前面了），过门就是就位那一下。
  const w = ready ? gateX + 0.65 : onRoad ? shown.current * (gateX - 1.3) : homeX + 1.3;
  const X = (x: number) => x - w;

  const out: ReactElement[] = [
    <polygon key="ground" points={pts([P(-9, -4), P(9, -4), P(9, 6), P(-9, 6)])} fill="#2e2720" />,
    <polygon key="road" points={pts([P(X(homeX + 0.5), roadY - roadHalf), P(X(roadEnd), roadY - roadHalf), P(X(roadEnd), roadY + roadHalf), P(X(homeX + 0.5), roadY + roadHalf)])} fill="#221d18" />,
    seg('edge1', P(X(homeX + 0.5), roadY - roadHalf), P(X(roadEnd), roadY - roadHalf), '#3a3128', 1),
    seg('edge2', P(X(homeX + 0.5), roadY + roadHalf), P(X(roadEnd), roadY + roadHalf), '#3a3128', 1),
    // 路面虚线跟着世界走：线从路的起点画起，世界一退，虚线就往后流。
    <polyline key="center" points={pts([P(X(homeX + 0.6), roadY), P(X(gateX), roadY)])} className="stage-centerline" />,
  ];
  // 走过的那段路亮起来。
  if (!away && w > 0) out.push(<polyline key="walked" points={pts([P(X(0), roadY), P(0, roadY)])} className="stage-walked" />);

  const visible = (x: number) => X(x) > -4 && X(x) < 5;
  out.push(home(X(homeX), !away));
  // 片场的楼在路的远侧，总在人后面画。
  if (X(studio.x) < 5) out.push(studioBlock(X(studio.x), ready));
  for (const [i, tr] of farTrees.entries()) if (visible(tr.x) && tr.x < D) out.push(tree(`ft${i}`, X(tr.x), tr.y, tr.s));
  if (visible(gateX)) out.push(gatePart('far', X(gateX), ready, t));

  // 人（在路中间，站在取景框的固定位置）。
  const person0: ReactElement[] = [];
  if (!away) {
    let pose: Pose;
    let a = 0;
    let tt = t;
    if (ready) {
      pose = cheering ? 'cheer' : 'cross';
      a = Math.PI / 4;
    } else if (state === 'waiting') {
      pose = 'look';
      a = Math.PI / 4;
    } else if (state === 'failed') {
      pose = 'slump';
    } else if (state === 'paused' || stopped) {
      pose = 'hold';
    } else {
      pose = running ? 'carryRun' : 'carry';
      tt = phase.current;
    }
    const y = roadY;
    // 跑起来时脚后扬起几团尘土。
    if (running) {
      for (let i = 0; i < 3; i++) {
        const k = (phase.current / 260 + i / 3) % 1;
        const d = P(-0.15 - k * 0.5, y + (i - 1) * 0.08, 0.05 + k * 0.12);
        person0.push(<circle key={`dust${i}`} cx={d[0]} cy={d[1]} r={1.5 + k * 3} className="stage-dust" opacity={0.5 * (1 - k)} />);
      }
    }
    person0.push(person(id + 'crew', 0, y, a, pose, tt, look));
    if (pose === 'carry' || pose === 'carryRun' || pose === 'hold') {
      const l = jointAt(0, y, a, pose, tt, 'haL');
      const r = jointAt(0, y, a, pose, tt, 'haR');
      person0.push(gear(kind, [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2 + 2], 'gear'));
    } else {
      // 不拿在手里时器材放在脚边。
      person0.push(gear(kind, P(0.1, y + 0.32, 0), 'gear'));
    }
    if (stopped) {
      const h = P(0, y, 2.05);
      person0.push(
        <g key="wait" className="stage-bubble">
          <rect x={h[0] - 9} y={h[1] - 7} width={18} height={10} rx={5} />
          {[0, 1, 2].map((i) => (
            <circle key={i} cx={h[0] - 4.5 + i * 4.5} cy={h[1] - 2} r={1.1} className={`dot d${i}`} />
          ))}
        </g>,
      );
    }
  }

  // 人过了大门（就位）时门在他身后先画；还在路上时门在他前面（更近）。
  if (ready) {
    if (visible(gateX)) out.push(gatePart('near', X(gateX), ready, t), gatePart('beam', X(gateX), ready, t));
    out.push(...person0);
  } else {
    out.push(...person0);
    if (visible(gateX)) out.push(gatePart('near', X(gateX), ready, t), gatePart('beam', X(gateX), ready, t));
  }
  for (const [i, lp] of lamps.entries()) if (visible(lp.x)) out.push(lamp(`lp${i}`, X(lp.x), lp.y));
  for (const [i, tr] of nearTrees.entries()) if (visible(tr.x) && tr.x < D) out.push(tree(`nt${i}`, X(tr.x), tr.y, tr.s));

  return (
    <svg className={'crew-stage-svg ' + state} viewBox={viewBox} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {out}
    </svg>
  );
}

/** 组的 key 对应哪种小景；不认识的（插件登记的「以后可能用到」）都是搬运工。 */
export function stageKind(key: string): StageKind {
  return key === 'render' || key === 'media' || key === 'voice' || key === 'align' ? key : 'carry';
}
