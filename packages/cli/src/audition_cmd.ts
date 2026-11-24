/**
 * 试镜与模型互学（引擎在 @onset/engine/audition）：
 *   scene_audition        同一镜头交给几位选手各渲染一遍（可两段式：先由一位写设计稿）；也用来开人评考试
 *   scene_audition_retry  重试失败或中断的一位，沿用冻结输入与选手配置
 *   scene_audition_vote   盲评；人评考试的结论落到记忆上，胜者的代码进范例库
 *   scene_audition_adopt  采用胜者，换进项目的镜头
 *   scene_design          两段式的第一段：让某位只为镜头写设计稿
 *   audition_learn        按一条学习关系，把老师赢了学生的试镜交给整理者，写成学生的试用经验
 *
 * 全都只给命令行与客户端（scopes: cli）：一场试镜是好几次完整的渲染，谁来比、选谁、向谁学由人定，
 * 编排工具不能自己发起，也不能替人投票。
 */
import path from 'node:path';
import * as audition from '@onset/engine/audition';
import * as config from '@onset/engine/config';
import * as envutil from '@onset/engine/envutil';
import * as memory from '@onset/engine/memory';
import * as scene from '@onset/engine/scene';
import {
  adoptAuditionContestant,
  checkRenderer,
  contestantRunner,
  makeLearnDrafter,
  projectOf,
  renderVerdict,
  resolveAuditionEntries,
  runDesign,
} from './audition_runner';
import { validateTolerance } from './cli';
import { defineGroup } from './ops/cli';
import { bool, num, str } from './ops/common';
import { defineOp, ParamError } from './ops/op';

export { renderVerdict, runDesign };

