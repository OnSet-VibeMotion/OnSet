/**
 * am scene usage 与 am usage：渲染与编排两本用量账。移植自 internal/cli/usage.go
 * （printJSON 移植自 internal/cli/memory.go）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type * as agentrun from '@am/engine/agentrun';
import * as config from '@am/engine/config';
import { compareBytes, marshalIndent, sortedKeys } from '@am/engine/gojson';
import * as ledger from '@am/engine/ledger';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import * as tools from '@am/engine/tools';
import { exactArgs, noArgs } from './cli';
import { Command, type Out, ref } from './cobra';

/** 一个镜头全部渲染尝试的用量账。 */
export interface SceneUsage {
  scene_id: string;
  attempts: number;
  succeeded: number;
  usage: tools.Usage;
  /** 按「渲染工具/模型」分开，模型未知时只有渲染工具。 */
  by_model: Record<string, tools.Usage>;
}

/** am scene usage 的机器可读结果。 */
export interface UsageReport {
  scenes: SceneUsage[];
  total: tools.Usage;
  by_model: Record<string, tools.Usage>;
}

/** am usage 的机器可读结果。 */
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

export function newSceneUsageCommand(stdout: Out): Command {
  const asJSON = ref(false);
  const cmd = new Command({
    use: 'usage ROOT',
    args: exactArgs(1, 'ROOT'),
    short: '每个镜头的渲染一共花了多少 token',
    long: `汇总 ROOT 下每个镜头全部渲染尝试的用量：当前这一次加 attempts/ 里归档的，
失败的尝试与调度层的重试一样计入——它们同样花了 token。

口径统一为：输入含缓存命中与写入，缓存是输入里命中的部分，输出含推理 token；
费用只有工具报了才有（claude 系与 opencode 报，codex 不报）。有的尝试没读到用量时，
合计标为下限。每次 am scene run 结束时也会打印这一次的用量，run-all 的汇总与
--report-json 里有每个镜头这一批的合计。`,
    example: '  am scene usage scenes/\n  am scene usage scenes/ --json',
    runE: (_cmd, args) => {
      const scenes = schedule.plan(args[0]);
      const report = collectUsage(scenes);
      if (asJSON.value) {
        printJSON(stdout, usageReportJSON(report));
        return;
      }
      for (const row of report.scenes) {
        if (row.attempts === 0) {
          stdout.write(`${row.scene_id}：还没有渲染记录\n`);
          continue;
        }
        stdout.write(`${row.scene_id}：${row.attempts} 次尝试（${row.succeeded} 次成功）· ${tools.formatUsage(row.usage)}\n`);
      }
      const keys = Object.keys(report.by_model).sort(compareBytes);
      stdout.write(`\n合计：${tools.formatUsage(report.total)}\n`);
      for (const key of keys) stdout.write(`  ${key}：${tools.formatUsage(report.by_model[key])}\n`);
    },
  });
  cmd.flags().boolVar(asJSON, 'json', false, '输出 JSON');
  return cmd;
}

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
  [ledger.SourceRun]: 'am run',
  [ledger.SourceStudio]: 'Studio 对话',
  [ledger.SourceConsolidate]: '整理记忆',
};

export function newUsageCommand(stdout: Out): Command {
  const asJSON = ref(false);
  const scenesDir = ref('scenes');
  const cmd = new Command({
    use: 'usage',
    args: noArgs,
    short: '这个项目一共花了多少 token：渲染加编排',
    long: `在项目根运行，合计两本账：

  渲染   scenes/ 下每个镜头的全部渲染尝试（同 am scene usage）
  编排   production/usage/orchestrator.jsonl：每次 am run、Studio 每一轮对话各一行，
         失败与取消的调用同样记入

记忆打开时另列「整理记忆」的用量：它不属于哪个项目，记在记忆库的
orchestrator-usage.jsonl 里，所有项目共用一本。

口径与 am scene usage 相同：输入含缓存，输出含推理；费用只有工具报了才有，
有的调用没读到用量时合计标为下限。`,
    example: '  am usage\n  am usage --json\n  am usage --scenes scenes',
    runE: () => {
      const root = process.cwd();
      const report: ProjectUsage = { renders: emptyReport(), orchestrator: ledger.summarize(null), total: tools.newUsage() };
      let dir = scenesDir.value;
      if (!path.isAbsolute(dir)) dir = path.join(root, dir);
      if (fs.existsSync(dir)) report.renders = collectUsage(schedule.plan(dir));
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
      if (asJSON.value) {
        printJSON(stdout, projectUsageJSON(report));
        return;
      }
      let attempts = 0;
      for (const row of report.renders.scenes) attempts += row.attempts;
      stdout.write(`渲染：${report.renders.scenes.length} 个镜头、${attempts} 次尝试 · ${usageOrNone(report.renders.total, attempts)}\n`);
      for (const key of ledger.sortedKeys(report.renders.by_model)) stdout.write(`  ${key}：${tools.formatUsage(report.renders.by_model[key])}\n`);
      stdout.write(`编排：${report.orchestrator.calls} 次调用 · ${usageOrNone(report.orchestrator.total, report.orchestrator.calls)}\n`);
      for (const key of ledger.sortedKeys(report.orchestrator.by_source)) {
        const name = usageSourceNames[key] || key;
        stdout.write(`  ${name}：${tools.formatUsage(report.orchestrator.by_source[key])}\n`);
      }
      for (const key of ledger.sortedKeys(report.orchestrator.by_model)) stdout.write(`  ${key}：${tools.formatUsage(report.orchestrator.by_model[key])}\n`);
      stdout.write(`\n本项目合计：${usageOrNone(report.total, attempts + report.orchestrator.calls)}\n`);
      if (report.memory) {
        stdout.write(`整理记忆（所有项目共用，不计入上面的合计）：${report.memory.calls} 次 · ${tools.formatUsage(report.memory.total)}\n`);
      }
    },
  });
  cmd.flags().stringVar(scenesDir, 'scenes', 'scenes', '镜头根目录，相对项目根');
  cmd.flags().boolVar(asJSON, 'json', false, '输出 JSON');
  return cmd;
}

function usageOrNone(u: tools.Usage, count: number): string {
  if (count === 0) return '还没有记录';
  return tools.formatUsage(u);
}
