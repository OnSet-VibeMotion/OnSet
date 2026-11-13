/**
 * am setup：下载并准备全部前置资源。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as beat from '@am/engine/beat';
import { goQuote } from '@am/engine/gofmt';
import { SetupCommand } from '@am/engine/prereq';
import * as prereqs from '@am/engine/prereqs';
import { currentEnvironment, hyperframesVersion, noArgs } from './cli';
import { Command, ExitError, type Out, ref } from './cobra';
import { sourceSummary } from './filmstyle';
import { clock, homeShort, pad, SetupView, tailLines, ViewState } from './setupview';

export function newSetupCommand(stdout: Out, _stderr?: Out): Command {
  const check = ref(false);
  const only = ref<string[]>([]);
  const proxy = ref('');
  const npmRegistry = ref('');
  const cmd = new Command({
    use: 'setup',
    args: noArgs,
    short: '下载并准备全部前置资源（HyperFrames 技能与 CLI、浏览器、ffmpeg、配音与对齐工具、整片风格来源）',
    long:
      `要联网的东西都由这一条命令准备，放在用户级目录里，所有项目共用：

  skills   HyperFrames ` +
      hyperframesVersion +
      ` 官方技能（有 git 时浅克隆，没有时从 GitHub 逐个文件下载并核对，缓存在 ~/.local/share/am/hyperframes/<commit>）
  cli      HyperFrames CLI ` +
      hyperframesVersion +
      `（npm，客户端自带一份；装在 ~/.local/share/am/hyperframes/cli-<版本>）
  browser  渲染用浏览器。客户端里的 am 用客户端自带的 Chromium，这一项直接就绪；单独使用命令行时
           下载 chrome-headless-shell（约 390 MB，在 ~/.cache/hyperframes/chrome）
  ffmpeg   ffmpeg 与 ffprobe。系统里已有（PATH 能找到）就直接就绪；没有时下载固定版本的静态构建
           （约 40 MB，装在 ~/.local/share/am/bin），不需要 Homebrew
  tts      配音工具（按项目的 TTS_PROVIDER，缺省在 Apple Silicon 上是本机 Breeze TTS 2，其余平台是 MiniMax 的 mmx）；align  对齐工具（按 ALIGN_PROVIDER）。
           固定版本，装在 ~/.local/share/am/tools，命令放进 ~/.local/share/am/bin；npm 包用客户端
           自带的运行时，Python 包由 uv 带一份独立的 Python，都不需要你装 Node 或 Python
  beat     卡点模式的节拍分析环境：beat-this ` +
      beat.AnalyzerVersion +
      ` 与 torch 的 Python 虚拟环境加默认模型权重，约 1 GB
           （装在 ~/.local/share/am/beat/venv-<版本>）；只做卡点片才需要
  styles   每个整片风格来源一项（styles:<来源>），数据放在 ~/.local/share/am/film-styles/<来源>；
           已登记的来源：
` +
      sourceSummary() +
      `

其余命令（am init、am film-style use、am scene run、am hyperframes、am studio）只检查
不下载，缺了就提示先运行 am setup。已就绪的项直接跳过；下载断了再运行一次会接着下。
git 与 npm 的原始输出写进 ~/.local/share/am/setup.log，失败时屏幕上给出最后几行。

--proxy（例如本机的 Clash）只给 git 与 GitHub 下载（技能、ffmpeg、uv、Python）、浏览器与节拍模型权重用；
GitHub 的 release 也可以设 AM_GITHUB_MIRROR 走镜像（文件都核对 sha256）。npm 与 pip 照常用你 ~/.npmrc、
pip.conf 里的镜像与代理（Python 类工具由 uv 安装，也沿用 pip.conf 的 index-url），npm 要临时换源用
--npm-registry。--only 认 skills、cli、browser、ffmpeg、tts、align、beat、styles（全部风格来源）或
styles:<来源>。--check 只报告哪些已就绪、哪些缺，不下载；有缺项时退出码为 1。`,
    example: `  am setup
  am setup --proxy http://127.0.0.1:7890
  am setup --only styles --proxy http://127.0.0.1:7890
  am setup --only styles:lemo-opuscar
  am setup --only beat
  am setup --only tts,align
  am setup --check`,
    runE: async (c) => {
      const env = currentEnvironment();
      // 在项目目录里运行时，配音与对齐工具按项目配置挑；不在项目里按环境变量与缺省值。
      const selected = selectSetupItems(prereqs.items(prereqs.selection(env, process.cwd())), only.value);
      if (check.value) return setupCheck(stdout, env, selected);
      return setupPrepare(c.context(), stdout, env, selected, proxy.value, npmRegistry.value);
    },
  });
  cmd.flags().boolVar(check, 'check', false, '只检查哪些已就绪，不下载；有缺项时退出码为 1');
  cmd.flags().stringSliceVar(only, 'only', [], '只准备其中几项：skills、cli、browser、ffmpeg、tts、align、beat、styles 或 styles:<来源>（可逗号分隔）');
  cmd.flags().stringVar(proxy, 'proxy', '', 'git 下载（GitHub）、浏览器与节拍模型权重用的代理，例如 http://127.0.0.1:7890；不影响 npm 与 pip');
  cmd.flags().stringVar(npmRegistry, 'npm-registry', '', 'npm 用的源，覆盖 ~/.npmrc 的 registry');
  return cmd;
}

export function selectSetupItems(items: prereqs.Item[], only: string[]): prereqs.Item[] {
  const wanted = new Set<string>();
  for (const value of only) for (const id of value.split(',')) if (id.trim() !== '') wanted.add(id.trim());
  for (const id of wanted) {
    if (!items.some((item) => item.id === id || item.group === id)) {
      throw new Error(`--only 不认 ${goQuote(id)}（可选：skills、cli、browser、ffmpeg、tts、align、beat、styles、${items.map((item) => item.id).join('、')}）`);
    }
  }
  return items.filter((item) => wanted.size === 0 || wanted.has(item.id) || wanted.has(item.group));
}

function newItemsView(stdout: Out, items: prereqs.Item[]): SetupView {
  return new SetupView(
    stdout,
    items.map((item) => item.name),
    items.map((item) => item.version),
    Boolean(stdout.isTTY),
  );
}

/** 只报告：每项一行，已就绪 / 缺，附位置。 */
function setupCheck(stdout: Out, env: Record<string, string>, items: prereqs.Item[]): void {
  const view = newItemsView(stdout, items);
  const [nameWidth, versionWidth] = view.widths();
  stdout.write('\n');
  let missing = 0;
  for (const item of items) {
    const [ok, where] = item.ready(env);
    let icon = view.paint('32', '✓');
    let state = '已就绪';
    if (!ok) {
      icon = view.paint('31', '✗');
      state = view.paint('31', '缺');
      missing++;
    }
    const version = versionWidth > 0 ? view.paint('2', pad(item.version, versionWidth)) + '  ' : '';
    stdout.write(`  ${icon} ${pad(item.name, nameWidth)}  ${version}${pad(state, 6)}  ${view.paint('2', homeShort(where))}\n`);
  }
  stdout.write('\n');
  if (missing > 0) {
    stdout.write(`缺 ${missing} 项，运行 ${SetupCommand} 准备。\n`);
    throw new ExitError(1, '');
  }
  stdout.write('前置资源都已就绪。\n');
}