defineOp({
  name: 'scene_audition',
  cli: ['scene', 'audition'],
  summary: '试镜：同一个镜头交给几位选手各渲染一遍，等人盲评',
  description: `同一个镜头、同一份冻结的输入，交给几位选手（渲染工具，可指定模型）各渲染一遍。
选手按随机标号 A、B、C……放进项目的 production/studio/auditions/<编号>/，评判之前看不出谁是谁。
渲染完在客户端的「试镜」页并排看、选出最好的一份（或判差不多、都不行），再决定采不采用。

两段式：选手写成「实现者<设计者」（两边都是「渲染工具[:模型]」），先由设计者只写一份 design.md，再由实现者照着做。

with_memory 为 true（缺省）时每位选手照常带上按自己召回的记忆与参考范例（真实情况下它会拿到的）；
为 false 时谁都不带，只比模型本身。试镜的渲染不写进记忆的经历：同一个镜头连着渲染几遍是人为安排的对照。

人评考试：给 exam（学习关系编号）时不看 contestants，出三份——学生不带新经验、学生带新经验（lessons，
缺省是向这位老师学来、还在试用的全部经验）、老师作参照。人从两份学生作品里选，选中带经验的那份经验才生效。

渲染次数 = 选手数（两段式的选手再加一次写设计稿），每次都是一次完整的 AI CLI 调用。单个选手失败不影响其他人。`,
  examples: [
    'scene_audition({"scene": "scenes/scene-003", "contestants": "claude:opus,codex"})',
    '# 只比模型本身，不带记忆',
    'scene_audition({"scene": "scenes/scene-003", "contestants": "claude,opencode:deepseek/deepseek-v4,qoder", "with_memory": false})',
    '# 两段式：codex 自己做，对比 codex 照 claude 的设计稿做',
    'scene_audition({"scene": "scenes/scene-003", "contestants": "codex,codex<claude:opus"})',
    '# 人评考试',
    'scene_audition({"scene": "scenes/scene-003", "exam": "rel-1a2b3c4d"})',
  ],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    contestants: {
      type: 'string',
      description: '选手，逗号分隔，每位写「渲染工具[:模型]」，两段式写「实现者<设计者」',
    },
    with_memory: { type: 'boolean', description: '每位选手带上按自己召回的记忆与参考范例', default: true },
    exam: { type: 'string', description: '人评考试：学习关系的编号' },
    lessons: { type: 'string', description: '人评考试要考的试用经验，逗号分隔；缺省是向这位老师学来、还在试用的全部' },
    jobs: { type: 'integer', description: '同时渲染几位；缺省读配置 SCENE_JOBS' },
    duration_tolerance: { type: 'number', description: '产物时长与 duration_seconds 的允许偏差（秒）', default: 0.15 },
  },
  scopes: ['cli'],
  run: async (p, { out, err, signal, unsafe }) => {
    const tolerance = num(p.duration_tolerance);
    validateTolerance(tolerance);
    const sc = scene.load(str(p.scene));
    const root = projectOf(sc.directory);
    const cfg = config.load(root, null);
    const store = cfg.memory.enabled ? memory.open(cfg.memory.dir) : null;
    const { entries, exam, withMemory } = resolveAuditionEntries(
      cfg,
      store,
      str(p.exam),
      str(p.lessons),
      str(p.contestants),
      bool(p.with_memory),
    );
    let jobs = num(p.jobs);
    if (jobs === 0) jobs = cfg.sceneJobs;
    jobs = Math.max(1, Math.min(jobs, entries.length));
    const a = audition.create(root, sc, entries, { withMemory, exam });
    out.write(
      `${exam ? '人评考试' : '试镜'} ${a.id}：镜头 ${sc.id}，${a.contestants.length} 份${withMemory ? '' : '（都不带记忆）'}\n`,
    );
    const release = audition.acquireRun(root, a);
    try {
      const { runOne, persist } = contestantRunner(root, a, cfg, out, unsafe, tolerance, jobs, signal);
      const queue = [...a.contestants];
      await Promise.all(
        Array.from({ length: jobs }, async () => {
          for (let c = queue.shift(); c; c = queue.shift()) {
            if (signal?.aborted) {
              audition.applyAttempt(root, c, null, '已取消');
              await persist();
              continue;
            }
            await runOne(c);
          }
        }),
      );
      await persist();
      const done = a.contestants.filter((c) => c.outcome === 'succeeded').length;
      out.write(`${done}/${a.contestants.length} 份出了合格的产物。到「试镜」页并排看、选出最好的一份。\n`);
      if (signal?.aborted) err.write('试镜被取消，没跑完的记为失败。\n');
      return { data: { audition: a.id, scene: sc.id, succeeded: done } };
    } finally {
      release();
    }
  },
});

defineOp({
  name: 'scene_audition_retry',
  cli: ['scene', 'audition-retry'],
  summary: '重试一位失败或中断的试镜选手，保留原标号、模型与冻结输入',
  description: `重新渲染一场试镜里失败或中断的一位选手：沿用原来的标号、渲染工具与模型、冻结的镜头输入，不续接旧的模型会话。
只能重试还没评判、也还没有合格产物的选手；同一场试镜里还有别的选手在跑时会被拒绝，等它们跑完再试。
冻结目录里已有指纹一致的产物时先在本机验收，合格就直接用，不再花一次渲染。`,
  examples: ['scene_audition_retry({"audition": "audition-20261114-153012", "slot": "B"})'],
  params: {
    audition: { type: 'string', description: '试镜编号', required: true, positional: 0 },
    slot: { type: 'string', description: '要重试的选手标号', required: true },
    project_root: { type: 'string', description: '项目根目录；缺省为当前目录' },
  },
  scopes: ['cli'],
  run: async (p, { out, signal, unsafe }) => {
    const root = path.resolve(str(p.project_root) || '.');
    const id = str(p.audition);
    const release = audition.acquireRun(root, audition.load(root, id));
    try {
      // 拿到整场写权后重读，不能拿排队前的结果覆盖别人的完成记录。
      const a = audition.load(root, id);
      const c = audition.retryContestant(root, a, str(p.slot));
      checkRenderer(c.renderer);
      if (c.designer) checkRenderer(c.designer);
      const cfg = config.load(root, null);
      if (a.exam) {
        const store = cfg.memory.enabled ? memory.open(cfg.memory.dir) : null;
        if (!store || a.exam.lessons.some((name) => store.find(name)?.status !== memory.StatusTrial)) {
          throw new Error('本场考试的试用经验已不可用，请恢复记忆配置或新开一场考试');
        }
      }
      const { runOne } = contestantRunner(root, a, cfg, out, unsafe, 0.15, 1, signal);
      out.write(`重试 ${a.id} 的选手 ${c.slot}\n`);
      await runOne(c);
      if (c.outcome !== 'succeeded') throw new Error(`选手 ${c.slot} 未生成合格画面，可在试镜页重试`);
      return { data: { audition: a.id, slot: c.slot, scene: a.scene_id } };
    } finally {
      release();
    }
  },
});

