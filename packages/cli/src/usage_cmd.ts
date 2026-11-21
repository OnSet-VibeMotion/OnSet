/**
 * scene_usage 与 usage：渲染与编排两本用量账。移植自 internal/cli/usage.go
 * （printJSON 移植自 internal/cli/memory.go）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type * as agentrun from '@onset/engine/agentrun';
import * as config from '@onset/engine/config';
import { compareBytes, marshalIndent, sortedKeys } from '@onset/engine/gojson';
import * as ledger from '@onset/engine/ledger';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import * as tools from '@onset/engine/tools';
import { type Out } from './cobra';
import { bool, str } from './ops/common';
import { defineOp } from './ops/op';

/** 一个镜头全部渲染尝试的用量账。 */
export interface SceneUsage {
  scene_id: string;
  attempts: number;
  succeeded: number;
  usage: tools.Usage;
  /** 按「渲染工具/模型」分开，模型未知时只有渲染工具。 */
  by_model: Record<string, tools.Usage>;
}

/** onset scene usage 的机器可读结果。 */
export interface UsageReport {
  scenes: SceneUsage[];
  total: tools.Usage;
  by_model: Record<string, tools.Usage>;
}

/** onset usage 的机器可读结果。 */
export interface ProjectUsage {
  renders: UsageReport;
  orchestrator: ledger.Summary;
  total: tools.Usage;
  memory?: ledger.Summary;
}

/** json.MarshalIndent(value, "", "  ") 后加换行写出。 */
export function printJSON(w: Out, value: unknown): void {
  w.write(marshalIndent(value) + '\n');
}

function usageMapJSON(m: Record<string, tools.Usage>): Record<string, unknown> {
  return sortedKeys(Object.fromEntries(Object.entries(m).map(([key, usage]) => [key, tools.usageJSON(usage)])));
}

export function usageReportJSON(r: UsageReport): unknown {
  return {
    scenes: r.scenes.map((row) => ({
      scene_id: row.scene_id,
      attempts: row.attempts,
      succeeded: row.succeeded,
      usage: tools.usageJSON(row.usage),
      by_model: usageMapJSON(row.by_model),
    })),
    total: tools.usageJSON(r.total),
    by_model: usageMapJSON(r.by_model),
  };
}

export function projectUsageJSON(r: ProjectUsage): unknown {
  return {
    renders: usageReportJSON(r.renders),
    orchestrator: ledger.summaryJSON(r.orchestrator),
    total: tools.usageJSON(r.total),
    memory: r.memory ? ledger.summaryJSON(r.memory) : undefined,
  };
}

function usageKey(renderer: string, model: string): string {
  return model === '' ? renderer : renderer + '/' + model;
}

function emptyReport(): UsageReport {
  return { scenes: [], total: tools.newUsage(), by_model: {} };
}

/** 汇总 ROOT 下每个镜头的全部尝试记录（含 attempts/ 里归档的）。 */
export function collectUsage(scenes: readonly scene.Scene[]): UsageReport {
  const report = emptyReport();
  for (const s of scenes) {
    const row: SceneUsage = { scene_id: s.id, attempts: 0, succeeded: 0, usage: tools.newUsage(), by_model: {} };
    for (const attempt of scene.attemptHistory(s.directory, s.id)) {
      row.attempts++;
      if (attempt.outcome === scene.OutcomeSucceeded) row.succeeded++;
      const usage = attempt.usage ?? tools.newUsage();
      const key = usageKey(attempt.renderer, attempt.model);
      for (const target of [row.usage, report.total]) tools.usageAdd(target, usage);
      const perRow = Object.hasOwn(row.by_model, key) ? row.by_model[key] : tools.newUsage();
      const perAll = Object.hasOwn(report.by_model, key) ? report.by_model[key] : tools.newUsage();
      tools.usageAdd(perRow, usage);
      tools.usageAdd(perAll, usage);
      row.by_model[key] = perRow;
      report.by_model[key] = perAll;
    }
    report.scenes.push(row);
  }
  return report;
}

defineOp({
  name: 'scene_usage',
  cli: ['scene', 'usage'],
  summary: '每个镜头的渲染一共花了多少 token',
  description: `汇总 scenes 下每个镜头全部渲染尝试的用量：当前这一次加 attempts/ 里归档的，
失败的尝试与调度层的重试一样计入——它们同样花了 token。

口径统一为：输入含缓存命中与写入，缓存是输入里命中的部分，输出含推理 token；
费用只有工具报了才有（claude 系与 opencode 报，codex 不报）。有的尝试没读到用量时，
合计标为下限。每次 scene_run() 结束时也会打印这一次的用量，scene_run_all() 的汇总与
report_json 里有每个镜头这一批的合计。`,
  examples: ['scene_usage({"scenes": "scenes/"})', 'scene_usage({"scenes": "scenes/", "json": true})'],
  params: {
    scenes: { type: 'string', description: '镜头目录的上级目录', required: true, positional: 0 },
    json: { type: 'boolean', description: '输出 JSON' },
  },
  run: (p, { out }) => {
    const report = collectUsage(schedule.plan(str(p.scenes)));
    const data = usageReportJSON(report);
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    for (const row of report.scenes) {
      if (row.attempts === 0) {
        out.write(`${row.scene_id}：还没有渲染记录\n`);
        continue;
      }
      out.write(`${row.scene_id}：${row.attempts} 次尝试（${row.succeeded} 次成功）· ${tools.formatUsage(row.usage)}\n`);
    }
    const keys = Object.keys(report.by_model).sort(compareBytes);
    out.write(`\n合计：${tools.formatUsage(report.total)}\n`);
    for (const key of keys) out.write(`  ${key}：${tools.formatUsage(report.by_model[key])}\n`);
    return { data };
  },
});

