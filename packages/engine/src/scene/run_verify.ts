import fs from 'node:fs';
import path from 'node:path';
import * as determinism from '../determinism';
import { atomicWrite } from '../fsutil';
import { formatFixed, goRound } from '../gofmt';
import * as mediaprobe from '../mediaprobe';
import { AgyMcpFile, agyMcpJSON, McodeMcpFile, type McpServer, mcodeMcpJSON } from '../tools';
import { blockValue } from './block';
import { CheckOutputFrames, CheckOutputOther, classifyOutputProblem, DeterminismCheckPrefix } from './checks';
import { verifyComponentReferences } from './component-plan';
import type { RepairContext } from './repair';
import { contained, DesignFile, evalSymlinks, outputPath, relPath, type Scene, sceneCanvas } from './scene';
import { VerificationError } from './verification';

/** 写给用户看的输出（Go 的 io.Writer）。 */
export interface Writer {
  write(chunk: string): unknown;
}

const complexVisualRe =
  /\b(?:three\.?js|webgl|canvas|lottie|3d|shader|particle|character|rig)\b|多角色|粒子|三维|算法艺术|生成式/i;

/** 判断单镜头是否属于低复杂度镜头（短标题/文字卡等），便于在用户配了 simple_effort 时自动降档省 token。 */
export function isSimpleScene(s: Scene): boolean {
  if (s.duration_seconds > 6 || s.text.length > 60) return false;
  if (s.components.length > 0 || s.plugin_skills.length > 0) return false;
  if (blockValue(s, 'cast') !== null || blockValue(s, 'song') !== null || blockValue(s, 'beat') !== null) return false;
  try {
    const promptPath = contained(s.directory, 'prompt.md', 'prompt.md');
    if (fs.existsSync(promptPath)) {
      const body = fs.readFileSync(promptPath, 'utf8');
      if (body.length > 450 || complexVisualRe.test(body)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function renderStage(s: Scene, repair?: RepairContext): 'full' | 'repair' | 'simple' {
  if (repair || s.seam) return 'repair';
  return isSimpleScene(s) ? 'simple' : 'full';
}

/** 只写设计稿那一次的日志：design-<镜头>.<后缀>，不盖掉渲染的日志。 */
export function designLog(s: Pick<Scene, 'directory' | 'id'>, suffix: string): string {
  return path.join(s.directory, `design-${s.id}.${suffix}`);
}

/** 设计稿那一次的校验：design.md 写出来了、不是空的。 */
export function verifyDesign(s: Scene): void {
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
export function verifyOutput(
  s: Scene,
  baseEnv: Record<string, string>,
  tolerance: number,
  checkComponents = false,
): void {
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
  const engineContract = determinism.checkEngineContract(s.directory, {
    filmStyle: s.film_style,
    files: scan.files,
  });
  for (const issue of engineContract.errors) {
    problems.push(determinism.formatEngineContractIssue(issue));
    checks.push(CheckOutputOther);
  }
  if (problems.length > 0) throw new VerificationError(s.output, problems, checks);
  if (checkComponents) verifyComponentReferences(s, scan.files);
}

function isOursMcpConfig(text: string, serverName: string): boolean {
  try {
    const servers = JSON.parse(text).mcpServers as Record<string, { args?: unknown }>;
    const names = Object.keys(servers ?? {});
    return (
      names.length === 1 &&
      names[0] === serverName &&
      Array.isArray(servers[serverName]!.args) &&
      (servers[serverName]!.args as unknown[]).includes('tools-mcp')
    );
  } catch {
    return false;
  }
}

/**
 * mcode exec 只从工作目录的 .mcp.json 读 MCP（tools.mcodeMcpJSON），渲染期间在镜头目录里放一份 onset 工具服务的配置，
 * 渲染完删掉。上次没删干净的（只有 onset 一个服务、跑的是 tools-mcp）直接换掉；镜头目录里原本就有别的 .mcp.json 时
 * 不覆盖，照实报错——盖掉的话那份配置就丢了。
 */
export function stageMcodeMcp(sceneDir: string, server: McpServer): () => void {
  const file = path.join(sceneDir, McodeMcpFile);
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${McodeMcpFile} 不能是符号链接：${file}`);
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== null && !isOursMcpConfig(existing, server.name))
    throw new Error(
      `镜头目录里已有 ${McodeMcpFile}，MiniMax Code 渲染要在这里放 onset 工具服务的配置；请先挪走它：${file}`,
    );
  const content = mcodeMcpJSON(server);
  atomicWrite(file, content, 0o600);
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8') === content) fs.rmSync(file, { force: true });
    } catch {
      // 已经不在了。
    }
  };
}

/**
 * Antigravity CLI（agy）headless 模式从工作区 `.agents/mcp_config.json` 读 MCP（tools.agyMcpJSON），
 * 渲染期间在镜头目录里放一份 onset 工具服务的配置，渲染完删掉；别人的配置不覆盖，报错退出。
 */
export function stageAgyMcp(sceneDir: string, server: McpServer): () => void {
  const file = path.join(sceneDir, AgyMcpFile);
  const dir = path.dirname(file);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${path.dirname(AgyMcpFile)} 不能是符号链接：${dir}`);
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`${AgyMcpFile} 不能是符号链接：${file}`);
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== null && !isOursMcpConfig(existing, server.name))
    throw new Error(
      `镜头目录里已有 ${AgyMcpFile}，Antigravity 渲染要在这里放 onset 工具服务的配置；请先挪走它：${file}`,
    );
  const createdDir = !fs.existsSync(dir);
  const content = agyMcpJSON(server);
  atomicWrite(file, content, 0o600);
  return () => {
    try {
      if (fs.readFileSync(file, 'utf8') === content) fs.rmSync(file, { force: true });
      if (createdDir) fs.rmdirSync(dir);
    } catch {
      // 已经不在了或目录非空。
    }
  };
}
