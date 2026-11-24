/**
 * 渲染记忆的整理、回放考试与人工验收操作（memory_consolidate、memory_exam、memory_accept_exam）。
 */
import os from 'node:os';
import path from 'node:path';
import * as agentrun from '@onset/engine/agentrun';
import * as config from '@onset/engine/config';
import * as envutil from '@onset/engine/envutil';
import { formatFixed } from '@onset/engine/gofmt';
import { compareBytes } from '@onset/engine/gojson';
import * as ledger from '@onset/engine/ledger';
import * as memory from '@onset/engine/memory';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import * as tools from '@onset/engine/tools';
import { EventPrinter } from './agentprint';
import { currentEnvironment, validateTolerance } from './cli';
import { ExitError } from './cobra';
import { errorText, examPostCheck, jsonParam, loadMemoryConfig, splitList, writeReport } from './memory_cmd_shared';
import { bool, num, str, strs } from './ops/common';
import { defineOp } from './ops/op';
import { printJSON, recordOrchestratorUsage } from './usage_cmd';

/**
 * examWorkspace 是考场目录在项目里的位置。考场必须在项目里：渲染器从镜头目录
 * 逐级向上找 .agents/skills，放到记忆库里就找不到项目的技能。
 */
const examWorkspace = 'production/memory-exams';

function orNone(list: readonly string[] | null): string {
  if (list === null || list.length === 0) return '（无）';
  return list.join('、');
}

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
  examples: [
    'memory_consolidate()',
    'memory_consolidate({"min_count": 1, "all": true})',
    'memory_consolidate({"drafts": "./my-drafts"})',
  ],
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
          throw new Error(
            '没有配置整理者：在项目里运行，或用环境变量 ORCHESTRATOR 指定编排工具；也可以用 drafts 参数直接收录现成草稿',
          );
        }
        const isUnsafe = envutil.isUnsafe(unsafe);
        const env = config.childEnvironment(
          cfg,
          currentEnvironment(),
          isUnsafe,
          envutil.parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''),
        );
        out.write(`整理者: ${cfg.orchestrator}\n工作目录: ${workdir}\n---\n`);
        const printer = new EventPrinter(out, stderr);
        const { result, error } = await agentrun.run(
          {
            tool: cfg.orchestrator,
            // 用设置里给编排选的模型：制作人（director）靠它挑服务商，其他几家空着就用自己的默认。
            model: cfg.orchestratorModel,
            options: tools.effectiveOptions(cfg.orchestrator, cfg.orchestratorOptions),
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
        if (result.started)
          recordOrchestratorUsage(
            drafterSignal,
            ledger.memoryFile(store.dir),
            ledger.SourceConsolidate,
            cfg.orchestrator,
            env,
            result,
            error,
            stderr,
          );
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

defineOp({
  name: 'memory_exam',
  cli: ['memory', 'exam'],
  scopes: ['cli'],
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

两组必须按重复次数一一配对、实际模型一致。每条待考经验至少在一对试用组中实际召回，
否则整组保留原状态，先单独考试或调整召回条件与预算。多条合考只证明整组效果。
没有留出镜头时只能说明旧题上的表现；留出镜头不退步也不等于已证明跨项目改善。
机器检查不评价画面美感，构图与节奏等技法走人评考试。

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
    retest: {
      type: 'string',
      description: '重考生效、停用或被拒的经验（逗号分隔）：对照组去掉它们；停用经验通过后恢复生效，未通过保留原状态',
    },
    holdout: { type: 'strings', description: '留出题的镜头目录，可重复' },
    holdout_only: { type: 'boolean', description: '只验证所选新镜头，不重放来源旧题；仍要求严格改善且不得退步' },
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
        return scene.newAttempt({
          scene_id: s.id,
          renderer,
          outcome: scene.OutcomeFailed,
          error: runErr === null ? '' : errorText(runErr),
        });
      }
      return got;
    };
    const result = await store.exam({
      renderers: list,
      trial: splitList(str(p.trial)),
      episodes: splitList(str(p.episodes)),
      holdout: strs(p.holdout),
      holdoutOnly: bool(p.holdout_only),
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
        for (const c of r.cells ?? [])
          if (c.question === q.id && c.renderer === renderer && c.arm === arm) marks.push(mark(c));
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
      b +=
        '重考未通过：在当前模型上没有提升。状态不变——可用 memory_retire() 让它沉睡，或给它加 applies_when.models 限定到旧模型\n';
      break;
    default:
      if (r.verdict.invalid) b += '考试无效：记忆状态不变\n';
      else if (r.verdict.needs_human) b += '待人工确认：用 memory_promote() / memory_reject() 决定\n';
      else b += '未改动记忆状态（dry_run）\n';
  }
  return b;
}

defineOp({
  name: 'memory_accept_exam',
  cli: ['memory', 'accept-exam'],
  scopes: ['cli'],
  summary: '记录用户对视频对照的人工验收，标记进化完成',
  description:
    '只在用户明确确认观看效果后调用。指定本场已生效经验及看过的题目，保留原话；独立保存人工验收，不改机器判卷、评分、适用范围或原考试文件。',
  examples: [
    'memory_accept_exam({"exam":"exam-0001","name":"hold-readable","questions":["q1"],"note":"已核对画面与阅读节奏","statement":"填写用户明确确认的原话"})',
  ],
  params: {
    exam: { type: 'string', required: true, description: '考试编号' },
    name: { type: 'string', required: true, description: '本场已生效经验名' },
    questions: { type: 'strings', required: true, description: '明确看过并认可的题目编号' },
    note: { type: 'string', required: true, description: '人工验收结论' },
    statement: { type: 'string', required: true, description: '用户确认原话，不得自行编造' },
  },
  run: (p, { out }) => {
    const { store } = loadMemoryConfig();
    const acceptance = memory.acceptExam(store, {
      exam: str(p.exam),
      name: str(p.name),
      questions: strs(p.questions),
      note: str(p.note),
      userStatement: str(p.statement),
    });
    out.write(`${acceptance.exam}：进化完成（人工验收通过），机器检查记录保留\n`);
    return { data: acceptance };
  },
});
