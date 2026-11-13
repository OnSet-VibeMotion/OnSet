/**
 * am memory：渲染记忆的整组命令，以及被 scene run / run-all、am run、事后检查调用的挂钩函数
 * （attachMemory、preferenceBrief、recordCheckFindings）。移植自 internal/cli/memory.go。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agentrun from '@am/engine/agentrun';
import * as config from '@am/engine/config';
import * as envutil from '@am/engine/envutil';
import * as fsutil from '@am/engine/fsutil';
import { compareBytes, marshalIndent, sortedKeys } from '@am/engine/gojson';
import { formatFixed, formatG, goTrimSpace } from '@am/engine/gofmt';
import * as ledger from '@am/engine/ledger';
import * as mediaprobe from '@am/engine/mediaprobe';
import * as memory from '@am/engine/memory';
import * as scene from '@am/engine/scene';
import * as schedule from '@am/engine/schedule';
import * as tools from '@am/engine/tools';
import { EventPrinter } from './agentprint';
import { currentEnvironment, exactArgs, noArgs, validateTolerance } from './cli';
import { Command, ExitError, MinimumNArgs, type Out, type Ref, ref } from './cobra';
import { printJSON, recordOrchestratorUsage } from './usage_cmd';

/** memory.Finding：事后检查查出的一条问题，check 是校验器 ID。 */
export type Finding = memory.Finding;

/**
 * examWorkspace 是考场目录在项目里的位置。考场必须在项目里：渲染器从镜头目录
 * 逐级向上找 .agents/skills，放到记忆库里就找不到项目的技能。
 */
const examWorkspace = 'production/memory-exams';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * newRunID 是一次 am scene run / run-all 调用的批次编号，同一批次的镜头共用，
 * am memory report 按它对比「第一次」与「第二次」。
 */
