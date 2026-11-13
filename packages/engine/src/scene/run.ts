// 移植自 internal/scene/run_unix.go（Go 版只在 darwin / linux 上编译）。
import fs from 'node:fs';
import path from 'node:path';
import { childEnvironment, type Config } from '../config';
import * as determinism from '../determinism';
import { addExecutableLocation, lookPath, parsePassthrough } from '../envutil';
import * as hyperframes from '../hyperframes';
import * as mediaprobe from '../mediaprobe';
import { ExitError, start, type Started } from '../procgroup';
import {
  accumulateUsage,
  configuredModel,
  detectModel,
  extractUserMessages,
  formatUsage,
  newUsage,
  rendererInvocation,
  usageEmpty,
  type Usage,
} from '../tools';
import { formatFixed, goRound } from '../gofmt';
import { newAttempt, OutcomeFailed, OutcomeInterrupted, OutcomeSucceeded, OutcomeVerificationFailed, timestamp, writeAttempt, archiveAttempt } from './attempt';
import { CheckOutputFrames, classifyOutputProblem, DeterminismCheckPrefix } from './checks';
import { fingerprint, removeRecord, writeRecord } from './record';
import { buildPrompt, canvasOf, evalSymlinks, outputPath, relPath, stderrLog, streamLog, userLog, type Scene } from './scene';
import { writeSceneData } from './scenedata';
import { HyperFramesSkillName, rendererAccess, resolveAllSkills, skillsEnvironment, SkillsDirEnv } from './skills';
import { VerificationError } from './verification';

/** SIGTERM 之后等渲染器进程组自行退出的时间（毫秒）。 */
const terminateGrace = 500;

/** bufio.Scanner 的最大单行长度：超过时 Go 报「token too long」。 */
const maxLineBytes = 4 * 1024 * 1024;

