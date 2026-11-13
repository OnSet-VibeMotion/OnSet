import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import type { CrewMood, CrewSignal } from './chat/crew';
import '../pet.css';

/*
 * 桌宠窗口（main/pet.ts）：一间像素小工作室——书架、书桌与显示器、导演椅、三脚架上的摄影机——
 * 场记小人按编排工具在做的事走到对应的位置：读在书架前、写和跑命令在桌后、拍在摄影机旁、
 * 想和待命坐在导演椅上、等批准与收工站到台前。
 *
 * 状态由主窗口从会话事件推出后经主进程转来（chat/crew.ts 的 useCrewBroadcast），这里只负责画。
 * 像素图全是这里手画的字符画（不取任何现成素材），每个字符一格，字符到颜色见 `ink`，颜色在 pet.css。
 */

/** 每格多少毫秒。慢一点才像像素动画，也不抢桌面上别的东西的注意力。 */
const frameMs = 280;
/** 画布格数与每格像素。 */
const width = 96;
const height = 48;
const scale = 3;
/** 地板从这一行开始。 */
const floor = 42;
/** 走一格要多少毫秒。 */
const stepMs = 45;

type Part = { x: number; y: number; rows: string[] };

/** 字符 → 颜色类名（pet.css 的 `.pet .px-<名字>`）。`.` 是空格。 */
const ink: Record<string, string> = {
  h: 'brass',
  H: 'brass-deep',
  a: 'brass-light',
  s: 'skin',
  S: 'skin-shade',
  e: 'eye',
  n: 'hair',
  c: 'coat',
  C: 'coat-shade',
  p: 'trousers',
  k: 'shoe',
  o: 'frame',
  O: 'frame-deep',
  g: 'metal',
  d: 'screen',
  w: 'paper',
  l: 'ink',
  r: 'rec',
  D: 'wood',
  E: 'wood-deep',
  B: 'shelf-back',
  F: 'floor',
  f: 'floor-edge',
};

// ---- 小人 ----

const head: string[] = [
  '......h',
  '...hhhhhhh',
  '..hhhhhhhhhH',
  '..HHHHHHHHH',
  '...nssssssn',
  '...nsessesn',
  '...ssssssss',
  '....SssssS',
  '....hhhhhh',
  '...cchhcccc',
  '..CcchcccccC',
  '..CccccccccC',
  '..sccccccccs',
];

const standing = [...head, '...CCCCCCCC', '....pp..pp', '...kkk..kkk'];
const stride = [...head, '...CCCCCCCC', '.....pppp', '....kkkk'];
const sitting = [...head, '...pppppppp', '....pp..pp', '....pp..pp', '....pp..pp', '....pp..pp', '...kkk..kkk'];

/** 眨眼：眼睛换成皮肤色。没做成：眼睛垂下来。 */
const closeEyes = (rows: string[]) => rows.map((row, y) => (y === 5 ? row.replace(/e/g, 's') : row));
const downcast = (rows: string[]) => closeEyes(rows).map((row, y) => (y === 6 ? '...sSSssSSs' : row));

type Station = 'shelf' | 'desk' | 'chair' | 'camera' | 'front';

/** 每个位置小人身子的左上角 x；坐着还是站着。 */
const stations: Record<Station, { x: number; sit: boolean }> = {
  shelf: { x: 6, sit: false },
  desk: { x: 26, sit: false },
  chair: { x: 46, sit: true },
  camera: { x: 61, sit: false },
  front: { x: 44, sit: false },
};

const stationOf: Record<CrewMood, Station> = {
  idle: 'chair',
  thinking: 'chair',
  stopped: 'chair',
  reading: 'shelf',
  writing: 'desk',
  running: 'desk',
  filming: 'camera',
  waiting: 'front',
  done: 'front',
  failed: 'front',
};

const slate = (open: boolean, y: number): Part[] => [
  { x: 13, y: open ? y - 1 : y, rows: [open ? '..wwOOww' : 'wwOOwwOO'] },
  { x: 13, y: y + 1, rows: ['OOwwOOww', 'oooooooo', 'oOOOOOOo', 'oOwwwOwo', 'oOOOOOOo', 'oooooooo'] },
];

