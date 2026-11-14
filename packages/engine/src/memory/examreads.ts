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
import { contained, ReadsCheckPrefix, type Scene } from '../scene';
import type { Finding } from './checks';

/** 作答者交的本镜头可读元素清单，写在镜头目录里。 */
export const ExamEventsFile = 'visible-events.json';

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
  '机器按这份清单核对每个元素够不够读完、有没有绑定短语、是否早于短语出现；没有这份清单按不合格处理。';

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
    return [{ check: wanted[0], problem: err instanceof Error ? err.message : String(err) }];
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
      return [{ check: wanted[0], problem: '读不了短语时间轴：' + (err instanceof Error ? err.message : String(err)) }];
    }
  }
  const report = reads.check(inventory, timeline, reads.Defaults);
  const out: Finding[] = [];
  for (const f of report.findings) {
    const id = ReadsCheckPrefix + f.rule;
    if (wanted.includes(id)) out.push({ check: id, problem: f.message });
  }
  return out;
}
