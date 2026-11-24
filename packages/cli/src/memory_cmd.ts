/**
 * 渲染记忆的整组操作（memory_*），以及被 scene_run / scene_run_all、客户端对话、事后检查调用的挂钩函数
 * （attachMemory、preferenceBrief、recordCheckFindings）。移植自 internal/cli/memory.go。
 */
import * as config from '@onset/engine/config';
import { formatFixed } from '@onset/engine/gofmt';
import { compareBytes, sortedKeys } from '@onset/engine/gojson';
import * as memory from '@onset/engine/memory';
import * as scene from '@onset/engine/scene';
import { currentEnvironment } from './cli';
import './memory_cmd_exam';
import './memory_cmd_lifecycle';
import { errorText, jsonParam, loadMemoryConfig, sceneSeriesId, splitList } from './memory_cmd_shared';
import { defineGroup } from './ops/cli';
import { bool, num, str, strs } from './ops/common';
import { defineOp, ParamError } from './ops/op';
import { printJSON } from './usage_cmd';

export { renderExam } from './memory_cmd_exam';
export {
  attachMemory,
  blankPostCheck,
  examPostCheck,
  type Finding,
  newRunID,
  preferenceBrief,
  recordCheckFindings,
} from './memory_cmd_shared';

defineGroup({
  path: ['memory'],
  summary: '渲染记忆：经历、经验、召回、考试与回退',
  description: `渲染记忆让下一次渲染比这一次好，而且对所有渲染工具都有效。

  经历   每次渲染尝试与人工反馈自动写成一段经历，只增不改
  经验   由 memory_consolidate 从反复出现的失败里提炼，一条可由校验器判定的约束
  偏好   人工反馈里的审美取向，不参加考试，由人确认后生效

新经验先进入试用，经 memory_exam 回放考试（多个渲染工具 × {不带, 带试用经验}）
通过才转为生效；生效记忆集合每变一次就生成一个快照，memory_rollback 可回到任意一版。

渲染前由 onset 按镜头特征与关键词召回相关的几条，注入提示词里固定的「记忆」段，
所有渲染工具收到逐字相同的文本。召回只读快照：手改记忆文件后调用 memory_status()
把改动记成新快照，才会被召回。

项目配置（onset.conf）：
  MEMORY=on                  off 时完全不召回、不写经历
  MEMORY_SNAPSHOT=           留空跟随最新快照，写快照号就钉住
  MEMORY_RECALL_BUDGET=1500  每个镜头召回的记忆总字数上限
记忆库目录默认 ~/.local/share/onset/memory，可用 ONSET_MEMORY_DIR 覆盖。`,
});

const validListStatus = new Set(['active', 'trial', 'rejected', 'dormant']);

defineOp({
  name: 'memory_list',
  cli: ['memory', 'list'],
  scopes: ['cli'],
  summary: '列出记忆',
  description:
    '列出记忆库里的经验与偏好，附按渲染工具分开的效果统计（召回次数 / 一次通过次数，只计正式渲染的首次尝试）。',
  examples: ['memory_list()', 'memory_list({"status": "trial", "json": true})'],
  params: {
    status: { type: 'string', description: '只列某个状态：active、trial、rejected、dormant' },
    json: jsonParam,
  },
  run: (p, { out }) => {
    const status = str(p.status);
    if (status !== '' && !validListStatus.has(status))
      throw new ParamError('status 只能是 active、trial、rejected 或 dormant');
    const { store } = loadMemoryConfig();
    const { memories: all, broken } = store.memories();
    const stats = store.stats();
    const rows: { memory: memory.Memory; stats: Record<string, memory.Stat> | undefined }[] = [];
    for (const m of all) {
      if (status === '' || m.status === status)
        rows.push({ memory: m, stats: Object.hasOwn(stats, m.name) ? stats[m.name] : undefined });
    }
    const data = rows.map((r) => ({
      ...memory.memoryToJSON(r.memory),
      stats:
        r.stats === undefined
          ? null
          : sortedKeys(
              Object.fromEntries(
                Object.entries(r.stats).map(([k, v]) => [
                  k,
                  { recalled: v.recalled, passed_first_try: v.passed_first_try },
                ]),
              ),
            ),
    }));
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    if (rows.length === 0) out.write('（没有记忆）\n');
    for (const r of rows) {
      const label = r.memory.kind === memory.KindPreference ? ' [偏好，未经机器验证]' : '';
      out.write(`${r.memory.status.padEnd(8)} ${r.memory.name}${label} — ${r.memory.description}\n`);
      const byRenderer = r.stats ?? {};
      for (const name of Object.keys(byRenderer).sort(compareBytes)) {
        out.write(
          `         ${name}：召回 ${byRenderer[name].recalled} 次，一次通过 ${byRenderer[name].passed_first_try} 次\n`,
        );
      }
    }
    // Go 版按 map 遍历（顺序随机）；这里按路径排序。
    for (const file of Object.keys(broken).sort(compareBytes))
      out.write(`无法解析：${file}：${broken[file].message}\n`);
    return { data };
  },
});