defineOp({
  name: 'scene_audition_vote',
  cli: ['scene', 'audition-vote'],
  summary: '试镜的评判：选出一位、判差不多或都不行',
  description: `给一场试镜下评判。kind 是 winner（选出 winner 那一位）、tie（差不多）或 none（都不行）。
可以改判，以最后一次为准（人评考试的结论一旦生效就不能改）。评判记进记忆库目录的 auditions.jsonl，
跨项目累积谁在哪类镜头上赢了谁；胜者的合成代码进范例库。人评考试里选中带经验的那份，经验生效。`,
  examples: [
    'scene_audition_vote({"audition": "audition-20261114-153012", "kind": "winner", "winner": "B", "note": "节奏更好"})',
  ],
  params: {
    audition: { type: 'string', description: '试镜编号', required: true, positional: 0 },
    kind: { type: 'string', description: 'winner、tie 或 none', required: true },
    winner: { type: 'string', description: 'kind 为 winner 时选中的标号（A、B……）' },
    note: { type: 'string', description: '一句说明' },
    project_root: { type: 'string', description: '项目根目录；缺省为当前目录' },
  },
  scopes: ['cli'],
  run: (p, { out, err }) => {
    const root = path.resolve(str(p.project_root) || '.');
    const a = audition.vote(root, str(p.audition), { kind: str(p.kind), winner: str(p.winner), note: str(p.note) });
    const { exam, warnings } = audition.afterVote(root, config.load(root, null).memory.dir, a);
    out.write(renderVerdict(a));
    if (exam) out.write(exam.summary + '\n');
    for (const w of warnings) err.write(`警告：${w}\n`);
    return { data: { ...audition.auditionToJSON(a), exam_outcome: exam ?? undefined } };
  },
});

defineOp({
  name: 'scene_audition_adopt',
  cli: ['scene', 'audition-adopt'],
  summary: '采用试镜里的一份：换进项目的镜头',
  description: `把一位选手渲染出的东西换进项目里的镜头：镜头原来的产物与日志先归档进 attempts/，
再拷入选手的产物、合成代码、日志与设计稿（两段式）；scene.json 的 renderer 改成这位选手的渲染工具，
渲染记录按项目里的镜头重写，所以镜头不会被判为 Stale。只能采用评判过、产物合格的选手；
镜头在试镜之后改过时拒绝。人评考试的作品不能采用。`,
  examples: ['scene_audition_adopt({"audition": "audition-20261114-153012", "slot": "B"})'],
  params: {
    audition: { type: 'string', description: '试镜编号', required: true, positional: 0 },
    slot: { type: 'string', description: '要采用的选手标号', required: true },
    project_root: { type: 'string', description: '项目根目录；缺省为当前目录' },
  },
  scopes: ['cli'],
  run: (p, { out, err }) => {
    const root = path.resolve(str(p.project_root) || '.');
    return { data: adoptAuditionContestant(root, str(p.audition), str(p.slot), out, err) };
  },
});

