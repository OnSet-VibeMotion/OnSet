/**
 * am studio：与 ArticleToMotion 客户端打交道的命令。移植自 internal/cli/studio.go。
 *
 * 浏览器版 Studio 已经去掉，客户端是唯一的界面；这里只留编排工具在客户端对话里调用的 show。
 */
import readline from 'node:readline';
import * as studioview from '@am/engine/studioview';
import { currentEnvironment, rangeArgs } from './cli';
import { Command, type Out, ref } from './cobra';

export function newStudioCommand(stdout: Out): Command {
  const cmd = new Command({
    use: 'studio',
    short: '与 ArticleToMotion 客户端打交道',
    long: `ArticleToMotion 客户端是制作视频的界面（浏览器版 Studio 已去掉）。

这里只有编排工具在客户端对话里使用的 show：把用户的界面切到要看的那一页。`,
  });
  cmd.addCommand(newStudioShowCommand(stdout));
  cmd.addCommand(newPermissionMCPCommand());
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

不在 Studio 的对话里运行（例如 am run、终端里手动执行）时什么都不做，退出码为 0。

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
