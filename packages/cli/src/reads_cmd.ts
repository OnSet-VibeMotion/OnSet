/**
 * am validate reads：检查每个可读元素是否给了观众足够的阅读时间。移植自 internal/cli/reads.go。
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatG } from '@am/engine/gofmt';
import * as reads from '@am/engine/reads';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import { noArgs } from './cli';
import { Command, type Out, ref } from './cobra';
import { type Finding, recordCheckFindings } from './memory_cmd';

export function newValidateReadsCommand(stdout: Out): Command {
  const inventoryPath = ref('');
  const phrasesPath = ref('');
  const reportPath = ref('');
  const root = ref('');
  const charsPerSecond = ref(0);
  const minSeconds = ref(0);
  const crowdSeconds = ref(0);

  const cmd = new Command({
    use: 'reads',
    args: noArgs,
    short: '检查每个可读元素是否给了观众足够的阅读时间',
    long: `读取 visible-event-inventory.json，逐个检查画面上的可读元素。

作者知道画面写了什么，观众只看一遍、第一次看。元素一个接一个飞快出现、
没读完就切走，是生成式动画最常见的失败，而渲染、产物校验都发现不了它。

判为问题（退出码 1）：
  - 可读区间（readable_start_frame 到 readable_end_frame_exclusive）短于
    max(--min-seconds, 字数 / --chars-per-second)
  - 帧号顺序不成立：enter ≤ readable_start < readable_end ≤ exit_end
  - event_id 缺失或重复
  - 给了短语时间轴时：元素没绑定 phrase_id、绑定的短语不存在、元素早于短语
    开始帧出现（画面剧透口播）、元素的可读顺序与口播短语顺序相反

只进 hints：可读起点相距不到 --crowd-seconds 的多个元素。观众一次只能读一个，
但卡片组、标题加副标题一起出现也是合法版式，机器分不清。

字数按阅读单位计：一个汉字一个单位，一个英文词或一个数一个单位，标点不算。
role 为 decorative 的元素不检查阅读时间。

默认阈值取自 Netflix 简体中文字幕规范（成人节目每秒不超过 9 个字，每条至少
5/6 秒）。字幕位置固定、观众已经盯着；画面元素还要先被找到，所以这是下限。

文件结构：
  visible-event-inventory.json
    {"schema":1,"fps":30,"events":[{"event_id","scene_id","selector","text","role",
      "phrase_id","enter_frame","readable_start_frame",
      "readable_end_frame_exclusive","exit_end_frame"}]}
  phrase-timeline.json
    {"fps":30,"phrases":[{"phrase_id","semantic_order","start_frame",
      "end_frame_exclusive", ...}]}
帧号都是全片全局帧。`,
    example: `  # 默认读 production/ 下的两个文件；短语时间轴不存在时跳过短语相关检查
  am validate reads

  am validate reads --inventory production/visible-event-inventory.json \\
    --report-json production/reads-check.json`,
    runE: () => {
      // Go 版遍历一个 map，多个参数同时非法时报哪一个不确定；这里固定按参数表顺序。
      for (const [name, value] of [
        ['--chars-per-second', charsPerSecond.value],
        ['--min-seconds', minSeconds.value],
        ['--crowd-seconds', crowdSeconds.value],
      ] as const) {
        if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} 必须是有限正数，收到 ${formatG(value)}`);
      }
      const opts: reads.Options = { charsPerSecond: charsPerSecond.value, minSeconds: minSeconds.value, crowdSeconds: crowdSeconds.value };
      if (inventoryPath.value === '') inventoryPath.value = path.join(root.value, 'production', 'visible-event-inventory.json');
      const inventory = reads.loadInventory(inventoryPath.value);
      let timeline: reads.Timeline | null = null;
      const explicit = phrasesPath.value !== '';
      if (!explicit) phrasesPath.value = path.join(root.value, 'production', 'phrase-timeline.json');
      let exists = true;
      try {
        fs.statSync(phrasesPath.value);
      } catch {
        exists = false;
      }
      if (exists || explicit) {
        timeline = reads.loadTimeline(phrasesPath.value);
      } else {
        stdout.write(`提示：没有 ${phrasesPath.value}，跳过短语绑定与顺序检查\n`);
      }
      const report = reads.check(inventory, timeline, opts);
      recordReadsFindings(stdout, root.value, report);
      if (reportPath.value !== '') reads.writeJSON(report, reportPath.value);
      for (const hint of report.hints ?? []) stdout.write(`提示：${hint}\n`);
      if (!report.ok) throw new Error(`阅读时间检查未通过：${inventoryPath.value}\n  - ${(report.problems ?? []).join('\n  - ')}`);
      stdout.write(`阅读时间检查通过：${report.events?.length ?? 0} 个可读元素\n`);
    },
  });
  const f = cmd.flags();
  f.stringVar(root, 'project-root', '.', '项目根目录，用于定位 production/ 下的默认文件');
  f.stringVar(inventoryPath, 'inventory', '', '可读元素清单，缺省为 <project-root>/production/visible-event-inventory.json');
  f.stringVar(phrasesPath, 'phrases', '', '短语时间轴，缺省为 <project-root>/production/phrase-timeline.json（不存在则跳过）');
  f.stringVar(reportPath, 'report-json', '', '把逐元素结果写成 JSON 报告到该路径');
  f.float64Var(charsPerSecond, 'chars-per-second', reads.Defaults.charsPerSecond, '阅读速度上限（单位/秒）');
  f.float64Var(minSeconds, 'min-seconds', reads.Defaults.minSeconds, '任何可读元素的最短可读时长（秒）');
  f.float64Var(crowdSeconds, 'crowd-seconds', reads.Defaults.crowdSeconds, '可读起点相距不到这么久视为同时出现（秒）');
  return cmd;
}

/**
 * recordReadsFindings 把阅读时间问题按镜头写进记忆库。镜头从 <root>/scenes 下找；
 * 不属于任何镜头的问题（清单级错误）不记——那是编排阶段的事，与渲染写法无关。
 */
export function recordReadsFindings(warn: Out, root: string, report: reads.Report): void {
  const byScene = new Map<string, Finding[]>();
  for (const f of report.findings ?? []) {
    if (f.scene_id) byScene.set(f.scene_id, [...(byScene.get(f.scene_id) ?? []), { check: scene.ReadsCheckPrefix + f.rule, problem: f.message }]);
  }
  if (byScene.size === 0) return;
  let scenes: scene.Scene[];
  try {
    scenes = schedule.plan(path.join(root, 'scenes'));
  } catch {
    return;
  }
  recordCheckFindings(warn, root, scenes, byScene);
}
