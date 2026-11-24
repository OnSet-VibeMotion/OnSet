import type { CrewMood, CrewSignal, PetCommand } from '../chat/crew';
import { clamp, P, type Pt, speed } from './iso';
import type { Pose } from './poses';

// ---- 位置 ----

/** 朝向：朝 +x、朝 -x、朝 -y（后墙）、正对我们。 */
export const toward = { right: 0, left: Math.PI, wall: -Math.PI / 2, viewer: Math.PI / 4, leftWall: Math.PI };

export type Spot = { x: number; y: number; a: number; via: Pt[] };

/** 走廊：后排（机位、剪辑台）与前排（剧本桌、录音棚、沙发）之间的一条线。 */
export const aisle = 3.2;

export const director: Record<string, Spot> = {
  chair: { x: 1.9, y: 2.85, a: toward.viewer, via: [[1.9, aisle]] },
  table: { x: 3.35, y: 3.45, a: toward.viewer, via: [[3.35, aisle]] },
  storyboard: { x: 0.95, y: 3.1, a: toward.leftWall, via: [[0.95, aisle]] },
  console: { x: 1.15, y: 1.2, a: toward.leftWall, via: [[1.15, aisle]] },
  filming: { x: 2.35, y: 2.05, a: -0.6, via: [[2.35, aisle]] },
  editing: { x: 6.3, y: 1.95, a: toward.wall, via: [[6.3, aisle]] },
  voicing: { x: 2.15, y: 5.15, a: toward.left, via: [[2.15, aisle]] },
  front: { x: 4.3, y: 5.0, a: toward.viewer, via: [[4.3, aisle]] },
};