/**
 * recordOrchestratorUsage 把一次编排调用记进账本。记账失败只告警：
 * 不能因为账没记上就让一次已经跑完的调用报错。
 *
 * Go 的 ctx 换成 signal（取消时 aborted）；runErr 是 agentrun.run 返回的 error（null 表示成功）。
 */
export function recordOrchestratorUsage(
  signal: AbortSignal | undefined,
  file: string,
  source: string,
  tool: string,
  env: Record<string, string>,
  result: agentrun.Result,
  runErr: unknown,
  stderr: Out,
): void {
  let model = result.model;
  if (model === '') model = tools.configuredModel(tool, env);
  const cancelled = (signal?.aborted ?? false) || (runErr instanceof Error && runErr.name === 'AbortError');
  const entry = ledger.fromResult(source, tool, model, result.sessionID, result.usage, runErr, cancelled);
  try {
    ledger.append(file, entry);
  } catch (err) {
    stderr.write(`警告：编排用量没能记进账本 ${file}：${(err as Error).message}\n`);
  }
}

const usageSourceNames: Record<string, string> = {
  [ledger.SourceStudio]: 'Studio 对话',
  [ledger.SourceConsolidate]: '整理记忆',
  [ledger.SourcePolish]: '润色输入',
  [ledger.SourcePromptCheck]: '检查画面描述',
};

export interface SceneDiagnostics {
  scene_id: string;
  attempts: number;
  retries: number;
  repairs: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cache_hit_rate: number | null;
  turns: number;
  preview_calls: number;
  cost_usd: number;
}

export interface UsageBreakdown {
  render_cache_hit_rate: number | null;
  orchestrator_cache_hit_rate: number | null;
  retry_and_repair_input_tokens: number;
  retry_and_repair_output_tokens: number;
  top_scenes: SceneDiagnostics[];
}

function cacheHitRate(u: tools.Usage): number | null {
  const input = u.input_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  if (input <= 0) return null;
  return Math.round((cached / input) * 1000) / 10;
}

function countStreamPreviews(dir: string, id: string): number {
  const file = path.join(dir, `render-${id}.stream.jsonl`);
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const matches = text.match(/scene_preview_check|hyperframes[^}\n]*snapshot/g);
  return matches ? matches.length : 0;
}

function buildBreakdown(scenes: readonly scene.Scene[], report: ProjectUsage): UsageBreakdown {
  let retryInput = 0;
  let retryOutput = 0;
  const rows: SceneDiagnostics[] = [];
  for (const s of scenes) {
    const history = scene.attemptHistory(s.directory, s.id);
    if (history.length === 0) continue;
    const sum = tools.newUsage();
    let retries = 0;
    let repairs = 0;
    for (const attempt of history) {
      const u = attempt.usage ?? tools.newUsage();
      tools.usageAdd(sum, u);
      if (attempt.retry) {
        retries++;
        retryInput += u.input_tokens ?? 0;
        retryOutput += u.output_tokens ?? 0;
      }
      if (attempt.local_repair) {
        repairs++;
        retryInput += u.input_tokens ?? 0;
        retryOutput += u.output_tokens ?? 0;
      }
    }
    rows.push({
      scene_id: s.id,
      attempts: history.length,
      retries,
      repairs,
      input_tokens: sum.input_tokens ?? 0,
      cached_input_tokens: sum.cached_input_tokens ?? 0,
      output_tokens: sum.output_tokens ?? 0,
      cache_hit_rate: cacheHitRate(sum),
      turns: sum.turns ?? 0,
      preview_calls: countStreamPreviews(s.directory, s.id),
      cost_usd: sum.cost_usd ?? 0,
    });
  }
  rows.sort((a, b) => (b.input_tokens + b.output_tokens) - (a.input_tokens + a.output_tokens));
  return {
    render_cache_hit_rate: cacheHitRate(report.renders.total),
    orchestrator_cache_hit_rate: cacheHitRate(report.orchestrator.total),
    retry_and_repair_input_tokens: retryInput,
    retry_and_repair_output_tokens: retryOutput,
    top_scenes: rows.slice(0, 5),
  };
}

