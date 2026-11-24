import fs from 'node:fs';
import path from 'node:path';
import { type Config, childEnvironment } from '../config';
import { addToolsLocation, lookPath, parsePassthrough } from '../envutil';
import * as hyperframes from '../hyperframes';
import { ExitError, start } from '../procgroup';
import { verify as verifyResources } from '../renderassets';
import { timestamp } from './attempt';
import { acquireSceneLease } from './lease';
import { removeLive, writeLive } from './live';
import { fingerprint, refreshRecordOutput, writeRecord } from './record';
import { verifyOutput, type Writer } from './run_verify';
import { sandboxAvailable, sandboxed, sandboxProfile } from './sandbox';
import { contained, findProjectRoot, outputPath, type Scene } from './scene';
import { resolveAllSkills, skillsEnvironment } from './skills';

/** SIGTERM 之后等渲染器进程组自行退出的时间（毫秒）。 */
export const TerminateGrace = 500;

export function buildHyperFramesEnv(cfg: Config, baseEnv: Record<string, string>): Record<string, string> {
  const cliEnv: Record<string, string> = { ...baseEnv };
  if (cfg.hyperFramesCLI !== '') {
    cliEnv[hyperframes.CLIDirEnv] = cfg.hyperFramesCLI;
  } else if (!cliEnv[hyperframes.CLIDirEnv]) {
    // 调用方给的环境里没有时，取进程自己的设置（例如手工指定的 CLI 目录）。
    const dir = process.env[hyperframes.CLIDirEnv];
    if (dir) cliEnv[hyperframes.CLIDirEnv] = dir;
  }
  for (const key of [
    hyperframes.BrowserEnv,
    hyperframes.HyperFramesBrowserEnv,
    hyperframes.BrowserHookEnv,
    hyperframes.BrowserAppArgEnv,
  ]) {
    if (!cliEnv[key] && process.env[key]) cliEnv[key] = process.env[key]!;
  }
  return cliEnv;
}

export function buildChildEnv(
  s: Scene,
  cfg: Config,
  unsafe: boolean,
  baseEnv: Record<string, string>,
): Record<string, string> {
  const childEnv = childEnvironment(cfg, baseEnv, unsafe, parsePassthrough(baseEnv.ONSET_PASSTHROUGH_ENV ?? ''));
  // 客户端操作转发只交给编排工具。镜头渲染器已经拿到本次服务，不给它请求整片写操作的入口。
  delete childEnv.ONSET_STUDIO_OP_PIPE;
  if (s.renderWorkers > 0) childEnv.ONSET_RENDER_WORKERS = String(s.renderWorkers);
  addToolsLocation(childEnv);
  // opencode 按 PWD 而不是进程的工作目录定项目目录：不安全模式下照搬过来的 PWD 是 onset 自己的目录，渲染器会写到镜头外面（2026-11 实测）。
  childEnv.PWD = s.directory;
  return childEnv;
}

export function sandboxReadDirs(
  argv0: string,
  childEnv: Record<string, string>,
  cliEnv: Record<string, string>,
  extraDirs: string[] = [],
): string[] {
  // 渲染工具、onset 的运行时与资源、借来的浏览器所在的目录；资源目录的上一层是应用资源目录（开发时是仓库，浏览器模式从那里加载界面）。
  return [
    path.dirname(fs.realpathSync(argv0)),
    path.dirname(process.execPath),
    ...(process.env.ONSET_ASSETS_DIR ? [path.dirname(process.env.ONSET_ASSETS_DIR)] : []),
    ...[
      process.env.ONSET_ASSETS_DIR,
      childEnv.ONSET_SELF,
      cliEnv[hyperframes.BrowserEnv],
      cliEnv[hyperframes.CLIDirEnv],
    ]
      .filter((v): v is string => !!v)
      .map((v) => (fs.existsSync(v) && fs.statSync(v).isDirectory() ? v : path.dirname(v))),
    ...extraDirs,
  ];
}

/**
 * 零模型直接出片：不启动 AI 渲染器，直接用固定版本 HyperFrames CLI 把镜头目录里现有的 index.html
 * 重新编码成 MP4，通过产物规格与确定性校验后原子替换正式产物，并刷新渲染记录。
 */
