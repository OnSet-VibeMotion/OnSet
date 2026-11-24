import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, rendererModelFor, rendererOptionsFor } from '../config';
import * as director from '../director';
import { onsetExecutable } from '../envutil';
import { goRound } from '../gofmt';
import * as hyperframes from '../hyperframes';
import * as mediaprobe from '../mediaprobe';
import {
  configuredModel,
  effectiveOptions,
  type Invocation,
  newUsage,
  onsetToolsServer,
  presetSessionID,
  type RendererSession,
  rendererEnv,
  rendererLaunch,
  type Usage,
} from '../tools';
import { withWindowsInstructions } from '../windowsruntime';
import { archiveAttempt, newAttempt, timestamp } from './attempt';
import { acquireSceneLease } from './lease';
import { removeLive, writeLive } from './live';
import { fingerprint, RecordSchemaRenderContract, removeRecord } from './record';
import { prepareRepairEvidence, type RepairContext, type RepairIssue, repairPrompt, withRepairBackup } from './repair';
import { prepareResources } from './resources';
import { leftoverFiles, resumeState } from './resume';
import { buildChildEnv, buildHyperFramesEnv } from './run_encode';
import { executeRender } from './run_layers';
import { buildConfine } from './run_process';
import { acceptRecoveredOutput, finalizeAttempt, stageRendererWorkspace } from './run_recover';
import type { Writer } from './run_verify';
import { rendererUnfiltered, sandboxAvailable } from './sandbox';
import {
  buildPrompt,
  contained,
  findProjectRoot,
  outputPath,
  renderPromptVersion,
  type Scene,
  sceneCanvas,
} from './scene';
import { writeSceneData } from './scenedata';
import {
  HyperFramesSkillName,
  rendererAccess,
  resolveAllSkills,
  SkillsDirEnv,
  skillsEnvironment,
  stagedSkills,
  unstageRendererSkills,
} from './skills';
import { transcriptTimingWarning } from './timing';

export { encodeScene } from './run_encode';
export { recoverOutput } from './run_recover';
export {
  designLog,
  isSimpleScene,
  stageAgyMcp,
  stageMcodeMcp,
  verifyOutput,
  type Writer,
} from './run_verify';

/**
 * 渲染一个镜头：解析技能、拼提示词、启动渲染器（独立进程组，signal 取消时整组终止）、
 * 写三份日志与尝试记录，渲染器正常退出后校验产物并写下渲染记录。
 */
export async function run(
  s: Scene,
  cfg: Config,
  unsafe: boolean,
  baseEnv: Record<string, string>,
  userOutput: Writer,
  tolerance: number,
  signal?: AbortSignal,
): Promise<void> {
  const release = acquireSceneLease(s.directory, s.id);
  try {
    await runScene(s, cfg, unsafe, baseEnv, userOutput, tolerance, signal);
  } finally {
    release();
  }
}

/** Run an explicitly scoped repair under the same lease as a regular render. */
export async function repairScene(
  s: Scene,
  issues: RepairIssue[],
  cfg: Config,
  unsafe: boolean,
  baseEnv: Record<string, string>,
  userOutput: Writer,
  tolerance: number,
  signal?: AbortSignal,
): Promise<{ evidence: string }> {
  const release = acquireSceneLease(s.directory, s.id);
  try {
    signal?.throwIfAborted();
    if (!fs.existsSync(contained(s.directory, 'index.html', '合成入口')))
      throw new Error('局部返修需要已有的 index.html 合成');
    return await withRepairBackup(s, async (baseline) => {
      const evidence = await prepareRepairEvidence(s, issues, mediaprobe.newToolchain(baseEnv), signal);
      await runScene(s, cfg, unsafe, baseEnv, userOutput, tolerance, signal, { issues, evidence, baseline });
      return { evidence };
    });
  } finally {
    release();
  }
}

