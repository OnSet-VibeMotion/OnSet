import fs from 'node:fs';
import path from 'node:path';
import { checkValid } from '../gojson/decode';
import { formatG, goPathError } from '../gofmt';
import { sceneDirs } from '../schedule';
import { ptrTo, unmarshal, type StructType } from '../scene/jsondecode';

/**
 * 本命令需要知道的全部镜头信息：它在哪、叫什么、多长、有没有
 * cast 块。既有的 cast.beats 不在其中，这是刻意的。
 */
export interface SceneHead {
  dir: string;
  id: string;
  duration: number;
  hasCast: boolean;
}

const headType: StructType = {
  kind: 'struct',
  goName: 'struct { ID string "json:\\"id\\""; DurationSeconds *float64 "json:\\"duration_seconds\\""; Cast json.RawMessage "json:\\"cast\\"" }',
  name: '',
  fields: [
    ['id', 'string'],
    ['duration_seconds', ptrTo('float')],
  ],
};

/**
 * json.RawMessage 字段 cast：键名先精确、再不区分大小写匹配，后出现的覆盖先出现的；
 * 原文非空且不是 null 才算有 cast 块。
 */
function hasCastBlock(body: string): boolean {
  const value = JSON.parse(body) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  let found: unknown = undefined;
  let present = false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'cast' || key.toLowerCase() === 'cast') {
      found = item;
      present = true;
    }
  }
  return present && found !== null;
}

/**
 * 按 schedule.sceneDirs 给出的顺序读出各镜头，只解析上面那几个字段。
 *
 * 刻意不走 schedule.plan（也就是不走 scene.load）：plan 会连带校验既有的
 * cast.beats，而 beats 是本命令的输出、不是它的输入。把 duration_seconds
 * 改小、旧节拍还越界时，scene.load 会拒绝这份 scene.json——而本命令正是
 * 修它的工具，跟着 plan 走就是把工具自己锁在门外，用户只剩手改 JSON 一条
 * 路。忽略既有节拍之后，重跑天然幂等，越界与否与本命令无关。
 *
 * 顺序仍然来自 schedule.sceneDirs，与 plan 同源：这里放弃的只是"读哪些
 * 字段"，不是"镜头谁先谁后"——后者有第二条路径才是真问题。
 *
 * 代价：本命令不再对损坏的 scene.json 做完整校验。这不留缺口——渲染前的
 * scene.load 与 am validate cast 仍然会拦下越界节拍与其它非法字段，本命令
 * 只是不在这一步重复拦一次。
 */
export function readSceneHeads(scenesDir: string): SceneHead[] {
  let dirs: string[];
  try {
    dirs = sceneDirs(scenesDir);
  } catch (err) {
    throw new Error(`读取镜头目录失败：${(err as Error).message}`, { cause: err });
  }
  const heads: SceneHead[] = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'scene.json');
    let body: Buffer;
    try {
      body = fs.readFileSync(file);
    } catch (err) {
      throw new Error(`读取 ${file} 失败：${goPathError('open', file, err)}`, { cause: err });
    }
    let parsed: { id: string; duration_seconds: number | null };
    try {
      parsed = unmarshal(body, headType);
    } catch (err) {
      throw new Error(`${file} 不是合法 JSON：${(err as Error).message}`, { cause: err });
    }
    if (parsed.id === '') throw new Error(`${file} 缺少 id`);
    if (parsed.duration_seconds === null) throw new Error(`${file} 缺少 duration_seconds`);
    const duration = parsed.duration_seconds;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`${file} 的 duration_seconds 必须是有限正数，收到 ${formatG(duration)}`);
    }
    heads.push({ dir, id: parsed.id, duration, hasCast: checkValid(body) === null && hasCastBlock(body.toString('utf8')) });
  }
  return heads;
}