/** 写给用户看的输出（Go 的 io.Writer）。 */
export interface Writer {
  write(chunk: string): unknown;
}

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
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('tolerance 必须是有限且非负的数字');
  const renderer = s.renderer !== '' ? s.renderer : cfg.renderer;
  const resolvedSkills = resolveAllSkills(renderer, s.directory, skillsEnvironment(baseEnv, cfg.overlay), s);
  if ((resolvedSkills[HyperFramesSkillName] ?? '') === '') {
    userOutput.write(
      `警告：未能为渲染工具 ${renderer} 定位 ${HyperFramesSkillName} 技能目录，组合规范与动效要求改用技能名兜底；可运行 am init 安装，或用 ${SkillsDirEnv} 显式指定\n`,
    );
  }
  const prompt = buildPrompt(s, resolvedSkills);
  // 渲染器要用的 CLI 是前置资源（am setup 装）：在渲染途中现下载的话，网络一差渲染器
  // 就空等、白花一次模型调用，最后只剩「没有产物」。没装好就在这里停，不启动渲染器。
  const cliEnv: Record<string, string> = { ...baseEnv };
  if (cfg.hyperFramesCLI !== '') {
    cliEnv[hyperframes.CLIDirEnv] = cfg.hyperFramesCLI;
  } else if (!cliEnv[hyperframes.CLIDirEnv]) {
    // 调用方给的环境里没有时，取进程自己的设置（例如手工指定的 CLI 目录）。
    const dir = process.env[hyperframes.CLIDirEnv];
    if (dir) cliEnv[hyperframes.CLIDirEnv] = dir;
  }
  hyperframes.requireCLI(cliEnv);
  for (const key of [hyperframes.BrowserEnv, hyperframes.HyperFramesBrowserEnv]) {
    if (!cliEnv[key] && process.env[key]) cliEnv[key] = process.env[key]!;
  }
  // 浏览器同理：客户端里是它自带的 Chromium，单独用命令行时是 am setup 下载的 headless-shell。
  hyperframes.requireBrowser(cliEnv);
  const argv = rendererInvocation(renderer, prompt, unsafe, rendererAccess(resolvedSkills));
  argv[0] = lookPath(argv[0], baseEnv.PATH ?? '');
  const inputs = fingerprint(s, renderer, resolvedSkills);
  // 先挪走上一次的现场再截断日志；旧记录随即作废，本次通过校验后再写新的。
  archiveAttempt(s);
  removeRecord(s);
  // 局部时间数据在渲染器启动前写好：提示词让渲染器直接加载它，
  // 不再自己从全片字幕里做减法。
  writeSceneData(s);

  const started = new Date();
  const startedNs = process.hrtime.bigint();
  const attempt = newAttempt({
    scene_id: s.id,
    renderer,
    model: configuredModel(renderer, baseEnv),
    fingerprint: inputs.fingerprint,
    started_at: timestamp(started),
    retry: s.retryNote !== '',
  });
  const usage: Usage = newUsage();
  let err: unknown = null;
  try {
    await render();
  } catch (e) {
    err = e;
  }
  // Go 版的 defer：无论成败都写尝试记录、报一行用量、回调记忆经历。
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
    writeAttempt(s, attempt);
  } catch (writeErr) {
    if (err === null) err = writeErr;
  }
  // 每次渲染都报一行用量：失败的尝试一样花了 token。
  userOutput.write(`[${s.id}] 用量：${formatUsage(usage)}\n`);
  // Go 的 writeAttempt 只在自己的副本上置 schema，回调拿到的仍是 0。
  s.afterAttempt?.({ ...attempt });
  if (err !== null) throw err;

  async function render(): Promise<void> {
    const rawFile = fs.openSync(streamLog(s), 'w');
    try {
      const stderrFile = fs.openSync(stderrLog(s), 'w');
      try {
        const userFile = fs.openSync(userLog(s), 'w');
        try {
          await spawnRenderer(rawFile, stderrFile, userFile);
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
    verifyOutput(s, baseEnv, tolerance);
    writeRecord(s, inputs);
  }

  async function spawnRenderer(rawFile: number, stderrFile: number, userFile: number): Promise<void> {
    const passthrough = parsePassthrough(baseEnv.AM_PASSTHROUGH_ENV ?? '');
    const childEnv = childEnvironment(cfg, baseEnv, unsafe, passthrough);
    // 提示词让渲染器调用 am hyperframes：把当前 am 放进它的 PATH。
    addExecutableLocation(childEnv);
    let started: Started;
    try {
      started = await start(argv[0], argv.slice(1), { cwd: s.directory, env: childEnv, stdio: ['ignore', 'pipe', stderrFile], signal }, terminateGrace);
    } catch (e) {
      throw new Error(`启动渲染器：${(e as Error).message}`, { cause: e });
    }
    let pending: Buffer = Buffer.alloc(0);
    let scanError: Error | null = null;
    const handleLine = (raw: Buffer) => {
      if (scanError) return;
      // bufio.ScanLines 去掉行尾的 \r。
      let line = raw.toString('utf8');
      if (line.endsWith('\r')) line = line.slice(0, -1);
      fs.writeSync(rawFile, line + '\n');
      accumulateUsage(renderer, line, usage);
      const model = detectModel(renderer, line);
      if (model !== '') attempt.model = model;
      for (const message of extractUserMessages(renderer, line)) {
        fs.writeSync(userFile, message + '\n');
        userOutput.write(message + '\n');
      }
    };
    started.child.stdout!.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let index: number;
      while ((index = pending.indexOf(0x0a)) >= 0) {
        handleLine(pending.subarray(0, index));
        pending = pending.subarray(index + 1);
      }
      if (pending.length > maxLineBytes && !scanError) scanError = new Error('bufio.Scanner: token too long');
      if (scanError) pending = Buffer.alloc(0);
    });
    let waitErr: unknown = null;
    try {
      await started.wait();
    } catch (e) {
      waitErr = e;
    }
    if (pending.length > 0) handleLine(pending);
    if (signal?.aborted) throw new Error('已中断：渲染器进程组已终止');
    if (scanError) throw new Error(`读取渲染器输出：${(scanError as Error).message}`);
    if (waitErr !== null) {
      if (waitErr instanceof ExitError) {
        attempt.exit_code = waitErr.code;
        throw new Error(`渲染器退出码 ${waitErr.code}`);
      }
      throw waitErr;
    }
  }
}

