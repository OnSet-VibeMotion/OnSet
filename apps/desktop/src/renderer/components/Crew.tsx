import { useEffect, useId, useState, type ReactElement } from 'react';
import type { PermissionAsk, Scene } from '../types';
import { crewState, type CrewMood } from './chat/crew';
import type { TurnBlock } from './chat/model';

/**
 * 对话底部的场记小人：编排工具在读、写、跑命令、拍镜头、等批准时各有一套动作。
 * 像素图是这里手画的字符画（不取任何现成素材），每个字符是一格，字符到颜色的对应见 `ink`，
 * 颜色在 chat.css 的 `.crew .px-*`，取「放映室」色板：象牙白的外套、黄铜的贝雷帽与围巾，不描黑边——暖黑底上黑边看不见。
 */

/** 每格多少毫秒。慢一点才像像素动画，也不抢对话的注意力。 */
const frameMs = 280;

/** 画布格数：身子在左，道具在右，头顶留两行给气泡外的小符号。 */
const width = 26;
const height = 20;
/** 每格多少像素。 */
const scale = 3;

type Part = { x: number; y: number; rows: string[] };
type Frame = Part[];

/** 字符 → 颜色类名（chat.css 的 `.crew .px-<名字>`）。`.` 是空格。 */
const ink: Record<string, string> = {
  h: 'brass',
  H: 'brass-deep',
  a: 'brass-light',
  n: 'hair',
  s: 'skin',
  S: 'skin-shade',
  e: 'eye',
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
};

/** 身子放在画布的 (1, 3)。 */
const bodyAt = { x: 1, y: 3 };

const body: string[] = [
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
  '...CCCCCCCC',
  '....pp..pp',
  '...kkk..kkk',
];

/** 眨眼那一格：眼睛换成皮肤色。 */
const blink = body.map((row, y) => (y === 5 ? row.replace(/e/g, 's') : row));
/** 没做成：眼睛垂下来。 */
const downcast = body.map((row, y) => (y === 5 ? row.replace(/e/g, 's') : y === 6 ? '...sSSssSSs' : row));

const book = (lines: string): Part => ({
  x: 2,
  y: 13,
  rows: ['wwwwwowwwww', lines, 'wwwwwowwwww', 'HhhhhhhhhhH'],
});

const slate = (open: boolean, y: number): Part[] => [
  { x: 14, y: open ? y - 1 : y, rows: [open ? '..wwOOww' : 'wwOOwwOO'] },
  { x: 14, y: y + 1, rows: ['OOwwOOww', 'oooooooo', 'oOOOOOOo', 'oOwwwOwo', 'oOOOOOOo', 'oooooooo'] },
];

const reel = (x: number, turned: boolean): Part => ({ x, y: 5, rows: turned ? ['.oo.', 'oa.o', 'o.ao', '.oo.'] : ['.oo.', 'o.ao', 'oa.o', '.oo.'] });

const camera = (turned: boolean, rec: boolean): Frame => [
  reel(14, turned),
  reel(19, turned),
  { x: 14, y: 9, rows: ['oooooooooo', 'oggggggggoaa', rec ? 'ogrggggggoaa' : 'oggggggggoaa', 'oggggggggoaa', 'oooooooooo'] },
  { x: 16, y: 14, rows: ['..o..', '.o.o.', '.o.o.', 'o...o', 'o...o'] },
];

