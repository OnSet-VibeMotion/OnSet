/**
 * 渲染记忆的整组操作（memory_*），以及被 scene_run / scene_run_all、客户端对话、事后检查调用的挂钩函数
 * （attachMemory、preferenceBrief、recordCheckFindings）。移植自 internal/cli/memory.go。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agentrun from '@onset/engine/agentrun';
import * as audition from '@onset/engine/audition';
import * as config from '@onset/engine/config';
import * as envutil from '@onset/engine/envutil';
import * as fsutil from '@onset/engine/fsutil';
import { compareBytes, marshalIndent, sortedKeys } from '@onset/engine/gojson';
import { formatFixed, formatG, goTrimSpace } from '@onset/engine/gofmt';
import * as ledger from '@onset/engine/ledger';
import * as mediaprobe from '@onset/engine/mediaprobe';
import * as memory from '@onset/engine/memory';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import * as tools from '@onset/engine/tools';
import { EventPrinter } from './agentprint';
import { currentEnvironment, validateTolerance } from './cli';
import { ExitError, type Out } from './cobra';
import { defineGroup } from './ops/cli';
import { bool, num, str, strs } from './ops/common';
import { defineOp, ParamError, type ParamSpec } from './ops/op';
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
 * newRunID 是一次 scene_run / scene_run_all 调用的批次编号，同一批次的镜头共用，
 * memory_report 按它对比「第一次」与「第二次」。
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
      model: store.currentModel(renderer, currentEnvironment(), config.rendererModelFor(cfg, renderer)),
      explore: cfg.memory.explore,
      exploreSeed: run,
    });
  } catch (err) {
    throw new Error(`召回记忆：${errorText(err)}`, { cause: err });
  }
  // 参考范例跟着学习关系走：这位渲染工具 + 模型向谁学，就带上谁在同类镜头上被人选中的代码（audition.pickExemplars）。
  const exemplars = audition.pickExemplars(cfg.memory.dir, {
    renderer,
    model: store.currentModel(renderer, currentEnvironment(), config.rendererModelFor(cfg, renderer)),
    features: memory.features(s),
    project: memory.projectName(s.directory),
    sceneID: s.id,
  });
  const attached: scene.Scene = { ...memory.attachRecall(result, s), ...(exemplars ? { exemplars } : {}) };
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

const jsonParam: ParamSpec = { type: 'boolean', description: '输出 JSON' };

function loadMemoryConfig(): { cfg: config.Config; store: memory.Store } {
  let cfg: config.Config;
  try {
    cfg = config.load('.', null);
  } catch (err) {
    // 不在项目里（没有 onset.conf）时也能看记忆库：
    // 按 ONSET_MEMORY_DIR 或默认位置打开。项目配置本身有错时照常报错。
    let missing = false;
    try {
      fs.statSync('onset.conf');
    } catch (statErr) {
      missing = (statErr as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (!missing) throw err;
    const env = currentEnvironment();
    // 编排与渲染工具照项目配置的写法取环境变量，整理与考试在项目外也能跑。
    cfg = config.newConfig({
      orchestrator: env.ORCHESTRATOR ?? '',
      renderer: env.RENDERER ?? '',
      memory: { enabled: true, dir: env.ONSET_MEMORY_DIR ?? '', recallBudget: config.DefaultMemoryRecallBudget },
    });
    if (cfg.memory.dir === '') cfg.memory.dir = config.defaultMemoryDir(env);
  }
  return { cfg, store: memory.open(cfg.memory.dir) };
}

const validListStatus = new Set(['active', 'trial', 'rejected', 'dormant']);

defineOp({
  name: 'memory_list',
  cli: ['memory', 'list'],
  summary: '列出记忆',
  description: '列出记忆库里的经验与偏好，附按渲染工具分开的效果统计（召回次数 / 一次通过次数，只计正式渲染的首次尝试）。',
  examples: ['memory_list()', 'memory_list({"status": "trial", "json": true})'],
  params: {
    status: { type: 'string', description: '只列某个状态：active、trial、rejected、dormant' },
    json: jsonParam,
  },
  run: (p, { out }) => {
    const status = str(p.status);
    if (status !== '' && !validListStatus.has(status)) throw new ParamError('status 只能是 active、trial、rejected 或 dormant');
    const { store } = loadMemoryConfig();
    const { memories: all, broken } = store.memories();
    const stats = store.stats();
    const rows: { memory: memory.Memory; stats: Record<string, memory.Stat> | undefined }[] = [];
    for (const m of all) {
      if (status === '' || m.status === status) rows.push({ memory: m, stats: Object.hasOwn(stats, m.name) ? stats[m.name] : undefined });
    }
    const data = rows.map((r) => ({
      ...memory.memoryToJSON(r.memory),
      stats:
        r.stats === undefined
          ? null
          : sortedKeys(Object.fromEntries(Object.entries(r.stats).map(([k, v]) => [k, { recalled: v.recalled, passed_first_try: v.passed_first_try }]))),
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
        out.write(`         ${name}：召回 ${byRenderer[name].recalled} 次，一次通过 ${byRenderer[name].passed_first_try} 次\n`);
      }
    }
    // Go 版按 map 遍历（顺序随机）；这里按路径排序。
    for (const file of Object.keys(broken).sort(compareBytes)) out.write(`无法解析：${file}：${broken[file].message}\n`);
    return { data };
  },
});

defineOp({
  name: 'memory_show',
  cli: ['memory', 'show'],
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
  summary: '预览一个镜头会召回哪些记忆，以及原因',
  description: `按项目配置（MEMORY_SNAPSHOT、MEMORY_RECALL_BUDGET）预览镜头渲染时会召回的记忆。
不受 MEMORY=off 影响：关闭时渲染不召回，但仍可预览。`,
  examples: ['memory_recall({"scene": "scenes/scene-001"})', 'memory_recall({"scene": "scenes/scene-001", "with_trial": true, "json": true})'],
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
    if (model === '') model = store.currentModel(renderer, currentEnvironment(), config.rendererModelFor(cfg, renderer));
    const opts: memory.RecallOptions = { snapshot: cfg.memory.snapshot, budget: cfg.memory.recallBudget, renderer, model };
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
    for (const item of result.items) out.write(`  ✓ ${item.name}（${memory.recallReason(item)}，得分 ${formatFixed(item.score, 2)}）— ${item.description}\n`);
    for (const item of result.omitted) {
      if (item.omit_reason === 'limit') {
        out.write(`  ✗ ${item.name} 经验已满 ${result.max_lessons} 条，排在后面没注入（得分 ${formatFixed(item.score, 2)}）\n`);
        continue;
      }
      out.write(`  ✗ ${item.name} 超出字数预算（${item.chars} 字）\n`);
    }
    const section = memory.recallSection(result);
    if (section !== '') out.write(`\n注入提示词的原文：${section}`);
    return { data };
  },
});

defineOp({
  name: 'memory_consolidate',
  cli: ['memory', 'consolidate'],
  summary: '整理：把反复出现的失败提炼成试用经验',
  description: `把上次整理之后的失败经历按校验器聚类，出现次数不少于 min_count 的组交给 ORCHESTRATOR
起草经验或修订旧经验。草稿要过格式校验才进入试用：字段齐全、checked_by 是已有校验器、
不出现渲染工具名或模型名、不照抄镜头文案、不超长、与已有记忆说同一件事时必须写成修订。
没过校验的草稿带着原因交回去改一稿，改了仍不合格才记为被拒。

整理者只在记忆库的 consolidate/<run>/ 目录里写草稿，不改动项目。
drafts 跳过整理者，直接收录一个目录里现成的草稿（lessons/*.md、preferences/*.md）。`,
  examples: ['memory_consolidate()', 'memory_consolidate({"min_count": 1, "all": true})', 'memory_consolidate({"drafts": "./my-drafts"})'],
  params: {
    min_count: { type: 'integer', description: '一组失败至少出现几次才提炼', default: 2 },
    all: { type: 'boolean', description: '不看上次整理时间，把全部经历都算进来' },
    drafts: { type: 'string', description: '不调用整理者，直接收录该目录下现成的草稿' },
    json: jsonParam,
  },
  run: async (p, { out, err: stderr, signal, unsafe }) => {
    const { cfg, store } = loadMemoryConfig();
    const drafts = str(p.drafts);
    const minCount = num(p.min_count);
    const opts: memory.ConsolidateOptions = { minCount, all: bool(p.all), draftsDir: drafts, signal };
    if (drafts === '') {
      opts.drafter = async (workdir, prompt, drafterSignal) => {
        if (cfg.orchestrator === '') {
          throw new Error('没有配置整理者：在项目里运行，或用环境变量 ORCHESTRATOR 指定编排工具；也可以用 drafts 参数直接收录现成草稿');
        }
        const isUnsafe = envutil.isUnsafe(unsafe);
        const env = config.childEnvironment(cfg, currentEnvironment(), isUnsafe, envutil.parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''));
        out.write(`整理者: ${cfg.orchestrator}\n工作目录: ${workdir}\n---\n`);
        const printer = new EventPrinter(out, stderr);
        const { result, error } = await agentrun.run(
          {
            tool: cfg.orchestrator,
            // 用设置里给编排选的模型：导演（director）靠它挑服务商，其他几家空着就用自己的默认。
            model: cfg.orchestratorModel,
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
          drafterSignal,
        );
        if (result.started) recordOrchestratorUsage(drafterSignal, ledger.memoryFile(store.dir), ledger.SourceConsolidate, cfg.orchestrator, env, result, error, stderr);
        if (error) throw error;
      };
    }
    const result = await store.consolidate(opts);
    const data = memory.consolidateResultToJSON(result);
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    if (result.clusters.length === 0 && drafts === '') {
      out.write(`没有出现 ${Math.max(minCount, 1)} 次以上的同类失败，无需整理。\n`);
      return { data };
    }
    out.write(`聚类出 ${result.clusters.length} 组高频失败：\n`);
    for (const cl of result.clusters) out.write(`  ${cl.key} × ${cl.count}\n`);
    out.write(`进入试用：${orNone(result.accepted)}\n`);
    for (const name of Object.keys(result.rejected).sort(compareBytes)) {
      out.write(`被拒草稿 ${name}：\n  - ${result.rejected[name].join('\n  - ')}\n`);
    }
    if (result.accepted.length > 0) out.write('下一步：memory_exam({"renderers": "<工具1>,<工具2>"})\n');
    return { data };
  },
});

function orNone(list: readonly string[] | null): string {
  if (list === null || list.length === 0) return '（无）';
  return list.join('、');
}

defineOp({
  name: 'memory_exam',
  cli: ['memory', 'exam'],
  summary: '回放考试：试用经验能否转为生效',
  description: `考试矩阵：考题 × 渲染工具 × {对照组：当前生效记忆, 试用组：再加试用经验}。
考题是试用经验来源的失败经历（冻结输入原样重放），加上 holdout 给的留出镜头。
每格真实渲染一次（不重试），按确定性校验评分：一次通过得 10 分，否则每个失败项扣 1 分。

门槛（全部满足才转为生效）：
  1. 试用组总分严格高于对照组
  2. 任意一个渲染工具上，对照组通过的题试用组都通过
  3. 留出题上任意一个渲染工具的一次通过数不下降
  4. 所有格子都有有效结果——渲染工具自身故障使整场考试无效，不按 0 分算
  5. 考试期间生效记忆没变过，否则转为待人工确认

渲染次数 = 题数 × 渲染工具数 × 2 × 重复次数，每次都是一次完整的 AI CLI 调用。
考场建在项目的 production/memory-exams/ 下。考试未通过时报错。`,
  examples: [
    'memory_exam({"renderers": "claude,codex"})',
    'memory_exam({"renderers": "claude,codex", "holdout": ["scenes/scene-004"], "report_json": "production/exam.json"})',
  ],
  params: {
    renderers: { type: 'string', description: '参加考试的渲染工具，逗号分隔；缺省为配置的 RENDERER' },
    trial: { type: 'string', description: '只考这几条试用经验，逗号分隔；缺省考全部' },
    episodes: { type: 'string', description: '错题来源经历，逗号分隔；缺省取试用经验的 from_episodes' },
    retest: { type: 'string', description: '重考这几条生效经验（逗号分隔）：对照组去掉它们，用于模型换了以后确认它们还有用' },
    holdout: { type: 'strings', description: '留出题的镜头目录，可重复' },
    max_questions: { type: 'integer', description: '错题数上限', default: 4 },
    repeat: { type: 'integer', description: '每格重复次数，按多数结果计分', default: 1 },
    jobs: { type: 'integer', description: '并发上限；缺省读配置 SCENE_JOBS' },
    dry_run: { type: 'boolean', description: '只出结果，不改记忆状态' },
    report_json: { type: 'string', description: '把考试结果写成 JSON' },
    duration_tolerance: { type: 'number', description: '产物时长与 duration_seconds 的允许偏差（秒）', default: 0.15 },
  },
  run: async (p, { out, signal, unsafe }) => {
    const tolerance = num(p.duration_tolerance);
    validateTolerance(tolerance);
    const { cfg, store } = loadMemoryConfig();
    let list = splitList(str(p.renderers));
    if (list.length === 0) list = [cfg.renderer];
    for (const r of list) if (!tools.ValidRenderers.has(r)) throw new Error(`无效的渲染工具：${r}`);
    let jobs = num(p.jobs);
    if (jobs === 0) jobs = cfg.sceneJobs;
    const root = process.cwd();
    const workers = schedule.renderWorkers(os.availableParallelism(), schedule.systemMemory(), jobs);
    const isUnsafe = envutil.isUnsafe(unsafe);
    const run: memory.ExamRunner = async (sc, renderer, runSignal) => {
      let attempt: scene.Attempt | null = null;
      let s: scene.Scene = { ...sc, afterAttempt: (a) => (attempt = a) };
      s = scene.withRenderWorkers(s, workers);
      let runErr: unknown = null;
      try {
        await scene.run(s, cfg, isUnsafe, currentEnvironment(), out, tolerance, runSignal);
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
      trial: splitList(str(p.trial)),
      episodes: splitList(str(p.episodes)),
      holdout: strs(p.holdout),
      retest: splitList(str(p.retest)),
      maxQuestions: num(p.max_questions),
      repeat: num(p.repeat),
      jobs,
      budget: cfg.memory.recallBudget,
      workspace: path.join(root, examWorkspace),
      run,
      dryRun: bool(p.dry_run),
      modelOf: (renderer) => store.currentModel(renderer, currentEnvironment(), config.rendererModelFor(cfg, renderer)),
      postCheck: examPostCheck,
      signal,
    });
    const data = memory.examResultToJSON(result);
    if (str(p.report_json) !== '') writeReport(str(p.report_json), data);
    out.write(renderExam(result));
    if (!result.verdict.pass) throw new ExitError(1, '考试未通过');
    return { data };
  },
});

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
      b += '重考未通过：在当前模型上没有提升。状态不变——可用 memory_retire() 让它沉睡，或给它加 applies_when.models 限定到旧模型\n';
      break;
    default:
      if (r.verdict.invalid) b += '考试无效：记忆状态不变\n';
      else if (r.verdict.needs_human) b += '待人工确认：用 memory_promote() / memory_reject() 决定\n';
      else b += '未改动记忆状态（dry_run）\n';
  }
  return b;
}

defineOp({
  name: 'memory_promote',
  cli: ['memory', 'promote'],
  summary: '人工确认一条试用记忆生效',
  description: '偏好不参加考试，只能由人确认生效。经验通常由 memory_exam 转为生效；人工确认的经验会让快照标为「未经考试」。',
  examples: ['memory_promote({"name": "no-neon-overload"})'],
  params: { name: { type: 'string', description: '记忆名', required: true, positional: 0 } },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const snapshot = store.promote(str(p.name));
    out.write(`${str(p.name)} 已生效，快照 #${snapshot.id}\n`);
    return { data: { name: str(p.name), snapshot: snapshot.id } };
  },
});

defineOp({
  name: 'memory_reject',
  cli: ['memory', 'reject'],
  summary: '人工拒绝一条试用记忆',
  description: '把一条试用中的记忆记为被拒，原因写进它的 rejected_reason。被拒记忆保留文件、不再参加考试，也不会被召回。',
  examples: ['memory_reject({"name": "loop-forever", "reason": "无限循环会被确定性扫描判失败"})'],
  params: {
    name: { type: 'string', description: '记忆名', required: true, positional: 0 },
    reason: { type: 'string', description: '拒绝原因' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    store.reject(str(p.name), str(p.reason));
    out.write(`${str(p.name)} 已记为被拒\n`);
    return { data: { name: str(p.name) } };
  },
});

defineOp({
  name: 'memory_retire',
  cli: ['memory', 'retire'],
  summary: '让一条生效记忆转为沉睡',
  description: 'memory_status() 会列出待沉睡候选（召回后一次通过率不高于基线）；确认后用它让一条记忆沉睡。用户收回一条偏好时也用它。',
  examples: ['memory_retire({"name": "font-local-block", "reason": "在两个渲染工具上都没有提升"})'],
  params: {
    name: { type: 'string', description: '记忆名', required: true, positional: 0 },
    reason: { type: 'string', description: '原因' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const snapshot = store.retire(str(p.name), str(p.reason));
    out.write(`${str(p.name)} 已转为沉睡，快照 #${snapshot.id}\n`);
    return { data: { name: str(p.name), snapshot: snapshot.id } };
  },
});

defineOp({
  name: 'memory_rollback',
  cli: ['memory', 'rollback'],
  summary: '回退到某个快照',
  description: '把快照 to 的生效记忆集合恢复成一个新快照，不删除任何历史。缺省回到最新快照的上一个。',
  examples: ['memory_rollback()', 'memory_rollback({"to": 3})'],
  params: { to: { type: 'integer', description: '目标快照号；缺省为最新快照的上一个' } },
  run: (p, { out }) => {
    const to = num(p.to);
    if (to < 0) throw new ParamError('to 必须是快照号');
    const { store } = loadMemoryConfig();
    const snapshot = store.rollback(to);
    out.write(`已回退到快照 #${snapshot.restored_from}，记为新快照 #${snapshot.id}（${(snapshot.entries ?? []).length} 条生效记忆）\n`);
    return { data: { restored_from: snapshot.restored_from, snapshot: snapshot.id, active: (snapshot.entries ?? []).length } };
  },
});

defineOp({
  name: 'memory_status',
  cli: ['memory', 'status'],
  summary: '记忆库现状；发现人工编辑时记成新快照',
  description: `汇总记忆库：各状态的记忆数、最新快照、经历数、上次整理后新增的失败数，以及待沉睡候选。

召回只读快照。手改了记忆文件时，memory_status 会发现与最新快照不一致的生效记忆，
把当前状态记成一个新快照并标注「人工编辑，未经考试」；"no_record": true 只报告不记录。`,
  examples: ['memory_status()', 'memory_status({"report_json": "production/memory-status.json"})'],
  params: {
    report_json: { type: 'string', description: '把现状写成 JSON' },
    no_record: { type: 'boolean', description: '只报告人工编辑，不记成新快照' },
  },
  run: (p, { out }) => {
    const { cfg, store } = loadMemoryConfig();
    const report = store.status(!bool(p.no_record), (r) => store.currentModel(r, currentEnvironment()));
    const data = memory.statusReportToJSON(report);
    if (str(p.report_json) !== '') writeReport(str(p.report_json), data);
    const state = cfg.memory.enabled ? '打开' : '关闭';
    const pinned = cfg.memory.snapshot > 0 ? '钉住 #' + cfg.memory.snapshot : '跟随最新';
    out.write(`记忆库：${report.dir}\n本项目：记忆${state}，快照${pinned}，召回预算 ${cfg.memory.recallBudget} 字\n最新快照：#${report.snapshot}\n`);
    for (const key of Object.keys(report.counts).sort(compareBytes)) out.write(`  ${key}：${report.counts[key]}\n`);
    out.write(`经历 ${report.episodes} 段，上次整理后新增失败 ${report.pending_failures} 段\n`);
    if ((report.drift ?? []).length > 0) {
      if (report.recorded_snapshot > 0) out.write(`发现人工编辑：${report.drift.join('、')}，已记为快照 #${report.recorded_snapshot}（未经考试）\n`);
      else out.write(`发现人工编辑：${report.drift.join('、')}（未记快照，召回不会用到）\n`);
    }
    for (const r of report.retest ?? []) {
      out.write(
        `需要重考：${r.name} 当初在 ${r.renderer} 上用 ${r.examined_models.join('、')} 考过，现在是 ${r.current_model}（memory_exam({"renderers": "${r.renderer}", "retest": "${r.name}"})）\n`,
      );
    }
    for (const x of report.suspect ?? []) {
      const renderer = x.renderer.split('/')[0];
      out.write(
        `可疑：${x.name} 在 ${x.renderer} 上召回 ${x.recalled} 次，其中 ${x.harmful} 次它要防的 ${(x.checks ?? []).join('、')} 照样判了失败（memory_exam({"renderers": "${renderer}", "retest": "${x.name}"})）\n`,
      );
    }
    for (const w of report.weak ?? []) {
      out.write(`待沉睡：${w.name} 在 ${w.renderer} 上召回 ${w.recalled} 次，一次通过率 ${formatFixed(w.rate * 100, 0)}%，不高于基线 ${formatFixed(w.baseline * 100, 0)}%\n`);
    }
    // Go 版按 map 遍历（顺序随机）；这里按路径排序。
    for (const file of Object.keys(report.broken ?? {}).sort(compareBytes)) out.write(`无法解析：${file}：${report.broken[file]}\n`);
    return { data };
  },
});

/** strconv.ParseFloat 能接受的十进制写法（含 inf / nan 等，与 Go 一致地判为数，再由范围检查拦下）。 */
function parseGoFloat(text: string): number | null {
  if (/^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?)$/.test(text)) return Number(text);
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^nan$/i.test(text)) return NaN;
  return null;
}

