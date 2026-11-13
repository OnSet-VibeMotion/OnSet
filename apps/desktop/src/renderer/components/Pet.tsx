import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { CrewMood, CrewSignal } from './chat/crew';
import '../pet.css';

/*
 * 桌宠窗口（main/pet.ts）：一间 2.5D 像素工作室（俯视四分之三视角：家具画顶面与正面，人按脚下的 y 前后遮挡）。
 *
 *   导演（编排工具）——在哪个部门干活就走到哪：读稿、写稿在剧本桌，跑命令在导演台，拍摄时在机位旁盯着，
 *       剪辑时站在剪辑师身后，配音时站在录音棚外；等批准、收工站到台前；想事情和待命坐在导演椅上。
 *   摄影 ×3（渲染器）——每个正在渲染的镜头一个人，从休息区的沙发走到摄影机后面，头上挂着镜头编号。
 *   剪辑师——导演交来拼接、复查、抽帧、校验、字幕时间轴时盯着时间线干活，平时转过椅子歇着。
 *   配音演员——导演跑配音命令、动音色库时站到话筒前，录音灯亮；平时坐着看稿。
 *
 * 状态由主窗口从会话事件推出后经主进程转来（chat/crew.ts），这里只负责画。像素图全是这里手画的字符画，
 * 不取任何现成素材；每个字符一格，字符到颜色见 `ink`，颜色在 pet.css，人的衣帽颜色按 `.who-*` 换。
 */

/** 画布格数、每格像素、画布在卡片里的内边距（像素）。 */
const W = 128;
const H = 88;
const S = 3;
const inset = 7;
/** 走廊：人从一个地方走到另一个地方都先走到这一行再横过去，免得穿过家具。 */
const aisle = 56;
/** 动画的节拍：位置每 60 毫秒走一步，画面（道具、屏幕）每 280 毫秒换一格。 */
const simMs = 60;
const frameMs = 280;
const speed = 1.6;

type Part = { x: number; y: number; rows: string[] };

/** 字符 → 颜色类名（pet.css 的 `.pet .px-<名字>`）。人身上的颜色随 `.who-*` 变。 */
const ink: Record<string, string> = {
  // 人
  h: 'hat',
  H: 'hat-shade',
  n: 'hair',
  s: 'skin',
  S: 'skin-shade',
  e: 'eye',
  c: 'coat',
  C: 'coat-shade',
  x: 'accent',
  p: 'trousers',
  k: 'shoe',
  q: 'phones',
  // 工作室
  a: 'brass-light',
  b: 'brass',
  B: 'brass-deep',
  o: 'frame',
  O: 'frame-deep',
  g: 'metal',
  d: 'screen',
  w: 'paper',
  l: 'ink',
  r: 'rec',
  D: 'wood',
  E: 'wood-deep',
  T: 'wood-top',
  F: 'floor',
  f: 'floor-seam',
  V: 'wall-top',
  W: 'wall',
  Y: 'baseboard',
  P: 'backdrop',
  Q: 'backdrop-shade',
  u: 'sofa-top',
  U: 'sofa',
  M: 'foam',
  m: 'foam-deep',
  L: 'leaf',
  K: 'leaf-deep',
  Z: 'soft-on',
  z: 'soft-off',
  G: 'glass',
  1: 'clip-1',
  2: 'clip-2',
  3: 'clip-3',
};

// ---- 人 ----

const faceFront = ['..hhhhh..', '.hhhhhhh.', '.HHHHHHH.', '..sssss..', '..seses..', '..sssss..', '...SSS...', '.ccxxxcc.', 'cccxxxccc', 'scccxcccs'];
const faceBack = ['..hhhhh..', '.hhhhhhh.', '.HHHHHHH.', '..nnnnn..', '..nnnnn..', '..snnns..', '...SSS...', '.ccccccc.', 'ccccccccc', 'scccccccs'];

type Facing = 'front' | 'back';
type Pose = 'stand' | 'sit' | 'walk';

/** 一个人的样子：站着 13 行，坐着 12 行。 */
function sprite(facing: Facing, pose: Pose, step: number, blink: boolean): string[] {
  const rows = facing === 'front' ? [...faceFront] : [...faceBack];
  if (blink && facing === 'front') rows[4] = '..sssss..';
  if (pose === 'sit') return [...rows, facing === 'front' ? '.ppppppp.' : '.CCCCCCC.', '.kk...kk.'];
  if (pose === 'walk') return [...rows, '.CCCCCCC.', ...(step % 2 === 0 ? ['.pp...pp.', '.kk...kk.'] : ['...ppp...', '...kkk...'])];
  return [...rows, '.CCCCCCC.', '..pp.pp..', '..kk.kk..'];
}

