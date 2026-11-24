// 角色包（character pack）规范的唯一真相源。
//
// onset 不内置任何角色：这个包只定义格式、解析它、并拦住那些会在渲染阶段
// 静默坏掉的写法。角色包由 onset cast add 从外部拷进项目。
import fs from 'node:fs';
import path from 'node:path';
import { compareBytes, marshalIndent, sortedKeys } from '../gojson';
import { unmarshal } from '../goyaml/decode';
import { formatG, goQuote, pathError } from './gofmt';
import {
  DefaultView,
  formatFloats,
  IdlePose,
  type Joint,
  own,
  type Pack,
  PackFile,
  type Pose,
  packSchema,
  type Rig,
  type Scale,
  SchemaVersion,
  type Turn,
  type Voice,
} from './pack_schema';
import { validateRig } from './rig';

export {
  DefaultView,
  formatFloats,
  IdlePose,
  type Joint,
  own,
  type Pack,
  PackFile,
  type Pose,
  type Rig,
  type Scale,
  SchemaVersion,
  type Turn,
  type Voice,
};

const idPattern = /^[a-z][a-z0-9-]*$/;
const idPatternText = '^[a-z][a-z0-9-]*$';

/** turns 的键必须写成 <from>-><to>。 */
const turnKeyPattern = /^([a-z][a-z0-9-]*)->([a-z][a-z0-9-]*)$/;

/**
 * 只解析并校验 character.yaml 本身，不碰 rig.svg。
 * 完整校验走 load。
 */
