/**
 * 试镜与模型互学的执行、评判输出与采用辅助逻辑（由 audition_cmd.ts 调用与再导出）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agentrun from '@onset/engine/agentrun';
import * as audition from '@onset/engine/audition';
import * as config from '@onset/engine/config';
import * as envutil from '@onset/engine/envutil';
import * as fsutil from '@onset/engine/fsutil';
import { marshal } from '@onset/engine/gojson';
import * as ledger from '@onset/engine/ledger';
import * as memory from '@onset/engine/memory';
import { decodeRawMap, encodeRawMapIndent } from '@onset/engine/rawjson';
import * as scene from '@onset/engine/scene';
import * as schedule from '@onset/engine/schedule';
import * as tools from '@onset/engine/tools';
import { EventPrinter } from './agentprint';
import type { Out } from './cobra';
import { attachMemory, newRunID } from './memory_cmd';
import { sceneSeriesId } from './memory_cmd_shared';
import { ParamError } from './ops/op';
import { recordOrchestratorUsage } from './usage_cmd';

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 每行前面加上选手标号，几位选手同时渲染时分得清是谁说的。 */
function prefixed(out: Out, label: string): Out {
  let pending = '';
  return {
    write(text: string) {
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) out.write(`[${label}] ${line}\n`);
    },
  };
}

/** 按项目根找到项目（有 onset.conf 的那一层）；镜头不在项目里时报错。 */
export function projectOf(dir: string): string {
  const root = scene.findProjectRoot(dir);
  if (root === '') throw new Error(`${dir} 不在项目里（向上找不到 onset.conf）`);
  return root;
}

export function checkRenderer(renderer: string): void {
  if (!tools.ValidRenderers.has(renderer)) throw new ParamError(`无效的渲染工具：${renderer}`);
}

/**
 * 两段式的第一段：让 designer 只写 design.md（scene.run 的 designOnly），返回这一次的尝试记录（用量、模型）。
 * 设计者与实现者拿到的镜头说明一样，所以召回记忆与参考范例按设计者自己的工具与模型算。
 */
export async function runDesign(
  s: scene.Scene,
  cfg: config.Config,
  designer: string,
  model: string,
  unsafe: boolean,
  out: Out,
  signal?: AbortSignal,
): Promise<scene.Attempt | null> {
  let attempt: scene.Attempt | null = null;
  const own: config.Config = {
    ...cfg,
    renderer: designer,
    rendererModel: model,
    rendererOptions: config.rendererOptionsFor(cfg, designer),
  };
  let ds: scene.Scene = { ...s, renderer: designer, designOnly: true, afterAttempt: (x) => (attempt = x) };
  if (cfg.memory.enabled) {
    ds = { ...attachMemory(ds, own, out, newRunID()), designOnly: true, afterAttempt: (x) => (attempt = x) };
  }
  await scene.run(ds, own, unsafe, envutil.envMap(), out, 0.15, signal);
  return attempt;
}