/** 戴耳机的人（剪辑、配音）：两侧各一块。 */
const phones: Part[] = [
  { x: 0, y: 2, rows: ['q', 'q', 'q'] },
  { x: 8, y: 2, rows: ['q', 'q', 'q'] },
];
/** 导演的贝雷帽顶上的小揪。 */
const beret: Part[] = [{ x: 4, y: -1, rows: ['h'] }];

// ---- 位置 ----

type Spot = { x: number; y: number; facing: Facing; pose: 'stand' | 'sit'; via: [number, number][] };

/** 导演的各个位置：脚下中点、朝向、站还是坐，以及从走廊走过来的路线。 */
const director: Record<string, Spot> = {
  chair: { x: 30, y: 42, facing: 'front', pose: 'sit', via: [[30, aisle]] },
  table: { x: 13, y: 47, facing: 'front', pose: 'stand', via: [[24, aisle], [24, 47]] },
  console: { x: 12, y: 31, facing: 'back', pose: 'stand', via: [[24, aisle], [24, 31]] },
  filming: { x: 40, y: 50, facing: 'front', pose: 'stand', via: [[40, aisle]] },
  editing: { x: 92, y: 44, facing: 'back', pose: 'stand', via: [[92, aisle]] },
  voicing: { x: 88, y: 70, facing: 'front', pose: 'stand', via: [[88, aisle]] },
  front: { x: 64, y: 80, facing: 'front', pose: 'stand', via: [[64, aisle]] },
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

const cameras = [52, 64, 76];
/** 摄影的沙发座位与机位。 */
const operatorSpots = [0, 1, 2].map((i) => ({
  seat: { x: 12 + i * 9, y: 73, facing: 'front', pose: 'sit', via: [[42, aisle], [42, 79], [12 + i * 9, 79]] } as Spot,
  camera: { x: cameras[i], y: 50, facing: 'back', pose: 'stand', via: [[cameras[i], aisle]] } as Spot,
}));

/** 走着的人：当前位置、要去的位置、剩下的路，以及走了多远（换腿用）。 */
interface Walker {
  x: number;
  y: number;
  spot: Spot;
  path: [number, number][];
  travelled: number;
  facing: Facing;
}

function newWalker(spot: Spot): Walker {
  return { x: spot.x, y: spot.y, spot, path: [], travelled: 0, facing: spot.facing };
}

/** 换目的地：先按来路退回走廊，再沿走廊横过去，最后按新位置的路线走进去。 */
function retarget(walker: Walker, spot: Spot, teleport: boolean): void {
  if (walker.spot === spot) return;
  const out: [number, number][] = walker.path.length === 0 ? [...walker.spot.via].reverse() : [[Math.round(walker.x), aisle]];
  walker.path = [...out, ...spot.via, [spot.x, spot.y]];
  walker.spot = spot;
  if (teleport) {
    walker.x = spot.x;
    walker.y = spot.y;
    walker.path = [];
    walker.facing = spot.facing;
  }
}

function advance(walker: Walker): void {
  let budget = speed;
  while (budget > 0 && walker.path.length > 0) {
    const [tx, ty] = walker.path[0];
    const dx = tx - walker.x;
    const dy = ty - walker.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) walker.facing = dy < 0 && Math.abs(dy) >= Math.abs(dx) ? 'back' : 'front';
    if (dist <= budget) {
      walker.x = tx;
      walker.y = ty;
      walker.path.shift();
      budget -= dist;
      walker.travelled += dist;
    } else {
      walker.x += (dx / dist) * budget;
      walker.y += (dy / dist) * budget;
      walker.travelled += budget;
      budget = 0;
    }
  }
  if (walker.path.length === 0) walker.facing = walker.spot.facing;
}

// ---- 画 ----

/** 字符画转成按行合并的矩形，一行同色的连续格子画成一个 rect。 */
function cells(part: Part, key: string): ReactElement[] {
  const out: ReactElement[] = [];
  part.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const name = ink[row[x]];
      if (!name) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === row[x]) end++;
      out.push(<rect key={`${key}-${y}-${x}`} className={'px-' + name} x={part.x + x} y={part.y + y} width={end - x} height={1} />);
      x = end;
    }
  });
  return out;
}