defineOp({
  name: 'usage',
  cli: ['usage'],
  summary: '这个项目一共花了多少 token：渲染加编排',
  description: `在项目根运行，合计两本账：

  渲染   scenes/ 下每个镜头的全部渲染尝试（同 scene_usage()）
  编排   production/usage/orchestrator.jsonl：客户端每一轮对话各一行，
         失败与取消的调用同样记入

记忆打开时另列「整理记忆」的用量：它不属于哪个项目，记在记忆库的
orchestrator-usage.jsonl 里，所有项目共用一本。

传入 "breakdown": true 输出降本诊断拆账：缓存命中率、重试与返修占比，以及最耗 token 的前 5 个镜头。

口径与 scene_usage() 相同：输入含缓存，输出含推理；费用只有工具报了才有，
有的调用没读到用量时合计标为下限。`,
  examples: ['usage()', 'usage({"json": true})', 'usage({"breakdown": true})', 'usage({"scenes": "scenes"})'],
  params: {
    scenes: { type: 'string', description: '镜头根目录，相对项目根', default: 'scenes' },
    json: { type: 'boolean', description: '输出 JSON' },
    breakdown: { type: 'boolean', description: '输出缓存命中率、重试/返修浪费与高耗镜头诊断拆账' },
  },
  run: (p, { out }) => {
    const root = process.cwd();
    const report: ProjectUsage = { renders: emptyReport(), orchestrator: ledger.summarize(null), total: tools.newUsage() };
    let dir = str(p.scenes);
    if (!path.isAbsolute(dir)) dir = path.join(root, dir);
    const plannedScenes = fs.existsSync(dir) ? schedule.plan(dir) : [];
    if (plannedScenes.length > 0) report.renders = collectUsage(plannedScenes);
    const entries = ledger.read(ledger.projectFile(root));
    report.orchestrator = ledger.summarize(entries);
    if (!tools.usageEmpty(report.renders.total) || report.renders.total.partial) tools.usageAdd(report.total, report.renders.total);
    if (report.orchestrator.calls > 0) tools.usageAdd(report.total, report.orchestrator.total);
    try {
      const cfg = config.load(root, null);
      if (cfg.memory.enabled && cfg.memory.dir !== '') {
        const memoryEntries = ledger.read(ledger.memoryFile(cfg.memory.dir));
        if (memoryEntries !== null && memoryEntries.length > 0) report.memory = ledger.summarize(memoryEntries);
      }
    } catch {
      // 读不到配置或记忆库的账就不列。
    }
    const wantBreakdown = bool(p.breakdown);
    const breakdown = wantBreakdown ? buildBreakdown(plannedScenes, report) : undefined;
    const data = breakdown ? { ...(projectUsageJSON(report) as Record<string, unknown>), breakdown } : projectUsageJSON(report);
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    let attempts = 0;
    for (const row of report.renders.scenes) attempts += row.attempts;
    out.write(`渲染：${report.renders.scenes.length} 个镜头、${attempts} 次尝试 · ${usageOrNone(report.renders.total, attempts)}\n`);
    for (const key of ledger.sortedKeys(report.renders.by_model)) out.write(`  ${key}：${tools.formatUsage(report.renders.by_model[key])}\n`);
    out.write(`编排：${report.orchestrator.calls} 次调用 · ${usageOrNone(report.orchestrator.total, report.orchestrator.calls)}\n`);
    for (const key of ledger.sortedKeys(report.orchestrator.by_source)) {
      const name = usageSourceNames[key] || key;
      out.write(`  ${name}：${tools.formatUsage(report.orchestrator.by_source[key])}\n`);
    }
    for (const key of ledger.sortedKeys(report.orchestrator.by_model)) out.write(`  ${key}：${tools.formatUsage(report.orchestrator.by_model[key])}\n`);
    out.write(`\n本项目合计：${usageOrNone(report.total, attempts + report.orchestrator.calls)}\n`);
    if (breakdown) {
      const fmtPct = (v: number | null) => (v === null ? '无数据' : `${v.toFixed(1)}%`);
      out.write('\n降本诊断拆账：\n');
      out.write(`  缓存命中率：渲染 ${fmtPct(breakdown.render_cache_hit_rate)}，编排 ${fmtPct(breakdown.orchestrator_cache_hit_rate)}\n`);
      out.write(`  重试与返修消耗：输入 ${breakdown.retry_and_repair_input_tokens}，输出 ${breakdown.retry_and_repair_output_tokens}\n`);
      if (breakdown.top_scenes.length > 0) {
        out.write('  高耗镜头 Top 5：\n');
        for (const row of breakdown.top_scenes) {
          out.write(
            `    ${row.scene_id}：输入 ${row.input_tokens}（缓存 ${fmtPct(row.cache_hit_rate)}），输出 ${row.output_tokens}，` +
            `${row.attempts} 次尝试（重试 ${row.retries} / 返修 ${row.repairs}），${row.turns} 轮，预览 ${row.preview_calls} 次\n`,
          );
        }
      }
    }
    if (report.memory) {
      out.write(`整理记忆（所有项目共用，不计入上面的合计）：${report.memory.calls} 次 · ${tools.formatUsage(report.memory.total)}\n`);
    }
    return { data };
  },
});

function usageOrNone(u: tools.Usage, count: number): string {
  if (count === 0) return '还没有记录';
  return tools.formatUsage(u);
}
