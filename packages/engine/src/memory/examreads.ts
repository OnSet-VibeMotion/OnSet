/**
 * 考试里的阅读时间补查。
 *
 * 正式制作时阅读时间读整片的可读元素清单（production/visible-event-inventory.json），
 * 那份清单由编排在全部镜头定稿后填，单镜头重放时没有。考试改为要求作答者自己交一份
 * 本镜头的清单（局部帧），按镜头自己的短语时间轴判：判据与整片检查是同一个 reads.check。
 *
 * 清单是作答者自己申报的，不是从画面量出来的——正式制作里也一样。对照组与试用组
 * 拿到逐字相同的要求，所以两组之间仍然可比。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as reads from '../reads';
import { buildSceneData, contained, ReadsCheckPrefix, type Scene } from '../scene';
import type { Finding } from './checks';

/** 作答者交的本镜头可读元素清单，写在镜头目录里。 */
export const ExamEventsFile = 'visible-events.json';

/** 旧考试没有结构化完整性标记；只识别确切的清单缺失/空清单错误，不猜画面缺陷。 */
export function missingReadEvidence(problem: string): boolean {
  return problem.includes(ExamEventsFile) && (problem.endsWith(' 的 events 为空') || problem.startsWith('没有交出可读元素清单 ')) ||
    problem.startsWith('subtitle-') && (problem.includes('缺少与冻结字幕文字一致的字幕事件') || problem.includes('不是本镜头的冻结字幕事件') || problem.includes('无法与冻结短语文字对应')) ||
    problem.startsWith('没有冻结短语时间轴') || problem.startsWith('读不了短语时间轴：') || problem.startsWith('读不了冻结字幕与短语：') ||
    problem.includes('的帧号顺序不成立，应满足 enter ≤ readable_start < readable_end ≤ exit_end：');
}

/** checks 里由阅读时间判定的那几个。 */
export function readsChecks(checks: readonly string[]): string[] {
  return checks.filter((id) => id.startsWith(ReadsCheckPrefix));
}

/** 加在考试作答提示词里的要求。 */
export const ReadsExamNote =
  '可读元素清单（强制，渲染完成后由机器核对）：\n' +
  `在镜头目录写 ${ExamEventsFile}，登记画面上每一个供观众阅读的元素（标题、标签、数字、图表里的文字；烧录字幕不用登记）。\n` +
  '结构：{"schema": 1, "fps": <本镜头帧率>, "events": [...]}，每个元素一条，字段：\n' +
  '- event_id（本镜头内唯一）、selector（元素的稳定 id 或选择器）、text（显示的文字）；\n' +
  '- role：纯装饰、不需要读的写 decorative，其余写它的语义角色；\n' +
  '- phrase_id：它对应口播里的哪个短语，取自上面短语表的编号；\n' +
  '- enter_frame、readable_start_frame、readable_end_frame_exclusive、exit_end_frame：本镜头的局部帧，' +
  '按合成代码里实际的时间填——入场动画结束才算可读开始，退场开始就是可读结束。\n' +
  '机器按这份清单核对每个元素够不够读完、有没有绑定短语、是否早于短语出现；没有这份清单只能判为证据不足，不能比较经验增益。';

/** 顺序考试必须把字幕放在同一时间轴里，不能漏掉原本要防的跨层倒序。 */
export function readsExamNote(checks: readonly string[]): string {
  if (!checks.includes('reads.order')) return ReadsExamNote;
  return ReadsExamNote.replace('烧录字幕不用登记', '烧录字幕也必须登记') + '\n' +
    '在清单根部用 subtitle_cues 数组列出本镜头实际烧录的字幕编号；没有烧录字幕就写 []。SRT 时间合同不等于画面已有字幕，不要只为凑清单新增字幕；项目要求烧录时仍须遵守。' +
    '所列字幕各登记一条 role=subtitle、event_id=subtitle-<cues.index> 的事件，text 保留完整字幕文字，换行可调整；' +
    '按实际字幕代码填写可读区间，不得用口播短语帧替代字幕显示帧。机器会把字幕中包含的短语与标题合并核对顺序。' +
    '字幕文字、起止与短语时间轴保持冻结输入。若当前 SceneKit.captions 返回对象提供 events()，优先用它导出实际字幕事件；旧库没有此方法时按同一结构登记。';
}

