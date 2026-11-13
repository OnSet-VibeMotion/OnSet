/**
 * am hyperframes：am 管理的固定版本 HyperFrames CLI 的入口，参数原样转给它。移植自 internal/cli/hyperframes_cmd.go。
 */
import { spawn } from 'node:child_process';
import * as hyperframes from '@am/engine/hyperframes';
import { currentEnvironment, hyperframesVersion } from './cli';
import { Command, ExitError, type Out } from './cobra';

export function newHyperframesCommand(stdout: Out, stderr: Out): Command {
  return new Command({
    use: 'hyperframes [ARGS...]',
    short: '运行 am 管理的固定版本 HyperFrames CLI',
    long:
      `用固定版本 ` +
      hyperframesVersion +
      ` 的 HyperFrames CLI 执行 ARGS，工作目录不变，退出码透传。

CLI 是前置资源，由 am setup 装在用户级目录（默认 ~/.local/share/am/hyperframes/cli-` +
      hyperframesVersion +
      `，
可用 ` +
      hyperframes.CLIDirEnv +
      ` 指定），所有项目共用。这里只用不装：没装好就报错，
提示先运行 am setup。

渲染器和编排工具调用 CLI 一律写成 am hyperframes <子命令>，不要用 npx：npx 会在
渲染途中现下载，网络不好时整次渲染白跑。`,
    example: `  am hyperframes lint
  am hyperframes check --json
  am hyperframes snapshot --at 1.5 --describe false
  am hyperframes render`,
    disableFlagParsing: true,
    runE: (cmd, args) => {
      const env = currentEnvironment();
      const dir = hyperframes.requireCLI(env);
      const spec = hyperframes.cliCommandFor(dir, env, args);
      return new Promise<void>((resolve, reject) => {
        const child = spawn(spec.file, spec.args, { env: spec.env, stdio: ['inherit', 'pipe', 'pipe'], signal: cmd.context() });
        child.stdout.on('data', (chunk) => stdout.write(String(chunk)));
        child.stderr.on('data', (chunk) => stderr.write(String(chunk)));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) resolve();
          else if (code !== null) reject(new ExitError(code, `hyperframes 退出码 ${code}`));
          else reject(new Error('signal: killed'));
        });
      });
    },
  });
}