async function runScene(
  s: Scene,
  cfg: Config,
  unsafe: boolean,
  baseEnv: Record<string, string>,
  userOutput: Writer,
  tolerance: number,
  signal?: AbortSignal,
  repair?: RepairContext,
): Promise<void> {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('tolerance 必须是有限且非负的数字');
  const warning = transcriptTimingWarning(s);
  if (warning) userOutput.write(`[${s.id}] 提醒：${warning}\n`);
  const renderer = s.renderer !== '' ? s.renderer : cfg.renderer;
  // 上次渲染没收拾干净的 qoder 技能链接先清掉：resolveSkill 也会找镜头目录里的 .qoder/skills。
  unstageRendererSkills(s.directory);
  const resolvedSkills = resolveAllSkills(renderer, s.directory, skillsEnvironment(baseEnv, cfg.overlay), s);
  if ((resolvedSkills[HyperFramesSkillName] ?? '') === '') {
    userOutput.write(
      `警告：未能为渲染工具 ${renderer} 定位 ${HyperFramesSkillName} 技能目录，组合规范与动效要求改用技能名兜底；请在客户端顶栏点「缺少 HyperFrames 技能 · 安装」，或用 ${SkillsDirEnv} 显式指定\n`,
    );
  }
  // 渲染器要用的 CLI 是前置资源（onset setup 装）：在渲染途中现下载的话，网络一差渲染器
  // 就空等、白花一次模型调用，最后只剩「没有产物」。没装好就在这里停，不启动渲染器。
  const cliEnv = buildHyperFramesEnv(cfg, baseEnv);
  // 浏览器同理：客户端里是它自带的 Chromium，单独用命令行时是 onset setup 下载的 headless-shell。
  // 资源先落到项目内容池并链接进镜头；不联网，失败时不启动模型也不清掉上一次产物。
  const preparedResources = prepareResources(s, resolvedSkills);
  const auditionNote = s.audition
    ? '\n这是独立试镜。只使用本目录的冻结输入、明确提供的技能和参考素材；禁止读取其他选手、其他试镜、项目已有镜头的代码、日志、截图或视频。完成必要资料读取后立即制作本目录的合成，不要反复搜索或研究别人的作品。\n'
    : '';
  const prompt = withWindowsInstructions(
    (repair ? repairPrompt(s, repair) : buildPrompt(s, resolvedSkills, renderer === director.Tool)) + auditionNote,
    'renderer',
  );
  // 渲染器的环境：onset 不在它的 PATH 里，HyperFrames 经 onset 的工具服务（--profile renderer）调用。
  const childEnv = buildChildEnv(s, cfg, unsafe, baseEnv);
  const access = rendererAccess(resolvedSkills);
  access.toolsServer = onsetToolsServer(onsetExecutable(), 'renderer', s.directory, childEnv);
  // 镜头要用的技能链进镜头目录（stageRendererSkills），opencode 另按名字只放行这几个。
  access.skills = stagedSkills(resolvedSkills, prompt).map((x) => x.name);
  Object.assign(childEnv, rendererEnv(renderer, access, childEnv));
  const model = rendererModelFor(cfg, renderer);
  // 调用选项（推理强度、快速模式、上下文长度）规则同模型：镜头换了渲染工具就不用设置里给另一家写的。
  const options = effectiveOptions(renderer, rendererOptionsFor(cfg, renderer));
  // macOS 的试镜始终保留目录边界；普通镜头沿用用户的不安全模式设置。
  const projectRoot = findProjectRoot(s.directory);
  if ((!unsafe || s.audition) && projectRoot !== '' && sandboxAvailable()) access.osSandbox = true;
  // 渲染器自己不拦命令：套了沙箱时由沙箱管边界；Windows 没有系统沙箱，用户定的是全放开（2026-11），安全先放下。
  access.unfiltered = rendererUnfiltered(access.osSandbox === true);
  const confine = buildConfine({
    s,
    renderer,
    projectRoot,
    osSandbox: access.osSandbox === true,
    baseEnv,
    childEnv,
    cliEnv,
    resolvedSkills,
  });
  const invocation = (
    text: string,
    session: RendererSession | null,
    stage: 'full' | 'repair' | 'simple' = 'full',
  ): Invocation =>
    confine(
      rendererLaunch(
        renderer,
        text,
        unsafe,
        access,
        model,
        session,
        s.directory,
        { ...childEnv, [director.DirEnv]: director.defaultDir({ ...process.env, ...baseEnv }) },
        options,
        stage,
      ),
    );
  const inputs = fingerprint(s, renderer, resolvedSkills);
  const resourceKeys = new Set([
    ...Object.keys(preparedResources),
    ...Object.keys(inputs.parts ?? {}).filter((key) => key.startsWith('asset:')),
  ]);
  if ([...resourceKeys].some((key) => preparedResources[key] !== inputs.parts?.[key])) {
    throw new Error('准备期间共享渲染资源发生变化，请重新渲染；本次尚未启动渲染器');
  }
  // 中途异常退出过、输入没变：接着上一次做，不从头重来（resume.ts）。要在归档上一次之前读。
  const design = s.designOnly === true;
  const engineRenders = !design && (repair !== undefined || renderPromptVersion(s) >= 4);
  const resume =
    design || repair || s.fresh || s.seam || s.examNote !== ''
      ? null
      : resumeState(
          s,
          inputs.fingerprint,
          () => fingerprint(s, renderer, resolvedSkills, RecordSchemaRenderContract).fingerprint,
        );
  if (acceptRecoveredOutput(s, inputs, resume, baseEnv, userOutput, tolerance, signal)) return;
  // 补验收不启动模型或浏览器。只有确实需要制作时才检查这些运行依赖。
  if (renderer === director.Tool && !director.resolveService(director.defaultDir({ ...process.env, ...baseEnv })))
    throw new Error(director.NoServiceMessage);
  hyperframes.requireCLI(cliEnv);
  hyperframes.requireBrowser(cliEnv);
  const frameCount = goRound(s.duration_seconds * sceneCanvas(s).fps);
  /** 新会话：能预先指定会话号的工具给一个，续接时就靠它。 */
  const newSession = (): RendererSession | null =>
    presetSessionID(renderer) ? { id: crypto.randomUUID(), resume: false } : null;
  /** 第三层的提示词：完整提示词加「接着上一次做」。 */
  const continuePrompt = (): string =>
    withWindowsInstructions(
      buildPrompt(
        {
          ...s,
          continuation: {
            reason: resume?.previous.error ?? '',
            files: leftoverFiles(s),
            lastSteps: s.audition ? [] : (resume?.lastSteps ?? []),
            codeDone: resume?.codeDone ?? false,
          },
        },
        resolvedSkills,
        renderer === director.Tool,
      ) + auditionNote,
      'renderer',
    );
  const resumeSession =
    !s.audition && resume !== null && resume.previous.session_id !== '' && resume.previous.renderer === renderer;
  // 直接渲染要看的是归档前就在镜头目录里的合成入口（归档只挪产物与日志，合成代码留在原处）。
  const directRender = resume !== null && resume.codeDone && fs.existsSync(path.join(s.directory, 'index.html'));
  // 先挪走上一次的现场再截断日志；旧记录随即作废，本次通过校验后再写新的。
  // 只写设计稿时不动镜头已有的产物、日志与渲染记录：设计稿只是给实现者的输入。
  if (!design) {
    archiveAttempt(s, repair !== undefined);
    if (!repair) {
      if (fs.existsSync(outputPath(s))) throw new Error(`旧视频未能归档，已停止渲染：${outputPath(s)}`);
      removeRecord(s);
    }
  }
  // 局部时间数据在渲染器启动前写好：提示词让渲染器直接加载它，
  // 不再自己从全片字幕里做减法。
  writeSceneData(s);

  const started = new Date();
  const startedNs = process.hrtime.bigint();
  const attempt = newAttempt({
    scene_id: s.id,
    renderer,
    model: model || configuredModel(renderer, baseEnv),
    fingerprint: inputs.fingerprint,
    started_at: timestamp(started),
    retry: s.retryNote !== '',
    local_repair: repair !== undefined,
  });
  if (resume) userOutput.write(`[${s.id}] 上一次中途中断了，接着做（不从头重来）\n`);
  const usage: Usage = newUsage();
  let err: unknown = null;
  // 客户端据此显示「渲染中」与渲染器此刻在做什么，见 live.ts。
  const live = { pid: process.pid, renderer, started_at: attempt.started_at };
  writeLive(s.directory, s.id, live);
  let unstage = () => {};
  try {
    unstage = stageRendererWorkspace(renderer, s.directory, resolvedSkills, prompt, access.toolsServer);
    await executeRender({
      s,
      renderer,
      resolvedSkills,
      baseEnv,
      cliEnv,
      childEnv,
      userOutput,
      tolerance,
      signal,
      repair,
      options,
      inputs,
      design,
      engineRenders,
      resume,
      resumeSession,
      directRender,
      frameCount,
      prompt,
      attempt,
      usage,
      live,
      confine,
      invocation,
      newSession,
      continuePrompt,
    });
  } catch (e) {
    err = e;
  } finally {
    try {
      unstage();
    } catch {
      // 清不掉就留到下次渲染前再清。
    }
    removeLive(s.directory, s.id);
  }
  finalizeAttempt(s, attempt, startedNs, usage, design, userOutput, err, signal);
}
