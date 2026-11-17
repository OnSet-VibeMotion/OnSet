import crypto from 'node:crypto';
import fs from 'node:fs';
import { withWindowsInstructions } from '../windowsruntime';
import path from 'node:path';
import { childEnvironment, rendererModelFor, rendererOptionsFor, type Config } from '../config';
import * as determinism from '../determinism';
import { addToolsLocation, onsetExecutable, lookPath, parsePassthrough } from '../envutil';
import * as hyperframes from '../hyperframes';
import * as director from '../director';
import * as mediaprobe from '../mediaprobe';
import { ExitError, start, type Started } from '../procgroup';
import {
  accumulateUsage,
  configuredModel,
  effectiveOptions,
  detectModel,
  extractUserMessages,
  formatUsage,
  newUsage,
  onsetToolsServer,
  rendererEnv,
  presetSessionID,
  rendererLaunch,
  type Invocation,
  usageEmpty,
  type RendererSession,
  type Usage,
} from '../tools';
import { KindSession, KindText, KindToolCall, newParser } from '../agentrun';
import { formatFixed, goRound } from '../gofmt';
import { newAttempt, OutcomeFailed, OutcomeInterrupted, OutcomeSucceeded, OutcomeVerificationFailed, timestamp, writeAttempt, archiveAttempt } from './attempt';
import { CheckOutputFrames, classifyOutputProblem, DeterminismCheckPrefix } from './checks';
import { fingerprint, removeRecord, writeRecord } from './record';
import { buildPrompt, DesignFile, findProjectRoot, sceneCanvas, evalSymlinks, outputPath, relPath, stderrLog, streamLog, userLog, type Scene } from './scene';
import { removeLive, writeLive } from './live';
import { rendererHome, rendererUnfiltered, sandboxAvailable, sandboxed, sandboxProfile } from './sandbox';
import { verifySeam } from './seam';
import { leftoverFiles, resumePrompt, resumeState } from './resume';
import { writeSceneData } from './scenedata';
import { prepareResources } from './resources';
import { verify as verifyResources } from '../renderassets';
import { HyperFramesSkillName, rendererAccess, resolveAllSkills, skillsEnvironment, SkillsDirEnv, stagedSkills, stageRendererSkills, unstageRendererSkills } from './skills';
import { VerificationError } from './verification';
import { acquireSceneLease } from './lease';

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
  const release = acquireSceneLease(s.directory, s.id);
  try { await runScene(s, cfg, unsafe, baseEnv, userOutput, tolerance, signal); }
  finally { release(); }
}

