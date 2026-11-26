import fs from 'node:fs';
import path from 'node:path';
import * as mediaprobe from '../mediaprobe';
import { verify as verifyResources } from '../renderassets';
import { type AgentOptions, type Invocation, type RendererSession, sessionBaseline, type Usage } from '../tools';
import type { Attempt } from './attempt';
import { rendererFailureAdvice } from './failure';
import { writeLive } from './live';
import { fingerprint, type Inputs, writeRecord } from './record';
import { type RepairContext, verifyRepair } from './repair';
import { CodeDoneMessage, RenderHandoffMessage, RenderRepairMessage, type ResumeState, resumePrompt } from './resume';
import { RendererFailure, RenderLogError, renderComposition, spawnRenderer } from './run_process';
import { designLog, renderStage, verifyDesign, verifyOutput, type Writer } from './run_verify';
import { contained, outputPath, type Scene, sceneCanvas, stderrLog, streamLog, userLog } from './scene';
import { verifySeam } from './seam';
import { VerificationError } from './verification';

export interface RenderExecutionContext {
  s: Scene;
  renderer: string;
  resolvedSkills: Record<string, string>;
  baseEnv: Record<string, string>;
  cliEnv: Record<string, string>;
  childEnv: Record<string, string>;
  userOutput: Writer;
  tolerance: number;
  signal?: AbortSignal;
  repair?: RepairContext;
  options: AgentOptions;
  inputs: Inputs;
  design: boolean;
  engineRenders: boolean;
  resume: ResumeState | null;
  resumeSession: boolean;
  directRender: boolean;
  frameCount: number;
  prompt: string;
  attempt: Attempt;
  usage: Usage;
  live: { pid: number; renderer: string; started_at: string };
  confine: (command: Invocation) => Invocation;
  invocation: (text: string, session: RendererSession | null, stage?: 'full' | 'repair' | 'simple') => Invocation;
  newSession: () => RendererSession | null;
  continuePrompt: () => string;
}