/** 不会变的部分（墙、地板、家具）画成的元素只算一次，走路时每一步重画不必再算几千个格子。 */
const cache = new Map<string, ReactElement[]>();
function cached(key: string, make: () => ReactElement[]): ReactElement[] {
  let hit = cache.get(key);
  if (!hit) cache.set(key, (hit = make()));
  return hit;
}

const draw = (parts: Part[], key: string) => parts.flatMap((part, i) => cells(part, `${key}${i}`));
const fill = (x: number, y: number, w: number, h: number, c: string): Part => ({ x, y, rows: Array.from({ length: h }, () => c.repeat(w)) });

/** 俯视四分之三的箱子：顶面 `top` 行、正面 `front` 行，正面最上一行压一道暗边。 */
function box(x: number, y: number, w: number, top: number, front: number, topC = 'T', frontC = 'D'): Part[] {
  return [fill(x, y, w, top, topC), fill(x, y + top, w, 1, 'E'), fill(x, y + top + 1, w, front - 1, frontC)];
}

/** 地板：木条一行六格，接缝错开。 */
const floor: Part[] = (() => {
  const parts: Part[] = [fill(0, 20, W, H - 20, 'F')];
  for (let y = 20, band = 0; y < H; y += 6, band++) {
    parts.push(fill(0, y, W, 1, 'f'));
    for (let x = (band % 2) * 9 + 4; x < W; x += 18) parts.push(fill(x, y + 1, 1, 5, 'f'));
  }
  return parts;
})();

const wall: Part[] = [fill(0, 0, W, 1, 'V'), fill(0, 1, W, 18, 'W'), fill(0, 19, W, 1, 'Y')];

const poster: Part = {
  x: 26,
  y: 4,
  rows: ['ooooooooooo', 'oOOOOOOOOOo', 'oOOObbbOOOo', 'oOObbbbbOOo', 'oOObbbbbOOo', 'oOOObbbOOOo', 'oOOOOOOOOOo', 'oOlllllllOo', 'oOOOlllOOOo', 'oOOOOOOOOOo', 'ooooooooooo'],
};
const clock: Part = { x: 87, y: 4, rows: ['.ooo.', 'o.b.o', 'o.bbo', 'o...o', '.ooo.'] };

/** 影棚：卷纸背景从墙上垂下来铺到地上。 */
const backdrop: Part[] = [fill(45, 2, 39, 1, 'g'), fill(46, 3, 37, 17, 'P'), fill(46, 20, 37, 8, 'P'), fill(46, 28, 37, 2, 'Q')];

/** 屏幕：边框加里面几行。 */
function screen(x: number, y: number, w: number, h: number, lines: string[]): Part {
  const rows = ['o'.repeat(w)];
  for (let i = 0; i < h - 2; i++) rows.push('o' + ((lines[i] ?? '') + 'd'.repeat(w)).slice(0, w - 2) + 'o');
  rows.push('o'.repeat(w));
  return { x, y, rows };
}

/** 导演台的显示器：跑命令时字往上滚、光标闪。 */
function consoleScreen(active: boolean, frame: number): Part {
  const text = ['dbllll', 'dblll', 'dbllllll', 'dbll', 'dblllll'];
  const lines = active ? [0, 1, 2, 3].map((i) => text[(i + frame) % text.length]) : ['dggg', 'dgggg', 'dgg'];
  if (active) lines.push(frame % 2 === 0 ? 'dba' : 'db');
  return screen(6, 8, 13, 10, ['', ...lines]);
}

/** 剪辑台的两块屏：左边是时间线（片段条与走动的播放头），右边是画面。 */
function editScreens(active: boolean, frame: number): Part[] {
  const head = frame % 10;
  const track = (pattern: string) => (active ? [...pattern].map((c, i) => (i === head + 1 ? 'a' : c)).join('') : pattern.replace(/[123l]/g, 'g'));
  const left = screen(96, 8, 13, 10, ['', track('d11112233dd'), track('d22233311dd'), track('d3311d2222d'), '', track('dllllllllld')]);
  const picture = active ? ['', 'dddPPPPPddd', 'ddPPPbPPPdd', 'ddPPbbbPPdd', 'dddPPPPPddd', ''] : ['', '', 'ddddgdddddd', '', ''];
  return [left, screen(110, 8, 13, 10, ['', ...picture])];
}