export function parsePack(dir: string): Pack {
  const file = path.join(dir, PackFile);
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读取角色包清单失败：${pathError('open', file, err)}`, { cause: err });
  }
  let pack: Pack;
  try {
    pack = unmarshal<Pack>(body, packSchema);
  } catch (err) {
    throw new Error(`解析 ${PackFile} 失败：${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  pack.dir = dir;
  if (pack.schema !== SchemaVersion)
    throw new Error(`角色包 schema 必须是 ${SchemaVersion}，收到 ${goQuote(pack.schema)}`);
  if (!idPattern.test(pack.id)) throw new Error(`角色包 id 必须匹配 ${idPatternText}，收到 ${goQuote(pack.id)}`);
  if (pack.name === '') throw new Error(`角色包 ${pack.id} 缺少 name`);
  if (Object.keys(pack.voice ?? {}).length === 0) throw new Error(`角色包 ${pack.id} 没有声明任何音色`);
  validateRigFields(pack.id, DefaultView, pack.rig);
  if (own(pack.views, DefaultView) !== undefined) {
    throw new Error(`角色包 ${pack.id} 的 views 不能再声明 ${DefaultView}，它已经是 rig 字段代表的默认视图`);
  }
  for (const [name, view] of Object.entries(pack.views ?? {})) validateRigFields(pack.id, name, view);
  const [lo, hi] = pack.scale.heightRatio;
  if (lo <= 0 || hi <= lo || hi >= 1) {
    throw new Error(
      `角色包 ${pack.id} 的 heightRatio 必须满足 0 < lo < hi < 1，收到 ${formatFloats(pack.scale.heightRatio)}`,
    );
  }
  if (!pack.poses || !Object.hasOwn(pack.poses, IdlePose))
    throw new Error(`角色包 ${pack.id} 必须提供 ${IdlePose} 姿势作为基准`);
  const names = viewNames(pack);
  for (const [poseName, pose] of Object.entries(pack.poses)) {
    for (const [jointName, angle] of Object.entries(pose ?? {})) {
      const joint = own(pack.rig.joints, jointName);
      if (!joint) throw new Error(`角色包 ${pack.id} 姿势 ${poseName} 引用了未声明的关节 ${jointName}`);
      if (angle < joint.rotate[0] || angle > joint.rotate[1]) {
        throw new Error(
          `角色包 ${pack.id} 姿势 ${poseName} 的关节 ${jointName} 角度 ${formatG(angle)} 在视图 ${DefaultView} 里超出区间 ${formatFloats(joint.rotate)}`,
        );
      }
      // 姿势跨视图共享，但关节是每视图独立声明的：同一个姿势换个视图，
      // 用到的关节必须在那个视图里也存在，且角度落在那个视图自己的
      // rotate 区间内。漏了这条检查，角色一转身某个姿势就会静默失效。
      for (const viewName of names) {
        if (viewName === DefaultView) continue;
        const viewJoint = own(own(pack.views, viewName)?.joints ?? null, jointName);
        if (!viewJoint)
          throw new Error(`角色包 ${pack.id} 姿势 ${poseName} 的关节 ${jointName} 在视图 ${viewName} 里没有声明`);
        if (angle < viewJoint.rotate[0] || angle > viewJoint.rotate[1]) {
          throw new Error(
            `角色包 ${pack.id} 姿势 ${poseName} 的关节 ${jointName} 角度 ${formatG(angle)} 在视图 ${viewName} 里超出区间 ${formatFloats(viewJoint.rotate)}`,
          );
        }
      }
    }
  }
  validateTurns(pack.id, pack.turns, names);
  return pack;
}

/**
 * 校验一个 rig（不论是默认视图的 rig 字段，还是 views 里的
 * 某个视图）本身的字段是否完整合法。viewName 只用来让错误信息点出问题出在
 * 哪个视图，不参与校验逻辑。
 */
function validateRigFields(id: string, viewName: string, rig: Rig): void {
  if (rig.file === '') throw new Error(`角色包 ${id} 的视图 ${viewName} 缺少 file`);
  if (Object.keys(rig.joints ?? {}).length === 0) throw new Error(`角色包 ${id} 的视图 ${viewName} 没有声明任何关节`);
  for (const [name, joint] of Object.entries(rig.joints ?? {})) {
    if (joint.rotate[0] >= joint.rotate[1]) {
      throw new Error(`角色包 ${id} 的视图 ${viewName} 关节 ${name} 的 rotate 区间无效：${formatFloats(joint.rotate)}`);
    }
  }
  // 这里不像 internal/scene 对 beats 时间戳那样加浮点容差：baselineY 与
  // viewBox 都是角色作者手写在 YAML 里的字面量，不是加减法运算的中间结
  // 果，不存在误差累积会把一个本该合法的值判成越界。等号边界本身也该
  // 拒绝——baselineY 恰好落在视口顶/上边缘意味着脚底基准线与画布边缘
  // 重合，姿势稍有偏移（比如抬腿）就会出画。
  if (rig.baselineY <= rig.viewBox[1] || rig.baselineY > rig.viewBox[1] + rig.viewBox[3]) {
    throw new Error(`角色包 ${id} 的视图 ${viewName} 的 baselineY=${formatG(rig.baselineY)} 落在 viewBox 之外`);
  }
}

/**
 * 校验 turns 声明：键必须匹配 <from>-><to>，from/to/via 引用的
 * 视图都必须已经声明过，durationMs 必须为正。
 */
function validateTurns(id: string, turns: Record<string, Turn> | null, names: string[]): void {
  const known = new Set(names);
  for (const [key, turn] of Object.entries(turns ?? {})) {
    const m = turnKeyPattern.exec(key);
    if (!m) throw new Error(`角色包 ${id} 的 turns 键 ${goQuote(key)} 格式不对，必须是 <from>-><to>`);
    const [, from, to] = m;
    if (!known.has(from)) throw new Error(`角色包 ${id} 的 turns ${goQuote(key)} 引用了未声明的视图 ${from}`);
    if (!known.has(to)) throw new Error(`角色包 ${id} 的 turns ${goQuote(key)} 引用了未声明的视图 ${to}`);
    for (const via of turn.via ?? []) {
      if (!known.has(via)) throw new Error(`角色包 ${id} 的 turns ${goQuote(key)} 的 via 引用了未声明的视图 ${via}`);
    }
    if (turn.durationMs <= 0)
      throw new Error(`角色包 ${id} 的 turns ${goQuote(key)} 的 durationMs 必须大于 0，收到 ${turn.durationMs}`);
  }
}

/** 按名字返回视图，DefaultView（或空串）回落到 rig 字段。 */
export function view(p: Pack, name: string): Rig {
  if (name === '' || name === DefaultView) return p.rig;
  const found = own(p.views, name);
  if (!found) throw new Error(`角色 ${p.id} 没有视图 ${name}`);
  return found;
}

/**
 * 全部视图名（含默认视图），去重后排序，便于确定性遍历。
 *
 * 去重是这个函数契约的一部分，不外包给调用方保证：parsePack 会挡掉 views
 * 里出现 DefaultView 的写法，但调用方也可能绕过 parsePack 直接手工构造
 * Pack（测试 fixture 就很常见），这时 views 仍可能意外带上 DefaultView。
 * 不去重的话，下游按 viewNames() 逐视图渲染或校验时会悄悄把同一个视图
 * 处理两遍，且不报错。
 */
export function viewNames(p: Pick<Pack, 'views'>): string[] {
  const names = new Set<string>([DefaultView, ...Object.keys(p.views ?? {})]);
  return [...names].sort(compareBytes);
}

/** 指定 provider 的音色声明。 */
export function voiceFor(p: Pack, provider: string): Voice {
  const voice = own(p.voice, provider);
  if (!voice) throw new Error(`角色 ${p.id} 没有声明 ${provider} 的音色`);
  if (voice.voiceId === '') throw new Error(`角色 ${p.id} 的 ${provider} 音色缺少 voiceId`);
  return voice;
}

/*
 * 错误信息按"角色包 -> 视图 -> 具体问题"三层列出，每往下一层多缩进 4 个
 * 空格。bulletIndentN 把这层关系落成命名常量，而不是把 "\n  - "、
 * "\n      - " 这种缩进散落在两处字符串字面量里靠肉眼对齐——以后要加第四层
 * （比如按 SVG 元素再细分问题），照着加一个
 * bulletIndent4 = bulletIndent3 + "    " 就行，不用重新数空格核对两层是否对齐。
 */
const bulletIndent2 = '\n  - '; // 第二层：角色包下面按视图分组
const bulletIndent3 = '\n      - '; // 第三层：分组内的具体问题，比第二层多缩进 4 格

/**
 * 解析角色包并校验每一个视图的 rig，是外部唯一该用的入口。
 *
 * 逐视图校验、逐视图报错：三个视图的 rig 各自独立成图，一个视图混进自走
 * 动画不代表另外两个也有问题。把问题按视图分组聚合进同一个错误里一次报出
 * 全部，而不是每个视图各自的错误信息里不点名是哪个视图——不然三个视图都
 * 报"rig 有问题"，人不知道该改哪个文件。
 */
export function load(dir: string): Pack {
  const pack = parsePack(dir);
  const groups: string[] = [];
  for (const viewName of viewNames(pack)) {
    const rig = view(pack, viewName);
    const problems = validateRig(path.join(dir, rig.file), rig);
    if (problems.length === 0) continue;
    groups.push(
      `视图 ${viewName}（${rig.file}）有 ${problems.length} 处问题：${bulletIndent3}${problems.join(bulletIndent3)}`,
    );
  }
  if (groups.length > 0) {
    throw new Error(`角色包 ${pack.id} 的 rig 校验未通过：${bulletIndent2}${groups.join(bulletIndent2)}`);
  }
  return pack;
}

function mapJSON<T>(record: Record<string, T> | null, convert: (value: T) => unknown): unknown {
  if (record === null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) out[key] = convert(value);
  return sortedKeys(out);
}

function rigJSON(rig: Rig): unknown {
  return {
    file: rig.file,
    viewBox: rig.viewBox,
    baselineY: rig.baselineY,
    joints: mapJSON(rig.joints, (joint) => ({ pivot: joint.pivot, rotate: joint.rotate })),
  };
}

/** 按 Go 的 struct 字段顺序（map 按键排序、nil 为 null、不含 dir）构造 Pack 的 JSON 值。 */
export function packToJSON(p: Pack): unknown {
  return {
    schema: p.schema,
    id: p.id,
    name: p.name,
    summary: p.summary,
    voice: mapJSON(p.voice, (v) => ({
      voiceId: v.voiceId,
      speed: v.speed,
      rate: v.rate,
      pitch: v.pitch,
      volume: v.volume,
      instruction: v.instruction,
    })),
    rig: rigJSON(p.rig),
    views: mapJSON(p.views, rigJSON),
    turns: mapJSON(p.turns, (turn) => ({ via: turn.via, durationMs: turn.durationMs })),
    scale: { heightRatio: p.scale.heightRatio },
    poses: mapJSON(p.poses, (pose) => mapJSON(pose, (angle) => angle)),
  };
}

/**
 * 把角色包序列化成 character.json，写进 dir。
 *
 * 驱动库 cast.js 要在浏览器里读角色包：渲染机是干净的无头 Chrome，CSP 下引不进
 * YAML 解析库，手写 YAML 子集解析器纯属埋雷。character.yaml 仍是人工编辑的
 * 唯一真相源，character.json 是每次校验（onset cast new/add/validate）都重新
 * 生成的产物，用 JSON.parse 读。dir 是本机绝对路径，不该进产物。
 */
export function writePackJSON(p: Pack, dir: string): void {
  const body = marshalIndent(packToJSON(p));
  const file = path.join(dir, 'character.json');
  try {
    fs.writeFileSync(file, body, { mode: 0o644 });
  } catch (err) {
    throw new Error(`写出 character.json 失败：${pathError('open', file, err)}`, { cause: err });
  }
}