/** 小人手上、头顶的东西，坐标相对身子的左上角。每种状态几格画面轮流放。 */
const held: Partial<Record<CrewMood, Part[][]>> = {
  thinking: [
    [{ x: 13, y: 1, rows: ['a'] }],
    [{ x: 13, y: 1, rows: ['a'] }, { x: 15, y: -1, rows: ['aa', 'aa'] }],
    [{ x: 13, y: 1, rows: ['a'] }, { x: 15, y: -1, rows: ['aa', 'aa'] }, { x: 18, y: -4, rows: ['.a.', 'aaa', '.a.'] }],
    [{ x: 13, y: 1, rows: ['a'] }, { x: 15, y: -1, rows: ['aa', 'aa'] }, { x: 18, y: -4, rows: ['.a.', 'aaa', '.a.'] }],
  ],
  reading: [
    [{ x: 1, y: 10, rows: ['wwwwwowwwww', 'wlllwowllww', 'wwwwwowwwww', 'HhhhhhhhhhH'] }],
    [{ x: 1, y: 10, rows: ['wwwwwowwwww', 'wwllwowlllw', 'wwwwwowwwww', 'HhhhhhhhhhH'] }],
  ],
  waiting: [slate(true, 7), slate(true, 7), slate(true, 6), slate(true, 6)],
  done: [
    [...slate(true, 7), { x: 22, y: 1, rows: ['.a.', 'aaa', '.a.'] }],
    [...slate(false, 7), { x: 21, y: 3, rows: ['a'] }, { x: 23, y: -1, rows: ['a'] }],
  ],
  failed: [[{ x: 13, y: -2, rows: ['r.r', '.r.', 'r.r'] }], [{ x: 13, y: -1, rows: ['r.r', '.r.', 'r.r'] }]],
  stopped: [[{ x: 13, y: -1, rows: ['l.l', 'l.l', 'l.l'] }]],
};

// ---- 工作室 ----

/** 书架：每列一本书，数字是书比格子矮几行。 */
function shelf(x: number, y: number): Part {
  const shelves: [string, string][] = [
    ['hcCBwhcCwB', '0001010200'],
    ['CwhhBcCwhc', '1000300100'],
    ['wcBhCcwhCh', '0030001000'],
  ];
  const rows = ['EEEEEEEEEEEE'];
  for (const [colors, short] of shelves) {
    for (let r = 0; r < 6; r++) {
      rows.push('E' + [...colors].map((c, i) => (r < Number(short[i]) ? 'B' : c)).join('') + 'E');
    }
    rows.push('EEEEEEEEEEEE');
  }
  rows.push('E..........E', 'E..........E');
  return { x, y, rows };
}

const poster: Part = {
  x: 48,
  y: 7,
  rows: ['oooooooooo', 'oOOOOOOOOo', 'oOOOhhOOOo', 'oOOhhhhOOo', 'oOOhhhhOOo', 'oOOOhhOOOo', 'oOOOOOOOOo', 'oOllllllOo', 'oOOOllOOOo', 'oooooooooo'],
};

/** 吊灯：线从天花板垂到书桌上方。 */
const lamp: Part = { x: 30, y: 0, rows: ['..g..', '..g..', '..g..', '..g..', '..g..', '..g..', '.HHH.', 'HhhhH', '.aaa.'] };

const chair: Part = {
  x: 47,
  y: 27,
  rows: [
    'D..........D',
    'DhhhhhhhhhhD',
    'DhhhhhhhhhhD',
    'DHHHHHHHHHHD',
    'D..........D',
    'D..........D',
    'D..........D',
    'DDDDDDDDDDDD',
    'D..........D',
    'DhhhhhhhhhhD',
    'DD........DD',
    'D.DD....DD.D',
    'D...DDDD...D',
    'D..DD..DD..D',
    'DDD......DDD',
  ],
};