export async function encodeScene(
  s: Scene,
  cfg: Config,
  unsafe: boolean,
  baseEnv: Record<string, string>,
  userOutput: Writer,
  tolerance: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('tolerance 必须是有限且非负的数字');
  const release = acquireSceneLease(s.directory, s.id);
  try {
    signal?.throwIfAborted();
    const html = contained(s.directory, 'index.html', '合成入口');
    if (!fs.existsSync(html)) throw new Error('直接出片需要已有的 index.html 合成');
    const cliEnv = buildHyperFramesEnv(cfg, baseEnv);
    const cli = hyperframes.requireCLI(cliEnv);
    const browser = hyperframes.requireBrowser(cliEnv);
    const childEnv = buildChildEnv(s, cfg, unsafe, baseEnv);
    const renderEnv: Record<string, string> = { ...childEnv, [hyperframes.BrowserEnv]: browser };
    if (cliEnv[hyperframes.HyperFramesBrowserEnv])
      renderEnv[hyperframes.HyperFramesBrowserEnv] = cliEnv[hyperframes.HyperFramesBrowserEnv];
    if (cliEnv[hyperframes.BrowserHookEnv]) renderEnv[hyperframes.BrowserHookEnv] = cliEnv[hyperframes.BrowserHookEnv];
    if (cliEnv[hyperframes.BrowserAppArgEnv])
      renderEnv[hyperframes.BrowserAppArgEnv] = cliEnv[hyperframes.BrowserAppArgEnv];
    if (cliEnv[hyperframes.CLIDirEnv]) renderEnv[hyperframes.CLIDirEnv] = cliEnv[hyperframes.CLIDirEnv];

    const live = { pid: process.pid, renderer: 'encode', started_at: timestamp(new Date()), encoding: true };
    writeLive(s.directory, s.id, live);
    const stage = fs.mkdtempSync(path.join(s.directory, '.onset-encode-'));
    try {
      const candidate = { ...s, output: path.relative(s.directory, path.join(stage, path.basename(s.output))) };
      const args = [
        'render',
        '--output',
        candidate.output,
        ...(s.renderWorkers > 0 ? ['--workers', String(s.renderWorkers)] : []),
      ];
      const spec = hyperframes.cliCommandFor(cli, renderEnv, args);
      let argv = [spec.file, ...spec.args];
      argv[0] = lookPath(argv[0], baseEnv.PATH ?? '');
      const projectRoot = findProjectRoot(s.directory);
      if (!unsafe && projectRoot !== '' && sandboxAvailable()) {
        const profile = sandboxProfile({
          sceneDir: s.directory,
          projectRoot,
          env: { ...baseEnv, ...renderEnv },
          toolStateDirs: [],
          readDirs: sandboxReadDirs(argv[0], childEnv, cliEnv),
        });
        argv = sandboxed(argv, profile);
      }
      userOutput.write(`[${s.id}] 正在从当前 HTML 合成直接出片…\n`);
      const started = await start(
        argv[0],
        argv.slice(1),
        { cwd: s.directory, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], signal },
        TerminateGrace,
      );
      let tail = '';
      started.child.stderr!.setEncoding('utf8');
      started.child.stderr!.on('data', (chunk: string) => {
        tail = (tail + chunk).slice(-4000);
      });
      started.child.stdout!.setEncoding('utf8');
      started.child.stdout!.on('data', (chunk: string) => {
        tail = (tail + chunk).slice(-4000);
      });
      try {
        await started.wait();
      } catch (e) {
        if (signal?.aborted) throw new Error('已中断：出片进程组已终止');
        const reason = e instanceof ExitError ? `HyperFrames 出片退出码 ${e.code}` : (e as Error).message;
        throw new Error(tail.trim() ? `${reason}\n${tail.trim()}` : reason, { cause: e });
      }
      verifyResources(s.directory);
      verifyOutput(candidate, baseEnv, tolerance, false);
      signal?.throwIfAborted();
      const destination = contained(s.directory, s.output, 'output');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.renameSync(outputPath(candidate), destination);
      if (!refreshRecordOutput(s)) {
        const renderer = s.renderer !== '' ? s.renderer : cfg.renderer;
        if (renderer) {
          try {
            const resolvedSkills = resolveAllSkills(renderer, s.directory, skillsEnvironment(baseEnv, cfg.overlay), s);
            writeRecord(s, fingerprint(s, renderer, resolvedSkills));
          } catch {
            // 没有旧记录且算不出技能指纹时保留新视频，不阻断直接出片。
          }
        }
      }
      userOutput.write(`[${s.id}] 已完成直接出片：${s.output}\n`);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
      removeLive(s.directory, s.id);
    }
  } finally {
    release();
  }
}