export function newRunID(now = new Date()): string {
  return (
    'run-' +
    now.getUTCFullYear() +
    pad2(now.getUTCMonth() + 1) +
    pad2(now.getUTCDate()) +
    '-' +
    pad2(now.getUTCHours()) +
    pad2(now.getUTCMinutes()) +
    pad2(now.getUTCSeconds())
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * attachMemory 在渲染前为镜头召回记忆，并挂上把这次尝试写成经历的回调。
 * 记忆关闭时原样返回，不建记忆库目录。
 */
export function attachMemory(s: scene.Scene, cfg: config.Config, warn: Out, run: string): scene.Scene {
  if (!cfg.memory.enabled) return s;
  const store = memory.open(cfg.memory.dir);
  const renderer = s.renderer !== '' ? s.renderer : cfg.renderer;
  // 探索是这一批渲染的决定：按批次编号加镜头抽签，同一批里的重试拿到同一份召回。
  let result: memory.RecallResult;
  try {
    result = store.recallScene(s, {
      snapshot: cfg.memory.snapshot,
      budget: cfg.memory.recallBudget,
      renderer,
      model: store.currentModel(renderer, currentEnvironment()),
      explore: cfg.memory.explore,
      exploreSeed: run,
    });
  } catch (err) {
    throw new Error(`召回记忆：${errorText(err)}`, { cause: err });
  }
  const attached = memory.attachRecall(result, s);
  const x = result.explored;
  if (x) warn.write(`[${attached.id}] 记忆探索：这次用 ${x.added} 替换 ${x.dropped}（概率 ${formatG(x.propensity)}，镜头是否过期不受影响）\n`);
  const recorded: scene.Scene = { ...attached, afterAttempt: null };
  return {
    ...attached,
    afterAttempt: (attempt) => {
      try {
        store.recordAttempt(recorded, attempt, { source: memory.SourceRender, run, explored: result.explored });
      } catch (err) {
        warn.write(`警告：镜头 ${attached.id} 的经历没能写进记忆库：${errorText(err)}\n`);
      }
    },
  };
}

function writeReport(file: string, value: unknown): void {
  fsutil.atomicWrite(file, marshalIndent(value) + '\n', 0o644);
}

function splitList(value: string): string[] {
  const out: string[] = [];
  for (let item of value.split(',')) {
    item = goTrimSpace(item);
    if (item !== '') out.push(item);
  }
  return out;
}

export function newMemoryCommand(stdout: Out, stderr: Out, unsafe: Ref<boolean>): Command {
  const cmd = new Command({
    use: 'memory',
    short: '渲染记忆：经历、经验、召回、考试与回退',
    long: `渲染记忆让下一次渲染比这一次好，而且对所有渲染工具都有效。

  经历   每次渲染尝试与人工反馈自动写成一段经历，只增不改
  经验   由 consolidate 从反复出现的失败里提炼，一条可由校验器判定的约束
  偏好   人工反馈里的审美取向，不参加考试，由人确认后生效

新经验先进入试用，经 exam 回放考试（多个渲染工具 × {不带, 带试用经验}）
通过才转为生效；生效记忆集合每变一次就生成一个快照，rollback 可回到任意一版。

渲染前由 am 按镜头特征与关键词召回相关的几条，注入提示词里固定的「记忆」段，
所有渲染工具收到逐字相同的文本。召回只读快照：手改记忆文件后运行 am memory status
把改动记成新快照，才会被召回。

项目配置（article-to-motion.conf）：
  MEMORY=on                  off 时完全不召回、不写经历
  MEMORY_SNAPSHOT=           留空跟随最新快照，写快照号就钉住
  MEMORY_RECALL_BUDGET=1500  每个镜头召回的记忆总字数上限
记忆库目录默认 ~/.local/share/am/memory，可用 AM_MEMORY_DIR 覆盖。`,
  });
  cmd.addCommand(
    newMemoryListCommand(stdout),
    newMemoryShowCommand(stdout),
    newMemoryRecallCommand(stdout),
    newMemoryConsolidateCommand(stdout, stderr, unsafe),
    newMemoryExamCommand(stdout, unsafe),
    newMemoryPromoteCommand(stdout),
    newMemoryRejectCommand(stdout),
    newMemoryRetireCommand(stdout),
    newMemoryRollbackCommand(stdout),
    newMemoryStatusCommand(stdout),
    newMemoryFeedbackCommand(stdout),
    newMemoryTimelineCommand(stdout),
    newMemoryRememberCommand(stdout),
    newMemoryReportCommand(stdout),
    newMemoryImportCommand(stdout),
  );
  return cmd;
}

function loadMemoryConfig(): { cfg: config.Config; store: memory.Store } {
  let cfg: config.Config;
  try {
    cfg = config.load('.', null);
  } catch (err) {
    // 不在项目里（没有 article-to-motion.conf）时也能看记忆库：
    // 按 AM_MEMORY_DIR 或默认位置打开。项目配置本身有错时照常报错。
    let missing = false;
    try {
      fs.statSync('article-to-motion.conf');
    } catch (statErr) {
      missing = (statErr as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!missing) throw err;
    const env = currentEnvironment();
    // 编排与渲染工具照项目配置的写法取环境变量，整理与考试在项目外也能跑。
    cfg = config.newConfig({
      orchestrator: env.ORCHESTRATOR ?? '',
      renderer: env.RENDERER ?? '',
      memory: { enabled: true, dir: env.AM_MEMORY_DIR ?? '', recallBudget: config.DefaultMemoryRecallBudget },
    });
    if (cfg.memory.dir === '') cfg.memory.dir = config.defaultMemoryDir(env);
  }
  return { cfg, store: memory.open(cfg.memory.dir) };
}

const validListStatus = new Set(['active', 'trial', 'rejected', 'dormant']);

function newMemoryListCommand(stdout: Out): Command {
  const status = ref('');
  const asJSON = ref(false);
  const cmd = new Command({
    use: 'list',
    args: noArgs,
    short: '列出记忆',
    long: '列出记忆库里的经验与偏好，附按渲染工具分开的效果统计（召回次数 / 一次通过次数，只计正式渲染的首次尝试）。',
    example: '  am memory list\n  am memory list --status trial --json',
    runE: () => {
      if (status.value !== '' && !validListStatus.has(status.value)) throw new Error('--status 只能是 active、trial、rejected 或 dormant');
      const { store } = loadMemoryConfig();
      const { memories: all, broken } = store.memories();
      const stats = store.stats();
      const rows: { memory: memory.Memory; stats: Record<string, memory.Stat> | undefined }[] = [];
      for (const m of all) {
        if (status.value === '' || m.status === status.value) rows.push({ memory: m, stats: Object.hasOwn(stats, m.name) ? stats[m.name] : undefined });
      }
      if (asJSON.value) {
        printJSON(
          stdout,
          rows.map((r) => ({
            ...memory.memoryToJSON(r.memory),
            stats:
              r.stats === undefined
                ? null
                : sortedKeys(Object.fromEntries(Object.entries(r.stats).map(([k, v]) => [k, { recalled: v.recalled, passed_first_try: v.passed_first_try }]))),
          })),
        );
        return;
      }
      if (rows.length === 0) stdout.write('（没有记忆）\n');
      for (const r of rows) {
        const label = r.memory.kind === memory.KindPreference ? ' [偏好，未经机器验证]' : '';
        stdout.write(`${r.memory.status.padEnd(8)} ${r.memory.name}${label} — ${r.memory.description}\n`);
        const byRenderer = r.stats ?? {};
        for (const name of Object.keys(byRenderer).sort(compareBytes)) {
          stdout.write(`         ${name}：召回 ${byRenderer[name].recalled} 次，一次通过 ${byRenderer[name].passed_first_try} 次\n`);
        }
      }
      // Go 版按 map 遍历（顺序随机）；这里按路径排序。
      for (const file of Object.keys(broken).sort(compareBytes)) stdout.write(`无法解析：${file}：${broken[file].message}\n`);
    },
  });
  cmd.flags().stringVar(status, 'status', '', '只列某个状态：active、trial、rejected、dormant');
  cmd.flags().boolVar(asJSON, 'json', false, '输出 JSON');
  return cmd;
}

function newMemoryShowCommand(stdout: Out): Command {
  return new Command({
    use: 'show NAME',
    args: exactArgs(1, 'NAME'),
    short: '显示一条记忆的全文',
    long: '按名字打印一条经验或偏好的完整文件内容（frontmatter 与正文），包括它的状态、来源经历与考试记录。',
    example: '  am memory show font-local-block',
    runE: (_cmd, args) => {
      const { store } = loadMemoryConfig();
      const m = store.find(args[0]);
      if (m === null) throw new Error(`记忆 ${args[0]} 不存在`);
      stdout.write(memory.format(m));
    },
  });
}

function newMemoryRecallCommand(stdout: Out): Command {
  const renderer = ref('');
  const model = ref('');
  const withTrial = ref(false);
  const asJSON = ref(false);
  const cmd = new Command({
    use: 'recall DIRECTORY',
    args: exactArgs(1, 'DIRECTORY'),
    short: '预览一个镜头会召回哪些记忆，以及原因',
    long: `按项目配置（MEMORY_SNAPSHOT、MEMORY_RECALL_BUDGET）预览镜头渲染时会召回的记忆。
不受 MEMORY=off 影响：关闭时渲染不召回，但仍可预览。`,
    example: '  am memory recall scenes/scene-001\n  am memory recall scenes/scene-001 --with-trial --json',
    runE: (_cmd, args) => {
      const { cfg, store } = loadMemoryConfig();
      const s = scene.load(args[0]);
      if (renderer.value === '') renderer.value = s.renderer;
      if (renderer.value === '') renderer.value = cfg.renderer;
      if (model.value === '') model.value = store.currentModel(renderer.value, currentEnvironment());
      const opts: memory.RecallOptions = { snapshot: cfg.memory.snapshot, budget: cfg.memory.recallBudget, renderer: renderer.value, model: model.value };
      if (withTrial.value) {
        const extra: memory.Memory[] = [];
        for (const m of store.memories().memories) if (m.status === memory.StatusTrial) extra.push(m);
        opts.extra = extra.length > 0 ? extra : null;
      }
      const result = store.recallScene(s, opts);
      if (asJSON.value) {
        printJSON(stdout, memory.recallResultToJSON(result));
        return;
      }
      const snapshot = result.snapshot > 0 ? `#${result.snapshot}` : '（记忆库还没有快照）';
      const shownModel = model.value === '' ? '未知（限定了模型的记忆不召回）' : model.value;
      stdout.write(
        `镜头 ${s.id} · 渲染工具 ${renderer.value} · 模型 ${shownModel} · 快照 ${snapshot}\n特征：${(result.features ?? []).join('、')}\n召回 ${result.items.length} 条，用去 ${result.used} / ${result.budget} 字\n`,
      );
      for (const item of result.items) stdout.write(`  ✓ ${item.name}（${memory.recallReason(item)}，得分 ${formatFixed(item.score, 2)}）— ${item.description}\n`);
      for (const item of result.omitted) {
        if (item.omit_reason === 'limit') {
          stdout.write(`  ✗ ${item.name} 经验已满 ${result.max_lessons} 条，排在后面没注入（得分 ${formatFixed(item.score, 2)}）\n`);
          continue;
        }
        stdout.write(`  ✗ ${item.name} 超出字数预算（${item.chars} 字）\n`);
      }
      const section = memory.recallSection(result);
      if (section !== '') stdout.write(`\n注入提示词的原文：${section}`);
    },
  });
  cmd.flags().stringVar(renderer, 'renderer', '', '按这个渲染工具召回与排序；缺省取镜头的 renderer 或配置的 RENDERER');
  cmd.flags().stringVar(model, 'model', '', '按这个模型召回；缺省取工具配置或最近一次实测到的模型');
  cmd.flags().boolVar(withTrial, 'with-trial', false, '把试用中的记忆也算进来（考试里试用组看到的样子）');
  cmd.flags().boolVar(asJSON, 'json', false, '输出 JSON');
  return cmd;
}

function newMemoryConsolidateCommand(stdout: Out, stderr: Out, unsafe: Ref<boolean>): Command {
  const minCount = ref(0);
  const all = ref(false);
  const asJSON = ref(false);
  const drafts = ref('');
  const cmd = new Command({
    use: 'consolidate',
    args: noArgs,
    short: '整理：把反复出现的失败提炼成试用经验',
    long: `把上次整理之后的失败经历按校验器聚类，出现次数不少于 --min-count 的组交给 ORCHESTRATOR
起草经验或修订旧经验。草稿要过格式校验才进入试用：字段齐全、checked_by 是已有校验器、
不出现渲染工具名或模型名、不照抄镜头文案、不超长、与已有记忆说同一件事时必须写成修订。

整理者只在记忆库的 consolidate/<run>/ 目录里写草稿，不改动项目。
--drafts 跳过整理者，直接收录一个目录里现成的草稿（lessons/*.md、preferences/*.md）。`,
    example: '  am memory consolidate\n  am memory consolidate --min-count 1 --all\n  am memory consolidate --drafts ./my-drafts',
    runE: async (c) => {
      const { cfg, store } = loadMemoryConfig();
      const opts: memory.ConsolidateOptions = { minCount: minCount.value, all: all.value, draftsDir: drafts.value, signal: c.context() };
      if (drafts.value === '') {
        opts.drafter = async (workdir, prompt, signal) => {
          if (cfg.orchestrator === '') {
            throw new Error('没有配置整理者：在项目里运行，或用环境变量 ORCHESTRATOR 指定编排工具；也可以用 --drafts 直接收录现成草稿');
          }
          const isUnsafe = envutil.isUnsafe(unsafe.value);
          const env = config.childEnvironment(cfg, currentEnvironment(), isUnsafe, envutil.parsePassthrough(process.env.AM_PASSTHROUGH_ENV ?? ''));
          stdout.write(`整理者: ${cfg.orchestrator}\n工作目录: ${workdir}\n---\n`);
          const printer = new EventPrinter(stdout, stderr);
          const { result, error } = await agentrun.run(
            {
              tool: cfg.orchestrator,
              workdir,
              prompt,
              unsafe: isUnsafe,
              sessionID: agentrun.newSessionID(cfg.orchestrator),
              // 整理者只写草稿文件，不需要任何命令。
              access: {},
              env,
              lookPath: (name) => envutil.lookPath(name, env.PATH ?? ''),
            },
            (event) => printer.print(event),
            signal,
          );
          if (result.started) recordOrchestratorUsage(signal, ledger.memoryFile(store.dir), ledger.SourceConsolidate, cfg.orchestrator, env, result, error, stderr);
          if (error) throw error;
        };
      }
      const result = await store.consolidate(opts);
      if (asJSON.value) {
        printJSON(stdout, memory.consolidateResultToJSON(result));
        return;
      }
      if (result.clusters.length === 0 && drafts.value === '') {
        stdout.write(`没有出现 ${Math.max(minCount.value, 1)} 次以上的同类失败，无需整理。\n`);
        return;
      }
      stdout.write(`聚类出 ${result.clusters.length} 组高频失败：\n`);
      for (const cl of result.clusters) stdout.write(`  ${cl.key} × ${cl.count}\n`);
      stdout.write(`进入试用：${orNone(result.accepted)}\n`);
      for (const name of Object.keys(result.rejected).sort(compareBytes)) {
        stdout.write(`被拒草稿 ${name}：\n  - ${result.rejected[name].join('\n  - ')}\n`);
      }
      if (result.accepted.length > 0) stdout.write('下一步：am memory exam --renderers <工具1>,<工具2>\n');
    },
  });
  cmd.flags().intVar(minCount, 'min-count', 2, '一组失败至少出现几次才提炼');
  cmd.flags().boolVar(all, 'all', false, '不看上次整理时间，把全部经历都算进来');
  cmd.flags().stringVar(drafts, 'drafts', '', '不调用整理者，直接收录该目录下现成的草稿');
  cmd.flags().boolVar(asJSON, 'json', false, '输出 JSON');
  return cmd;
}

function orNone(list: readonly string[] | null): string {
  if (list === null || list.length === 0) return '（无）';
  return list.join('、');
}

function newMemoryExamCommand(stdout: Out, unsafe: Ref<boolean>): Command {
  const renderers = ref('');
  const trials = ref('');
  const episodes = ref('');
  const retest = ref('');
  const holdout = ref<string[]>([]);
  const maxQuestions = ref(0);
  const repeat = ref(0);
  const jobs = ref(0);
  const dryRun = ref(false);
  const reportPath = ref('');
  const tolerance = ref(0);
  const cmd = new Command({
    use: 'exam',
    args: noArgs,
    short: '回放考试：试用经验能否转为生效',
    long: `考试矩阵：考题 × 渲染工具 × {对照组：当前生效记忆, 试用组：再加试用经验}。
考题是试用经验来源的失败经历（冻结输入原样重放），加上 --holdout 给的留出镜头。
每格真实渲染一次（不重试），按确定性校验评分：一次通过得 10 分，否则每个失败项扣 1 分。

门槛（全部满足才转为生效）：
  1. 试用组总分严格高于对照组
  2. 任意一个渲染工具上，对照组通过的题试用组都通过
  3. 留出题上任意一个渲染工具的一次通过数不下降
  4. 所有格子都有有效结果——渲染工具自身故障使整场考试无效，不按 0 分算
  5. 考试期间生效记忆没变过，否则转为待人工确认

渲染次数 = 题数 × 渲染工具数 × 2 × 重复次数，每次都是一次完整的 AI CLI 调用。
考场建在项目的 production/memory-exams/ 下。`,
    example:
      '  am memory exam --renderers claude,codex\n  am memory exam --renderers claude,codex --holdout scenes/scene-004 --report-json production/exam.json',
    runE: async (c) => {
      validateTolerance(tolerance.value);
      const { cfg, store } = loadMemoryConfig();
      let list = splitList(renderers.value);
      if (list.length === 0) list = [cfg.renderer];
      for (const r of list) if (!tools.ValidTools.has(r)) throw new Error(`无效的渲染工具：${r}`);
      if (jobs.value === 0) jobs.value = cfg.sceneJobs;
      const root = process.cwd();
      const workers = schedule.renderWorkers(os.availableParallelism(), schedule.systemMemory(), jobs.value);
      const isUnsafe = envutil.isUnsafe(unsafe.value);
      const run: memory.ExamRunner = async (sc, renderer, signal) => {
        let attempt: scene.Attempt | null = null;
        let s: scene.Scene = { ...sc, afterAttempt: (a) => (attempt = a) };
        s = scene.withRenderWorkers(s, workers);
        let runErr: unknown = null;
        try {
          await scene.run(s, cfg, isUnsafe, currentEnvironment(), stdout, tolerance.value, signal);
        } catch (err) {
          runErr = err;
        }
        const got = attempt as scene.Attempt | null;
        if (got === null || got.outcome === '') {
          return scene.newAttempt({ scene_id: s.id, renderer, outcome: scene.OutcomeFailed, error: runErr === null ? '' : errorText(runErr) });
        }
        return got;
      };
      const result = await store.exam({
        renderers: list,
        trial: splitList(trials.value),
        episodes: splitList(episodes.value),
        holdout: holdout.value,
        retest: splitList(retest.value),
        maxQuestions: maxQuestions.value,
        repeat: repeat.value,
        jobs: jobs.value,
        budget: cfg.memory.recallBudget,
        workspace: path.join(root, examWorkspace),
        run,
        dryRun: dryRun.value,
        modelOf: (renderer) => store.currentModel(renderer, currentEnvironment()),
        postCheck: blankPostCheck,
        signal: c.context(),
      });
      if (reportPath.value !== '') writeReport(reportPath.value, memory.examResultToJSON(result));
      stdout.write(renderExam(result));
      if (!result.verdict.pass) throw new ExitError(1, '考试未通过');
    },
  });
  const f = cmd.flags();
  f.stringVar(renderers, 'renderers', '', '参加考试的渲染工具，逗号分隔；缺省为配置的 RENDERER');
  f.stringVar(trials, 'trial', '', '只考这几条试用经验，逗号分隔；缺省考全部');
  f.stringVar(episodes, 'episodes', '', '错题来源经历，逗号分隔；缺省取试用经验的 from_episodes');
  f.stringVar(retest, 'retest', '', '重考这几条生效经验（逗号分隔）：对照组去掉它们，用于模型换了以后确认它们还有用');
  f.stringArrayVar(holdout, 'holdout', [], '留出题的镜头目录，可重复');
  f.intVar(maxQuestions, 'max-questions', 4, '错题数上限');
  f.intVar(repeat, 'repeat', 1, '每格重复次数，按多数结果计分');
  f.intVar(jobs, 'jobs', 0, '并发上限；缺省读配置 SCENE_JOBS');
  f.boolVar(dryRun, 'dry-run', false, '只出结果，不改记忆状态');
  f.stringVar(reportPath, 'report-json', '', '把考试结果写成 JSON');
  f.float64Var(tolerance, 'duration-tolerance', 0.15, '产物时长与 duration_seconds 的允许偏差（秒）');
  return cmd;
}

export function renderExam(r: memory.ExamResult): string {
  let b = `考试 ${r.id}：试用经验 ${(r.trials ?? []).join('、')}\n`;
  const mark = (c: memory.Cell): string => {
    if (c.invalid) return '⚠';
    if (c.passed) return '✅';
    return `❌${c.problems}`;
  };
  const header = ['考题'];
  for (const renderer of r.renderers ?? []) header.push(renderer + '·对照', renderer + '·试用');
  b += header.join('\t') + '\n';
  for (const q of r.questions ?? []) {
    const row = [q.id + '（' + q.scene_id + (q.holdout ? '，留出' : '') + '）'];
    for (const renderer of r.renderers ?? []) {
      for (const arm of [memory.ArmControl, memory.ArmTrial]) {
        const marks: string[] = [];
        for (const c of r.cells ?? []) if (c.question === q.id && c.renderer === renderer && c.arm === arm) marks.push(mark(c));
        row.push(marks.join(' '));
      }
    }
    b += row.join('\t') + '\n';
  }
  b += `对照 ${formatFixed(r.verdict.control_score, 1)} 分，试用 ${formatFixed(r.verdict.trial_score, 1)} 分\n`;
  for (const reason of r.verdict.reasons ?? []) b += `  - ${reason}\n`;
  switch (r.applied) {
    case 'promoted':
      b += `通过：试用经验转为生效，快照 #${r.snapshot}\n`;
      break;
    case 'rejected':
      b += '未通过：试用经验记为被拒\n';
      break;
    case 'retest-passed':
      b += '重考通过：在当前模型上仍有提升，已补记考试编号\n';
      break;
    case 'retest-failed':
      b += '重考未通过：在当前模型上没有提升。状态不变——可用 am memory retire 让它沉睡，或给它加 applies_when.models 限定到旧模型\n';
      break;
    default:
      if (r.verdict.invalid) b += '考试无效：记忆状态不变\n';
      else if (r.verdict.needs_human) b += '待人工确认：用 am memory promote / reject 决定\n';
      else b += '未改动记忆状态（--dry-run）\n';
  }
  return b;
}

function newMemoryPromoteCommand(stdout: Out): Command {
  return new Command({
    use: 'promote NAME',
    args: exactArgs(1, 'NAME'),
    short: '人工确认一条试用记忆生效',
    long: '偏好不参加考试，只能由人确认生效。经验通常由 exam 转为生效；人工确认的经验会让快照标为「未经考试」。',
    example: '  am memory promote no-neon-overload',
    runE: (_cmd, args) => {
      const { store } = loadMemoryConfig();
      const snapshot = store.promote(args[0]);
      stdout.write(`${args[0]} 已生效，快照 #${snapshot.id}\n`);
    },
  });
}

function newMemoryRejectCommand(stdout: Out): Command {
  const reason = ref('');
  const cmd = new Command({
    use: 'reject NAME',
    args: exactArgs(1, 'NAME'),
    short: '人工拒绝一条试用记忆',
    long: '把一条试用中的记忆记为被拒，原因写进它的 rejected_reason。被拒记忆保留文件、不再参加考试，也不会被召回。',
    example: '  am memory reject loop-forever --reason "无限循环会被确定性扫描判失败"',
    runE: (_cmd, args) => {
      const { store } = loadMemoryConfig();
      store.reject(args[0], reason.value);
      stdout.write(`${args[0]} 已记为被拒\n`);
    },
  });
  cmd.flags().stringVar(reason, 'reason', '', '拒绝原因');
  return cmd;
}

function newMemoryRetireCommand(stdout: Out): Command {
  const reason = ref('');
  const cmd = new Command({
    use: 'retire NAME',
    args: exactArgs(1, 'NAME'),
    short: '让一条生效记忆转为沉睡',
    long: 'am memory status 会列出待沉睡候选（召回后一次通过率不高于基线）；确认后用这条命令让它沉睡。',
    example: '  am memory retire font-local-block --reason "在两个渲染工具上都没有提升"',
    runE: (_cmd, args) => {
      const { store } = loadMemoryConfig();
      const snapshot = store.retire(args[0], reason.value);
      stdout.write(`${args[0]} 已转为沉睡，快照 #${snapshot.id}\n`);
    },
  });
  cmd.flags().stringVar(reason, 'reason', '', '原因');
  return cmd;
}

function newMemoryRollbackCommand(stdout: Out): Command {
  const to = ref(0);
  const cmd = new Command({
    use: 'rollback',
    args: noArgs,
    short: '回退到某个快照',
    long: '把快照 --to 的生效记忆集合恢复成一个新快照，不删除任何历史。缺省回到最新快照的上一个。',
    example: '  am memory rollback\n  am memory rollback --to 3',
    runE: () => {
      if (to.value < 0) throw new Error('--to 必须是快照号');
      const { store } = loadMemoryConfig();
      const snapshot = store.rollback(to.value);
      stdout.write(`已回退到快照 #${snapshot.restored_from}，记为新快照 #${snapshot.id}（${(snapshot.entries ?? []).length} 条生效记忆）\n`);
    },
  });
  cmd.flags().intVar(to, 'to', 0, '目标快照号；缺省为最新快照的上一个');
  return cmd;
}

function newMemoryStatusCommand(stdout: Out): Command {
  const reportPath = ref('');
  const noRecord = ref(false);
  const cmd = new Command({
    use: 'status',
    args: noArgs,
    short: '记忆库现状；发现人工编辑时记成新快照',
    long: `汇总记忆库：各状态的记忆数、最新快照、经历数、上次整理后新增的失败数，以及待沉睡候选。

召回只读快照。手改了记忆文件时，status 会发现与最新快照不一致的生效记忆，
把当前状态记成一个新快照并标注「人工编辑，未经考试」；--no-record 只报告不记录。`,
    example: '  am memory status\n  am memory status --report-json production/memory-status.json',
    runE: () => {
      const { cfg, store } = loadMemoryConfig();
      const report = store.status(!noRecord.value, (r) => store.currentModel(r, currentEnvironment()));
      if (reportPath.value !== '') writeReport(reportPath.value, memory.statusReportToJSON(report));
      const state = cfg.memory.enabled ? '打开' : '关闭';
      const pinned = cfg.memory.snapshot > 0 ? '钉住 #' + cfg.memory.snapshot : '跟随最新';
      stdout.write(`记忆库：${report.dir}\n本项目：记忆${state}，快照${pinned}，召回预算 ${cfg.memory.recallBudget} 字\n最新快照：#${report.snapshot}\n`);
      for (const key of Object.keys(report.counts).sort(compareBytes)) stdout.write(`  ${key}：${report.counts[key]}\n`);
      stdout.write(`经历 ${report.episodes} 段，上次整理后新增失败 ${report.pending_failures} 段\n`);
      if ((report.drift ?? []).length > 0) {
        if (report.recorded_snapshot > 0) stdout.write(`发现人工编辑：${report.drift.join('、')}，已记为快照 #${report.recorded_snapshot}（未经考试）\n`);
        else stdout.write(`发现人工编辑：${report.drift.join('、')}（未记快照，召回不会用到）\n`);
      }
      for (const r of report.retest ?? []) {
        stdout.write(
          `需要重考：${r.name} 当初在 ${r.renderer} 上用 ${r.examined_models.join('、')} 考过，现在是 ${r.current_model}（am memory exam --renderers ${r.renderer} --retest ${r.name}）\n`,
        );
      }
      for (const x of report.suspect ?? []) {
        const renderer = x.renderer.split('/')[0];
        stdout.write(
          `可疑：${x.name} 在 ${x.renderer} 上召回 ${x.recalled} 次，其中 ${x.harmful} 次它要防的 ${(x.checks ?? []).join('、')} 照样判了失败（am memory exam --renderers ${renderer} --retest ${x.name}）\n`,
        );
      }
      for (const w of report.weak ?? []) {
        stdout.write(`待沉睡：${w.name} 在 ${w.renderer} 上召回 ${w.recalled} 次，一次通过率 ${formatFixed(w.rate * 100, 0)}%，不高于基线 ${formatFixed(w.baseline * 100, 0)}%\n`);
      }
      // Go 版按 map 遍历（顺序随机）；这里按路径排序。
      for (const file of Object.keys(report.broken ?? {}).sort(compareBytes)) stdout.write(`无法解析：${file}：${report.broken[file]}\n`);
    },
  });
  cmd.flags().stringVar(reportPath, 'report-json', '', '把现状写成 JSON');
  cmd.flags().boolVar(noRecord, 'no-record', false, '只报告人工编辑，不记成新快照');
  return cmd;
}

/** strconv.ParseFloat 能接受的十进制写法（含 inf / nan 等，与 Go 一致地判为数，再由范围检查拦下）。 */
function parseGoFloat(text: string): number | null {
  if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(text)) return Number(text);
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^nan$/i.test(text)) return NaN;
  return null;
}

function newMemoryFeedbackCommand(stdout: Out): Command {
  const up = ref(false);
  const down = ref(false);
  const note = ref('');
  const element = ref('');
  const region = ref('');
  const at = ref(0);
  const cmd = new Command({
    use: 'feedback DIRECTORY',
    args: exactArgs(1, 'DIRECTORY'),
    short: '为一个镜头补录人工反馈（👍 / 👎）',
    long: '把人工反馈写成一段经历。👎 会进入下一次整理；说明里的审美取向会被写成偏好，偏好由人确认后才生效。',
    example: `  am memory feedback scenes/scene-003 --down --note "满屏霓虹太刺眼" --at 2.5
  am memory feedback scenes/scene-003 --down --region 0.1,0.6,0.8,0.3 --note "字幕压住了图表"`,
    runE: (_cmd, args) => {
      if (up.value === down.value) throw new Error('必须且只能给出 --up 或 --down 之一');
      const feedback = memory.newFeedback({ verdict: down.value ? 'down' : 'up', note: goTrimSpace(note.value), seconds: at.value, element: element.value });
      if (region.value !== '') {
        const values: number[] = [];
        for (const part of region.value.split(',')) {
          const value = parseGoFloat(goTrimSpace(part));
          // NaN 在 Go 里同样过得了 value < 0 || value > 1 的检查。
          if (value === null || value < 0 || value > 1) throw new Error('--region 必须是 4 个 0..1 之间的数：x,y,w,h');
          values.push(value);
        }
        if (values.length !== 4) throw new Error('--region 必须是 4 个 0..1 之间的数：x,y,w,h');
        feedback.region = values;
      }
      const { store } = loadMemoryConfig();
      const s = scene.load(args[0]);
      const episode = store.recordFeedback(s, feedback);
      stdout.write(`已记录经历 ${episode.id}\n`);
    },
  });
  const f = cmd.flags();
  f.boolVar(up, 'up', false, '👍');
  f.boolVar(down, 'down', false, '👎');
  f.stringVar(note, 'note', '', '说明');
  f.float64Var(at, 'at', -1, '画面在镜头内的时间点（秒）');
  f.stringVar(region, 'region', '', '框选区域，归一化坐标 x,y,w,h');
  f.stringVar(element, 'element', '', '点选的元素');
  return cmd;
}

function newMemoryTimelineCommand(stdout: Out): Command {
  const asJSON = ref(false);
  const limit = ref(0);
  const cmd = new Command({
    use: 'timeline',
    args: noArgs,
    short: '记忆库的事件时间线',
    long: '按发生顺序列出记忆库的事件：写经历、整理、试用、草稿被拒、考试、生效、被拒、沉睡、快照、人工编辑与回退。',
    example: '  am memory timeline --limit 20\n  am memory timeline --json',
    runE: () => {
      const { store } = loadMemoryConfig();
      let events = store.timeline();
      if (limit.value > 0 && events.length > limit.value) events = events.slice(events.length - limit.value);
      if (asJSON.value) {
        printJSON(stdout, events.map(memory.eventToJSON));
        return;
      }
      for (const event of events) stdout.write(`${event.time}  ${event.type.padEnd(14)} ${event.summary}\n`);
    },
  });
  cmd.flags().boolVar(asJSON, 'json', false, '输出 JSON');
  cmd.flags().intVar(limit, 'limit', 0, '只显示最近若干条');
  return cmd;
}

/**
 * preferenceBrief 返回追加给编排工具的用户偏好段；记忆关闭时为空。
 * 读不到记忆库只警告：偏好是锦上添花，不能因此挡住整片制作。
 */
export function preferenceBrief(cfg: config.Config, root: string, warn: Out): string {
  if (!cfg.memory.enabled) return '';
  try {
    return memory.openReadOnly(cfg.memory.dir).preferenceBrief(memory.projectName(root), cfg.memory.snapshot).text;
  } catch (err) {
    warn.write(`警告：读取用户偏好失败，本次不带偏好：${errorText(err)}\n`);
    return '';
  }
}

function newMemoryRememberCommand(stdout: Out): Command {
  const name = ref('');
  const description = ref('');
  const revises = ref('');
  const global = ref(false);
  const inferred = ref(false);
  const cmd = new Command({
    use: 'remember TEXT',
    args: exactArgs(1, 'TEXT'),
    short: '记住用户亲口说的一条偏好',
    long: `把用户表达的长期取向直接记为生效的偏好，并生成快照。用户自己说出来的就是确认，
不需要再经人工确认或考试。

偏好会进入两处：编排工具每次开工前读到的「用户偏好」段（am run 与 Studio 对话），
以及每个镜头渲染时的记忆召回。默认只对当前项目成立，--global 对所有项目成立。
用户收回一条偏好时用 am memory retire NAME。

--inferred 用于用户没有明说、由编排工具推测出来的取向：它进入试用，出现在偏好段的
「待确认」里，用户认可（am memory promote NAME）后才生效。`,
    example: `  am memory remember --name calm-palette --description "配色克制" "主色不超过两种高饱和色，背景用深色"
  am memory remember --global --name no-emoji "画面里不要出现 emoji"
  am memory remember --name calm-palette-v2 --revises calm-palette "配色只用品牌色加一个强调色"
  am memory remember --inferred --name slower-pacing "用户几次把节奏改慢，倾向每屏停留更久"`,
    runE: (_cmd, args) => {
      const { store } = loadMemoryConfig();
      const root = process.cwd();
      const { memory: m, snapshot } = store.remember({
        name: name.value,
        description: description.value,
        body: args[0],
        project: memory.projectName(root),
        global: global.value,
        revises: revises.value,
        inferred: inferred.value,
      });
      const scope = m.scope === '' ? '所有项目' : '本项目（' + m.scope + '）';
      if (inferred.value) {
        stdout.write(`推测的偏好 ${m.name}（${scope}）进入试用：${m.description}；用户确认后运行 am memory promote ${m.name}\n`);
        return;
      }
      stdout.write(`已记住偏好 ${m.name}（${scope}）：${m.description}，快照 #${snapshot?.id ?? 0}\n`);
    },
  });
  const f = cmd.flags();
  f.stringVar(name, 'name', '', '偏好名，小写字母、数字与连字符；缺省按时间生成');
  f.stringVar(description, 'description', '', '一句话概括；缺省取正文第一句');
  f.boolVar(global, 'global', false, '对用户所有项目都成立');
  f.stringVar(revises, 'revises', '', '替换的旧偏好名，旧偏好转为沉睡');
  f.boolVar(inferred, 'inferred', false, '用户没有明说、由编排工具推测的取向：先进入试用，用户确认后才生效');
  return cmd;
}

/**
 * recordCheckFindings 把事后检查（阅读时间、交接、空白帧）查出的问题按镜头写成经历。
 * 记忆关闭、读不到配置或写失败时只警告，不改变检查命令本身的结果。
 */
export function recordCheckFindings(warn: Out, root: string, scenes: readonly scene.Scene[], byScene: ReadonlyMap<string, Finding[]>): void {
  if (byScene.size === 0) return;
  let cfg: config.Config;
  try {
    cfg = config.load(root, null);
  } catch {
    return;
  }
  if (!cfg.memory.enabled) return;
  let store: memory.Store;
  try {
    store = memory.open(cfg.memory.dir);
  } catch (err) {
    warn.write(`警告：检查结果没能写进记忆库：${errorText(err)}\n`);
    return;
  }
  for (const s of scenes) {
    const findings = byScene.get(s.id) ?? [];
    if (findings.length === 0) continue;
    try {
      store.recordCheck(s, findings);
    } catch (err) {
      warn.write(`警告：镜头 ${s.id} 的检查结果没能写进记忆库：${errorText(err)}\n`);
    }
  }
}

/**
 * blankPostCheck 是考试里空白帧的补查：只看第 0 帧。
 * 空白帧经验来自 --at 0 --check-blank（第 0 帧当封面），看末帧会把合法的淡出也算进去。
 */
export function blankPostCheck(s: scene.Scene, checks: string[]): Finding[] {
  if (!checks.includes(scene.CheckFramesBlank)) return [];
  let report: mediaprobe.FrameReport;
  try {
    const toolchain = mediaprobe.newToolchain(currentEnvironment());
    report = toolchain.extractFramesRegion(scene.outputPath(s), [0], null, path.join(s.directory, 'visual-qc'));
  } catch (err) {
    return [{ check: scene.CheckFramesBlank, problem: '无法补查空白帧：' + errorText(err) }];
  }
  return (report.problems ?? []).map((problem) => ({ check: scene.CheckFramesBlank, problem }));
}

function snapshotsText(list: readonly number[] | null): string {
  return '[' + (list ?? []).join(' ') + ']';
}

function newMemoryReportCommand(stdout: Out): Command {
  const last = ref(0);
  const compare = ref('');
  const allProjects = ref(false);
  const asJSON = ref(false);
  const cmd = new Command({
    use: 'report',
    args: noArgs,
    short: '按渲染批次对比：一次通过率、重试、问题数、耗时与 token',
    long: `一次 am scene run / run-all 调用是一个批次。报告按批次汇总正式渲染：
  镜头数、首次尝试就通过的镜头数与比例（事后检查查出问题的不算通过）、
  重试次数、问题数（含事后检查查出的）、耗时、token、平均每镜召回的记忆条数、用到的快照，
并按「渲染工具/模型」分开列出——换了渲染工具带来的变化不能算成记忆的功劳。

缺省只看当前项目的批次，并对比最近两批；--compare 指定任意两批。`,
    example: '  am memory report\n  am memory report --compare run-20261113-101500,run-20261114-153000\n  am memory report --json',
    runE: () => {
      const { store } = loadMemoryConfig();
      const episodes = store.episodes();
      const project = memory.projectName(process.cwd());
      let runs: memory.RunSummary[] = [];
      for (const r of memory.runReport(episodes)) {
        if (allProjects.value || project === '' || r.project === project) runs.push(r);
      }
      let pair: memory.RunSummary[] | null = null;
      if (compare.value !== '') {
        const ids = splitList(compare.value);
        if (ids.length !== 2) throw new Error('--compare 要给两个批次编号，逗号分隔');
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
      if (last.value > 0 && runs.length > last.value) runs = runs.slice(runs.length - last.value);
      if (asJSON.value) {
        printJSON(stdout, { compare: pair === null ? null : pair.map(memory.runSummaryToJSON), runs: runs.map(memory.runSummaryToJSON) });
        return;
      }
      if (runs.length === 0) {
        stdout.write('还没有带批次编号的渲染记录。\n');
        return;
      }
      stdout.write('批次\t\t\t镜头\t一次通过\t重试\t问题(事后)\t耗时\ttoken(入/出)\t召回/镜\t探索(通过)\t快照\n');
      for (const r of runs) {
        stdout.write(
          `${r.run}\t${r.scenes}\t${r.passed_first_try}（${formatFixed(r.pass_rate * 100, 0)}%）\t${r.retries}\t${r.problems}(${r.check_problems})\t${formatFixed(r.seconds, 0)}s\t${r.input_tokens}/${r.output_tokens}\t${formatFixed(r.recalled, 1)}\t${r.explored}(${r.explored_passed})\t${snapshotsText(r.snapshots)}\n`,
        );
      }
      if (pair !== null && pair.length === 2) {
        stdout.write(`\n对比 ${pair[0].run} → ${pair[1].run}\n`);
        stdout.write(compareLine('全部', pair[0], pair[1]));
        const keys = new Set([...Object.keys(pair[0].by_model), ...Object.keys(pair[1].by_model)]);
        for (const key of [...keys].sort(compareBytes)) {
          const a = Object.hasOwn(pair[0].by_model, key) ? pair[0].by_model[key] : undefined;
          const b = Object.hasOwn(pair[1].by_model, key) ? pair[1].by_model[key] : undefined;
          if (a && b) stdout.write(compareLine(key, a, b));
          else stdout.write(`  ${key}：只出现在其中一批，不可比\n`);
        }
      }
    },
  });
  const f = cmd.flags();
  f.intVar(last, 'last', 10, '只列最近若干批');
  f.stringVar(compare, 'compare', '', '对比的两个批次编号，逗号分隔；缺省为最近两批');
  f.boolVar(allProjects, 'all-projects', false, '列出所有项目的批次');
  f.boolVar(asJSON, 'json', false, '输出 JSON');
  return cmd;
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

function newMemoryImportCommand(stdout: Out): Command {
  const asJSON = ref(false);
  const tolerance = ref(0);
  const cmd = new Command({
    use: 'import PROJECT...',
    args: MinimumNArgs(1),
    short: '把已有项目的渲染历史导入为种子经历',
    long: `从已有项目里导入渲染历史，作为记忆的种子：
  - 镜头目录里的尝试记录（render-<id>.attempt.json）与 attempts/ 下归档的尝试；
  - 只有产物没有尝试记录的归档（含 production/failed-attempts/<镜头>-attempt-NN-*），
    用现在的产物校验重判一遍，只记失败；
  - production/review/review.json 里没接上的交接；
  - production/visible-event-inventory.json（schema 1）的阅读时间问题。

每个镜头最早的一次尝试算首次尝试，其余算重试；批次编号是 import:<项目名>，
am memory report --all-projects 能看到这些项目当时的一次通过率。
冻结的输入是镜头现在的输入（历史输入没有留存）。重复导入同一个来源会跳过。`,
    example: '  am memory import ../c-language-20260929 ../agent原理/ep01-前大模型时代',
    runE: (_cmd, args) => {
      validateTolerance(tolerance.value);
      const { cfg, store } = loadMemoryConfig();
      const results: memory.ImportResult[] = [];
      for (const project of args) {
        try {
          results.push(store.importProject(project, { env: currentEnvironment(), tolerance: tolerance.value, renderer: cfg.renderer }));
        } catch (err) {
          throw new Error(`导入 ${project}：${errorText(err)}`, { cause: err });
        }
      }
      if (asJSON.value) {
        printJSON(stdout, results.map(memory.importResultToJSON));
        return;
      }
      for (const r of results) {
        stdout.write(`${r.project}：${r.scenes} 个镜头，导入 ${r.attempts} 次尝试（${r.failures} 次校验失败）、${r.checks} 条事后检查问题，跳过 ${r.skipped}\n`);
        for (const note of r.notes ?? []) stdout.write(`  提示：${note}\n`);
      }
    },
  });
  cmd.flags().boolVar(asJSON, 'json', false, '输出 JSON');
  cmd.flags().float64Var(tolerance, 'duration-tolerance', 0.15, '重新校验归档产物时的时长容差（秒）');
  return cmd;
}
