import fs from 'node:fs';
import path from 'node:path';
import { goPathError, goQuote } from '../gofmt';
import { ValidRenderers } from '../tools';
import { blockValue, sceneBlocks } from './block';
import { verifyComponentNames } from './components';
import { type FieldType, ptrTo, type StructType, sliceOf, topLevelKeys, unmarshal } from './jsondecode';
import type { Scene } from './scene';
import { contained, isRegularFile, verifySceneText } from './scene_paths';
import { timingStructType, timingToJSON, verifyFilmStyleValue } from './timing';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * requiredSceneFields、optionalSceneFields 加上已登记的镜头扩展块（block.ts）是 scene.json 字段契约的唯一真相源：
 * Load 的未知字段/缺字段校验、以及 cli 里 `onset scene --help` 的说明文字
 * 都从这里派生，不再各写一份、彼此漂移。扩展块排在 plugin_skills 之后、timing 之前。
 */
const requiredSceneFields = ['id', 'duration_seconds', 'output', 'transcript', 'text'];
const optionalSceneFields = ['renderer', 'film_style', 'plugin_skills', 'components'];
/** scene 自己的 timing 块，固定排在所有扩展块之后。 */
const timingField = 'timing';

/** 已登记的扩展块；与内核字段重名时报错。 */
function blocks() {
  const list = sceneBlocks();
  for (const b of list) {
    if (requiredSceneFields.includes(b.key) || optionalSceneFields.includes(b.key) || b.key === timingField) {
      throw new Error(`镜头扩展块与 scene.json 的内核字段重名：${b.key}`);
    }
  }
  return list;
}

/** RequiredFields 返回 scene.json 的必填字段名（副本，调用方可自由修改）。 */
export function requiredFields(): string[] {
  return [...requiredSceneFields];
}

/** OptionalFields 返回 scene.json 的可选字段名（副本，调用方可自由修改）。 */
export function optionalFields(): string[] {
  return [...optionalSceneFields, ...blocks().map((b) => b.key), timingField];
}

function allowedSceneFields(): Set<string> {
  return new Set([...requiredSceneFields, ...optionalFields()]);
}

/** scene.json 的解码描述：内核字段、已登记的扩展块（*T），最后是 timing。 */
function sceneType(): StructType {
  return {
    kind: 'struct',
    goName: 'scene.Scene',
    name: 'Scene',
    fields: [
      ['id', 'string'],
      ['duration_seconds', 'float'],
      ['output', 'string'],
      ['transcript', 'string'],
      ['text', 'string'],
      ['renderer', 'string'],
      ['film_style', 'string'],
      ['plugin_skills', sliceOf('string')],
      ['components', sliceOf('string')],
      ...blocks().map((b): [string, FieldType] => [b.key, ptrTo(b.type)]),
      [timingField, ptrTo(timingStructType)],
    ],
  };
}

/** 零值镜头（Go 的 Scene{}），测试与调用方构造镜头时用。 */
export function newScene(fields: Partial<Scene> = {}): Scene {
  const zero: Record<string, unknown> = {
    directory: '',
    id: '',
    duration_seconds: 0,
    output: '',
    transcript: '',
    text: '',
    renderer: '',
    film_style: '',
    plugin_skills: [],
    components: [],
  };
  for (const b of blocks()) zero[b.key] = null;
  return {
    ...zero,
    timing: null,
    retryNote: '',
    examNote: '',
    seam: null,
    continuation: null,
    fresh: false,
    renderWorkers: 0,
    memory: null,
    afterAttempt: null,
    ...fields,
  } as Scene;
}

/** 按 Go 的字段顺序与 omitempty 规则构造 Scene 的 JSON 值（json.Marshal(scene)）。 */
export function sceneToJSON(s: Scene): unknown {
  const out: Record<string, unknown> = {
    id: s.id,
    duration_seconds: s.duration_seconds,
    output: s.output,
    transcript: s.transcript,
    text: s.text,
    renderer: s.renderer || undefined,
    film_style: s.film_style || undefined,
    plugin_skills: s.plugin_skills.length > 0 ? s.plugin_skills : undefined,
    components: s.components.length > 0 ? s.components : undefined,
  };
  for (const b of blocks()) {
    const value = blockValue(s, b.key);
    out[b.key] = value !== null ? b.toJSON(value) : undefined;
  }
  out[timingField] = s.timing ? timingToJSON(s.timing) : undefined;
  return out;
}

export function load(directory: string): Scene {
  const file = path.join(directory, 'scene.json');
  let body: Buffer;
  try {
    body = fs.readFileSync(file);
  } catch (err) {
    throw new Error(`找不到或无法读取 scene.json：${goPathError('open', file, err)}`, { cause: err });
  }
  let keys: string[] | null;
  try {
    keys = topLevelKeys(body);
  } catch (err) {
    throw new Error(`scene.json 不是合法 JSON：${(err as Error).message}`, { cause: err });
  }
  const allowed = allowedSceneFields();
  for (const key of keys ?? []) {
    if (!allowed.has(key)) throw new Error(`scene.json 含未知字段：${key}`);
  }
  const present = new Set(keys ?? []);
  for (const key of requiredSceneFields) {
    if (!present.has(key)) throw new Error(`scene.json 缺少必填字段：${key}`);
  }
  let decoded: Omit<
    Scene,
    | 'directory'
    | 'retryNote'
    | 'examNote'
    | 'seam'
    | 'continuation'
    | 'fresh'
    | 'renderWorkers'
    | 'memory'
    | 'afterAttempt'
  >;
  try {
    decoded = unmarshal(body, sceneType());
  } catch (err) {
    throw new Error(`scene.json 字段类型非法：${(err as Error).message}`, { cause: err });
  }
  const result: Scene = newScene({ ...decoded, directory: path.resolve(directory) });
  if (
    Buffer.byteLength(result.id) > 100 ||
    result.id.startsWith('-') ||
    result.id === '.' ||
    result.id === '..' ||
    !idPattern.test(result.id)
  ) {
    throw new Error(`id 不是安全文件名：${goQuote(result.id)}`);
  }
  if (!Number.isFinite(result.duration_seconds) || result.duration_seconds < 1.0 / 30.0) {
    throw new Error('duration_seconds 必须是至少一帧的有限正数');
  }
  verifySceneText(result.text);
  contained(result.directory, result.output, 'output');
  const transcript = contained(result.directory, result.transcript, 'transcript');
  if (!isRegularFile(transcript)) throw new Error(`transcript 指向的文件不存在：${result.transcript}`);
  if (result.renderer !== '' && !ValidRenderers.has(result.renderer))
    throw new Error(`无效的 renderer：${result.renderer}`);
  verifyFilmStyleValue(result.film_style);
  result.plugin_skills = result.plugin_skills ?? [];
  for (const ref of result.plugin_skills) {
    if (!/^[a-z][a-z0-9-]{1,39}\/[a-z][a-z0-9-]*$/.test(ref))
      throw new Error(`plugin_skills 的每一项要写成「插件 id/技能名」：${goQuote(ref)}`);
  }
  result.components = result.components ?? [];
  verifyComponentNames(result.components);
  for (const b of blocks()) {
    const value = blockValue(result, b.key);
    if (value !== null) b.validate?.(result, value);
  }
  return result;
}
