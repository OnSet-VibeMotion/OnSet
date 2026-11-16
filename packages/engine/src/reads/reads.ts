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
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import { unmarshal } from './decode';
import type { StructType } from './decode';
import { attachApprovedCover } from './approvals';

/** Event 是 visible-event-inventory.json 里的一个可读元素。帧号都是全片全局帧。 */
export interface Event {
  event_id: string;
  scene_id: string;
  selector: string;
  text: string;
  role: string;
  phrase_id: string;
  enter_frame: number;
  readable_start_frame: number;
  readable_end_frame_exclusive: number;
  exit_end_frame: number;
}

/** Inventory 是 visible-event-inventory.json 的结构。 */
export interface Inventory {
  schema: number;
  fps: number;
  events: Event[];
  /** 只由文件加载器根据实际批准记录填入，不从清单的自述直接采信。 */
  approvedCover?: { ids: ReadonlySet<string>; approval: string };
}

/** Phrase 是 phrase-timeline.json 里本检查用到的字段。 */
export interface Phrase {
  phrase_id: string;
  semantic_order: number;
  start_frame: number;
  end_frame_exclusive: number;
}

/** Timeline 是 phrase-timeline.json 的结构（与 internal/song 导出的一致）。 */
export interface Timeline {
  fps: number;
  phrases: Phrase[];
}

/** 补齐 Go 零值，方便测试与调用方只写关心的字段。 */
export function newEvent(fields: Partial<Event> = {}): Event {
  return {
    event_id: '',
    scene_id: '',
    selector: '',
    text: '',
    role: '',
    phrase_id: '',
    enter_frame: 0,
    readable_start_frame: 0,
    readable_end_frame_exclusive: 0,
    exit_end_frame: 0,
    ...fields,
  };
}

/** 补齐 Go 零值。 */
export function newPhrase(fields: Partial<Phrase> = {}): Phrase {
  return { phrase_id: '', semantic_order: 0, start_frame: 0, end_frame_exclusive: 0, ...fields };
}

/** DecorativeRole 的元素不承载信息，不检查阅读时间。 */
export const DecorativeRole = 'decorative';

/** Options 是阅读时间判据。 */
export interface Options {
  charsPerSecond: number;
  minSeconds: number;
  /** crowdSeconds：两个可读元素的可读起点相距不到这么久，视为同时出现。 */
  crowdSeconds: number;
}

/**
 * Defaults 见包注释的出处。crowdSeconds 取 0.3 秒：视线在画面上找到一个新元素
 * 大约要这么久，再短就是同时出现。
 */
export const Defaults: Options = { charsPerSecond: 9, minSeconds: 5.0 / 6.0, crowdSeconds: 0.3 };

/** EventResult 是单个元素的检查结果。 */
export interface EventResult {
  event_id: string;
  units: number;
  readable_frames: number;
  required_frames: number;
}

/** Finding 是一条问题的结构化形式。scene_id 为空表示不属于某个镜头（例如清单级的错误）。 */
export interface Finding {
  rule: string;
  event_id?: string;
  scene_id?: string;
  message: string;
}

/** Report 是机器可读结果。ok 只由 problems 决定。 */
export interface Report {
  schema_version: number;
  ok: boolean;
  fps: number;
  events: EventResult[];
  problems: string[];
  /**
   * findings 与 problems 一一对应，给出问题属于哪个镜头、哪条规则；
   * 渲染记忆按它把阅读问题记到对应镜头上。
   */
  findings: Finding[];
  hints?: string[];
}

// 规则 ID。渲染记忆引用的是加了 reads. 前缀的形式，见 RuleIDs。
export const RuleDuration = 'duration';
export const RuleSpoiler = 'spoiler';
export const RuleOrder = 'order';
export const RuleBinding = 'binding';
export const RuleFrames = 'frames';
export const RuleIdentity = 'identity';
export const RuleTimeline = 'timeline';

/** RuleIDs 返回全部规则 ID，顺序固定。 */
export function ruleIDs(): string[] {
  return [RuleDuration, RuleSpoiler, RuleOrder, RuleBinding, RuleFrames, RuleIdentity, RuleTimeline];
}

function fail(r: Report, rule: string, e: Event | null, message: string): void {
  const f: Finding = { rule, message };
  if (e !== null) {
    f.event_id = e.event_id;
    f.scene_id = e.scene_id;
  }
  r.problems.push(message);
  r.findings.push(f);
}

/** ReportSchemaVersion 是 Report 的结构版本。 */
export const ReportSchemaVersion = 1;

