//
// Package reads 检查画面上每个可读元素是否给了观众足够的阅读时间。
//
// 生成式动画最常见的失败是节奏：元素一个接一个飞快出现，作者知道它写了什么，
// 观众只看一遍、第一次看，没读完就切走了。制作流程要求为每个可读元素记下
// 可读区间（visible-event-inventory.json），但过去只是写下来，没有任何环节
// 去算「这段时间够不够读完这些字」。
//
// 默认阈值取自 Netflix 简体中文字幕规范：成人节目每秒不超过 9 个字，每条至少
// 显示 5/6 秒。字幕是观众已经在盯着的固定位置，MG 画面里的元素还要先被找到，
// 所以这是下限中的下限——宁可漏判，不可误判。
import fs from 'node:fs';
import { attachApprovedCover } from './approvals';
import { type StructType, unmarshal } from './decode';
import { type Event, type Inventory, newEvent, newPhrase, type Phrase, type Timeline } from './types';

export { check, requiredFrames, units } from './check';
export {
  DecorativeRole,
  Defaults,
  type Event,
  type EventResult,
  type Finding,
  type Inventory,
  newEvent,
  newPhrase,
  type Options,
  type Phrase,
  type Report,
  ReportSchemaVersion,
  RuleBinding,
  RuleDuration,
  RuleFrames,
  RuleIdentity,
  RuleOrder,
  RuleSpoiler,
  RuleTimeline,
  ruleIDs,
  type Timeline,
  writeJSON,
} from './types';

const eventType: StructType = {
  kind: 'struct',
  goName: 'reads.Event',
  fields: [
    { json: 'event_id', name: 'event_id', type: 'string' },
    { json: 'scene_id', name: 'scene_id', type: 'string' },
    { json: 'selector', name: 'selector', type: 'string' },
    { json: 'text', name: 'text', type: 'string' },
    { json: 'role', name: 'role', type: 'string' },
    { json: 'phrase_id', name: 'phrase_id', type: 'string' },
    { json: 'enter_frame', name: 'enter_frame', type: 'int' },
    { json: 'readable_start_frame', name: 'readable_start_frame', type: 'int' },
    { json: 'readable_end_frame_exclusive', name: 'readable_end_frame_exclusive', type: 'int' },
    { json: 'exit_end_frame', name: 'exit_end_frame', type: 'int' },
  ],
};

const inventoryType: StructType = {
  kind: 'struct',
  goName: 'reads.Inventory',
  fields: [
    { json: 'schema', name: 'schema', type: 'int' },
    { json: 'fps', name: 'fps', type: 'int' },
    { json: 'events', name: 'events', type: { kind: 'slice', elem: eventType } },
  ],
};

const phraseType: StructType = {
  kind: 'struct',
  goName: 'reads.Phrase',
  fields: [
    { json: 'phrase_id', name: 'phrase_id', type: 'string' },
    { json: 'semantic_order', name: 'semantic_order', type: 'int' },
    { json: 'start_frame', name: 'start_frame', type: 'int' },
    { json: 'end_frame_exclusive', name: 'end_frame_exclusive', type: 'int' },
  ],
};

const timelineType: StructType = {
  kind: 'struct',
  goName: 'reads.Timeline',
  fields: [
    { json: 'fps', name: 'fps', type: 'int' },
    { json: 'phrases', name: 'phrases', type: { kind: 'slice', elem: phraseType } },
  ],
};

/** LoadInventory 读取并做结构校验。 */
export function loadInventory(path: string, options: { allowEmpty?: boolean } = {}): Inventory {
  const raw = readJSON(path, inventoryType);
  const inv: Inventory = {
    schema: (raw.schema as number | undefined) ?? 0,
    fps: (raw.fps as number | undefined) ?? 0,
    events: ((raw.events as Array<Partial<Event>> | undefined) ?? []).map((e) => newEvent(e)),
  };
  if (inv.fps <= 0) {
    throw new Error(`${path} 缺少正整数 fps`);
  }
  if (inv.events.length === 0 && !(options.allowEmpty && inv.schema === 1 && Array.isArray(raw.events))) {
    throw new Error(`${path} 的 events 为空`);
  }
  return attachApprovedCover(inv, path);
}

/** LoadTimeline 读取短语时间轴。 */
export function loadTimeline(path: string): Timeline {
  const raw = readJSON(path, timelineType);
  const t: Timeline = {
    fps: (raw.fps as number | undefined) ?? 0,
    phrases: ((raw.phrases as Array<Partial<Phrase>> | undefined) ?? []).map((p) => newPhrase(p)),
  };
  if (t.phrases.length === 0) {
    throw new Error(`${path} 的 phrases 为空`);
  }
  return t;
}

const errnoText: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EACCES: 'permission denied',
  EISDIR: 'is a directory',
  ENOTDIR: 'not a directory',
};

function readJSON(path: string, t: StructType): Record<string, unknown> {
  let body: Buffer;
  try {
    body = fs.readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = (code && errnoText[code]) || (err instanceof Error ? err.message : String(err));
    // Go：fmt.Errorf("无法读取 %s：%w", path, err)，err 是 *PathError「open <path>: <原因>」。
    // 读目录时 Go 的 ReadFile 报的是 read 而不是 open。
    const op = code === 'EISDIR' ? 'read' : 'open';
    throw new Error(`无法读取 ${path}：${op} ${path}: ${reason}`, { cause: err });
  }
  try {
    return unmarshal(body, t);
  } catch (err) {
    throw new Error(`${path} 不是合法 JSON 或字段类型不符：${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}