defineOp({
  name: 'memory_show',
  cli: ['memory', 'show'],
  scopes: ['cli'],
  summary: '显示一条记忆的全文',
  description: '按名字返回一条经验或偏好的完整文件内容（frontmatter 与正文），包括它的状态、来源经历与考试记录。',
  examples: ['memory_show({"name": "font-local-block"})'],
  params: { name: { type: 'string', description: '记忆名', required: true, positional: 0 } },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const m = store.find(str(p.name));
    if (m === null) throw new Error(`记忆 ${str(p.name)} 不存在`);
    out.write(memory.format(m));
    return { data: memory.memoryToJSON(m) };
  },
});

defineOp({
  name: 'memory_recall',
  cli: ['memory', 'recall'],
  scopes: ['cli'],
  summary: '预览一个镜头会召回哪些记忆，以及原因',
  description: `按项目配置（MEMORY_SNAPSHOT、MEMORY_RECALL_BUDGET）预览镜头渲染时会召回的记忆。
不受 MEMORY=off 影响：关闭时渲染不召回，但仍可预览。`,
  examples: [
    'memory_recall({"scene": "scenes/scene-001"})',
    'memory_recall({"scene": "scenes/scene-001", "with_trial": true, "json": true})',
  ],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    renderer: { type: 'string', description: '按这个渲染工具召回与排序；缺省取镜头的 renderer 或配置的 RENDERER' },
    model: { type: 'string', description: '按这个模型召回；缺省取工具配置或最近一次实测到的模型' },
    with_trial: { type: 'boolean', description: '把试用中的记忆也算进来（考试里试用组看到的样子）' },
    json: jsonParam,
  },
  run: (p, { out }) => {
    const { cfg, store } = loadMemoryConfig();
    const s = scene.load(str(p.scene));
    let renderer = str(p.renderer);
    if (renderer === '') renderer = s.renderer;
    if (renderer === '') renderer = cfg.renderer;
    let model = str(p.model);
    if (model === '')
      model = store.currentModel(renderer, currentEnvironment(), config.rendererModelFor(cfg, renderer));
    const opts: memory.RecallOptions = {
      snapshot: cfg.memory.snapshot,
      budget: cfg.memory.recallBudget,
      renderer,
      model,
      series: sceneSeriesId(s.directory),
    };
    if (bool(p.with_trial)) {
      const extra: memory.Memory[] = [];
      for (const m of store.memories().memories) if (m.status === memory.StatusTrial) extra.push(m);
      opts.extra = extra.length > 0 ? extra : null;
    }
    const result = store.recallScene(s, opts);
    const data = memory.recallResultToJSON(result);
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    const snapshot = result.snapshot > 0 ? `#${result.snapshot}` : '（记忆库还没有快照）';
    const shownModel = model === '' ? '未知（限定了模型的记忆不召回）' : model;
    out.write(
      `镜头 ${s.id} · 渲染工具 ${renderer} · 模型 ${shownModel} · 快照 ${snapshot}\n特征：${(result.features ?? []).join('、')}\n召回 ${result.items.length} 条，用去 ${result.used} / ${result.budget} 字\n`,
    );
    for (const item of result.items)
      out.write(
        `  ✓ ${item.name}（${memory.recallReason(item)}，得分 ${formatFixed(item.score, 2)}）— ${item.description}\n`,
      );
    for (const item of result.omitted) {
      if (item.omit_reason === 'limit') {
        out.write(
          `  ✗ ${item.name} 经验已满 ${result.max_lessons} 条，排在后面没注入（得分 ${formatFixed(item.score, 2)}）\n`,
        );
        continue;
      }
      out.write(`  ✗ ${item.name} 超出字数预算（${item.chars} 字）\n`);
    }
    const section = memory.recallSection(result);
    if (section !== '') out.write(`\n注入提示词的原文：${section}`);
    return { data };
  },
});