/** 初次试镜与单人重试共用配置、记忆、两段式制作与结果落盘。 */
export function contestantRunner(
  root: string,
  a: audition.Audition,
  cfg: config.Config,
  out: Out,
  unsafe: boolean,
  tolerance: number,
  jobs: number,
  signal?: AbortSignal,
) {
  const store = cfg.memory.enabled ? memory.open(cfg.memory.dir) : null;
  const withMemory = a.with_memory;
  const exam = a.exam;
  const env = envutil.envMap();
  const isUnsafe = envutil.isUnsafe(unsafe);
  const workers = schedule.renderWorkers(os.availableParallelism(), schedule.systemMemory(), jobs);
  const trials = exam ? exam.lessons.map((name) => store?.find(name) ?? null).filter((m) => m !== null) : [];
  // 选手的结果写回 audition.json：几位同时跑，按顺序落盘免得互相盖掉。
  let saving = Promise.resolve();
  const persist = () => {
    saving = saving.then(() => audition.save(root, a));
    return saving;
  };

  const runOne = async (c: audition.Contestant) => {
    c.status = 'running';
    c.outcome = '';
    c.output = '';
    c.error = '';
    c.problems = null;
    c.checks = null;
    await persist();
    const log = prefixed(out, c.slot);
    let attempt: scene.Attempt | null = null;
    let failure = '';
    const extra = tools.newUsage();
    let extraSeconds = 0;
    try {
      let s = audition.contestantScene(root, c);
      s.renderer = c.renderer;
      // 选手的工具与模型盖掉项目配置：rendererModelFor 只在工具相同时用 rendererModel。
      const own: config.Config = {
        ...cfg,
        renderer: c.renderer,
        rendererModel: c.model,
        rendererOptions: config.rendererOptionsFor(cfg, c.renderer),
      };
      const prepare = (target: scene.Scene): scene.Scene => {
        let prepared = target;
        if (store !== null && withMemory) {
          const model = store.currentModel(
            c.renderer,
            env,
            c.model !== '' ? c.model : config.rendererModelFor(cfg, c.renderer),
          );
          const result = store.recallScene(prepared, {
            snapshot: cfg.memory.snapshot,
            budget: cfg.memory.recallBudget,
            renderer: c.renderer,
            model,
            series: sceneSeriesId(root) || sceneSeriesId(prepared.directory),
            // 人评考试的带经验那份：再加上要考的试用经验，其余与不带的那份逐字相同。
            ...(c.role === 'trial' ? { extra: trials } : {}),
          });
          const exemplars = audition.pickExemplars(cfg.memory.dir, {
            renderer: c.renderer,
            model,
            features: memory.features(prepared),
            project: memory.projectName(prepared.directory),
            sceneID: prepared.id,
          });
          prepared = { ...memory.attachRecall(result, prepared), ...(exemplars ? { exemplars } : {}) };
        }
        return scene.withRenderWorkers({ ...prepared, afterAttempt: (x) => (attempt = x) }, workers);
      };
      const recovered = c.designer !== '' && scene.recoverOutput(prepare(s), own, env, log, tolerance, signal);
      if (!recovered) {
        if (c.designer !== '') {
          log.write(`先由 ${audition.entryLabel({ renderer: c.designer, model: c.designer_model })} 写设计稿\n`);
          const designCfg = withMemory ? cfg : { ...cfg, memory: { ...cfg.memory, enabled: false } };
          const designed = await runDesign(s, designCfg, c.designer, c.designer_model, isUnsafe, log, signal);
          if (designed?.usage) tools.usageAdd(extra, designed.usage);
          extraSeconds += designed?.seconds ?? 0;
          s = audition.contestantScene(root, c);
          s.renderer = c.renderer;
        }
        await scene.run(prepare(s), own, isUnsafe, env, log, tolerance, signal);
      }
    } catch (e) {
      failure = errorText(e);
      log.write(`没跑成：${failure}\n`);
    }
    audition.applyAttempt(root, c, attempt, failure);
    if (extraSeconds > 0 || !tools.usageEmpty(extra)) {
      const total = tools.newUsage();
      tools.usageAdd(total, extra);
      if (c.usage) tools.usageAdd(total, c.usage);
      c.usage = total;
      c.seconds += extraSeconds;
    }
    await persist();
    out.write(`[${c.slot}] ${c.outcome === 'succeeded' ? '完成' : '没有合格的产物'}\n`);
  };
  return { runOne, persist };
}

/** 解析试镜选手列表（普通试镜或人评考试），并校验所有渲染工具合法。 */
export function resolveAuditionEntries(
  cfg: config.Config,
  store: memory.Store | null,
  examId: string,
  lessonsRaw: string,
  contestantsRaw: string,
  defaultWithMemory: boolean,
): {
  entries: audition.Entry[];
  exam: Omit<audition.ExamInfo, 'applied'> | null;
  withMemory: boolean;
} {
  let entries: audition.Entry[];
  let exam: Omit<audition.ExamInfo, 'applied'> | null = null;
  let withMemory = defaultWithMemory;
  if (examId !== '') {
    if (store === null) throw new ParamError('人评考试要打开记忆（MEMORY=on）');
    const relation = audition.findRelation(cfg.memory.dir, examId);
    const student = audition.splitKey(relation.student);
    const teacher = audition.splitKey(relation.teacher);
    let lessons = lessonsRaw
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '');
    if (lessons.length === 0) {
      lessons = store
        .memories()
        .memories.filter(
          (m) =>
            m.kind === memory.KindLesson &&
            m.status === memory.StatusTrial &&
            (m.learned_from ?? []).includes(relation.teacher) &&
            m.applies_when.renderers.includes(student.renderer),
        )
        .map((m) => m.name);
    }
    if (lessons.length === 0) {
      throw new Error(
        `没有要考的经验：${relation.student} 向 ${relation.teacher} 学来、还在试用的经验一条都没有；先运行 audition_learn()`,
      );
    }
    for (const name of lessons) {
      const m = store.find(name);
      if (m === null || m.status !== memory.StatusTrial) throw new ParamError(`${name} 不是试用中的经验`);
    }
    exam = { relation: relation.id, student: relation.student, teacher: relation.teacher, lessons };
    withMemory = true;
    entries = [
      { ...student, role: 'control' },
      { ...student, role: 'trial' },
      { ...teacher, role: 'reference' },
    ];
  } else {
    entries = contestantsRaw
      .split(',')
      .filter((x) => x.trim() !== '')
      .map(audition.parseEntry);
  }
  for (const e of entries) {
    checkRenderer(e.renderer);
    if (e.designer) checkRenderer(e.designer.renderer);
  }
  return { entries, exam, withMemory };
}

