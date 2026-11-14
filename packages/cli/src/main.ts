/**
 * onset 命令行入口。由应用自带的 Electron 以 ELECTRON_RUN_AS_NODE=1 运行（见客户端安装的 shim），
 * 开发时也可以直接 node packages/cli/dist/onset.cjs。Ctrl-C 取消正在进行的命令，退出码 130。
 */
import { WorkerArg } from '@onset/engine/opworker';
import { execute } from './cli';
import { runOpWorker } from './ops/worker';

// shim 用 ELECTRON_RUN_AS_NODE=1 把客户端自带的 Electron 当 Node 跑；这个变量不能漏给 onset 启动的子进程
// （编排工具、渲染器、ffmpeg），它们之中若有 Electron 应用会被它改变行为。
delete process.env.ELECTRON_RUN_AS_NODE;

// 下游提前关了管道（`onset film-style list | head`）时安静退出：Go 程序此时被 SIGPIPE 终止，shell 看到的退出码是 141；
// Node 默认把它当成未处理的 EPIPE 错误，打一大段堆栈。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(141);
    throw err;
  });
}

const controller = new AbortController();
let interrupted = false;
// SIGTERM / SIGHUP 与 Ctrl-C 一样先取消、让操作收拾自己起的子进程（渲染器各成进程组，不收拾就留在后台）。
// 以前只认 SIGINT：客户端停掉一轮时整组发 SIGTERM，工具服务与执行进程按 Node 的缺省立刻退出，
// 已经起来的镜头渲染器没人管，用户在界面上怎么都停不掉（2026-11 实测）。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    // 第二次直接退出，不等子进程收尾。
    if (interrupted) process.exit(sig === 'SIGINT' ? 130 : 143);
    interrupted = true;
    controller.abort();
    // 被别的进程停掉（SIGTERM / SIGHUP）时给收尾留几秒，到点照样退出：有的命令不看取消信号（例如等 stdin 的 MCP 服务），
    // 不兜底的话进程永远挂着，调用方等它退出也跟着卡住（2026-11 实测审批服务）。渲染器的收尾只要半秒（先 SIGTERM，0.5 秒后 SIGKILL）。
    if (sig !== 'SIGINT') setTimeout(() => process.exit(143), 5000).unref();
  });
}

// 操作的执行进程：`onset.cjs [--unsafe] __op <名字> <参数 JSON>`，工具服务与客户端后端都起它跑一条操作（ops/worker.ts）。
const argv = process.argv.slice(2);
const unsafe = argv[0] === '--unsafe';
const rest = unsafe ? argv.slice(1) : argv;
// 执行进程的调用方（工具服务、客户端后端）没了——多半是被 SIGKILL，来不及停掉任务——就自己取消：
// 父进程变了说明已被过继给 init。不取消的话渲染这类几小时的操作会一直跑下去，界面上已经没有停的地方。
if (rest[0] === WorkerArg) {
  const parent = process.ppid;
  setInterval(() => {
    if (process.ppid !== parent && !controller.signal.aborted) controller.abort();
  }, 1000).unref();
}

const running = rest[0] === WorkerArg ? runOpWorker(rest[1] ?? '', rest[2] ?? '', process.stdout, controller.signal, unsafe) : execute(argv, process.stdout, process.stderr, controller.signal);

running.then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(String((err as Error)?.stack ?? err) + '\n');
    process.exitCode = 1;
  },
);