defineOp({
  name: 'memory_feedback',
  cli: ['memory', 'feedback'],
  summary: '为一个镜头补录人工反馈（👍 / 👎）',
  description: '把人工反馈写成一段经历。👎 会进入下一次整理；说明里的审美取向会被写成偏好，偏好由人确认后才生效。up 与 down 必须且只能给一个。',
  examples: [
    'memory_feedback({"scene": "scenes/scene-003", "down": true, "note": "满屏霓虹太刺眼", "at": 2.5})',
    'memory_feedback({"scene": "scenes/scene-003", "down": true, "region": "0.1,0.6,0.8,0.3", "note": "字幕压住了图表"})',
  ],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    up: { type: 'boolean', description: '👍' },
    down: { type: 'boolean', description: '👎' },
    note: { type: 'string', description: '说明' },
    at: { type: 'number', description: '画面在镜头内的时间点（秒）', default: -1 },
    region: { type: 'string', description: '框选区域，归一化坐标 x,y,w,h' },
    element: { type: 'string', description: '点选的元素' },
  },
  run: (p, { out }) => {
    if (bool(p.up) === bool(p.down)) throw new ParamError('必须且只能给出 up 或 down 之一');
    const feedback = memory.newFeedback({ verdict: bool(p.down) ? 'down' : 'up', note: goTrimSpace(str(p.note)), seconds: num(p.at), element: str(p.element) });
    const region = str(p.region);
    if (region !== '') {
      const values: number[] = [];
      for (const part of region.split(',')) {
        const value = parseGoFloat(goTrimSpace(part));
        // NaN 在 Go 里同样过得了 value < 0 || value > 1 的检查。
        if (value === null || value < 0 || value > 1) throw new ParamError('region 必须是 4 个 0..1 之间的数：x,y,w,h');
        values.push(value);
      }
      if (values.length !== 4) throw new ParamError('region 必须是 4 个 0..1 之间的数：x,y,w,h');
      feedback.region = values;
    }
    const { store } = loadMemoryConfig();
    const s = scene.load(str(p.scene));
    const episode = store.recordFeedback(s, feedback);
    out.write(`已记录经历 ${episode.id}\n`);
    return { data: { episode: episode.id } };
  },
});

