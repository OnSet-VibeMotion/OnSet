/**
 * hyperframes：onset 管理的固定版本 HyperFrames CLI 的入口，参数原样转给它。
 */
import { spawn } from 'node:child_process';
import * as hyperframes from '@onset/engine/hyperframes';
import { currentEnvironment, hyperframesVersion } from './cli';
import { ExitError } from './cobra';
import { strs, str } from './ops/common';
import { defineOp, ParamError } from './ops/op';

defineOp({
  name: 'hyperframes',
  cli: ['hyperframes'],
  summary: '运行 onset 管理的固定版本 HyperFrames CLI',
  description:
    `用固定版本 ` +
    hyperframesVersion +
    ` 的 HyperFrames CLI 执行 subcommand 与 args，工作目录不变，退出码透传。

CLI 是前置资源，在客户端工具准备页装在用户级目录（默认 ~/.local/share/onset/hyperframes/cli-` +
    hyperframesVersion +
    `，
可用 ` +
    hyperframes.CLIDirEnv +
    ` 指定），所有项目共用。这里只用不装：没装好就报错，请用户在客户端工具准备页安装。

调用 HyperFrames 一律经这个工具，不要用 npx：npx 会在渲染途中现下载，网络不好时整次渲染白跑。
子命令自己的用法：hyperframes({"subcommand": "<子命令>", "args": ["--help"]})。`,
  examples: [
    'hyperframes({"subcommand": "lint"})',
    'hyperframes({"subcommand": "check", "args": ["--json"]})',
    'hyperframes({"subcommand": "snapshot", "args": ["--at", "1.5", "--describe", "false"]})',
    'hyperframes({"subcommand": "render"})',
  ],
  // subcommand 不设必填：命令行透传时全部原始参数都在 args 里，由 run 取第一个当子命令。
  params: {
    subcommand: { type: 'string', description: 'HyperFrames 子命令，例如 lint、check、render', positional: 0 },
    args: { type: 'strings', description: '子命令之后的参数，例如 ["--json"]、["--at", "1.5"]', positional: 'rest' },
  },
  scopes: ['orchestrator', 'renderer'],
  passthrough: true,
  run: (p, { out, err, signal }) => {
    let argv = strs(p.args);
    const sub = str(p.subcommand);
    if (sub !== '') argv = [sub, ...argv];
    if (argv.length === 0) throw new ParamError('hyperframes 要给 subcommand，例如 {"subcommand": "lint"}');
    const env = currentEnvironment();
    const dir = hyperframes.requireCLI(env);
    const spec = hyperframes.cliCommandFor(dir, env, argv);
    return new Promise<void>((resolve, reject) => {
      const child = spawn(spec.file, spec.args, { env: spec.env, stdio: ['inherit', 'pipe', 'pipe'], signal });
      child.stdout.on('data', (chunk) => out.write(String(chunk)));
      child.stderr.on('data', (chunk) => err.write(String(chunk)));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else if (code !== null) reject(new ExitError(code, `hyperframes 退出码 ${code}`));
        else reject(new Error('signal: killed'));
      });
    });
  },
});
