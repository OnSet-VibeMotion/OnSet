/**
 * am 的根命令与命令之间共用的小工具。移植自 internal/cli/cli.go。
 *
 * 子命令按引擎移植进度逐个挂上；newRoot 里的注册顺序与 Go 版无关（帮助按名字排序）。
 */
import * as envutil from '@am/engine/envutil';
import { formatFixed } from '@am/engine/gofmt';
import { PinnedVersion } from '@am/engine/hyperframes';
import { Command, ExitError, type Out, type PositionalArgs, ref } from './cobra';
import { newFilmStyleCommand } from './filmstyle';
import { newHyperframesCommand } from './hyperframes';
import { newAlignCommand } from './align';
import { newAudioCommand } from './audio';
import { newArchiveCommand, newConfigCommand, newInitCommand } from './project_cmds';
import { newSetupCommand } from './setup';
import { newStudioCommand } from './studio';
import { newStyleCommand } from './style_cmd';
import { newBeatCommand } from './beat_cmd';
import { newCastCmd, newDialogueCmd } from './cast_cmd';
import { newConcatCommand } from './media';
import { newReviewCommand } from './review_cmd';
import { newRunCommand } from './run_cmd';
import { newSceneCommand } from './scene_cmd';
import { newSongCmd } from './song_cmd';
import { newUsageCommand } from './usage_cmd';
import { newValidateCommand } from './validate_cmd';
import { setToolVersion } from '@am/engine/scene';

/**
 * `am --version` 的版本号。由发布流程在构建时注入（esbuild --define:AM_VERSION），本地构建是 dev。
 * 版本号必须只有 tag 这一个来源：曾经写死过 1.0.0，发新版时没人改，下载到的程序一直自称 1.0.0。
 */
declare const AM_VERSION: string | undefined;
export const Version = typeof AM_VERSION === 'string' ? AM_VERSION : 'dev';

/** 本包内的简写，真相在 hyperframes.PinnedVersion（也是下发提示词里锁定指令的取值来源）。 */
export const hyperframesVersion = PinnedVersion;

export function currentEnvironment(): Record<string, string> {
  return envutil.envMap();
}

export function addExecutableLocation(env: Record<string, string>, stderr: Out): void {
  try {
    envutil.addExecutableLocation(env);
  } catch (err) {
    stderr.write(`警告：${(err as Error).message}\n`);
  }
}

export const rootLong = `ArticleToMotion 竖屏 MG 视频制作工具。

把定稿 SRT 拆成并发渲染的动画镜头，或从文章/口播稿走完 TTS、字幕、封面、
声音与发布交付的全流程。渲染由外部 AI CLI 完成，am 负责契约、调度与校验。

两种入口：
  am run                          有定稿 transcription.srt 读 PROMPT.md，否则读 PROMPT-PRODUCTION.md
  am run PROMPT-PRODUCTION.md     从文章或口播稿开始完整制作
  am scene run / run-all          只跑镜头渲染，可脱离 am run 单独使用

配置解析优先级（高到低）：环境变量 > 项目 .env > article-to-motion.conf > 内置默认。
用 am config get 读取解析结果，不要自己解析配置文件。
项目 .env 不允许出现以 API_KEY / TOKEN / SECRET / PASSWORD 结尾的键，出现则拒绝启动。

外部 AI CLI 默认运行在限制于项目工作区的安全模式。安全模式下子进程只继承白名单
环境变量加上 .env 覆盖层；缺变量用 AM_PASSTHROUGH_ENV=NAME1,NAME2 显式列出，
不要改用 --unsafe 绕过隔离。

退出码：
  0    成功
  1    一般失败（参数、校验、配置、IO）
  127  缺少必需的外部命令
  130  被中断（SIGINT / 上下文取消）
  其他 透传子进程退出码：am run 用编排工具的退出码，am scene run-all 用镜头汇总退出码

所有错误写 stderr，正常输出写 stdout；失败时不打印 usage，只打印一行错误。`;

/** 全局参数 --unsafe 的值，由各个会启动 AI CLI 的命令读取。 */
export interface RootFlags {
  unsafe: { value: boolean };
}