const props: Record<CrewMood, Frame[]> = {
  thinking: [
    [{ x: 14, y: 4, rows: ['a'] }],
    [{ x: 14, y: 4, rows: ['a'] }, { x: 16, y: 2, rows: ['aa', 'aa'] }],
    [{ x: 14, y: 4, rows: ['a'] }, { x: 16, y: 2, rows: ['aa', 'aa'] }, { x: 19, y: 0, rows: ['.a.', 'aaa', '.a.'] }],
    [{ x: 14, y: 4, rows: ['a'] }, { x: 16, y: 2, rows: ['aa', 'aa'] }, { x: 19, y: 0, rows: ['.a.', 'aaa', '.a.'] }],
  ],
  reading: [[book('wlllwowllww')], [book('wwllwowlllw')]],
  writing: [
    [
      { x: 14, y: 10, rows: ['..oo..', 'wwwwww', 'wllllw', 'wwwwww', 'wlwwww', 'wwwwww', 'wwwwww'] },
      { x: 15, y: 11, rows: ['...a', '..a.', '.a..', 'o...'] },
    ],
    [
      { x: 14, y: 10, rows: ['..oo..', 'wwwwww', 'wllllw', 'wwwwww', 'wllwww', 'wwwwww', 'wwwwww'] },
      { x: 16, y: 11, rows: ['...a', '..a.', '.a..', 'o...'] },
    ],
    [
      { x: 14, y: 10, rows: ['..oo..', 'wwwwww', 'wllllw', 'wwwwww', 'wlllww', 'wwwwww', 'wwwwww'] },
      { x: 17, y: 11, rows: ['...a', '..a.', '.a..', 'o...'] },
    ],
  ],
  running: [
    [{ x: 14, y: 7, rows: ['oooooooooo', 'oddddddddo', 'ohdllllddo', 'ohdllldddo', 'ohdadddddo', 'oddddddddo', 'oooooooooo', '...oooo...'] }],
    [{ x: 14, y: 7, rows: ['oooooooooo', 'oddddddddo', 'ohdllllddo', 'ohdllldddo', 'ohdddddddo', 'oddddddddo', 'oooooooooo', '...oooo...'] }],
  ],
  filming: [camera(false, true), camera(true, true), camera(false, false), camera(true, false)],
  waiting: [slate(true, 10), slate(true, 10), slate(true, 9), slate(true, 9)],
  done: [
    [...slate(true, 10), { x: 23, y: 4, rows: ['.a.', 'aaa', '.a.'] }],
    [...slate(false, 10), { x: 22, y: 6, rows: ['a'] }, { x: 24, y: 2, rows: ['a'] }],
  ],
  failed: [[{ x: 14, y: 2, rows: ['r.r', '.r.', 'r.r'] }], [{ x: 14, y: 3, rows: ['r.r', '.r.', 'r.r'] }]],
  stopped: [[{ x: 14, y: 3, rows: ['l.l', 'l.l', 'l.l'] }]],
};

/** 收工时蹦一下；其余动作身子不动，只动手里的东西。 */
const hops: Partial<Record<CrewMood, boolean>> = { done: true };

/** 字符画转成按行合并的矩形，一行同色的连续格子画成一个 rect。 */
function cells(part: Part, dy = 0) {
  const out: ReactElement[] = [];
  part.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const c = row[x];
      const name = ink[c];
      if (!name) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < row.length && row[end] === c) end++;
      out.push(<rect key={`${y}-${x}`} className={'px-' + name} x={part.x + x} y={part.y + y + dy} width={end - x} height={1} />);
      x = end;
    }
  });
  return out;
}

/** 某一种状态的某一格画面。单独导出，便于在别处（例如调样子时）把所有状态排开看。 */
export function CrewSprite({ mood, frame, still }: { mood: CrewMood; frame: number; still?: boolean }) {
  const glow = useId();
  const frames = props[mood];
  const prop = frames[frame % frames.length];
  const dy = hops[mood] && frame % 2 === 1 ? -1 : 0;
  const face = mood === 'failed' ? downcast : !still && frame % 14 === 13 ? blink : body;
  return (
    <svg className="crew-sprite" viewBox={`0 0 ${width} ${height}`} width={width * scale} height={height * scale} shapeRendering="crispEdges" aria-hidden="true">
      <defs>
        <radialGradient id={glow}>
          <stop offset="0" className="px-floor" stopOpacity="0.55" />
          <stop offset="1" className="px-floor" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 脚下一小片黄铜色的光，像放映室里打在场记身上的那一束。 */}
      <ellipse cx={bodyAt.x + 6} cy={height - 0.6} rx={9} ry={1.4} fill={`url(#${glow})`} shapeRendering="auto" />
      {cells({ ...bodyAt, rows: face }, dy)}
      {prop.map((part, index) => (
        <g key={index}>{cells(part)}</g>
      ))}
    </svg>
  );
}

function prefersStill(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function Crew({ turn, asks, scenes }: { turn: TurnBlock | undefined; asks: PermissionAsk[]; scenes: Scene[] }) {
  const [tick, setTick] = useState(0);
  const state = crewState(turn, asks, scenes, Date.now());
  const active = state !== null;
  useEffect(() => {
    if (!active) return;
    // 一轮结束后靠这个计时让小人按时退场；动画也跟着它走。
    const timer = window.setInterval(() => setTick((t) => t + 1), frameMs);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!state) return null;

  const still = prefersStill();
  return (
    <div className="crew" id="crew" data-mood={state.mood} role="status" aria-live="polite" aria-label={state.line}>
      <CrewSprite mood={state.mood} frame={still ? 0 : tick} still={still} />
      <span className="crew-line">{state.line}</span>
    </div>
  );
}