/** 摄影机（从机身后面看）：在拍时取景屏亮、录制灯闪。 */
function camera(cx: number, active: boolean, frame: number): Part[] {
  const rec = active && frame % 4 < 2;
  return [
    {
      x: cx - 4,
      y: 32,
      rows: ['..ggg....', '.ooooooo.', rec ? '.ogggggr.' : '.ogggggo.', active ? '.ogllldo.' : '.ogdddgo.', active ? '.oglldgo.' : '.ogdddgo.', '.ooooooo.', '....o....', '...o.o...', '..o...o..', '.o.....o.', 'o.......o'],
    },
  ];
}

function softbox(x: number, on: boolean): Part[] {
  const c = (on ? 'Z' : 'z').repeat(4);
  return [{ x, y: 8, rows: ['oooooo', `o${c}o`, `o${c}o`, 'oooooo'] }, fill(x + 2, 12, 2, 18, 'o'), { x, y: 30, rows: ['oo..oo'] }];
}

const directorChair: Part = {
  x: 26,
  y: 30,
  rows: ['b.......b', 'bbbbbbbbb', 'bbbbbbbbb', 'BBBBBBBBB', 'D.......D', 'D.......D', 'D.......D', 'DDDDDDDDD', 'DbbbbbbbD', 'D.D...D.D', 'D..D.D..D', 'D...D...D', 'D..D.D..D'],
};

const editChair: Part = { x: 104, y: 33, rows: ['.DDDDDDD.', 'DUUUUUUUD', 'DUUUUUUUD', '.DDDDDDD.', '....D....', '...D.D...'] };

