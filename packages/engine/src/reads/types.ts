// Package reads 的数据结构、默认阈值、规则常量与报告写出。
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';

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
