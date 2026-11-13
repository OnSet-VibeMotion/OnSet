// 镜头扩展块的注册表。
//
// scene.json 除了镜头本身的字段，还可以带功能自己的块（多角色对话的 cast、歌曲讲解的 song、
// 卡点的 beat）。功能由内置插件在 apply 里登记它的块（ctx.sceneBlock），内核只遍历注册表，
// 不按名字认识任何一个块。宿主自己的块（还没做成插件的卡点）经 registerBlock 登记。
//
// 块的先后由 order 决定，不由登记顺序决定：scene.json 写回、提示词段、校验与指纹项的先后都按它排。
// timing 是 scene 自己的块，不在表里，固定排在所有扩展块之后。
import { pluginSceneBlocks } from '../plugin/registry';
import type { FieldType } from './jsondecode';
import type { Scene } from './scene';
import { VerificationError } from './verification';

export interface SceneBlock<T = unknown> {
  /** scene.json 里的字段名，也是 Scene 上的属性名；块缺省时属性为 null。 */
  readonly key: string;
  /** 在所有扩展块里的先后，小的在前。 */
  readonly order: number;
  /** 块的结构体解码描述（Go 里是 *T 字段：缺省与 null 都是 null）。 */
  readonly type: FieldType;
  /** 按 Go 的字段顺序与 omitempty 规则构造块的 JSON 值。 */
  toJSON(value: T): unknown;
  /** scene.load 时的校验，块存在时才调用。 */
  validate?(s: Scene, value: T): void;
  /** 块存在时，镜头不能同时带的其他块与报错文案。在 verifyInputs 之前检查。 */
  readonly excludes?: { keys: readonly string[]; message: string };
  /**
   * 渲染前与复用已有产物前的输入校验。块缺省时也调用：项目启用了这项功能、镜头却没有块，同样是错。
   * 失败抛 VerificationError（确定性失败，不重试）。
   */
  verifyInputs?(s: Scene): void;
  /** 本块给出镜头自己的时间轴（与口播的 timing 块互斥）；label 是报错里的称呼。 */
  readonly timeline?: { label: string };
  /** 渲染提示词段，块存在时才调用：接在「视觉自由度」段之后、「时间合同」段之前，按 order 依次拼接。 */
  promptSection?(s: Scene, resolved: Record<string, string>): string;
  /** 块存在时额外记进输入指纹的项（键是 parts 的项名）。 */
  fingerprintParts?(s: Scene, value: T): Record<string, string>;
  /** 块存在时镜头带的记忆特征（memory 的镜头特征词表）：特征名 → 说明。缺省没有。 */
  readonly feature?: { name: string; description: string };
  /** 块存在时，考试重放要另外拷进考场的目录（相对镜头目录，例如角色包）。 */
  extraInputDirs?(s: Scene, value: T): string[];
}

const registry: SceneBlock[] = [];

/**
 * 登记一个镜头扩展块，返回撤销登记的函数（只给测试用）。
 * 键与已有块重名时直接报错；与 scene.json 内核字段重名由 scene 在用到注册表时报错。
 */
export function registerBlock<T>(block: SceneBlock<T>): () => void {
  if (sceneBlocks().some((b) => b.key === block.key)) throw new Error(`镜头扩展块重名：${block.key}`);
  const entry = block as SceneBlock;
  registry.push(entry);
  registry.sort((a, b) => a.order - b.order);
  return () => {
    const i = registry.indexOf(entry);
    if (i >= 0) registry.splice(i, 1);
  };
}

/** 已登记的块（宿主的与内置插件登记的），按 order 排好。 */
export function sceneBlocks(): readonly SceneBlock[] {
  const plugins = pluginSceneBlocks();
  if (plugins.length === 0) return registry;
  return [...registry, ...plugins.map((p) => p.value)].sort((a, b) => a.order - b.order);
}

/** 镜头上某个块的值；没有这个块时为 null。 */
export function blockValue(s: Scene, key: string): unknown {
  return (s as unknown as Record<string, unknown>)[key] ?? null;
}

/** 核对一个块：先查互斥，再跑它自己的输入校验。 */
export function verifyBlock(block: SceneBlock, s: Scene): void {
  if (block.excludes && blockValue(s, block.key) !== null && block.excludes.keys.some((key) => blockValue(s, key) !== null)) {
    throw new VerificationError(s.output, [block.excludes.message]);
  }
  block.verifyInputs?.(s);
}

/** 按 order 核对所有块。 */
export function verifyBlockInputs(s: Scene): void {
  for (const block of sceneBlocks()) verifyBlock(block, s);
}

/** 给出自己时间轴的块（与 timing 互斥），按 order 排好。 */
export function timelineBlocks(): SceneBlock[] {
  return sceneBlocks().filter((b) => b.timeline !== undefined);
}

/** 镜头带的块里给出自己时间轴的那几个（例如歌曲、卡点镜头）。 */
export function sceneTimelineBlocks(s: Scene): SceneBlock[] {
  return timelineBlocks().filter((b) => blockValue(s, b.key) !== null);
}

/** 镜头带的块给出的记忆特征名。 */
export function blockFeatures(s: Scene): string[] {
  return sceneBlocks()
    .filter((b) => b.feature && blockValue(s, b.key) !== null)
    .map((b) => b.feature!.name);
}

/** 镜头带的块要另外拷进考场的目录（相对镜头目录）。 */
export function blockExtraInputDirs(s: Scene): string[] {
  return sceneBlocks().flatMap((b) => {
    const v = blockValue(s, b.key);
    return v !== null && b.extraInputDirs ? b.extraInputDirs(s, v) : [];
  });
}

/** 所有块的提示词段，按 order 拼接。 */
export function blockPromptSections(s: Scene, resolved: Record<string, string>): string {
  let out = '';
  for (const block of sceneBlocks()) {
    if (block.promptSection && blockValue(s, block.key) !== null) out += block.promptSection(s, resolved);
  }
  return out;
}
