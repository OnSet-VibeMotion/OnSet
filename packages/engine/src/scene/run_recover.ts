import fs from 'node:fs';
import type { Config } from '../config';
import { verify as verifyResources } from '../renderassets';
import { formatUsage, type McpServer, type Usage, usageEmpty } from '../tools';
import {
  type Attempt,
  OutcomeFailed,
  OutcomeInterrupted,
  OutcomeSucceeded,
  OutcomeVerificationFailed,
  timestamp,
  writeAttempt,
} from './attempt';
import { acquireSceneLease } from './lease';
import { fingerprint, type Inputs, RecordSchemaRenderContract, writeRecord } from './record';
import { prepareResources } from './resources';
import { type ResumeState, resumeState } from './resume';
import { stageAgyMcp, stageMcodeMcp, verifyOutput, type Writer } from './run_verify';
import { outputPath, type Scene } from './scene';
import { resolveAllSkills, skillsEnvironment, stageRendererSkills, unstageRendererSkills } from './skills';
import { VerificationError } from './verification';

/** 两段式试镜重试先补验收，避免设计者覆盖仍能复用的 design.md；不调用模型。 */
export function recoverOutput(
  s: Scene,
  cfg: Config,
  baseEnv: Record<string, string>,
  userOutput: Writer,
  tolerance: number,
  signal?: AbortSignal,
): boolean {
  if (s.designOnly || s.fresh || s.seam || s.examNote !== '' || signal?.aborted) return false;
  const release = acquireSceneLease(s.directory, s.id);
  try {
    const renderer = s.renderer || cfg.renderer;
    unstageRendererSkills(s.directory);
    const skills = resolveAllSkills(renderer, s.directory, skillsEnvironment(baseEnv, cfg.overlay), s);
    prepareResources(s, skills);
    const inputs = fingerprint(s, renderer, skills);
    return acceptRecoveredOutput(
      s,
      inputs,
      resumeState(
        s,
        inputs.fingerprint,
        () => fingerprint(s, renderer, skills, RecordSchemaRenderContract).fingerprint,
      ),
      baseEnv,
      userOutput,
      tolerance,
      signal,
    );
  } finally {
    release();
  }
}

export function acceptRecoveredOutput(
  s: Scene,
  inputs: Inputs,
  resume: ResumeState | null,
  baseEnv: Record<string, string>,
  userOutput: Writer,
  tolerance: number,
  signal?: AbortSignal,
): boolean {
  // 上一轮已经出片、只是进程异常结束：重试先做本机验收。保留原日志、用量与真实退出码。
  // 只认还留在镜头目录里的那份记录：归档会把视频连同记录一起挪走，记录已经归档时，
  // 目录里的视频出自之后某次没来得及写记录的运行，不能算到这次头上。
  if (resume && resume.logDir === s.directory && !signal?.aborted && fs.existsSync(outputPath(s))) {
    let valid = false;
    try {
      verifyResources(s.directory);
      verifyOutput(s, baseEnv, tolerance, true);
      valid = true;
    } catch {
      /* 不合格才继续制作。 */
    }
    if (valid) {
      writeRecord(s, inputs);
      const recovered = {
        ...resume.previous,
        outcome: OutcomeSucceeded,
        error: '',
        warning: resume.previous.error,
        resumed: 'verify',
      };
      writeAttempt(s, recovered);
      s.afterAttempt?.(recovered);
      userOutput.write(`[${s.id}] 已有视频通过本机验收，无需再次调用模型\n`);
      return true;
    }
  }
  return false;
}

/** 挂载渲染器运行期间需要的技能链接与临时 MCP 配置，返回卸载清理函数。 */
export function stageRendererWorkspace(
  renderer: string,
  sceneDir: string,
  resolvedSkills: Record<string, string>,
  prompt: string,
  toolsServer?: McpServer,
): () => void {
  // qoder 用自己的 Skill 工具加载本镜头的技能（链接只在渲染期间存在，见 stageRendererSkills）。
  const unstageSkills = stageRendererSkills(renderer, sceneDir, resolvedSkills, prompt);
  if (renderer === 'mcode' && toolsServer) {
    const unstageMcp = stageMcodeMcp(sceneDir, toolsServer);
    return () => {
      unstageMcp();
      unstageSkills();
    };
  }
  if (renderer === 'agy' && toolsServer) {
    const unstageMcp = stageAgyMcp(sceneDir, toolsServer);
    return () => {
      unstageMcp();
      unstageSkills();
    };
  }
  return unstageSkills;
}

/** Go 版的 defer：无论成败都写尝试记录、报一行用量、回调记忆经历。 */
export function finalizeAttempt(
  s: Scene,
  attempt: Attempt,
  startedNs: bigint,
  usage: Usage,
  design: boolean,
  userOutput: Writer,
  err: unknown,
  signal?: AbortSignal,
): void {
  attempt.ended_at = timestamp(new Date());
  attempt.seconds = Number(process.hrtime.bigint() - startedNs) / 1e9;
  if (!usageEmpty(usage)) attempt.usage = usage;
  if (err === null) {
    attempt.outcome = OutcomeSucceeded;
  } else if (err instanceof VerificationError) {
    attempt.outcome = OutcomeVerificationFailed;
    attempt.problems = err.problems;
    attempt.checks = err.checks;
  } else if (signal?.aborted) {
    attempt.outcome = OutcomeInterrupted;
  } else {
    attempt.outcome = OutcomeFailed;
  }
  if (err !== null) attempt.error = err instanceof Error ? err.message : String(err);
  try {
    // 设计稿那一次不写尝试记录：镜头的尝试记录只记渲染，用量经 afterAttempt 交给调用方。
    if (!design) writeAttempt(s, attempt);
  } catch (writeErr) {
    if (err === null) err = writeErr;
  }
  // 每次渲染都报一行用量：失败的尝试一样花了 token。
  userOutput.write(`[${s.id}] 用量：${formatUsage(usage)}\n`);
  // Go 的 writeAttempt 只在自己的副本上置 schema，回调拿到的仍是 0。
  s.afterAttempt?.({ ...attempt });
  if (err !== null) throw err;
}