function snapshotsText(list: readonly number[] | null): string {
  return '[' + (list ?? []).join(' ') + ']';
}

function compareLine(label: string, a: memory.RunStats, b: memory.RunStats): string {
  return (
    `  ${label}：一次通过率 ${formatFixed(a.pass_rate * 100, 0)}% → ${formatFixed(b.pass_rate * 100, 0)}%，重试 ${a.retries} → ${b.retries}，` +
    `问题 ${a.problems} → ${b.problems}，平均耗时 ${formatFixed(perScene(a.seconds, a.scenes), 0)}s → ${formatFixed(perScene(b.seconds, b.scenes), 0)}s，` +
    `平均 token ${tokensPerScene(a)} → ${tokensPerScene(b)}\n`
  );
}

function perScene(total: number, scenes: number): number {
  if (scenes === 0) return 0;
  return total / scenes;
}

function tokensPerScene(s: memory.RunStats): string {
  if (s.input_tokens + s.output_tokens === 0) return '—';
  return String(Math.trunc((s.input_tokens + s.output_tokens) / Math.max(s.scenes, 1)));
}

defineOp({
  name: 'memory_report',
  cli: ['memory', 'report'],
  scopes: ['cli'],
  summary: '按渲染批次对比：一次通过率、重试、问题数、耗时与 token',
  description: `一次 scene_run / scene_run_all 调用是一个批次。报告按批次汇总正式渲染：
  镜头数、首次尝试就通过的镜头数与比例（事后检查查出问题的不算通过）、
  重试次数、问题数（含事后检查查出的）、耗时、token、平均每镜召回的记忆条数、用到的快照，
并按「渲染工具/模型」分开列出——换了渲染工具带来的变化不能算成记忆的功劳。

缺省只看当前项目的批次，并对比最近两批；compare 指定任意两批。`,
  examples: [
    'memory_report()',
    'memory_report({"compare": "run-20261113-101500,run-20261114-153000"})',
    'memory_report({"json": true})',
  ],
  params: {
    last: { type: 'integer', description: '只列最近若干批', default: 10 },
    compare: { type: 'string', description: '对比的两个批次编号，逗号分隔；缺省为最近两批' },
    all_projects: { type: 'boolean', description: '列出所有项目的批次' },
    json: jsonParam,
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const episodes = store.episodes();
    const project = memory.projectName(process.cwd());
    const allProjects = bool(p.all_projects);
    let runs: memory.RunSummary[] = [];
    for (const r of memory.runReport(episodes)) {
      if (allProjects || project === '' || r.project === project) runs.push(r);
    }
    let pair: memory.RunSummary[] | null = null;
    const compare = str(p.compare);
    if (compare !== '') {
      const ids = splitList(compare);
      if (ids.length !== 2) throw new ParamError('compare 要给两个批次编号，逗号分隔');
      pair = [];
      for (const id of ids) {
        let found = false;
        for (const r of runs) {
          if (r.run === id) {
            pair.push(r);
            found = true;
          }
        }
        if (!found) throw new Error(`找不到批次 ${id}`);
      }
    } else if (runs.length >= 2) {
      pair = runs.slice(runs.length - 2);
    }
    const last = num(p.last);
    if (last > 0 && runs.length > last) runs = runs.slice(runs.length - last);
    const data = {
      compare: pair === null ? null : pair.map(memory.runSummaryToJSON),
      runs: runs.map(memory.runSummaryToJSON),
    };
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    if (runs.length === 0) {
      out.write('还没有带批次编号的渲染记录。\n');
      return { data };
    }
    out.write('批次\t\t\t镜头\t一次通过\t重试\t问题(事后)\t耗时\ttoken(入/出)\t召回/镜\t探索(通过)\t快照\n');
    for (const r of runs) {
      out.write(
        `${r.run}\t${r.scenes}\t${r.passed_first_try}（${formatFixed(r.pass_rate * 100, 0)}%）\t${r.retries}\t${r.problems}(${r.check_problems})\t${formatFixed(r.seconds, 0)}s\t${r.input_tokens}/${r.output_tokens}\t${formatFixed(r.recalled, 1)}\t${r.explored}(${r.explored_passed})\t${snapshotsText(r.snapshots)}\n`,
      );
    }
    if (pair !== null && pair.length === 2) {
      out.write(`\n对比 ${pair[0].run} → ${pair[1].run}\n`);
      out.write(compareLine('全部', pair[0], pair[1]));
      const keys = new Set([...Object.keys(pair[0].by_model), ...Object.keys(pair[1].by_model)]);
      for (const key of [...keys].sort(compareBytes)) {
        const a = Object.hasOwn(pair[0].by_model, key) ? pair[0].by_model[key] : undefined;
        const b = Object.hasOwn(pair[1].by_model, key) ? pair[1].by_model[key] : undefined;
        if (a && b) out.write(compareLine(key, a, b));
        else out.write(`  ${key}：只出现在其中一批，不可比\n`);
      }
    }
    return { data };
  },
});

