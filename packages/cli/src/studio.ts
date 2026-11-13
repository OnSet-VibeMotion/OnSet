/**
 * am studio：与 ArticleToMotion 客户端打交道的命令。移植自 internal/cli/studio.go。
 *
 * 浏览器版 Studio 已经去掉，客户端是唯一的界面；这里只留编排工具在客户端对话里调用的 show。
 */
import readline from 'node:readline';
import * as studioview from '@am/engine/studioview';
import { currentEnvironment } from './cli';
import { Command, type Out, ref } from './cobra';
import { str } from './ops/common';
import { defineOp } from './ops/op';
import { type Profile, serveToolsMCP } from './toolsmcp';

export function newStudioCommand(_stdout?: Out): Command {
  const cmd = new Command({
    use: 'studio',
    short: '与 ArticleToMotion 客户端打交道',
    long: `ArticleToMotion 客户端是制作视频的界面（浏览器版 Studio 已去掉）。

这里有编排工具在客户端对话里使用的 show（把用户的界面切到要看的那一页），以及客户端内部用的两个 MCP 服务。`,
  });
  cmd.addCommand(newPermissionMCPCommand());
  cmd.addCommand(newToolsMCPCommand());
  return cmd;
}

function pageLabel(id: string): string {
  return studioview.viewPage(id)?.label ?? id;
}

const pageLines = studioview.ViewPages.map((page) => {
  let line = '  ' + page.id + '  ' + page.label;
  if (page.target === 'scene') line += '，要给镜头编号';
  else if (page.target === 'scene?') line += '，可以给镜头编号';
  else if (page.target === 'file') line += '，要给项目里的相对路径';
  return line;
});

/** 让客户端里的编排工具把界面切到某一页。 */
defineOp({
  name: 'studio_show',
  cli: ['studio', 'show'],
  summary: '把客户端界面切到某一页（在客户端的对话里调用时有效）',
  description:
    `把用户的界面切到要用户看的那一页，例如口播稿写好请用户审、某个镜头渲染完请用户看效果。
note 的一句话显示在对话里，说明为什么要看这一页。

不在客户端的对话里调用时什么都不做，也不算失败。

页面：
` + pageLines.join('\n'),
  examples: [
    'studio_show({"page": "script", "note": "口播稿写好了，请看一遍"})',
    'studio_show({"page": "scene", "target": "scene-003"})',
    'studio_show({"page": "file", "target": "production/review/contact-sheet.png"})',
  ],
  params: {
    page: { type: 'string', description: '页面', required: true, positional: 0 },
    target: { type: 'string', description: '对象：镜头编号或项目里的相对路径', positional: 1 },
    note: { type: 'string', description: '显示在对话里的一句说明' },
  },
  run: (p, { out }) => {
    const req: studioview.ViewRequest = { page: str(p.page), note: str(p.note).trim() };
    if (str(p.target) !== '') req.target = str(p.target);
    const env = currentEnvironment();
    const inStudio = studioview.writeViewRequest(env, req);
    if (!inStudio) {
      out.write('当前不在客户端的对话里，没有界面可切，已跳过。\n');
      return { data: { shown: false } };
    }
    // 有专门页面的文件会改切到那一页（例如口播稿、成片），照实告诉调用方。
    const shown = studioview.validateViewRequest(env[studioview.ViewProjectEnv] ?? '', req);
    out.write('已请客户端界面切到「' + pageLabel(shown.page) + '」' + (shown.target ? '（' + shown.target + '）' : '') + '。\n');
    return { data: { shown: true, page: shown.page, target: shown.target ?? '' } };
  },
});

const stepLabels: Record<string, string> = { beat: '节拍', script: '口播稿', storyboard: '分镜', scene: '镜头', final: '成片', publish: '发布' };

/** 让客户端里的编排工具标出整片制作现在到了哪一步。 */
defineOp({
  name: 'studio_step',
  cli: ['studio', 'step'],
  summary: '在客户端顶栏标出整片制作现在处在哪一步（每一轮结束前调用）',
  description: `每一轮结束前（汇报、停下来等用户之前）调用，标出整片制作现在处在哪一步，客户端顶栏的那一步会标成「进行中」。
只做标记，不切页；要用户看某一页用 studio_show。

不在客户端的对话里调用时什么都不做，也不算失败。

步骤：
  script      口播稿：整理稿子、审稿、配音、对齐
  storyboard  分镜：处理方案、分镜计划、每个镜头的画面描述、等用户确认分镜
  scene       镜头：渲染与修改镜头
  final       成片：拼接、配乐混音、复查、试听
  publish     发布：平台封面与发布信息
  beat        节拍（只有卡点项目）：故事、音乐、节拍网格、分镜计划`,
  examples: ['studio_step({"step": "storyboard"})', 'studio_step({"step": "final", "note": "成片拼好了，等你试听"})'],
  params: {
    step: { type: 'string', description: '步骤：script、storyboard、scene、final、publish 或 beat', required: true, positional: 0 },
    note: { type: 'string', description: '显示在对话里的一句说明' },
  },
  run: (p, { out }) => {
    const req: studioview.ViewRequest = { page: '', step: str(p.step).trim(), note: str(p.note).trim() };
    const inStudio = studioview.writeViewRequest(currentEnvironment(), req);
    if (!inStudio) {
      out.write('当前不在客户端的对话里，没有界面可标，已跳过。\n');
      return { data: { marked: false } };
    }
    out.write('已在客户端顶栏标出：现在在「' + (stepLabels[req.step!] ?? req.step) + '」这一步。\n');
    return { data: { marked: true, step: req.step } };
  },
});

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