/** 录音棚：吸音棉、话筒、配音演员与玻璃，录音灯在窗上。 */
function booth(active: boolean, frame: number, blink: boolean): ReactElement[] {
  const foam: string[] = [];
  for (let y = 0; y < 16; y++) foam.push(Array.from({ length: 27 }, (_, x) => ((Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0 ? 'M' : 'm')).join(''));
  const out = [...cached('booth', () => draw([...box(92, 60, 35, 4, 23, 'T', 'E'), { x: 96, y: 67, rows: foam }, { x: 103, y: 70, rows: ['gg', 'gg', '.o', '.o', '.o', '.o', '.o', '.o', '.o', '.o', '.o', 'ooo'] }], 'booth'))];
  // 录音时站在话筒前，平时坐在凳子上看稿。
  const actor: Part = active ? { x: 105, y: 69, rows: sprite('front', 'stand', 0, blink) } : { x: 112, y: 70, rows: sprite('front', 'sit', 0, blink) };
  out.push(
    <g key="actor" className="who-voice" data-who="voice" data-active={active ? 'true' : 'false'}>
      {cells(actor, 'actor')}
      {draw(
        phones.map((part) => ({ ...part, x: part.x + actor.x, y: part.y + actor.y })),
        'ph',
      )}
      {active ? cells({ x: 101, y: 68 + (frame % 2), rows: frame % 2 === 0 ? ['.a', 'a.', '.a'] : ['a', '.', 'a'] }, 'wave') : cells({ x: actor.x + 1, y: actor.y + 8, rows: ['wwwwwww', 'wlllllw'] }, 'script')}
    </g>,
  );
  out.push(
    ...draw(
      [fill(96, 67, 27, 16, 'G'), fill(95, 66, 29, 1, 'o'), fill(95, 83, 29, 1, 'o'), fill(95, 67, 1, 16, 'o'), fill(123, 67, 1, 16, 'o'), fill(106, 64, 5, 1, active ? 'r' : 'O')],
      'glass',
    ),
  );
  return out;
}

/** 沙发分两半画：靠背与坐垫顶面在坐着的人后面，坐垫正面与扶手在前面。 */
const sofaBack: Part[] = [fill(4, 62, 35, 2, 'u'), fill(4, 64, 35, 5, 'U'), fill(4, 69, 35, 4, 'u')];
const sofaSeat: Part[] = [fill(4, 73, 35, 1, 'E'), fill(4, 74, 35, 3, 'U'), fill(4, 62, 3, 15, 'U'), fill(36, 62, 3, 15, 'U'), fill(4, 62, 3, 1, 'u'), fill(36, 62, 3, 1, 'u')];
const coffeeTable: Part[] = [...box(12, 81, 21, 2, 4), { x: 16, y: 79, rows: ['ww', 'ww'] }, { x: 26, y: 79, rows: ['ww', 'ww'] }];
const plant: Part[] = [
  { x: 79, y: 66, rows: ['...L.L..', '..LLKLL.', '.LKLLLKL', 'LLLKLLLL', '.LKLLKL.', '..LLLL..', '...KK...'] },
  { x: 80, y: 73, rows: ['EEEEEE', '.DDDD.', '.DDDD.', '.DDDD.', '.EEEE.'] },
];
const setBox: Part[] = [...box(60, 22, 8, 2, 4), { x: 61, y: 17, rows: ['..L.L.', '.LLKLL', 'LKLLLK', '.LLKL.', '..KK..'] }];

/** 导演手上、头顶的东西，坐标相对身子左上角。 */
const slateOpen = ['.wOwO', 'wOwOw', 'ooooo', 'oOwOo', 'ooooo'];
const held: Partial<Record<CrewMood, Part[][]>> = {
  thinking: [
    [{ x: 9, y: 1, rows: ['a'] }],
    [{ x: 9, y: 1, rows: ['a'] }, { x: 10, y: -2, rows: ['aa', 'aa'] }],
    [{ x: 9, y: 1, rows: ['a'] }, { x: 10, y: -2, rows: ['aa', 'aa'] }, { x: 12, y: -6, rows: ['.a.', 'aaa', '.a.'] }],
    [{ x: 9, y: 1, rows: ['a'] }, { x: 10, y: -2, rows: ['aa', 'aa'] }, { x: 12, y: -6, rows: ['.a.', 'aaa', '.a.'] }],
  ],
  reading: [[{ x: 1, y: 8, rows: ['wwwOwww', 'wllOllw', 'wwwOwww'] }], [{ x: 1, y: 8, rows: ['wwwOwww', 'wlwOwlw', 'wwwOwww'] }]],
  writing: [[{ x: 7, y: 7, rows: ['..b', '.b.', 'o..'] }], [{ x: 8, y: 8, rows: ['..b', '.b.', 'o..'] }]],
  waiting: [[{ x: 8, y: 4, rows: slateOpen }], [{ x: 8, y: 5, rows: slateOpen }]],
  done: [
    [{ x: 8, y: 4, rows: slateOpen }, { x: 13, y: 0, rows: ['.a.', 'aaa', '.a.'] }],
    [{ x: 8, y: 5, rows: ['wOwOw', 'ooooo', 'oOwOo', 'ooooo'] }, { x: 14, y: -2, rows: ['a'] }],
  ],
  failed: [[{ x: 9, y: -4, rows: ['r.r', '.r.', 'r.r'] }], [{ x: 9, y: -3, rows: ['r.r', '.r.', 'r.r'] }]],
  stopped: [[{ x: 9, y: -3, rows: ['l.l', 'l.l', 'l.l'] }]],
};

function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 没有对话在跑时的那一份。 */
const idleSignal: CrewSignal = { mood: 'idle', line: '待命', project: '', rendering: [] };

/** 画布坐标换成卡片里的像素：人头的左右中点与头顶。 */
const pxX = (x: number) => Math.round(x) * S + inset;
const pxY = (y: number) => Math.round(y) * S + inset;

export function Pet() {
  const [signal, setSignal] = useState<CrewSignal>(idleSignal);
  const [tick, setTick] = useState(0);
  const still = prefersStill();
  const glow = useId();

  useEffect(() => window.am?.onCrew?.((next) => setSignal(next ?? idleSignal)), []);

  // 人：导演一位、摄影三位。走路在 ref 里算，每一步重画一次。
  const walkers = useRef<{ director: Walker; ops: Walker[] } | null>(null);
  if (!walkers.current) walkers.current = { director: newWalker(director.chair), ops: operatorSpots.map((spot) => newWalker(spot.seat)) };
  const mood = signal.mood;
  // 前三个在渲染的镜头各给一位摄影；导演在等渲染、却还没有镜头标成渲染中时，先开一台。
  const shooting = signal.rendering.length > 0 ? signal.rendering : mood === 'filming' ? [''] : [];
  useEffect(() => {
    const w = walkers.current!;
    retarget(w.director, director[directorSpot[mood]], still);
    w.ops.forEach((op, i) => retarget(op, i < shooting.length ? operatorSpots[i].camera : operatorSpots[i].seat, still));
    setTick((t) => t + 1);
  }, [mood, shooting.length, still]);

  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(() => {
      const w = walkers.current!;
      advance(w.director);
      w.ops.forEach(advance);
      setTick((t) => t + 1);
    }, simMs);
    return () => window.clearInterval(timer);
  }, [still]);

  const frame = still ? 0 : Math.floor((tick * simMs) / frameMs);
  const blinkAt = (seed: number) => !still && (frame + seed) % 17 === 16;
  const w = walkers.current;
  const arrived = (walker: Walker) => walker.path.length === 0;
  const dirArrived = arrived(w.director);

  // 每个部门此刻在不在干活。
  const filmingOps = w.ops.map((op, i) => i < shooting.length && arrived(op));
  const anyFilming = filmingOps.some(Boolean);
  const editing = mood === 'editing';
  const voicing = mood === 'voicing';

  type Drawable = { y: number; key: string; render: () => ReactElement | ReactElement[] };
  const drawables: Drawable[] = [];
  const add = (y: number, key: string, parts: Part[]) => drawables.push({ y, key, render: () => draw(parts, key) });
  /** 不会变的家具只画一次。 */
  const still_ = (y: number, key: string, parts: Part[]) => drawables.push({ y, key, render: () => cached(key, () => draw(parts, key)) });

  still_(26, 'console', box(4, 20, 17, 3, 4));
  still_(27, 'setbox', setBox);
  add(31, 'lightL', softbox(39, anyFilming));
  add(31, 'lightR', softbox(85, anyFilming));
  still_(41, 'chair', [directorChair]);
  still_(52, 'table', [...box(4, 44, 19, 5, 4), fill(7, 45, 5, 2, 'w'), fill(14, 45, 6, 3, 'w'), fill(15, 46, 4, 1, 'l')]);
  cameras.forEach((cx, i) => add(42, `cam${i}`, camera(cx, filmingOps[i], frame + i)));
  still_(28, 'editdesk', [...box(94, 20, 31, 5, 4), fill(104, 22, 9, 1, 'g')]);
  // 剪辑师背对我们干活时椅背在他前面，转过来歇着时椅背在他后面。
  still_(editing ? 39 : 37, 'editchair', [editChair]);
  still_(68, 'sofaback', sofaBack);
  still_(77, 'sofaseat', sofaSeat);
  still_(85, 'coffee', coffeeTable);
  still_(83, 'plant', plant);
  drawables.push({ y: 86, key: 'booth', render: () => booth(voicing, frame, blinkAt(5)) });

  const editorRows = sprite(editing ? 'back' : 'front', 'sit', 0, blinkAt(9));
  const editor: Part = { x: 104, y: 38 - editorRows.length, rows: editorRows };
  drawables.push({
    y: 38,
    key: 'editor',
    render: () => (
      <g key="editor" className="who-editor" data-who="editor" data-active={editing ? 'true' : 'false'}>
        {cells(editor, 'ed')}
        {draw(
          phones.map((part) => ({ ...part, x: part.x + editor.x, y: part.y + editor.y })),
          'edp',
        )}
      </g>
    ),
  });

  const person = (walker: Walker, who: string, seed: number, active: boolean, extra: (left: number, top: number, moving: boolean) => Part[] = () => []) => {
    const moving = !arrived(walker);
    const rows = sprite(walker.facing, moving ? 'walk' : walker.spot.pose, Math.floor(walker.travelled / 3), blinkAt(seed));
    const left = Math.round(walker.x) - 4;
    const hop = who === 'director' && mood === 'done' && !moving && frame % 2 === 1 ? -1 : 0;
    const top = Math.round(walker.y) - rows.length + 1 + hop;
    return (
      <g key={who} className={`who-${who}`} data-who={who} data-active={active ? 'true' : 'false'} data-walking={moving ? 'true' : 'false'}>
        <ellipse cx={walker.x + 0.5} cy={walker.y + 0.8} rx={4.5} ry={1.1} className="pet-shadow" shapeRendering="auto" />
        {cells({ x: left, y: top, rows }, `${who}b`)}
        {draw(extra(left, top, moving), `${who}x`)}
      </g>
    );
  };

  drawables.push({
    y: w.director.y + 0.5,
    key: 'director',
    render: () =>
      person(w.director, 'director', 0, true, (left, top, moving) => {
        const at = (parts: Part[]) => parts.map((part) => ({ ...part, x: part.x + left, y: part.y + top }));
        const props = moving ? undefined : held[mood];
        return [...at(beret), ...(props ? at(props[frame % props.length]) : [])];
      }),
  });
  w.ops.forEach((op, i) => drawables.push({ y: op.y + 0.4, key: `op${i}`, render: () => person(op, `op${i + 1}`, 3 + i * 4, filmingOps[i]) }));
  drawables.sort((a, b) => a.y - b.y);

  // 标签挂在脚下（头顶归导演的气泡）：开机的摄影写镜头号，干活的剪辑、配音写部门名。
  const tags: { key: string; text: string; title: string; left: number; top: number }[] = [];
  w.ops.forEach((op, i) => {
    if (!filmingOps[i] || !shooting[i]) return;
    const short = shooting[i].replace(/^scene-/, '');
    const text = i === 2 && shooting.length > 3 ? `${short}+${shooting.length - 3}` : short;
    tags.push({ key: `op${i + 1}`, text, title: shooting.slice(i, i === 2 ? undefined : i + 1).join('、'), left: pxX(op.x) + 1, top: pxY(op.y) + 5 });
  });
  if (editing) tags.push({ key: 'editor', text: '剪辑', title: '剪辑', left: pxX(108) + 1, top: pxY(39) + 3 });
  if (voicing) tags.push({ key: 'voice', text: '配音', title: '配音', left: pxX(109) + 1, top: pxY(84) + 1 });

  // 导演的气泡：夹在卡片里，尾巴指着导演。
  const bubble = useRef<HTMLDivElement>(null);
  const [bubbleWidth, setBubbleWidth] = useState(0);
  useLayoutEffect(() => setBubbleWidth(bubble.current?.offsetWidth ?? 0), [signal.line]);
  const cardWidth = W * S + inset * 2;
  const center = pxX(w.director.x) + 1;
  const bubbleLeft = Math.min(Math.max(center - bubbleWidth / 2, 6), cardWidth - 6 - bubbleWidth);
  const tail = Math.min(Math.max(center - bubbleLeft, 12), Math.max(12, bubbleWidth - 12));
  const headRows = w.director.spot.pose === 'sit' && dirArrived ? 12 : 13;
  const bubbleTop = Math.max(4, pxY(w.director.y - headRows) - 32 - (mood === 'thinking' && dirArrived ? 18 : 0));
  const filmingCount = shooting.filter(Boolean).length;

  return (
    <div className="pet" id="crew" data-mood={mood} data-walking={dirArrived ? 'false' : 'true'} role="status" aria-live="polite" aria-label={signal.line}>
      <div className="pet-card" onDoubleClick={() => window.am?.pet?.('focus')} title="双击回到客户端">
        <svg className="pet-room" viewBox={`0 0 ${W} ${H}`} width={W * S} height={H * S} shapeRendering="crispEdges" aria-hidden="true">
          <defs>
            <radialGradient id={glow}>
              <stop offset="0" className="px-glow" stopOpacity="0.5" />
              <stop offset="1" className="px-glow" stopOpacity="0" />
            </radialGradient>
          </defs>
          {cached('room', () => draw([...wall, poster, clock, ...backdrop, ...floor], 'bg'))}
          {draw([consoleScreen(mood === 'running' && dirArrived, frame), ...editScreens(editing, frame)], 'screens')}
          {/* 有人开机时影棚亮起来：两盏柔光箱的光打在背景纸上。 */}
          {anyFilming ? (
            <g className="pet-light" shapeRendering="auto">
              <polygon points="41,12 50,30 60,30" />
              <polygon points="87,12 68,30 78,30" />
              <ellipse cx={64} cy={25} rx={17} ry={5} fill={`url(#${glow})`} />
            </g>
          ) : null}
          {/* 导演脚下的光：放映室里打在场记身上的那一束。 */}
          <ellipse cx={w.director.x + 0.5} cy={w.director.y + 0.8} rx={10} ry={2.4} fill={`url(#${glow})`} shapeRendering="auto" />
          {drawables.map((item) => (
            <g key={item.key}>{item.render()}</g>
          ))}
        </svg>
        {tags.map((tag) => (
          <span key={tag.key} className="pet-tag" data-tag={tag.key} title={tag.title} style={{ left: tag.left, top: tag.top }}>
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
