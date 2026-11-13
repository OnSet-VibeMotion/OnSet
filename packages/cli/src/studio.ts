/**
 * am studio：与 ArticleToMotion 客户端打交道的命令。移植自 internal/cli/studio.go。
 *
 * 浏览器版 Studio 已经去掉，客户端是唯一的界面；这里只留编排工具在客户端对话里调用的 show。
 */
import readline from 'node:readline';
import * as studioview from '@am/engine/studioview';
import { currentEnvironment, rangeArgs } from './cli';
import { Command, type Out, ref } from './cobra';
import { type Profile, serveToolsMCP } from './toolsmcp';

export function newStudioCommand(stdout: Out): Command {
  const cmd = new Command({
    use: 'studio',
    short: '与 ArticleToMotion 客户端打交道',
    long: `ArticleToMotion 客户端是制作视频的界面（浏览器版 Studio 已去掉）。

这里只有编排工具在客户端对话里使用的 show：把用户的界面切到要看的那一页。`,
  });
  cmd.addCommand(newStudioShowCommand(stdout));
  cmd.addCommand(newPermissionMCPCommand());
  cmd.addCommand(newToolsMCPCommand());
  return cmd;
}

function pageLabel(id: string): string {
  return studioview.viewPage(id)?.label ?? id;
}

/** 让客户端里的编排工具把界面切到某一页。 */
function newStudioShowCommand(stdout: Out): Command {
  const note = ref('');
  const pages = studioview.ViewPages.map((page) => {
    let line = '  ' + page.id + '  ' + page.label;
    if (page.target === 'scene') line += '，要给镜头编号';
    else if (page.target === 'scene?') line += '，可以给镜头编号';
    else if (page.target === 'file') line += '，要给项目里的相对路径';
    return line;
  });
  const cmd = new Command({
    use: 'show PAGE [TARGET]',
    args: rangeArgs(1, 2, 'PAGE [TARGET]'),
    short: '把 Studio 网页切到某一页（在 Studio 的对话里运行时有效）',
    long:
      `给 Studio 里的编排工具用：把用户的网页切到要用户看的那一页，例如口播稿写好请用户审、
某个镜头渲染完请用户看效果。--note 的一句话显示在对话里，说明为什么要看这一页。

不在 Studio 的对话里运行（例如终端里手动执行）时什么都不做，退出码为 0。

页面：
` + pages.join('\n'),
    example: `  am studio show script --note "口播稿写好了，请看一遍"
  am studio show scene scene-003
  am studio show file production/treatment.md`,
    runE: (_cmd, args) => {
      const req: studioview.ViewRequest = { page: args[0], note: note.value.trim() };
      if (args.length === 2) req.target = args[1];
      const inStudio = studioview.writeViewRequest(currentEnvironment(), req);
      if (!inStudio) {
        stdout.write('当前不在 Studio 的对话里，没有网页可切，已跳过。\n');
        return;
      }
      stdout.write('已请 Studio 网页切到「' + pageLabel(req.page) + '」。\n');
    },
  });
  cmd.flags().stringVar(note, 'note', '', '显示在对话里的一句说明');
  return cmd;
}

/**
 * 客户端给 claude 挂的权限审批服务（--permission-prompt-tool），claude 自己启动它，人不直接用。
 * 读写的是进程的 stdin / stdout（MCP 的 stdio 传输），所以不走 Out。
 */
function newPermissionMCPCommand(): Command {
  return new Command({
    use: 'permission-mcp',
    hidden: true,
    short: '客户端内部用：编排工具的权限审批服务（MCP，stdio）',
    long: `客户端给 claude 编排工具挂的权限审批服务，由 claude 按 --mcp-config 自己启动，人不直接运行。

claude 遇到白名单外的工具调用时调它的 ask 工具：请求写进这一轮收件目录（AM_STUDIO_INBOX）的
permissions/ 子目录，客户端在输入框上方弹卡片问用户，答复写回后这里把结果交还 claude。
不在客户端里（没有 AM_STUDIO_INBOX）时一律拒绝。stdin / stdout 是 MCP 的 JSON-RPC，每行一条。`,
    example: `  # 客户端写给 claude 的 --mcp-config 里就是这一条，由 claude 启动：
  am studio permission-mcp`,
    runE: async (cmd) => {
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      const inbox = currentEnvironment()[studioview.ViewInboxEnv] ?? '';
      await studioview.servePermissionMCP(rl, (line) => process.stdout.write(line), inbox, cmd.context());
    },
  });
}

/**
 * 客户端给编排工具与渲染器挂的 am 工具服务（MCP，stdio），由它们按 MCP 配置自己启动，人不直接用。
 * 应用里的 agent 只经它调用 am 的能力；am 不在它们的 PATH 里。
 */
function newToolsMCPCommand(): Command {
  const profile = ref('orchestrator');
  const workdir = ref('');
  const cmd = new Command({
    use: 'tools-mcp',
    hidden: true,
    short: '客户端内部用：am 的工具服务（MCP，stdio）',
    long: `把 am 的每条命令做成一个 MCP 工具，给客户端里的编排工具（--profile orchestrator，全部工具）与
镜头渲染器（--profile renderer，只有 hyperframes）用。每次调用起一个 am 子进程执行，最多等 wait_seconds，
没跑完返回任务号，用 job_wait 接着等。stdin / stdout 是 MCP 的 JSON-RPC，每行一条。`,
    example: `  # 客户端写进编排工具 MCP 配置里的就是这一条，由编排工具启动：
  am studio tools-mcp --profile orchestrator --workdir /path/to/project`,
    runE: async (c) => {
      if (profile.value !== 'orchestrator' && profile.value !== 'renderer') throw new Error(`--profile 只认 orchestrator 或 renderer，收到 ${profile.value}`);
      // 工作目录显式给：各家 agent 启动 MCP 服务时用哪个目录不一，相对路径（scenes/…）要对着项目或镜头目录解析。
      if (workdir.value !== '') process.chdir(workdir.value);
      const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      await serveToolsMCP(rl, (line) => process.stdout.write(line), profile.value as Profile, undefined, c.context());
    },
  });
  cmd.flags().stringVar(profile, 'profile', 'orchestrator', '工具档位：orchestrator（全部）或 renderer（只有 hyperframes）');
  cmd.flags().stringVar(workdir, 'workdir', '', '工具在哪个目录里执行（编排工具是项目根，渲染器是镜头目录）');
  return cmd;
}