defineOp({
  name: 'memory_import',
  cli: ['memory', 'import'],
  scopes: ['cli'],
  summary: '把已有项目的渲染历史导入为种子经历',
  description: `从已有项目里导入渲染历史，作为记忆的种子：
  - 镜头目录里的尝试记录（render-<id>.attempt.json）与 attempts/ 下归档的尝试；
  - production/review/review.json 里没接上的交接；
  - production/visible-event-inventory.json（schema 1）的阅读时间问题。

每个镜头最早的一次尝试算首次尝试，其余算重试；批次编号是 import:<项目名>，
memory_report({"all_projects": true}) 能看到这些项目当时的一次通过率。
冻结的输入是镜头现在的输入（历史输入没有留存）。重复导入同一个来源会跳过。`,
  examples: ['memory_import({"projects": ["../c-language-20260929", "../agent原理/ep01-前大模型时代"]})'],
  params: {
    projects: { type: 'strings', description: '要导入的项目目录', required: true, positional: 'rest' },
    json: jsonParam,
  },
  run: (p, { out }) => {
    const { cfg, store } = loadMemoryConfig();
    const results: memory.ImportResult[] = [];
    for (const project of strs(p.projects)) {
      try {
        results.push(store.importProject(project, { renderer: cfg.renderer }));
      } catch (err) {
        throw new Error(`导入 ${project}：${errorText(err)}`, { cause: err });
      }
    }
    const data = results.map(memory.importResultToJSON);
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    for (const r of results) {
      out.write(
        `${r.project}：${r.scenes} 个镜头，导入 ${r.attempts} 次尝试（${r.failures} 次校验失败）、${r.checks} 条事后检查问题，跳过 ${r.skipped}\n`,
      );
    }
    return { data };
  },
});