/**
 * 校验镜头产物是否符合执行契约。
 *
 * 检查画幅、帧率、时长和「必须静音无音轨」四项，缺一项都会让错误在成片阶段才暴露。
 * 另外静态扫描合成源码的确定性（determinism）：读时钟、未播种随机数、
 * requestAnimationFrame 这类写法渲染照样成功，要到重渲染对不上时才暴露。
 *
 *   - 画幅：style_guide 声明了画布，渲染成别的尺寸无法靠后期规范化补救——
 *     把 720p 拉伸到 1080 是画质损失而不是格式统一。
 *   - 静音：镜头产物按契约就该无音轨，混音在后面的阶段统一做。
 *
 * 刻意不查编码和像素格式：PROMPT 第八阶段明确允许镜头产物规格不一致，
 * 由拼接前的规范化副本统一，在这里拦下会和那条既定流程打架。
 */
export function verifyOutput(s: Scene, baseEnv: Record<string, string>, tolerance: number): void {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('tolerance 必须是有限且非负的数字');
  const file = outputPath(s);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`渲染结束但产物不存在：${s.output}`);
  }
  if (!stat.isFile() || stat.size === 0) throw new Error(`渲染产物不是非空普通文件：${s.output}`);
  let root = '';
  try {
    root = evalSymlinks(s.directory);
  } catch {
    // Go 忽略这里的错误，下面的 Rel 会把它判成越界。
  }
  const resolved = evalSymlinks(file);
  const rel = root === '' ? '..' : relPath(root, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep)) throw new Error(`产物不得链接到镜头目录外：${s.output}`);
  const canvas = canvasOf(s.directory, s.style_guide);
  const toolchain = mediaprobe.newToolchain(baseEnv);
  const media = toolchain.probe(file);
  const spec: mediaprobe.Spec = {
    widthPx: canvas.widthPx,
    heightPx: canvas.heightPx,
    fps: canvas.fps,
    durationSeconds: s.duration_seconds,
    tolerance,
    audio: mediaprobe.AudioAbsent,
  };
  const problems = mediaprobe.checkSpec(spec, media);
  const checks = problems.map(classifyOutputProblem);
  // 帧数逐帧解码实测，不靠时长容差兜：默认 0.15 秒的容差在 30fps 下能放过
  // 差 4 帧的产物，要等拼接后整片复查才暴露，那时整批镜头都已渲染完。
  // verifyFrameAlignment 已保证时长是整数帧，这里的期望值没有取整歧义。
  // 没有视频流时 checkSpec 已经报过，不再重复解码。
  if (media.video !== null) {
    const expected = goRound(s.duration_seconds * canvas.fps);
    let counted: number | null = null;
    try {
      counted = toolchain.countFrames(file);
    } catch (e) {
      problems.push((e as Error).message);
      checks.push(CheckOutputFrames);
    }
    if (counted !== null && counted !== expected) {
      problems.push(
        `总帧数不符：期望 ${expected} 帧（${formatFixed(s.duration_seconds, 6)} 秒 × ${canvas.fps}fps），逐帧解码实测 ${counted} 帧`,
      );
      checks.push(CheckOutputFrames);
    }
  }
  // 源码扫描与规格检查一起报：两类问题常同时出现，分两轮发现就要多烧一次渲染。
  const scan = determinism.scan(s.directory);
  problems.push(...determinism.problems(scan));
  for (const finding of scan.findings) checks.push(DeterminismCheckPrefix + finding.rule);
  if (problems.length > 0) throw new VerificationError(s.output, problems, checks);
}