/** 这里只去排版空白，不用标点或近似匹配猜字幕的内容。 */
function compactText(text: string): string {
  return text.replace(/[\t\n\r ]/g, '');
}

function crossLayerInventory(sc: Scene, inventory: reads.Inventory, declaredCues: unknown): { inventory: reads.Inventory; problems: string[] } {
  const data = buildSceneData(sc);
  const problems: string[] = [];
  const events = inventory.events.filter((e) => e.role !== 'subtitle');
  const subtitles = inventory.events.filter((e) => e.role === 'subtitle');
  let cues = data.cues;
  const required = (data.subtitles as { required?: boolean } | null)?.required === true;
  if (declaredCues !== undefined) {
    if (!Array.isArray(declaredCues) || !declaredCues.every(Number.isInteger) || new Set(declaredCues).size !== declaredCues.length) {
      problems.push('subtitle_cues 必须是不重复的实际字幕编号数组');
    } else {
      const known = new Set(data.cues.map((cue) => cue.index));
      if (declaredCues.some((id) => !known.has(id))) problems.push('subtitle_cues 包含不属于冻结合同的字幕编号');
      if (required && data.cues.some((cue) => !declaredCues.includes(cue.index))) problems.push('画幅要求烧录字幕，但 subtitle_cues 未覆盖本镜头字幕');
      if (!required) cues = data.cues.filter((cue) => declaredCues.includes(cue.index));
    }
  } else if (!required && subtitles.length === 0 && data.cues.length > 0) {
    problems.push('未声明实际烧录的字幕编号 subtitle_cues，不能把 SRT 自动当作画面字幕');
    cues = [];
  }
  const ids = new Set(cues.map((cue) => `subtitle-${cue.index}`));
  for (const event of subtitles) if (!ids.has(event.event_id)) problems.push(`${event.event_id} 不是本镜头的冻结字幕事件`);
  for (const cue of cues) {
    const id = `subtitle-${cue.index}`;
    const matches = subtitles.filter((e) => e.event_id === id);
    if (matches.length !== 1 || compactText(matches[0].text) !== compactText(cue.text)) {
      problems.push(`${id} 缺少与冻结字幕文字一致的字幕事件，不能核对标题与字幕的阅读顺序`);
      continue;
    }
    const event = matches[0];
    // 一行字幕可能提前说出了几个短语。不能只绑定其中第一个，否则后续标题倒序会漏检。
    const phrases = data.phrases.filter((p) => compactText(p.text) !== '' &&
      p.start_frame < cue.end_frame_exclusive && p.end_frame_exclusive > cue.start_frame &&
      compactText(cue.text).includes(compactText(p.text)));
    for (const phrase of phrases) events.push({ ...event, event_id: `${id}/${phrase.phrase_id}`, phrase_id: phrase.phrase_id, text: phrase.text });
    const expected = data.phrases.filter((p) => p.start_frame < cue.end_frame_exclusive && p.end_frame_exclusive > cue.start_frame);
    if (expected.length > 0 && phrases.length === 0) problems.push(`${id} 无法与冻结短语文字对应，不能核对跨层阅读顺序`);
  }
  return { inventory: { ...inventory, events }, problems };
}

/**
 * 读作答者交的清单，按阅读时间的判据检查，只留 checks 点名的规则。
 * 清单缺失或读不了时记一条问题：没有清单就判不了，不能算通过。
 */