export function renderVerdict(a: audition.Audition): string {
  let b = '';
  for (const c of a.contestants) {
    const mark = a.verdict?.kind === 'winner' && a.verdict.winner === c.slot ? '★' : ' ';
    const role =
      c.role === 'reference'
        ? '（参照）'
        : c.role === 'trial'
          ? '（带经验）'
          : c.role === 'control'
            ? '（不带经验）'
            : '';
    b += `${mark} ${c.slot}  ${audition.contestantKey(c)}${role}  ${c.outcome === 'succeeded' ? '合格' : c.outcome || '没跑完'}\n`;
  }
  return b;
}

/** 把一位试镜选手的产物、代码与设计稿换进项目镜头，并重写 scene.json 与渲染记录。 */
export function adoptAuditionContestant(
  root: string,
  auditionId: string,
  slot: string,
  out: Out,
  err: Out,
): { audition: string; scene: string; slot: string; renderer: string; files: string[] } {
  const a = audition.load(root, auditionId);
  const target = scene.load(path.join(root, a.scene_dir));
  const { contestant, files } = audition.adoptFiles(root, a, slot, target);
  // 镜头以后归这位选手的渲染工具：渲染工具在指纹里，不改的话采用完马上就是 Stale。
  const sceneFile = path.join(target.directory, 'scene.json');
  const fields = decodeRawMap(fs.readFileSync(sceneFile, 'utf8'));
  fields.set('renderer', marshal(contestant.renderer));
  fsutil.atomicWrite(sceneFile, encodeRawMapIndent(fields) + '\n');
  // 渲染记录与 scene_run_all 判断复用时同一种算法：同样召回记忆与范例再算指纹。
  const cfg = config.load(root, null);
  let s = scene.load(target.directory);
  s = attachMemory(s, cfg, err, newRunID());
  const skillEnv = scene.skillsEnvironment(envutil.envMap(), cfg.overlay);
  const resolved = scene.resolveAllSkills(contestant.renderer, s.directory, skillEnv, s);
  scene.writeRecord(s, scene.fingerprint(s, contestant.renderer, resolved, undefined, skillEnv));
  out.write(
    `已采用 ${contestant.slot}（${audition.contestantKey(contestant)}），换进 ${a.scene_id}：${files.length} 个文件\n`,
  );
  out.write(`以后重渲染这个镜头用 ${contestant.renderer}`);
  const modelNote =
    contestant.model !== '' && contestant.model !== config.rendererModelFor(cfg, contestant.renderer)
      ? `（模型按设置，不一定是 ${contestant.model}）\n`
      : '\n';
  out.write(modelNote);
  if (files.includes(scene.DesignFile)) out.write('设计稿 design.md 也一起换进去了：以后重渲染照它做。\n');
  return { audition: a.id, scene: a.scene_id, slot: contestant.slot, renderer: contestant.renderer, files };
}

/** 为 audition_learn 构造调用编排整理者的 drafter 回调。 */
export function makeLearnDrafter(
  cfg: config.Config,
  store: memory.Store,
  isUnsafe: boolean,
  out: Out,
  stderr: Out,
): (workdir: string, prompt: string, drafterSignal?: AbortSignal) => Promise<void> {
  return async (workdir, prompt, drafterSignal) => {
    const env = config.childEnvironment(
      cfg,
      envutil.envMap(),
      isUnsafe,
      envutil.parsePassthrough(process.env.ONSET_PASSTHROUGH_ENV ?? ''),
    );
    out.write(`整理者: ${cfg.orchestrator}\n工作目录: ${workdir}\n---\n`);
    const printer = new EventPrinter(out, stderr);
    const { result: ran, error } = await agentrun.run(
      {
        tool: cfg.orchestrator,
        model: cfg.orchestratorModel,
        options: tools.effectiveOptions(cfg.orchestrator, cfg.orchestratorOptions),
        workdir,
        prompt,
        unsafe: isUnsafe,
        sessionID: agentrun.newSessionID(cfg.orchestrator),
        access: {},
        env,
        lookPath: (name) => envutil.lookPath(name, env.PATH ?? ''),
      },
      (event) => printer.print(event),
      drafterSignal,
    );
    if (ran.started) {
      recordOrchestratorUsage(
        drafterSignal,
        ledger.memoryFile(store.dir),
        ledger.SourceConsolidate,
        cfg.orchestrator,
        env,
        ran,
        error,
        stderr,
      );
    }
    if (error) throw error;
  };
}