defineOp({
  name: 'memory_timeline',
  cli: ['memory', 'timeline'],
  summary: '记忆库的事件时间线',
  description: '按发生顺序列出记忆库的事件：写经历、整理、试用、草稿被拒、考试、生效、被拒、沉睡、快照、人工编辑与回退。',
  examples: ['memory_timeline({"limit": 20})', 'memory_timeline({"json": true})'],
  params: {
    json: jsonParam,
    limit: { type: 'integer', description: '只显示最近若干条' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    let events = store.timeline();
    const limit = num(p.limit);
    if (limit > 0 && events.length > limit) events = events.slice(events.length - limit);
    const data = events.map(memory.eventToJSON);
    if (bool(p.json)) {
      printJSON(out, data);
      return { data };
    }
    for (const event of events) out.write(`${event.time}  ${event.type.padEnd(14)} ${event.summary}\n`);
    return { data };
  },
});

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

defineOp({
  name: 'memory_remember',
  cli: ['memory', 'remember'],
  summary: '记住用户亲口说的一条偏好',
  description: `把用户表达的长期取向直接记为生效的偏好，并生成快照。用户自己说出来的就是确认，
不需要再经人工确认或考试。

偏好会进入两处：编排工具每次开工前读到的「用户偏好」段（客户端的每一轮对话），
以及每个镜头渲染时的记忆召回。默认只对当前项目成立，"global": true 对所有项目成立。
用户收回一条偏好时用 memory_retire({"name": "<名字>"})。

"inferred": true 用于用户没有明说、由编排工具推测出来的取向：它进入试用，出现在偏好段的
「待确认」里，用户认可（memory_promote({"name": "<名字>"})）后才生效。`,
  examples: [
    'memory_remember({"text": "主色不超过两种高饱和色，背景用深色", "name": "calm-palette", "description": "配色克制"})',
    'memory_remember({"text": "画面里不要出现 emoji", "name": "no-emoji", "global": true})',
    'memory_remember({"text": "配色只用品牌色加一个强调色", "name": "calm-palette-v2", "revises": "calm-palette"})',
    'memory_remember({"text": "用户几次把节奏改慢，倾向每屏停留更久", "name": "slower-pacing", "inferred": true})',
  ],
  params: {
    text: { type: 'string', description: '偏好的完整说明', required: true, positional: 0 },
    name: { type: 'string', description: '偏好名，小写字母、数字与连字符；缺省按时间生成' },
    description: { type: 'string', description: '一句话概括；缺省取正文第一句' },
    global: { type: 'boolean', description: '对用户所有项目都成立' },
    revises: { type: 'string', description: '替换的旧偏好名，旧偏好转为沉睡' },
    inferred: { type: 'boolean', description: '用户没有明说、由编排工具推测的取向：先进入试用，用户确认后才生效' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const root = process.cwd();
    const inferred = bool(p.inferred);
    const { memory: m, snapshot } = store.remember({
      name: str(p.name),
      description: str(p.description),
      body: str(p.text),
      project: memory.projectName(root),
      global: bool(p.global),
      revises: str(p.revises),
      inferred,
    });
    const scope = m.scope === '' ? '所有项目' : '本项目（' + m.scope + '）';
    const data = { name: m.name, scope: m.scope, description: m.description, status: m.status, snapshot: snapshot?.id ?? 0 };
    if (inferred) {
      out.write(`推测的偏好 ${m.name}（${scope}）进入试用：${m.description}；用户确认后运行 memory_promote({"name": "${m.name}"})\n`);
      return { data };
    }
    out.write(`已记住偏好 ${m.name}（${scope}）：${m.description}，快照 #${snapshot?.id ?? 0}\n`);
    return { data };
  },
});

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
 * 空白帧经验来自 scene_frames 的 at=0 加 check_blank（第 0 帧当封面），看末帧会把合法的淡出也算进去。
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

/** 考试作答后的补查：空白帧看产物第 0 帧，阅读时间看作答者交的本镜头清单。 */
export function examPostCheck(s: scene.Scene, checks: string[]): Finding[] {
  return [...blankPostCheck(s, checks), ...memory.readsPostCheck(s, checks)];
}

function snapshotsText(list: readonly number[] | null): string {
  return '[' + (list ?? []).join(' ') + ']';
}

defineOp({
  name: 'memory_report',
  cli: ['memory', 'report'],
  summary: '按渲染批次对比：一次通过率、重试、问题数、耗时与 token',
  description: `一次 scene_run / scene_run_all 调用是一个批次。报告按批次汇总正式渲染：
  镜头数、首次尝试就通过的镜头数与比例（事后检查查出问题的不算通过）、
  重试次数、问题数（含事后检查查出的）、耗时、token、平均每镜召回的记忆条数、用到的快照，
并按「渲染工具/模型」分开列出——换了渲染工具带来的变化不能算成记忆的功劳。

缺省只看当前项目的批次，并对比最近两批；compare 指定任意两批。`,
  examples: ['memory_report()', 'memory_report({"compare": "run-20261113-101500,run-20261114-153000"})', 'memory_report({"json": true})'],
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
    const data = { compare: pair === null ? null : pair.map(memory.runSummaryToJSON), runs: runs.map(memory.runSummaryToJSON) };
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
  name: 'memory_import',
  cli: ['memory', 'import'],
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
      out.write(`${r.project}：${r.scenes} 个镜头，导入 ${r.attempts} 次尝试（${r.failures} 次校验失败）、${r.checks} 条事后检查问题，跳过 ${r.skipped}\n`);
    }
    return { data };
  },
});