/** git / npm 原始输出的日志：<数据目录>/am/setup.log，每次运行覆盖。 */
export function setupLogPath(env: Record<string, string>): string {
  return prereqs.logPath(env);
}

/** 逐项准备，界面每项一行；失败时停下，给出错误与日志最后几行。 */
async function setupPrepare(
  signal: AbortSignal,
  stdout: Out,
  env: Record<string, string>,
  items: prereqs.Item[],
  proxy: string,
  npmRegistry: string,
): Promise<void> {
  const logPath = setupLogPath(env);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let logFd: number;
  try {
    logFd = fs.openSync(logPath, 'w');
  } catch (err) {
    throw new Error(`创建日志 ${logPath}：${(err as Error).message}`);
  }
  const log = { write: (chunk: string) => fs.writeSync(logFd, chunk) };
  try {
    const run = prereqs.newRun(env, proxy, npmRegistry, log);

    const view = newItemsView(stdout, items);
    let header = 'am setup · 准备前置资源';
    if (proxy !== '') header += view.paint('2', '（git 代理 ' + proxy + '）');
    stdout.write(`\n${header}\n\n`);
    items.forEach((item, i) => {
      if (item.ready(env)[0]) view.markReady(i);
    });
    if (!view.tty) items.forEach((_, i) => view.items[i].state === ViewState.Ready && view.set(i, ViewState.Ready, ''));
    view.start();
    const started = Date.now();
    for (const [i, item] of items.entries()) {
      if (view.items[i].state === ViewState.Ready) continue;
      log.write(`\n===== ${item.name} ${item.version} =====\n`);
      view.set(i, ViewState.Running, '准备中');
      run.stage = (stage) => view.detail(i, stage);
      try {
        await item.prepare(run, signal);
      } catch (err) {
        const message = (err as Error).message;
        log.write(`\n[am] ${message}\n`);
        view.set(i, ViewState.Failed, '');
        view.stop();
        fs.fsyncSync(logFd);
        const body = fs.readFileSync(logPath, 'utf8');
        stdout.write(`\n${view.paint('31', '✗')} ${item.name} 没准备好：${message}\n`);
        // 日志最后一行是 am 自己记的错误，上面已经打过，不重复。
        const cut = body.lastIndexOf('\n[am] ');
        const tail = tailLines(body.slice(0, Math.max(0, cut)).replace(/\n+$/, ''), 12);
        if (tail.length > 0) {
          stdout.write(view.paint('2', '\n  日志最后几行：') + '\n');
          for (const line of tail) stdout.write(view.paint('2', '  │ ' + line) + '\n');
        }
        stdout.write(`\n完整日志：${homeShort(logPath)}\n再运行一次 am setup 会接着下；GitHub 慢可以加 --proxy。\n`);
        throw new ExitError(1, '');
      }
      view.set(i, ViewState.Done, '');
    }
    view.stop();
    stdout.write(`\n全部就绪，用时 ${clock(Date.now() - started)}。\n`);
  } finally {
    fs.closeSync(logFd);
  }
}
