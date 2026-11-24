// 可读元素阅读时长、防剧透、顺序与拥挤度检查。
import {
  DecorativeRole,
  type Event,
  type Finding,
  type Inventory,
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
  type Timeline,
} from './types';

function fail(r: Report, rule: string, e: Event | null, message: string): void {
  const f: Finding = { rule, message };
  if (e !== null) {
    f.event_id = e.event_id;
    f.scene_id = e.scene_id;
  }
  r.problems.push(message);
  r.findings.push(f);
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
      fail(
        report,
        RuleTimeline,
        null,
        `短语时间轴 fps=${timeline.fps} 与可读元素清单 fps=${inv.fps} 不一致，帧号无法比对`,
      );
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
      if (event.enter_frame < 0 || event.exit_end_frame <= event.enter_frame) {
        fail(
          report,
          RuleFrames,
          event,
          `${event.event_id} 的非文字元素存在区间无效：${event.enter_frame} / ${event.exit_end_frame}`,
        );
      }
      if (timeline !== null && event.role === 'graphic' && event.phrase_id !== '') {
        checkPhrase(report, event, phrases);
      }
      continue;
    }
    if (!framesOrdered(report, event) || event.role === DecorativeRole) {
      continue;
    }
    checkDuration(report, event, inv.fps, opts);
    if (inv.approvedCover?.ids.has(event.event_id)) {
      (report.hints ??= []).push(
        `${event.event_id} 按已批准的第零帧封面主题检查，阅读时长仍已核对；批准记录：${inv.approvedCover.approval}`,
      );
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
    fail(
      report,
      RuleFrames,
      e,
      `${e.event_id} 的帧号顺序不成立，应满足 enter ≤ readable_start < readable_end ≤ exit_end：${e.enter_frame} / ${e.readable_start_frame} / ${e.readable_end_frame_exclusive} / ${e.exit_end_frame}`,
    );
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
    fail(
      report,
      RuleDuration,
      e,
      `${e.event_id}（${e.scene_id}）可读 ${readable} 帧，读完 ${count} 个字至少要 ${required} 帧，还差 ${required - readable} 帧：「${e.text}」`,
    );
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
    fail(
      report,
      RuleSpoiler,
      e,
      `${e.event_id} 在第 ${e.enter_frame} 帧出现，早于绑定短语 ${phrase.phrase_id} 的开始帧 ${phrase.start_frame}：画面先于口播说出了这件事`,
    );
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
        fail(
          report,
          RuleOrder,
          current,
          `${previous.event_id}（短语顺序 ${before.semantic_order}）比 ${current.event_id}（短语顺序 ${phrase.semantic_order}）先可读：画面顺序与口播顺序相反`,
        );
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
