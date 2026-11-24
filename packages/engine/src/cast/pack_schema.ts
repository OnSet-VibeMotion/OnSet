// 角色包（character pack）的数据类型、常量与 YAML 反序列化结构。
//
// 字段名照抄 Go 的 yaml/json tag（小驼峰）。Go 里是 map、切片、指针的字段在 TS 里允许为 null，
// 对应 Go 的 nil：写 character.json 时它们是 null 而不是 {}，与 Go 版逐字节一致。
import { float, int, ptrFloat, type Schema, str } from '../goyaml/decode';
import { formatG } from './gofmt';

/** 角色包与项目班底共用的 schema 标识。 */
export const SchemaVersion = 'cast/v1';

/** 角色包的清单文件名。 */
export const PackFile = 'character.yaml';

/**
 * Voice 是一个 provider 下的音色声明。
 *
 * 不做跨 provider 映射：MiniMax 的 speed/pitch 与百炼的 rate/instruction
 * 参数名和取值域都不同，硬映射必然错。各家的字段各自可空。
 */
export interface Voice {
  voiceId: string;
  speed: number | null;
  rate: number | null;
  pitch: number | null;
  volume: number | null;
  instruction: string;
}

/** Joint 是一个可动关节。pivot 用 viewBox 的 user unit 绝对坐标。 */
export interface Joint {
  pivot: [number, number];
  rotate: [number, number];
}

/**
 * Rig 描述某一个视图（默认视图，或 views 里的某一个）的骨架：SVG 文件、
 * 画布坐标系与脚底基准线、以及这个视图自己的可动关节。
 *
 * 姿势（Pose）按关节名跨视图共享，但 Joint 本身——pivot 与 rotate 区
 * 间——是逐视图独立声明的，不做跨视图继承：正面与侧面的手臂支点位置、
 * 能转到的角度上限本就不同（透视压缩了侧面的活动范围），硬共享一份会
 * 在某个视图下产出物理上不成立的旋转，且不会在解析期报错。
 */
export interface Rig {
  file: string;
  viewBox: [number, number, number, number];
  baselineY: number;
  joints: Record<string, Joint> | null;
}

/**
 * Scale 只给角色占画面高度的区间，不给定值：具体镜头离摄像机的远近由
 * 排镜头时的创作判断决定，同一个角色在特写与远景里合理的占比本就不同。
 * 校验只保证 0 < lo < hi < 1（见 parsePack），把落在区间内挑哪个值的
 * 决定权留给调用方。
 */
export interface Scale {
  heightRatio: [number, number];
}

/** Pose 是关节名到角度的映射，缺省的关节取 0。 */
export type Pose = Record<string, number>;

/** 每个角色包必须提供的基准姿势。 */
export const IdlePose = 'idle';

/**
 * rig 字段所代表的视图名。它不出现在 views 里，
 * 但 viewNames / view 都把它当作一个正常视图对待，调用方无需分两条路径。
 */
export const DefaultView = 'front';

/**
 * Turn 是一次转身：经过哪些中间视图、总时长多少。
 *
 * 不做自动寻路：哪条路径好看是创作判断，不是图论问题。未声明的组合一律非法。
 */
export interface Turn {
  via: string[] | null;
  durationMs: number;
}

/**
 * Pack 是一个角色包（character.yaml）反序列化后的完整内容：跨 provider
 * 的音色声明、默认视图与可选的多视图 rig、转身路径、缩放区间与姿势库。
 *
 * dir 不参与序列化：它是 parsePack 读取时记下的本机
 * 绝对路径，只用来在同一次调用里定位同目录的 rig.svg 等文件；这条路径
 * 换台机器就失效，写进 character.json 既没有意义，也会泄漏本机目录结构。
 */
export interface Pack {
  dir: string;
  schema: string;
  id: string;
  name: string;
  summary: string;
  voice: Record<string, Voice> | null;
  rig: Rig;
  views: Record<string, Rig> | null;
  turns: Record<string, Turn> | null;
  scale: Scale;
  poses: Record<string, Pose | null> | null;
}

// --- YAML 结构（对应 Go struct 的 yaml tag） ---

const float2: Schema = { kind: 'array', len: 2, elem: float, type: '[2]float64' };
const float4: Schema = { kind: 'array', len: 4, elem: float, type: '[4]float64' };

const voiceSchema: Schema = {
  kind: 'struct',
  type: 'cast.Voice',
  fields: [
    ['voiceId', 'voiceId', str],
    ['speed', 'speed', ptrFloat],
    ['rate', 'rate', ptrFloat],
    ['pitch', 'pitch', ptrFloat],
    ['volume', 'volume', ptrFloat],
    ['instruction', 'instruction', str],
  ],
  zero: () => ({ voiceId: '', speed: null, rate: null, pitch: null, volume: null, instruction: '' }),
};

const jointSchema: Schema = {
  kind: 'struct',
  type: 'cast.Joint',
  fields: [
    ['pivot', 'pivot', float2],
    ['rotate', 'rotate', float2],
  ],
  zero: () => ({ pivot: [0, 0], rotate: [0, 0] }),
};

const rigSchema: Schema = {
  kind: 'struct',
  type: 'cast.Rig',
  fields: [
    ['file', 'file', str],
    ['viewBox', 'viewBox', float4],
    ['baselineY', 'baselineY', float],
    ['joints', 'joints', { kind: 'map', elem: jointSchema, type: 'map[string]cast.Joint' }],
  ],
  zero: () => ({ file: '', viewBox: [0, 0, 0, 0], baselineY: 0, joints: null }),
};

const turnSchema: Schema = {
  kind: 'struct',
  type: 'cast.Turn',
  fields: [
    ['via', 'via', { kind: 'slice', elem: str, type: '[]string' }],
    ['durationMs', 'durationMs', int],
  ],
  zero: () => ({ via: null, durationMs: 0 }),
};

const scaleSchema: Schema = {
  kind: 'struct',
  type: 'cast.Scale',
  fields: [['heightRatio', 'heightRatio', float2]],
  zero: () => ({ heightRatio: [0, 0] }),
};

export const packSchema: Schema & { kind: 'struct' } = {
  kind: 'struct',
  type: 'cast.Pack',
  fields: [
    ['schema', 'schema', str],
    ['id', 'id', str],
    ['name', 'name', str],
    ['summary', 'summary', str],
    ['voice', 'voice', { kind: 'map', elem: voiceSchema, type: 'map[string]cast.Voice' }],
    ['rig', 'rig', rigSchema],
    ['views', 'views', { kind: 'map', elem: rigSchema, type: 'map[string]cast.Rig' }],
    ['turns', 'turns', { kind: 'map', elem: turnSchema, type: 'map[string]cast.Turn' }],
    ['scale', 'scale', scaleSchema],
    [
      'poses',
      'poses',
      { kind: 'map', elem: { kind: 'map', elem: float, type: 'cast.Pose' }, type: 'map[string]cast.Pose' },
    ],
  ],
  zero: () => ({
    dir: '',
    schema: '',
    id: '',
    name: '',
    summary: '',
    voice: null,
    rig: { file: '', viewBox: [0, 0, 0, 0], baselineY: 0, joints: null },
    views: null,
    turns: null,
    scale: { heightRatio: [0, 0] },
    poses: null,
  }),
};

/** Go 的 map 取值：只认自有键（"constructor" 这类原型上的名字不算）。 */
export function own<T>(record: Record<string, T> | null | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Go 的 %v 打印 [N]float64：「[0 0 400 520]」。 */
export function formatFloats(values: readonly number[]): string {
  return `[${values.map(formatG).join(' ')}]`;
}