const desk: Part = {
  x: 16,
  y: 35,
  rows: [
    'DDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    'EEEEEEEEEEEEEEEEEEEEEEEEEEEE',
    'EE................EEEEEEEEEE',
    'EE................EDDDDDDDDE',
    'EE................EDDDhhDDDE',
    'EE................EDDDDDDDDE',
    'EE................EEEEEEEEEE',
  ],
};

const mug: Part = { x: 40, y: 32, rows: ['HHh', 'HHh.', 'HH'] };

/** 显示器：没在跑命令时只有几行暗字；跑命令时字往上滚、光标闪。 */
function monitor(active: boolean, frame: number): Part[] {
  const lines = ['hgggg', 'hggg', 'hgggggg', 'hgg', 'hgggg', 'hgggggg'];
  const shown = active ? [0, 1, 2, 3, 4].map((i) => lines[(i + frame) % lines.length]) : ['ggg', 'gggg', 'gg', '', ''];
  const screen = shown.map((line, i) => {
    const text = active ? line.replace(/g/g, i === 4 ? 'g' : 'l') : line;
    const withCursor = active && i === 4 && frame % 2 === 0 ? text + 'a' : text;
    return 'o' + ('d' + withCursor).padEnd(9, 'd').slice(0, 9) + 'o';
  });
  return [{ x: 18, y: 26, rows: ['ooooooooooo', ...screen, 'ooooooooooo', '....ggg....', '...ggggg...'] }];
}

/** 写字：纸铺在桌上，铅笔在纸上来回。 */
function paper(active: boolean, frame: number): Part[] {
  const sheet: Part = { x: 30, y: 34, rows: ['wwwwwww'] };
  if (!active) return [sheet];
  return [sheet, { x: 30 + (frame % 3) * 2, y: 30, rows: ['...a', '..a.', '.a..', 'o...'] }];
}

/** 三脚架上的摄影机：拍的时候片盘转、录制灯闪。 */
function camera(active: boolean, frame: number): Part[] {
  const turned = active && frame % 2 === 1;
  const reel = (x: number): Part => ({ x, y: 19, rows: turned ? ['.oo.', 'oa.o', 'o.ao', '.oo.'] : ['.oo.', 'o.ao', 'oa.o', '.oo.'] });
  const rec = active && frame % 4 < 2;
  return [
    reel(76),
    reel(81),
    { x: 76, y: 23, rows: ['oooooooooo', 'oggggggggoaa', rec ? 'ogrggggggoaa' : 'oggggggggoaa', 'oggggggggoaa', 'oooooooooo'] },
    { x: 77, y: 28, rows: ['...oo...', '...oo...', '..o..o..', '..o..o..', '.o....o.', '.o....o.', 'o......o', 'o......o', 'o......o', 'o......o', 'o......o', 'o......o', 'o......o', 'o......o'] },
  ];
}

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

function draw(parts: Part[], key: string): ReactElement[] {
  return parts.flatMap((part, index) => cells(part, `${key}${index}`));
}

function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 窗口宽度（main/pet.ts 的 width）、画布左边到窗口左边的距离、气泡离窗口边缘至少多远。 */
const windowWidth = 320;
const bubbleInset = 11;
const bubbleMargin = 6;

/** 待命时气泡说什么。 */
const idleLine = '待命';