export async function executeRender(ctx: RenderExecutionContext): Promise<void> {
  const {
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
  } = ctx;

  const state = { handoff: false };
  const compositionCtx = { s, cliEnv, childEnv, confine, signal };
  const spawnCtx = { s, renderer, childEnv, attempt, usage, signal, show, state };

  function show(message: string, userFile: number): void {
    fs.writeSync(userFile, message + '\n');
    userOutput.write(message + '\n');
  }

  /** 渲染出来以后：校验产物（修接缝另核对开头与其余画面），写渲染记录。 */
  async function finish(): Promise<void> {
    if (design) {
      verifyDesign(s);
      return;
    }
    await verifyRendered(s);
    writeRecord(s, inputs);
  }

  async function verifyRendered(candidate: Scene): Promise<void> {
    verifyResources(s.directory);
    verifyOutput(candidate, baseEnv, tolerance, true);
    // 修接缝：第 0 帧要接上前一镜的末帧、后面的画面不许变（seam.ts）。
    if (s.seam) verifySeam(candidate, s.seam, mediaprobe.newToolchain(baseEnv), sceneCanvas(s).fps);
    if (repair) {
      if (fingerprint(s, renderer, resolvedSkills, undefined, baseEnv).fingerprint !== inputs.fingerprint) {
        throw new VerificationError(s.output, ['局部返修改变了镜头的执行契约或其他渲染输入'], ['repair.inputs']);
      }
      await verifyRepair(candidate, repair, mediaprobe.newToolchain(baseEnv), signal);
    }
  }

  /** 先在镜头内的独立目录渲染与验收，失败产物不会覆盖正式路径或被续接误收。 */
  async function encodeHandoff(stderrFile: number, userFile: number): Promise<void> {
    signal?.throwIfAborted();
    show(CodeDoneMessage, userFile);
    const stage = fs.mkdtempSync(path.join(s.directory, '.onset-encode-'));
    try {
      writeLive(s.directory, s.id, { ...live, encoding: true });
      const candidate = { ...s, output: path.relative(s.directory, path.join(stage, path.basename(s.output))) };
      await renderComposition(compositionCtx, stderrFile, candidate.output, true);
      await verifyRendered(candidate);
      signal?.throwIfAborted();
      const destination = contained(s.directory, s.output, 'output');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const finalDestination = contained(s.directory, s.output, 'output');
      fs.renameSync(outputPath(candidate), finalDestination);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      writeLive(s.directory, s.id, live);
    }
  }

  async function renderHandoff(rawFile: number, stderrFile: number, userFile: number): Promise<void> {
    try {
      await encodeHandoff(stderrFile, userFile);
    } catch (error) {
      if (signal?.aborted || error instanceof RenderLogError) throw error;
      const detail = (error as Error).message.slice(0, 4000);
      show(RenderRepairMessage, userFile);
      userOutput.write(`[${s.id}] ${detail.split('\n')[0]}\n`);
      const next = `片场渲染或验收失败。按下面的错误修复现有合成，复查受影响的画面，然后按原约定交接：[[USER_MESSAGE]]${RenderHandoffMessage}。\n${detail}`;
      // With no explicit regular setting, an empty option on resume would keep the local repair setting.
      const previousID = repair && options.repair_effort && !options.effort ? '' : attempt.session_id;
      let resumed = false;
      if (previousID !== '') {
        usage.baseline = sessionBaseline(usage);
        try {
          await spawnRenderer(
            spawnCtx,
            invocation(next, { id: previousID, resume: true }),
            rawFile,
            stderrFile,
            userFile,
          );
          resumed = true;
        } catch (retryError) {
          if (signal?.aborted || (retryError as { events?: number }).events !== 0) throw retryError;
        }
      }
      if (!resumed) {
        usage.baseline = undefined;
        const session = newSession();
        attempt.session_id = session?.id ?? '';
        await spawnRenderer(spawnCtx, invocation(prompt + '\n\n' + next, session), rawFile, stderrFile, userFile);
      }
      if (state.handoff && (repair || !fs.existsSync(outputPath(s)))) await encodeHandoff(stderrFile, userFile);
      else if (repair) throw new Error('局部返修未重新完成画面自查和交接');
      else await verifyRendered(s);
    }
    writeRecord(s, inputs);
    show(`视频已渲染完成：${s.output}`, userFile);
  }

  /**
   * 按接续的三层依次试：onset 直接渲染（合成已写完）→ 续接原会话 → 新会话照上次的文件接着做；没有可接的就是一次普通渲染。
   * 直接渲染出片且校验通过就到此为止（render() 里还会再校验一次，结果相同）。
   */
  async function renderLayers(rawFile: number, stderrFile: number, userFile: number): Promise<void> {
    if (directRender) {
      try {
        if (engineRenders) await encodeHandoff(stderrFile, userFile);
        else {
          await renderComposition(compositionCtx, stderrFile);
          verifyOutput(s, baseEnv, tolerance, true);
        }
        attempt.resumed = 'render';
        fs.writeSync(userFile, `onset 直接渲染了上一次写好的合成：${s.output}\n`);
        userOutput.write(`[${s.id}] 上一次的合成已写完，直接渲染出片\n`);
        return;
      } catch (e) {
        if (signal?.aborted || e instanceof RenderLogError) throw e;
        if (engineRenders) show(RenderRepairMessage, userFile);
        userOutput.write(`[${s.id}] 直接渲染没成（${(e as Error).message.split('\n')[0]}），交给渲染器接着做\n`);
      }
    }
    if (resumeSession) {
      attempt.resumed = 'session';
      attempt.session_id = resume!.previous.session_id;
      // 续接后有的工具报整个会话的累计用量，减掉上一次记下的才是这一次的（tools 的 cumulativeFields）。
      usage.baseline = sessionBaseline(resume!.previous.usage);
      const text = resumePrompt(resume!.previous.error, s.output, frameCount, engineRenders);
      const events = await spawnRenderer(
        spawnCtx,
        invocation(text, { id: resume!.previous.session_id, resume: true }),
        rawFile,
        stderrFile,
        userFile,
      ).catch((e: unknown) => {
        if (signal?.aborted || (e as { events?: number }).events !== 0) throw e;
        return -1;
      });
      if (events >= 0) return;
      // 续接的会话一句话都没说就退出了（会话过期、找不到）：退到第三层。
      userOutput.write(`[${s.id}] 原来的会话续不上，开新会话照上次的文件接着做\n`);
    }
    usage.baseline = undefined;
    const session = newSession();
    attempt.session_id = session?.id ?? '';
    if (resume) attempt.resumed = 'files';
    await spawnRenderer(
      spawnCtx,
      invocation(resume ? continuePrompt() : prompt, session, renderStage(s, repair)),
      rawFile,
      stderrFile,
      userFile,
    );
  }

  const rawFile = fs.openSync(design ? designLog(s, 'stream.jsonl') : streamLog(s), 'w');
  try {
    const stderrFile = fs.openSync(design ? designLog(s, 'stderr.log') : stderrLog(s), 'w');
    try {
      const userFile = fs.openSync(design ? designLog(s, 'user.log') : userLog(s), 'w');
      try {
        try {
          await renderLayers(rawFile, stderrFile, userFile);
          if (engineRenders && state.handoff && (repair || !fs.existsSync(outputPath(s)))) {
            await renderHandoff(rawFile, stderrFile, userFile);
            attempt.exit_code = 0;
            return;
          }
        } catch (error) {
          // 服务失败发生在出片之后：验收实际产物，不能因为最后一句模型响应失败就丢掉已经完成的画面。
          // 取消、工具崩溃与设计稿阶段仍照常失败；旧视频已在本次运行前归档，不会误收旧产物。
          if (
            design ||
            repair ||
            signal?.aborted ||
            !(error instanceof RendererFailure) ||
            !rendererFailureAdvice(error.message) ||
            !fs.existsSync(outputPath(s))
          )
            throw error;
          attempt.warning = error.message;
          await finish();
          userOutput.write(
            `[${s.id}] 模型异常结束，已有视频通过本机验收：${rendererFailureAdvice(error.message)!.label}\n`,
          );
          return;
        }
      } finally {
        fs.closeSync(userFile);
      }
    } finally {
      fs.closeSync(stderrFile);
    }
  } finally {
    fs.closeSync(rawFile);
  }
  attempt.exit_code = 0;
  if (repair) throw new Error('局部返修尚未完成画面自查和交接');
  await finish();
}