export const directorSpot: Record<CrewMood, keyof typeof director> = {
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

export const directorPose: Record<CrewMood, Pose> = {
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
export const cameras = [3.35, 4.35, 5.35];
export const cameraY = 1.95;
export const operators = [0, 1, 2].map((i) => ({
  seat: {
    x: 5.8 + i * 0.6,
    y: 4.85,
    a: Math.PI / 2,
    via: [
      [5.1, aisle],
      [5.1, 5.35],
      [5.8 + i * 0.6, 5.35],
    ],
  } as Spot,
  camera: { x: cameras[i], y: cameraY + 0.7, a: toward.wall, via: [[cameras[i], aisle]] } as Spot,
}));

// ---- 闲着的时候 ----

export type Prop = 'cup' | 'phone' | 'zzz' | 'notes' | 'script';
export interface IdleAct {
  pose: Pose;
  /** 毫秒：到了位置之后待多久。 */
  dur: [number, number];
  weight: number;
  prop?: Prop;
  /** 制作人：在哪做；摄影：'camera' 表示走到自己的机位前摆弄一下。 */
  at?: keyof typeof director | 'camera';
  /** 坐着时扭头、转椅子的角度（弧度）。 */
  turn?: number;
  swivel?: boolean;
}

/** 制作人闲着时站在沙发左头，和沙发上的摄影聊天。 */
export const chatSpot: Spot = { x: 4.85, y: 4.95, a: toward.right, via: [[4.85, aisle]] };

export const directorIdle: Record<string, IdleAct> = {
  sit: { pose: 'sit', dur: [7000, 13000], weight: 3, at: 'chair' },
  coffee: { pose: 'sitSip', dur: [6000, 10000], weight: 2, at: 'chair', prop: 'cup' },
  doze: { pose: 'doze', dur: [6000, 11000], weight: 1, at: 'chair', prop: 'zzz' },
  script: { pose: 'read', dur: [5000, 9000], weight: 2, at: 'table', prop: 'script' },
  board: { pose: 'look', dur: [4000, 7000], weight: 2, at: 'storyboard' },
  chat: { pose: 'standTalk', dur: [6000, 10000], weight: 2 },
};

export const operatorIdle: Record<string, IdleAct> = {
  sit: { pose: 'sit', dur: [5000, 10000], weight: 3 },
  lean: { pose: 'lean', dur: [5000, 9000], weight: 2 },
  phone: { pose: 'phone', dur: [5000, 10000], weight: 2, prop: 'phone' },
  coffee: { pose: 'sitSip', dur: [5000, 8000], weight: 1, prop: 'cup' },
  doze: { pose: 'doze', dur: [6000, 10000], weight: 1, prop: 'zzz' },
  talk: { pose: 'talk', dur: [4000, 7000], weight: 2, turn: 0.7 },
  check: { pose: 'operate', dur: [3000, 5000], weight: 1, at: 'camera' },
};

export const editorIdle: Record<string, IdleAct> = {
  lean: { pose: 'lean', dur: [5000, 9000], weight: 3 },
  stretch: { pose: 'stretch', dur: [2500, 4000], weight: 1 },
  tinker: { pose: 'type', dur: [3000, 6000], weight: 1 },
  coffee: { pose: 'sitSip', dur: [5000, 8000], weight: 1, prop: 'cup' },
  doze: { pose: 'doze', dur: [6000, 10000], weight: 1, prop: 'zzz' },
  swivel: { pose: 'sit', dur: [4000, 7000], weight: 1, swivel: true },
};

export const voiceIdle: Record<string, IdleAct> = {
  script: { pose: 'script', dur: [6000, 11000], weight: 3 },
  hum: { pose: 'script', dur: [4000, 7000], weight: 2, prop: 'notes' },
  water: { pose: 'sitSip', dur: [4000, 7000], weight: 1, prop: 'cup' },
};

/** 闲着时在做什么的说法（与各人的闲事表一一对应）。 */
export const idleLabels = {
  director: {
    sit: '坐着琢磨',
    coffee: '喝咖啡',
    doze: '打盹',
    script: '翻剧本',
    board: '看分镜板',
    chat: '找摄影聊天',
  } as Record<string, string>,
  operator: {
    sit: '坐着',
    lean: '往后靠着',
    phone: '看手机',
    coffee: '喝咖啡',
    doze: '打盹',
    talk: '聊天',
    check: '摆弄机器',
  } as Record<string, string>,
  editor: {
    lean: '靠着椅背',
    stretch: '伸懒腰',
    tinker: '随手剪着玩',
    coffee: '喝咖啡',
    doze: '打盹',
    swivel: '转椅子',
  } as Record<string, string>,
  voice: { script: '看稿', hum: '哼歌', water: '喝水' } as Record<string, string>,
};

export interface Idler {
  act: string;
  /** 什么时候换下一样；走在路上时为 null，到了才开始计时。 */
  until: number | null;
}

export const between = ([lo, hi]: [number, number]) => lo + Math.random() * (hi - lo);

/** 按权重挑下一样，不重复刚才那样；刚离开默认那样的，一半机会回去。 */
export function nextAct(
  table: Record<string, IdleAct>,
  current: string,
  home: string,
  allowed: (k: string) => boolean = () => true,
): string {
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

export interface Walker {
  x: number;
  y: number;
  a: number;
  spot: Spot;
  path: Pt[];
  travelled: number;
}

export const newWalker = (spot: Spot): Walker => ({ x: spot.x, y: spot.y, a: spot.a, spot, path: [], travelled: 0 });

/** 换目的地：先按来路退回走廊，再沿走廊横过去，最后按新位置的路线走进去。 */
export function retarget(w: Walker, spot: Spot, teleport: boolean): void {
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

export function advance(w: Walker): void {
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

/** 没有对话在跑时的那一份。 */
export const idleSignal: CrewSignal = {
  mood: 'idle',
  line: '待命',
  project: '',
  rendering: [],
  asks: [],
  choices: [],
  question: '',
  running: false,
  canSend: false,
  plan: [],
  turnStarted: '',
  renderSince: {},
  recent: [],
};

export type Who = 'director' | 'op1' | 'op2' | 'op3' | 'editor' | 'voice';
export const opIndex = (who: Who) => Number(who.slice(2)) - 1;

export interface CrewInfo {
  name: string;
  role: string;
  doing: string;
  mood: string;
  /** 需求条；kind 为 time 的是计时（越长越满），不按「低了不好」标红。 */
  needs: { label: string; value: number; note: string; kind?: 'time' }[];
  queue: { text: string; state: string }[];
  scene?: string;
}

export interface PieItem {
  label: string;
  command?: PetCommand;
  /** 打开「说一句」的输入框。 */
  compose?: boolean;
}

export interface Spot2 {
  key: string;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一个站着的人在画布上占的那一块（脚到头顶，左右各留一点）。 */
export function figure(x: number, y: number): { left: number; top: number; width: number; height: number } {
  const foot = P(x, y, 0);
  const head = P(x, y, 1.95);
  return { left: foot[0] - 13, top: head[1] - 4, width: 26, height: foot[1] - head[1] + 8 };
}

/** 两点围出的一块。 */
export function area(a: Pt, b: Pt): { left: number; top: number; width: number; height: number } {
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  return { left, top, width: Math.abs(a[0] - b[0]), height: Math.abs(a[1] - b[1]) };
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 取景不让整间屋子跑出视口：最多挪出去大半，总有一块留在里面。 */
export function clampCam(c: { zoom: number; x: number; y: number }, w: number, h: number) {
  return { zoom: c.zoom, x: clamp(c.x, -w * 0.6, w * 0.6), y: clamp(c.y, -h * 0.6, h * 0.6) };
}

/** 剧组的心情：按此刻在做什么与最近几轮的结果。 */
export function crewMoodOf(signal: CrewSignal): string {
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

/** 昼夜的光：清晨偏冷、白天不加、傍晚偏暖、夜里压暗偏蓝并亮起台灯。 */
export function ambient(now: Date): { part: string; label: string; color: string; opacity: number; lamps: boolean } {
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