export function readsPostCheck(sc: Scene, checks: readonly string[]): Finding[] {
  const wanted = readsChecks(checks);
  if (wanted.length === 0) return [];
  const file = path.join(sc.directory, ExamEventsFile);
  let inventory: reads.Inventory;
  try {
    if (!fs.existsSync(file)) throw new Error(`没有交出可读元素清单 ${ExamEventsFile}`);
    inventory = reads.loadInventory(file);
  } catch (err) {
    return [{ check: wanted[0], problem: err instanceof Error ? err.message : String(err), incomplete: true }];
  }
  for (const event of inventory.events) if (event.scene_id === '') event.scene_id = sc.id;
  let timeline: reads.Timeline | null = null;
  const t = sc.timing;
  if (t !== null && t.phrases !== '') {
    try {
      const global = reads.loadTimeline(contained(sc.directory, t.phrases, 'phrases'));
      // 清单是局部帧，把短语也换到本镜头的局部帧上。
      timeline = {
        fps: global.fps,
        phrases: global.phrases.map((p) => ({
          ...p,
          start_frame: p.start_frame - t.start_frame,
          end_frame_exclusive: p.end_frame_exclusive - t.start_frame,
        })),
      };
    } catch (err) {
      return [{ check: wanted[0], problem: '读不了短语时间轴：' + (err instanceof Error ? err.message : String(err)), incomplete: true }];
    }
  }
  const report = reads.check(inventory, timeline, reads.Defaults);
  const out: Finding[] = [];
  const needsTimeline = wanted.find((id) => ['reads.order', 'reads.binding', 'reads.spoiler'].includes(id));
  if (needsTimeline && timeline === null) out.push({ check: needsTimeline, problem: '没有冻结短语时间轴，不能核对阅读顺序、绑定或提前出现', incomplete: true });
  for (const id of wanted.filter((id) => ['reads.duration', 'reads.binding', 'reads.spoiler'].includes(id))) {
    const applicable = inventory.events.some((event) => event.role !== 'subtitle' && event.role !== reads.DecorativeRole &&
      !inventory.windowsApprovedCover?.ids.has(event.event_id) &&
      (event.text.trim() !== '' || id !== 'reads.duration' && event.role === 'graphic' && event.phrase_id !== ''));
    if (!applicable) out.push({ check: id, problem: '没有可用于此项检查的正文或绑定图形证据，不能比较经验效果', incomplete: true });
  }
  const subtitleIDs = new Set(inventory.events.filter((e) => e.role === 'subtitle').map((e) => e.event_id));
  let orderReport = report;
  if (wanted.includes('reads.order')) {
    try {
      const cross = crossLayerInventory(sc, inventory, (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).subtitle_cues);
      out.push(...cross.problems.map((problem) => ({ check: 'reads.order', problem, incomplete: true })));
      // 同帧一起可读没有先后，不让清单书写顺序制造倒序。
      const order = new Map(timeline?.phrases.map((p) => [p.phrase_id, p.semantic_order]));
      cross.inventory.events.sort((a, b) => a.readable_start_frame - b.readable_start_frame ||
        (order.get(a.phrase_id) ?? 0) - (order.get(b.phrase_id) ?? 0));
      orderReport = reads.check(cross.inventory, timeline, reads.Defaults);
    } catch (err) {
      out.push({ check: 'reads.order', problem: '读不了冻结字幕与短语：' + (err instanceof Error ? err.message : String(err)), incomplete: true });
    }
  }
  for (const f of report.findings) {
    const id = ReadsCheckPrefix + f.rule;
    // 坏帧号、重复 id 与不同帧率会让阅读判据失效，不能因只考 order/duration 而被过滤。
    if ([reads.RuleFrames, reads.RuleIdentity, reads.RuleTimeline].includes(f.rule)) out.push({ check: wanted[0], problem: f.message, incomplete: true });
    // 冻结整行字幕可能先于其中某个口播短语。它只补足跨层顺序，不改变原来
    // duration/binding/spoiler 考试排除烧录字幕的范围，否则多条合考会制造不可解的新失败。
    else if (!subtitleIDs.has(f.event_id ?? '') && id !== 'reads.order' && wanted.includes(id)) out.push({ check: id, problem: f.message });
  }
  if (wanted.includes('reads.order')) for (const f of orderReport.findings) {
    if (f.rule === reads.RuleOrder) out.push({ check: 'reads.order', problem: f.message });
  }
  return out;
}