async function runScene(
  s: Scene, cfg: Config, unsafe: boolean, baseEnv: Record<string, string>,
  userOutput: Writer, tolerance: number, signal?: AbortSignal,
): Promise<void> {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('tolerance 必须是有限且非负的数字');
  const renderer = s.renderer !== '' ? s.renderer : cfg.renderer;
  if (renderer === director.Tool && !director.resolveService(director.defaultDir({ ...process.env, ...baseEnv }))) throw new Error(director.NoServiceMessage);
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
  const cliEnv: Record<string, string> = { ...baseEnv };
  if (cfg.hyperFramesCLI !== '') {
    cliEnv[hyperframes.CLIDirEnv] = cfg.hyperFramesCLI;
  } else if (!cliEnv[hyperframes.CLIDirEnv]) {
    // 调用方给的环境里没有时，取进程自己的设置（例如手工指定的 CLI 目录）。
    const dir = process.env[hyperframes.CLIDirEnv];
    if (dir) cliEnv[hyperframes.CLIDirEnv] = dir;
  }
  hyperframes.requireCLI(cliEnv);
  for (const key of [hyperframes.BrowserEnv, hyperframes.HyperFramesBrowserEnv, hyperframes.BrowserHookEnv, hyperframes.BrowserAppArgEnv]) {
    if (!cliEnv[key] && process.env[key]) cliEnv[key] = process.env[key]!;
  }
  // 浏览器同理：客户端里是它自带的 Chromium，单独用命令行时是 onset setup 下载的 headless-shell。
  hyperframes.requireBrowser(cliEnv);
  // 资源先落到项目内容池并链接进镜头；不联网，失败时不启动模型也不清掉上一次产物。
  const preparedResources = prepareResources(s, resolvedSkills);
  const prompt = withWindowsInstructions(buildPrompt(s, resolvedSkills), 'renderer');
  // 渲染器的环境：onset 不在它的 PATH 里，HyperFrames 经 onset 的工具服务（--profile renderer）调用。
  const childEnv = childEnvironment(cfg, baseEnv, unsafe, parsePassthrough(baseEnv.ONSET_PASSTHROUGH_ENV ?? ''));
  // 客户端操作转发只交给编排工具。镜头渲染器已经拿到本次服务，不给它请求整片写操作的入口。
  delete childEnv.ONSET_STUDIO_OP_PIPE;
  if (s.renderWorkers > 0) childEnv.ONSET_RENDER_WORKERS = String(s.renderWorkers);
  addToolsLocation(childEnv);
  // opencode 按 PWD 而不是进程的工作目录定项目目录：不安全模式下照搬过来的 PWD 是 onset 自己的目录，渲染器会写到镜头外面（2026-11 实测）。
  childEnv.PWD = s.directory;
  const access = rendererAccess(resolvedSkills);
  access.toolsServer = onsetToolsServer(onsetExecutable(), 'renderer', s.directory, childEnv);
  // 镜头要用的技能链进镜头目录（stageRendererSkills），opencode 另按名字只放行这几个。
  access.skills = stagedSkills(resolvedSkills, prompt).map((x) => x.name);
  Object.assign(childEnv, rendererEnv(renderer, access, childEnv));
  const model = rendererModelFor(cfg, renderer);
  // 调用选项（推理强度、快速模式、上下文长度）规则同模型：镜头换了渲染工具就不用设置里给另一家写的。
  const options = effectiveOptions(renderer, rendererOptionsFor(cfg, renderer));
  // 渲染器套系统沙箱：只能写镜头目录、读本项目与工具自己的目录（见 sandbox.ts）。macOS 上五家都套，不安全模式不套。
  const projectRoot = findProjectRoot(s.directory);
  if (!unsafe && projectRoot !== '' && sandboxAvailable()) access.osSandbox = true;
  // 渲染器自己不拦命令：套了沙箱时由沙箱管边界；Windows 没有系统沙箱，用户定的是全放开（2026-11），安全先放下。
  access.unfiltered = rendererUnfiltered(access.osSandbox === true);
  /** 渲染器的命令行：给定提示词与会话；qoder 再套系统沙箱。 */
  const invocation = (text: string, session: RendererSession | null): Invocation => {
    const command = rendererLaunch(renderer, text, unsafe, access, model, session, s.directory, { ...childEnv, [director.DirEnv]: director.defaultDir({ ...process.env, ...baseEnv }) }, options);
    let argv = command.argv;
    argv[0] = lookPath(argv[0], baseEnv.PATH ?? '');
    if (!access.osSandbox) return { ...command, argv };
    const home = childEnv.HOME ?? baseEnv.HOME ?? '';
    const own = rendererHome(renderer, home);
    const profile = sandboxProfile({
      sceneDir: s.directory,
      projectRoot,
      env: { ...baseEnv, ...childEnv },
      toolStateDirs: [...(home ? own.state : []), ...(renderer === director.Tool ? [director.rendererDir(director.defaultDir({ ...process.env, ...baseEnv }))] : [])],
      toolStateFiles: home ? own.files : [],
      hiddenDirs: home ? own.hidden : [],
      // 渲染工具、onset 的运行时与资源、借来的浏览器所在的目录；资源目录的上一层是应用资源目录（开发时是仓库，浏览器模式从那里加载界面）。
      readDirs: [path.dirname(fs.realpathSync(argv[0])), path.dirname(process.execPath), ...(process.env.ONSET_ASSETS_DIR ? [path.dirname(process.env.ONSET_ASSETS_DIR)] : []), ...[process.env.ONSET_ASSETS_DIR, childEnv.ONSET_SELF, cliEnv[hyperframes.BrowserEnv], cliEnv[hyperframes.CLIDirEnv]].filter((v): v is string => !!v).map((v) => (fs.existsSync(v) && fs.statSync(v).isDirectory() ? v : path.dirname(v))), ...(s.exemplars?.dirs ?? [])],
    });
    return { ...command, argv: sandboxed(argv, profile) };
  };
  const inputs = fingerprint(s, renderer, resolvedSkills);
  const resourceKeys = new Set([...Object.keys(preparedResources), ...Object.keys(inputs.parts ?? {}).filter((key) => key.startsWith('asset:'))]);
  if ([...resourceKeys].some((key) => preparedResources[key] !== inputs.parts?.[key])) {
    throw new Error('准备期间共享渲染资源发生变化，请重新渲染；本次尚未启动渲染器');
  }
  // 中途异常退出过、输入没变：接着上一次做，不从头重来（resume.ts）。要在归档上一次之前读。
  const design = s.designOnly === true;
  const resume = design || s.fresh || s.seam || s.examNote !== '' ? null : resumeState(s, inputs.fingerprint);
  const frameCount = goRound(s.duration_seconds * sceneCanvas(s).fps);
  /** 新会话：能预先指定会话号的工具给一个，续接时就靠它。 */
  const newSession = (): RendererSession | null => (presetSessionID(renderer) ? { id: crypto.randomUUID(), resume: false } : null);
  /** 第三层的提示词：完整提示词加「接着上一次做」。 */
  const continuePrompt = (): string =>
    withWindowsInstructions(buildPrompt({ ...s, continuation: { reason: resume?.previous.error ?? '', files: leftoverFiles(s), lastSteps: resume?.lastSteps ?? [], codeDone: resume?.codeDone ?? false } }, resolvedSkills), 'renderer');
  const resumeSession = resume !== null && resume.previous.session_id !== '' && resume.previous.renderer === renderer;
  // 直接渲染要看的是归档前就在镜头目录里的合成入口（归档只挪产物与日志，合成代码留在原处）。
  const directRender = resume !== null && resume.codeDone && fs.existsSync(path.join(s.directory, 'index.html'));
  // 先挪走上一次的现场再截断日志；旧记录随即作废，本次通过校验后再写新的。
  // 只写设计稿时不动镜头已有的产物、日志与渲染记录：设计稿只是给实现者的输入。
  if (!design) {
    archiveAttempt(s);
    removeRecord(s);
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
  });
  if (resume) userOutput.write(`[${s.id}] 上一次中途中断了，接着做（不从头重来）\n`);
  const usage: Usage = newUsage();
  let err: unknown = null;
  // 客户端据此显示「渲染中」与渲染器此刻在做什么，见 live.ts。
  writeLive(s.directory, s.id, { pid: process.pid, renderer, started_at: attempt.started_at });
  let unstage = () => {};
  try {
    // qoder 用自己的 Skill 工具加载本镜头的技能（链接只在渲染期间存在，见 stageRendererSkills）。
    unstage = stageRendererSkills(renderer, s.directory, resolvedSkills, prompt);
    await render();
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

  async function render(): Promise<void> {
    const rawFile = fs.openSync(design ? designLog(s, 'stream.jsonl') : streamLog(s), 'w');
    try {
      const stderrFile = fs.openSync(design ? designLog(s, 'stderr.log') : stderrLog(s), 'w');
      try {
        const userFile = fs.openSync(design ? designLog(s, 'user.log') : userLog(s), 'w');
        try {
          await renderLayers(rawFile, stderrFile, userFile);
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
    finish();
  }

  /** 渲染出来以后：校验产物（修接缝另核对开头与其余画面），写渲染记录。 */
  function finish(): void {
    if (design) {
      verifyDesign(s);
      return;
    }
    verifyResources(s.directory);
    verifyOutput(s, baseEnv, tolerance);
    // 修接缝：第 0 帧要接上前一镜的末帧、后面的画面不许变（seam.ts）。
    if (s.seam) verifySeam(s, s.seam, mediaprobe.newToolchain(baseEnv), sceneCanvas(s).fps);
    writeRecord(s, inputs);
  }

  /**
   * 按接续的三层依次试：onset 直接渲染（合成已写完）→ 续接原会话 → 新会话照上次的文件接着做；没有可接的就是一次普通渲染。
   * 直接渲染出片且校验通过就到此为止（render() 里还会再校验一次，结果相同）。
   */
  async function renderLayers(rawFile: number, stderrFile: number, userFile: number): Promise<void> {
    if (directRender) {
      try {
        await renderComposition(stderrFile);
        verifyOutput(s, baseEnv, tolerance);
        attempt.resumed = 'render';
        fs.writeSync(userFile, `onset 直接渲染了上一次写好的合成：${s.output}\n`);
        userOutput.write(`[${s.id}] 上一次的合成已写完，直接渲染出片\n`);
        return;
      } catch (e) {
        if (signal?.aborted) throw e;
        userOutput.write(`[${s.id}] 直接渲染没成（${(e as Error).message.split('\n')[0]}），交给渲染器接着做\n`);
      }
    }
    if (resumeSession) {
      attempt.resumed = 'session';
      attempt.session_id = resume!.previous.session_id;
      const text = resumePrompt(resume!.previous.error, s.output, frameCount);
      const events = await spawnRenderer(invocation(text, { id: resume!.previous.session_id, resume: true }), rawFile, stderrFile, userFile).catch((e: unknown) => {
        if (signal?.aborted || (e as { events?: number }).events !== 0) throw e;
        return -1;
      });
      if (events >= 0) return;
      // 续接的会话一句话都没说就退出了（会话过期、找不到）：退到第三层。
      userOutput.write(`[${s.id}] 原来的会话续不上，开新会话照上次的文件接着做\n`);
    }
    const session = newSession();
    attempt.session_id = session?.id ?? '';
    if (resume) attempt.resumed = 'files';
    await spawnRenderer(invocation(resume ? continuePrompt() : prompt, session), rawFile, stderrFile, userFile);
  }

  /** 第一层：onset 自己用固定版本的 HyperFrames CLI 渲染镜头目录里的合成，不用模型。 */
  async function renderComposition(stderrFile: number): Promise<void> {
    const args = ['render', '--output', s.output, ...(s.renderWorkers > 0 ? ['--workers', String(s.renderWorkers)] : [])];
    const spec = hyperframes.cliCommandFor(hyperframes.requireCLI(cliEnv), cliEnv, args);
    const started = await start(spec.file, spec.args, { cwd: s.directory, env: spec.env, stdio: ['ignore', stderrFile, stderrFile], signal }, terminateGrace);
    try {
      await started.wait();
    } catch (e) {
      if (signal?.aborted) throw new Error('已中断：渲染进程组已终止');
      throw new Error(e instanceof ExitError ? `HyperFrames 渲染退出码 ${e.code}` : (e as Error).message);
    }
  }

  /** 跑一次渲染器；返回它说了几句话、调了几次工具（0 表示根本没开始）。失败时抛出的错误也带着这个数（events）。 */
  async function spawnRenderer(command: Invocation, rawFile: number, stderrFile: number, userFile: number): Promise<number> {
    let events = 0;
    const parser = newParser(renderer);
    const fail = (e: Error): Error => Object.assign(e, { events });
    let started: Started;
    try {
      started = await start(command.argv[0], command.argv.slice(1), { cwd: s.directory, env: { ...childEnv, ...command.env }, stdio: [command.stdin ? 'pipe' : 'ignore', 'pipe', stderrFile], signal }, terminateGrace);
      if (command.stdin && started.child.stdin) {
        started.child.stdin.on('error', () => {});
        started.child.stdin.end(command.stdin);
      }
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
      for (const e of parser.parse(line)) {
        if (e.kind === KindSession && e.session_id) attempt.session_id = e.session_id;
        if (e.kind === KindText || e.kind === KindToolCall) events++;
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
    if (signal?.aborted) throw fail(new Error('已中断：渲染器进程组已终止'));
    if (scanError) throw fail(new Error(`读取渲染器输出：${(scanError as Error).message}`));
    if (waitErr !== null) {
      if (waitErr instanceof ExitError) {
        attempt.exit_code = waitErr.code;
        throw fail(new Error(`渲染器退出码 ${waitErr.code}`));
      }
      throw fail(waitErr as Error);
    }
    return events;
  }
}

/** 只写设计稿那一次的日志：design-<镜头>.<后缀>，不盖掉渲染的日志。 */
export function designLog(s: Pick<Scene, 'directory' | 'id'>, suffix: string): string {
  return path.join(s.directory, `design-${s.id}.${suffix}`);
}

/** 设计稿那一次的校验：design.md 写出来了、不是空的。 */
function verifyDesign(s: Scene): void {
  let text = '';
  try {
    text = fs.readFileSync(path.join(s.directory, DesignFile), 'utf8');
  } catch {
    throw new Error(`设计稿没写出来：镜头目录里没有 ${DesignFile}`);
  }
  if (text.trim() === '') throw new Error(`设计稿是空的：${DesignFile}`);
}

/**
 * 校验镜头产物是否符合执行契约。
 *
 * 检查画幅、帧率、时长和「必须静音无音轨」四项，缺一项都会让错误在成片阶段才暴露。
 * 另外静态扫描合成源码的确定性（determinism）：读时钟、未播种随机数、
 * requestAnimationFrame 这类写法渲染照样成功，要到重渲染对不上时才暴露。
 *
 *   - 画幅：就近的 frame.md 声明了画布，渲染成别的尺寸无法靠后期规范化补救——
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
  const canvas = sceneCanvas(s);
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