export function Pet() {
  const [signal, setSignal] = useState<CrewSignal | null>(null);
  const [tick, setTick] = useState(0);
  const still = prefersStill();
  const mood: CrewMood = signal?.mood ?? 'idle';
  const target = stations[stationOf[mood]];

  // 走路：目标位置变了就走过去，走的时间按距离算；走到之前用走路的腿、不拿道具。
  const [x, setX] = useState(target.x);
  const [walkMs, setWalkMs] = useState(0);
  const [walking, setWalking] = useState(false);
  const arrive = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (target.x === x) return;
    const ms = still ? 0 : Math.max(300, Math.abs(target.x - x) * stepMs);
    setWalkMs(ms);
    setWalking(ms > 0);
    setX(target.x);
    window.clearTimeout(arrive.current);
    arrive.current = window.setTimeout(() => setWalking(false), ms);
  }, [target.x, x, still]);
  useEffect(() => () => window.clearTimeout(arrive.current), []);

  useEffect(() => window.am?.onCrew?.((next) => setSignal(next ?? null)), []);
  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), frameMs);
    return () => window.clearInterval(timer);
  }, [still]);

  const frame = still ? 0 : tick;
  const sit = target.sit && !walking;
  let body = walking ? (frame % 2 === 0 ? stride : standing) : sit ? sitting : standing;
  if (mood === 'failed' && !walking) body = downcast(body);
  else if (!still && frame % 14 === 13) body = closeEyes(body);
  const top = floor - body.length;
  const hop = mood === 'done' && !walking && frame % 2 === 1 ? -1 : 0;
  const props = walking ? [] : held[mood] ?? [];
  const prop = props.length > 0 ? props[frame % props.length] : [];
  const line = signal?.line ?? idleLine;
  const glow = useId();

  // 气泡不出窗口：按自身宽度把它夹在窗口里，尾巴另算，始终指着小人。
  const bubble = useRef<HTMLDivElement>(null);
  const [bubbleWidth, setBubbleWidth] = useState(0);
  useLayoutEffect(() => setBubbleWidth(bubble.current?.offsetWidth ?? 0), [line]);
  const center = (x + 7) * scale + bubbleInset;
  const left = Math.min(Math.max(center - bubbleWidth / 2, bubbleMargin), windowWidth - bubbleMargin - bubbleWidth);
  const tail = Math.min(Math.max(center - left, 12), Math.max(12, bubbleWidth - 12));

  return (
    <div className="pet" id="crew" data-mood={mood} data-walking={walking ? 'true' : 'false'} role="status" aria-live="polite" aria-label={line}>
      <div
        ref={bubble}
        className="pet-bubble"
        style={{ left, transition: `left ${walkMs}ms linear`, ['--tail' as string]: `${tail}px` }}
        onDoubleClick={() => window.am?.pet?.('focus')}
      >
        <span className="pet-line">{line}</span>
      </div>
      <div className="pet-card" onDoubleClick={() => window.am?.pet?.('focus')} title="双击回到客户端">
        <svg className="pet-room" viewBox={`0 0 ${width} ${height}`} width={width * scale} height={height * scale} shapeRendering="crispEdges" aria-hidden="true">
          <defs>
            <radialGradient id={glow}>
              <stop offset="0" className="px-glow" stopOpacity="0.5" />
              <stop offset="1" className="px-glow" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect className="px-floor" x={0} y={floor} width={width} height={height - floor} />
          <rect className="px-floor-edge" x={0} y={floor} width={width} height={1} />
          {draw([lamp, poster, shelf(2, 17), chair], 's')}
          {draw(camera(mood === 'filming' && !walking, frame), 'c')}
          <g className="pet-walker" style={{ transform: `translateX(${x}px)`, transition: `transform ${walkMs}ms linear` }}>
            {/* 脚下一小片黄铜色的光，跟着人走：像放映室里打在场记身上的那一束。 */}
            <ellipse cx={7} cy={floor + 0.5} rx={9} ry={1.6} fill={`url(#${glow})`} shapeRendering="auto" />
            <g style={{ transform: `translateY(${hop}px)` }}>
              {cells({ x: 0, y: top, rows: body }, 'b')}
              {draw(
                prop.map((part) => ({ ...part, y: part.y + top })),
                'p',
              )}
            </g>
          </g>
          {draw([desk, mug, ...monitor(mood === 'running' && !walking, frame), ...paper(mood === 'writing' && !walking, frame)], 'd')}
        </svg>
        <div className="pet-foot">
          <span className="pet-project">{signal?.project || 'ArticleToMotion'}</span>
          <button className="pet-close" title="收起桌宠（菜单「窗口 → 场记桌宠」再打开）" onClick={() => window.am?.pet?.('hide')}>
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