defineOp({
  name: 'scene_design',
  cli: ['scene', 'design'],
  summary: '两段式：让某位只为镜头写设计稿（design.md）',
  description: `让 designer（「渲染工具[:模型]」）读完整的镜头说明，只在镜头目录写一份 design.md：画面构成、时间线、动效、
视觉与容易做砸的地方。有了它之后，这个镜头的渲染提示词会要求照设计稿做，design.md 也成为镜头的输入（改了它镜头会 Stale）。
镜头已有的产物、日志与渲染记录不动。`,
  examples: ['scene_design({"scene": "scenes/scene-003", "designer": "claude:opus"})'],
  params: {
    scene: { type: 'string', description: '镜头目录', required: true, positional: 0 },
    designer: { type: 'string', description: '写设计稿的一位：「渲染工具[:模型]」', required: true },
  },
  scopes: ['cli'],
  run: async (p, { out, signal, unsafe }) => {
    const sc = scene.load(str(p.scene));
    const who = audition.parseEntry(str(p.designer));
    checkRenderer(who.renderer);
    const cfg = config.load(projectOf(sc.directory), null);
    const attempt = await runDesign(sc, cfg, who.renderer, who.model, envutil.isUnsafe(unsafe), out, signal);
    const actual = attempt?.model && attempt.model !== who.model ? `，实际模型 ${attempt.model}` : '';
    out.write(`设计稿写好了：${path.join(sc.directory, scene.DesignFile)}（${audition.entryLabel(who)}${actual}）\n`);
    return { data: { scene: sc.id, design: scene.DesignFile, designer: audition.toolKey(who.renderer, who.model) } };
  },
});

defineGroup({
  path: ['audition'],
  summary: '模型互学：按试镜里的评判向老师学',
  description:
    '学习关系由人在客户端确认（试镜的评判累积出提议）；audition_learn 把老师赢了学生的试镜整理成学生的试用经验。',
});

defineOp({
  name: 'audition_learn',
  cli: ['audition', 'learn'],
  summary: '向老师学：把老师赢了学生的试镜整理成学生的试用经验',
  description: `按一条已确认的学习关系（学生 · 老师），把老师在试镜里赢了学生、还没学过的几场（最多 4 场）里两边的合成代码
交给 ORCHESTRATOR 对比，写成只给学生用的经验：范围限定学生的渲染工具与模型，learned_from 记老师，
checked_by 是 audition.judged（人在试镜里判的）。经验进入试用，用人评考试（scene_audition 的 exam）决定留不留。`,
  examples: ['audition_learn({"relation": "rel-1a2b3c4d"})'],
  params: {
    relation: { type: 'string', description: '学习关系的编号', required: true, positional: 0 },
  },
  scopes: ['cli'],
  run: async (p, { out, err: stderr, signal, unsafe }) => {
    const cfg = config.load('.', null);
    if (!cfg.memory.enabled) throw new ParamError('向老师学要打开记忆（MEMORY=on）');
    if (cfg.orchestrator === '')
      throw new Error('没有配置整理者：在项目里运行，或用环境变量 ORCHESTRATOR 指定编排工具');
    const store = memory.open(cfg.memory.dir);
    const relation = audition.findRelation(cfg.memory.dir, str(p.relation));
    const result = await audition.learn(store, {
      relation,
      rows: audition.readVerdicts(cfg.memory.dir),
      signal,
      drafter: makeLearnDrafter(cfg, store, envutil.isUnsafe(unsafe), out, stderr),
    });
    out.write(
      `向 ${relation.teacher} 学，用了 ${result.pairs.length} 场试镜：${result.pairs.map((x) => x.audition).join('、')}\n`,
    );
    out.write(`进入试用：${result.accepted.length > 0 ? result.accepted.join('、') : '（无）'}\n`);
    for (const [label, problems] of Object.entries(result.rejected)) {
      out.write(`被拒草稿 ${label}：\n  - ${problems.join('\n  - ')}\n`);
    }
    if (result.accepted.length > 0) {
      out.write(`下一步：挑一个镜头做人评考试 scene_audition({"scene": "<镜头>", "exam": "${relation.id}"})\n`);
    }
    return {
      data: {
        run: result.run,
        workdir: result.workdir,
        pairs: result.pairs.map((x) => x.audition),
        accepted: result.accepted,
        rejected: result.rejected,
      },
    };
  },
});