/** WriteJSON 原子写出报告。 */
export function writeJSON(r: Report, target: string): void {
  const body = marshalIndent({
    schema_version: r.schema_version,
    ok: r.ok,
    fps: r.fps,
    events: r.events ?? null,
    problems: r.problems ?? null,
    findings: r.findings
      ? r.findings.map((f) => ({
          rule: f.rule,
          event_id: f.event_id ? f.event_id : undefined,
          scene_id: f.scene_id ? f.scene_id : undefined,
          message: f.message,
        }))
      : null,
    hints: r.hints && r.hints.length > 0 ? r.hints : undefined,
  });
  atomicWrite(target, body + '\n', 0o644);
}

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
export function loadInventory(path: string): Inventory {
  const raw = readJSON(path, inventoryType);
  const inv: Inventory = {
    schema: (raw.schema as number | undefined) ?? 0,
    fps: (raw.fps as number | undefined) ?? 0,
    events: ((raw.events as Array<Partial<Event>> | undefined) ?? []).map((e) => newEvent(e)),
  };
  if (inv.fps <= 0) {
    throw new Error(`${path} 缺少正整数 fps`);
  }
  if (inv.events.length === 0) {
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

// Unicode 字符类与 Go 的 unicode 表对照：Han / Hiragana / Katakana / Hangul 是文字（Script），
// IsLetter 是 L 大类，IsDigit 是 Nd。两边的 Unicode 版本可能差一两个版本，只影响新增的生僻字。
const scriptRe = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const letterOrDigitRe = /[\p{L}\p{Nd}]/u;

/**
 * Units 统计阅读量：一个汉字算一个单位，一串连续的字母或数字（一个英文词、
 * 一个数）也算一个单位，标点和空白不算。按字母计数会把「GPU」算成三个字，
 * 明显高估阅读量，制造误判。
 */
export function units(text: string): number {
  let count = 0;
  let inWord = false;
  for (const r of text) {
    if (scriptRe.test(r)) {
      count++;
      inWord = false;
    } else if (letterOrDigitRe.test(r)) {
      if (!inWord) {
        count++;
      }
      inWord = true;
    } else {
      inWord = false;
    }
  }
  return count;
}

/** RequiredFrames 返回读完 units 个单位所需的最少帧数。 */
export function requiredFrames(unitCount: number, fps: number, opts: Options): number {
  const seconds = Math.max(opts.minSeconds, unitCount / opts.charsPerSecond);
  return Math.trunc(Math.ceil(seconds * fps - 1e-9));
}

/** Go 的 math.Round：.5 远离零取整。 */
function goRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Check 逐个检查可读元素；timeline 为 null 时跳过与短语相关的两项。 */
export function check(inv: Inventory, timeline: Timeline | null, opts: Options): Report {
  const report: Report = {
    schema_version: ReportSchemaVersion,
    ok: false,
    fps: inv.fps,
    events: [],
    problems: [],
    findings: [],
  };
  const phrases = new Map<string, Phrase>();
  if (timeline !== null) {
    if (timeline.fps > 0 && timeline.fps !== inv.fps) {
      fail(report, RuleTimeline, null,
        `短语时间轴 fps=${timeline.fps} 与可读元素清单 fps=${inv.fps} 不一致，帧号无法比对`);
      timeline = null;
    } else {
      for (const phrase of timeline.phrases) {
        phrases.set(phrase.phrase_id, phrase);
      }
    }
  }
  const semantic: Event[] = [];
  const seen = new Set<string>();
  for (const event of inv.events) {
    if (event.event_id === '') {
      fail(report, RuleIdentity, event, '存在缺少 event_id 的可读元素');
      continue;
    }
    if (seen.has(event.event_id)) {
      fail(report, RuleIdentity, event, `event_id 重复：${event.event_id}`);
      continue;
    }
    seen.add(event.event_id);
    // 非文字清单用 null 表示没有阅读区间，Go 兼容解码会把它变成零。
    // 这些元素仍须有有效的存在区间；有文字的元素不能借此跳过阅读检查。
    if (event.text.trim() === '' && (event.role === DecorativeRole || event.role === 'graphic')) {
      if (event.enter_frame < 0 || event.exit_end_frame <= event.enter_frame) fail(report, RuleFrames, event, `${event.event_id} 的非文字元素存在区间无效：${event.enter_frame} / ${event.exit_end_frame}`);
      if (timeline !== null && event.role === 'graphic' && event.phrase_id !== '') checkPhrase(report, event, phrases);
      continue;
    }
    if (!framesOrdered(report, event) || event.role === DecorativeRole) {
      continue;
    }
    checkDuration(report, event, inv.fps, opts);
    if (inv.approvedCover?.ids.has(event.event_id)) {
      (report.hints ??= []).push(`${event.event_id} 按已批准的第零帧封面主题检查，阅读时长仍已核对；批准记录：${inv.approvedCover.approval}`);
      continue;
    }
    semantic.push(event);
    if (timeline !== null) {
      checkPhrase(report, event, phrases);
    }
  }
  // sort.SliceStable：Array.prototype.sort 是稳定排序。
  semantic.sort((a, b) => a.readable_start_frame - b.readable_start_frame);
  if (timeline !== null) {
    checkOrder(report, semantic, phrases);
  }
  checkCrowding(report, semantic, inv.fps, opts);
  report.ok = report.problems.length === 0;
  return report;
}

/** framesOrdered 要求 进入 ≤ 可读开始 < 可读结束 ≤ 退出完成。 */
function framesOrdered(report: Report, e: Event): boolean {
  if (
    e.enter_frame < 0 ||
    e.enter_frame > e.readable_start_frame ||
    e.readable_start_frame >= e.readable_end_frame_exclusive ||
    e.readable_end_frame_exclusive > e.exit_end_frame
  ) {
    fail(report, RuleFrames, e,
      `${e.event_id} 的帧号顺序不成立，应满足 enter ≤ readable_start < readable_end ≤ exit_end：${e.enter_frame} / ${e.readable_start_frame} / ${e.readable_end_frame_exclusive} / ${e.exit_end_frame}`);
    return false;
  }
  return true;
}

function checkDuration(report: Report, e: Event, fps: number, opts: Options): void {
  const count = units(e.text);
  const readable = e.readable_end_frame_exclusive - e.readable_start_frame;
  const required = requiredFrames(count, fps, opts);
  report.events.push({ event_id: e.event_id, units: count, readable_frames: readable, required_frames: required });
  if (readable < required) {
    fail(report, RuleDuration, e,
      `${e.event_id}（${e.scene_id}）可读 ${readable} 帧，读完 ${count} 个字至少要 ${required} 帧，还差 ${required - readable} 帧：「${e.text}」`);
  }
}

/** checkPhrase：非装饰元素不得早于它绑定的短语开始出现，否则画面在剧透口播。 */
function checkPhrase(report: Report, e: Event, phrases: Map<string, Phrase>): void {
  if (e.phrase_id === '') {
    fail(report, RuleBinding, e, `${e.event_id} 没有绑定 phrase_id`);
    return;
  }
  const phrase = phrases.get(e.phrase_id);
  if (phrase === undefined) {
    fail(report, RuleBinding, e, `${e.event_id} 绑定的短语 ${e.phrase_id} 不在短语时间轴里`);
    return;
  }
  if (e.enter_frame < phrase.start_frame) {
    fail(report, RuleSpoiler, e,
      `${e.event_id} 在第 ${e.enter_frame} 帧出现，早于绑定短语 ${phrase.phrase_id} 的开始帧 ${phrase.start_frame}：画面先于口播说出了这件事`);
  }
}

/** checkOrder：按可读开始排序后，绑定短语的语义顺序不得倒退。 */
function checkOrder(report: Report, events: Event[], phrases: Map<string, Phrase>): void {
  let previous: Event | null = null;
  for (const current of events) {
    const phrase = phrases.get(current.phrase_id);
    if (phrase === undefined) {
      continue;
    }
    if (previous !== null) {
      const before = phrases.get(previous.phrase_id) ?? newPhrase();
      if (before.semantic_order > phrase.semantic_order) {
        fail(report, RuleOrder, current,
          `${previous.event_id}（短语顺序 ${before.semantic_order}）比 ${current.event_id}（短语顺序 ${phrase.semantic_order}）先可读：画面顺序与口播顺序相反`);
      }
    }
    previous = current;
  }
}

/**
 * checkCrowding 找出可读起点挤在一起的元素。只进 hints：卡片组、标题加副标题
 * 一起出现是常见的合法版式，机器分不清那是一个信息点还是几个。
 */
function checkCrowding(report: Report, events: Event[], fps: number, opts: Options): void {
  const window = Math.trunc(goRound(opts.crowdSeconds * fps));
  for (let i = 0; i < events.length; ) {
    let j = i + 1;
    while (j < events.length && events[j].readable_start_frame - events[i].readable_start_frame < window) {
      j++;
    }
    if (j - i > 1) {
      const ids = events.slice(i, j).map((e) => e.event_id);
      // Go 的 %v 把 []string 写成 [a b]。
      (report.hints ??= []).push(
        `第 ${events[i].readable_start_frame} 帧附近 ${j - i} 个可读元素同时开始可读（[${ids.join(' ')}]）：观众一次只能读一个，确认它们是同一个信息点，否则错开`,
      );
    }
    i = j;
  }
}
