/**
 * am run：按配置启动编排工具。移植自 internal/cli/cli.go 里内联定义的 runCmd。
 */
import path from 'node:path';
import * as agentrun from '@am/engine/agentrun';
import * as config from '@am/engine/config';
import * as envutil from '@am/engine/envutil';
import * as ledger from '@am/engine/ledger';
import * as project from '@am/engine/project';
import * as tools from '@am/engine/tools';
import { EventPrinter } from './agentprint';
import { addExecutableLocation, currentEnvironment, maxArgs, rulesDisplay } from './cli';
import { Command, ExitError, type Out, type Ref, ref } from './cobra';
import * as memory from '@am/engine/memory';
import { preferenceBrief } from './memory_cmd';
import { recordOrchestratorUsage } from './usage_cmd';

export function newRunCommand(stdout: Out, stderr: Out, unsafe: Ref<boolean>): Command {
  const workdir = ref('');
  const runCmd = new Command({
    use: 'run [PROMPT]',
    short: '按配置启动编排工具',
    long: `把 prompt 文件交给配置的编排工具执行，由它驱动整条制作流程。

PROMPT 省略时：项目根已有定稿 transcription.srt 就读 PROMPT.md；还没有时读
PROMPT-PRODUCTION.md，从文章、口播稿或参考字幕开始完整制作。也可以显式传入。
两者都是随 am init 下发的内置 prompt，可按项目改写。找不到该文件时失败。

启动前会做三件事：
  1. 按 ORCHESTRATOR 解析出该工具会自动读取的项目级指令文件名
     （codex/qoder/opencode 读 AGENTS.md，claude 读 CLAUDE.md，codebuddy 读 CODEBUDDY.md），
     再从 templates/project-rules.md 派生并写到项目根。模板缺失时只打印警告继续，
     本次不下发项目规则；目标文件已存在且内容不同时失败，不覆盖。
  2. 把当前 am 可执行文件所在目录放到子进程 PATH 首位，并注入绝对路径为 AM_EXECUTABLE，
     因此 prompt 里的 am scene ... 会用回启动本次流程的同一个 CLI，无需把二进制拷进项目。
  3. 安全模式下按白名单构造子进程环境；额外变量用 AM_PASSTHROUGH_ENV 列出。

启动后先打印一段以 --- 结尾的头部（编排工具、渲染工具、Prompt 路径、项目规则路径），
其后是编排工具的输出：它的结构化事件流被整理成可读文字——正文原样打印，每次工具
调用一行摘要，失败的工具结果与用量单独标出，开头打印会话 id。编排工具失败时透传它的退出码。

安全模式下编排工具只被放行文件编辑和一组命令：am、ffmpeg、ffprobe、ls、mkdir、
固定版本的 hyperframes，以及 TTS_PROVIDER 与 ALIGN_PROVIDER 各自的那一个命令；
安装命令不在其中，要先自己装好。codex 改由沙箱限制写入范围（放开网络），
opencode 没有可用的白名单机制，安全模式下仍能执行任何命令。`,
    example: `  # 有定稿 transcription.srt 时读 PROMPT.md，否则从文章开始完整制作
  am run

  # 显式指定从文章或口播稿开始完整制作
  am run PROMPT-PRODUCTION.md

  # 只有确认项目与输入可信时才关闭权限隔离
  am --unsafe run

  # 安全模式下额外透传两个环境变量
  AM_PASSTHROUGH_ENV=HTTPS_PROXY,NO_PROXY am run`,
    args: maxArgs(1, 'PROMPT'),
    runE: async (cmd, args) => {
      const rootDir = process.cwd();
      const cfg = config.load(rootDir, null);
      if (workdir.value === '') workdir.value = rootDir;
      workdir.value = path.resolve(workdir.value);
      const override = args.length === 1 ? args[0] : '';
      const { prompt: promptBytes, path: promptPath } = project.runPrompt(rootDir, override);
      let prompt = promptBytes.toString('utf8');
      if (cfg.memory.enabled) {
        // 先建好记忆库：codex 沙箱只能把已存在的目录加进可写范围。
        try {
          memory.open(cfg.memory.dir);
        } catch (err) {
          stderr.write(`警告：无法建立记忆库，本次渲染的经历可能写不进去：${(err as Error).message}\n`);
        }
      }
      const brief = preferenceBrief(cfg, rootDir, stderr);
      if (brief !== '') prompt = prompt + '\n\n' + brief;
      const rulesName = tools.projectRulesFilename(cfg.orchestrator);
      const rulesPath = project.writeRules(rootDir, rulesName);
      const isUnsafe = envutil.isUnsafe(unsafe.value);
      const childEnvironment = config.childEnvironment(cfg, currentEnvironment(), isUnsafe, envutil.parsePassthrough(process.env.AM_PASSTHROUGH_ENV ?? ''));
      addExecutableLocation(childEnvironment, stderr);
      if (rulesPath === '') stderr.write(`警告：项目缺少 ${project.RulesTemplate}，本次不下发项目规则；可运行 am init 补齐\n`);
      stdout.write(`编排工具: ${cfg.orchestrator}\n渲染工具: ${cfg.renderer}\nPrompt: ${promptPath}\n项目规则: ${rulesDisplay(rulesPath)}\n---\n`);
      const printer = new EventPrinter(stdout, stderr);
      const signal = cmd.context();
      const { result, error } = await agentrun.run(
        {
          tool: cfg.orchestrator,
          workdir: workdir.value,
          prompt,
          unsafe: isUnsafe,
          sessionID: agentrun.newSessionID(cfg.orchestrator),
          access: config.orchestratorAccess(cfg),
          env: childEnvironment,
          lookPath: (name) => envutil.lookPath(name, childEnvironment.PATH ?? ''),
        },
        (event) => printer.print(event),
        signal,
      );
      if (result.started) recordOrchestratorUsage(signal, ledger.projectFile(rootDir), ledger.SourceRun, cfg.orchestrator, childEnvironment, result, error, stderr);
      if (error) {
        if (error instanceof agentrun.ExitError) throw new ExitError(error.code, '编排工具执行失败');
        throw error;
      }
    },
  });
  runCmd.flags().stringVar(workdir, 'workdir', '', '编排工具的工作目录，缺省为当前项目根');
  return runCmd;
}
