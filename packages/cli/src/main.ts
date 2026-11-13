/**
 * am 命令行入口。由应用自带的 Electron 以 ELECTRON_RUN_AS_NODE=1 运行（见客户端安装的 shim），
 * 开发时也可以直接 node packages/cli/dist/am.cjs。Ctrl-C 取消正在进行的命令，退出码 130。
 */
import { execute } from './cli';

// shim 用 ELECTRON_RUN_AS_NODE=1 把客户端自带的 Electron 当 Node 跑；这个变量不能漏给 am 启动的子进程
// （编排工具、渲染器、ffmpeg），它们之中若有 Electron 应用会被它改变行为。
delete process.env.ELECTRON_RUN_AS_NODE;

// 下游提前关了管道（`am film-style list | head`）时安静退出：Go 程序此时被 SIGPIPE 终止，shell 看到的退出码是 141；
// Node 默认把它当成未处理的 EPIPE 错误，打一大段堆栈。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(141);
    throw err;
  });
}

const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  // 第二次 Ctrl-C 直接退出，不等子进程收尾。
  if (interrupted) process.exit(130);
  interrupted = true;
  controller.abort();
});

execute(process.argv.slice(2), process.stdout, process.stderr, controller.signal).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(String((err as Error)?.stack ?? err) + '\n');
    process.exitCode = 1;
  },
);