export function newRoot(stdout: Out, stderr: Out): { root: Command; flags: RootFlags } {
  const unsafe = ref(false);
  setToolVersion(Version);
  const root = new Command({ use: 'am', short: 'ArticleToMotion 竖屏 MG 视频制作工具', long: rootLong, version: Version });
  root.setOut(stdout);
  root.setErr(stderr);
  root.persistentFlags().boolVar(
    unsafe,
    'unsafe',
    false,
    '关闭 AI CLI 的权限隔离（危险）。只对会启动 AI CLI 的 run / studio / scene run / scene run-all 生效，对 init、config、validate、archive 无作用；会传递给嵌套镜头任务',
  );
  const flags: RootFlags = { unsafe };
  root.addCommand(newSetupCommand(stdout, stderr), newHyperframesCommand(stdout, stderr), newFilmStyleCommand(stdout, stderr));
  root.addCommand(newInitCommand(stdout, stderr), newConfigCommand(stdout), newArchiveCommand(stdout), newAlignCommand(stdout), newAudioCommand(stdout), newStyleCommand(stdout), newStudioCommand(stdout));
  // validate、concat、review 在 Go 版里共用同一个 --project-root 变量。
  const projectRoot = ref('');
  root.addCommand(newSceneCommand(stdout, stderr, unsafe), newRunCommand(stdout, stderr, unsafe), newUsageCommand(stdout));
  root.addCommand(newValidateCommand(stdout, projectRoot), newConcatCommand(stdout, projectRoot), newReviewCommand(stdout, projectRoot));
  root.addCommand(newSongCmd(stdout), newBeatCommand(stdout), newCastCmd(stdout), newDialogueCmd(stdout));
  // TODO(memory): root.addCommand(newMemoryCommand(stdout, stderr, unsafe))——am memory 整组命令下一轮移植。
  return { root, flags };
}

/**
 * 执行一条 am 命令并返回退出码：0 成功，1 一般失败，127 缺外部命令，130 被中断，
 * 其余是 ExitError 透传的子进程退出码。错误写 stderr，失败时不打印 usage，只打印一行错误。
 */
export async function execute(args: string[], stdout: Out, stderr: Out, signal?: AbortSignal): Promise<number> {
  const { root } = newRoot(stdout, stderr);
  if (signal) root.setContext(signal);
  try {
    await root.execute(args);
    return 0;
  } catch (err) {
    // 自己已经把结果完整打在屏幕上的命令（例如 am setup）抛出不带消息的 ExitError，这里不再补一行。
    if (!(err instanceof ExitError) || err.bare !== '') stderr.write(String((err as Error)?.message ?? err) + '\n');
    if (err instanceof ExitError) return err.code;
    if (signal?.aborted) return 130;
    if (String((err as Error)?.message ?? '').includes(envutil.MissingToolPrefix)) return 127;
    return 1;
  }
}

/** cobra.ExactArgs 的中文版：调用方只读这一行就知道补什么。 */
export function exactArgs(count: number, name: string): PositionalArgs {
  return (cmd, args) => {
    if (args.length !== count) throw new Error(`${cmd.commandPath()} 需要 ${count} 个位置参数 ${name}，实际收到 ${args.length} 个；用法：${cmd.useLine()}`);
  };
}

/** 可选位置参数。 */
export function maxArgs(count: number, name: string): PositionalArgs {
  return (cmd, args) => {
    if (args.length > count) throw new Error(`${cmd.commandPath()} 最多接受 ${count} 个位置参数 ${name}，实际收到 ${args.length} 个；用法：${cmd.useLine()}`);
  };
}

/** 位置参数个数在 min 到 max 之间。 */
export function rangeArgs(min: number, max: number, name: string): PositionalArgs {
  return (cmd, args) => {
    if (args.length < min || args.length > max) {
      throw new Error(`${cmd.commandPath()} 需要 ${min} 到 ${max} 个位置参数 ${name}，实际收到 ${args.length} 个；用法：${cmd.useLine()}`);
    }
  };
}

/** 不接受位置参数。 */
export const noArgs: PositionalArgs = (cmd, args) => {
  if (args.length > 0) throw new Error(`${cmd.commandPath()} 不接受位置参数，实际收到 ${args.length} 个：${args.join(' ')}；用法：${cmd.useLine()}`);
};

export function validateTolerance(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('--duration-tolerance 必须是有限且非负的数字');
}

export function rulesDisplay(path: string): string {
  return path === '' ? '（缺模板，未下发）' : path;
}

/**
 * 在终端里用一行回车刷新的进度显示 HyperFrames 技能与 CLI 的安装：克隆要一分钟上下，不显示的话像是卡住了。
 * 只在整数百分比或步骤变化时刷新。
 */
export function skillsProgressPrinter(w: Out): (p: { stage: string; percent: number; indeterminate?: boolean }) => void {
  let last = '';
  return (p) => {
    let line = `HyperFrames：${p.stage}`;
    if (!p.indeterminate) line += ` ${formatFixed(p.percent, 0).padStart(3)}%`;
    if (line === last) return;
    last = line;
    w.write(`\r\x1b[K${line}`);
    if (p.percent >= 100) w.write('\n');
  };
}
