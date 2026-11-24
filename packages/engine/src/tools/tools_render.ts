import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type Request as DirectorRequest,
  defaultDir as directorDir,
  resolveService as directorService,
  NoServiceMessage,
  rendererDir,
} from '../director';
import { onsetCommand } from '../envutil';
import { marshal } from '../gojson';
import {
  type AgentOptions,
  claudeOptionSettings,
  codexOptionOverrides,
  DefaultDirectorRendererCompactAt,
  effectiveOptions,
  opencodeModel,
  optionArgs,
  stageOptions,
} from './options';
import { DirectorTool, type Invocation, modelArgs, presetSessionID, qoderBinary } from './tools_catalog';
import {
  agySettings,
  claudeSettings,
  codexMcpOverrides,
  longWaitServer,
  mcpConfigJSON,
  opencodeMcpConfig,
  parseConfig,
  qoderEagerSettings,
  qoderRendererSources,
  type RendererAccess,
  rendererToolLimits,
  ToolsServerName,
} from './tools_mcp';
import { windowsPromptInput } from './windows';

/**
 * 渲染器的会话：id 为空时不指定；resume 为真时续接 id 那个会话（渲染中途异常退出后接着做，scene/resume.ts）。
 * 新会话预先指定 id 只有 claude、qoder、codebuddy 支持（presetSessionID），codex、opencode 的会话号从输出流读。
 * 各家的写法与编排工具相同（orchestratorInvocation）。
 */
export interface RendererSession {
  id: string;
  resume: boolean;
}

export function rendererInvocation(
  tool: string,
  prompt: string,
  unsafe: boolean,
  access: RendererAccess,
  model = '',
  session: RendererSession | null = null,
  options: AgentOptions = {},
  stage: 'full' | 'repair' | 'simple' = 'full',
): string[] {
  const server =
    tool === 'claude' || tool === 'codex'
      ? longWaitServer(access.toolsServer)
      : tool === 'agy'
        ? longWaitServer(access.toolsServer, 600)
        : access.toolsServer;
  const effective = stageOptions(effectiveOptions(tool, options), stage);
  // 调用选项（推理强度、快速模式、上下文长度，见 options.ts）跟着模型参数一起放。
  const m = [
    ...modelArgs(tool, tool === 'opencode' ? opencodeModel(model, effective, stage) : model),
    ...(tool === 'codex' ? codexOptionOverrides(effective) : optionArgs(tool, effective)),
  ];
  const claudeExtra = tool === 'claude' ? claudeOptionSettings(effective) : {};
  if (session && session.id === '') session = null;
  if (session && !session.resume && !presetSessionID(tool)) throw new Error(`${tool} 不支持预先指定会话 id`);
  /** claude 系：新会话 --session-id，续接 --resume。 */
  const claudeSession = session ? (session.resume ? ['--resume', session.id] : ['--session-id', session.id]) : [];
  switch (tool) {
    case 'codex': {
      const mcp = server ? codexMcpOverrides(server) : [];
      // Windows Codex 的 MCP 审批独立于 shell 策略。只逐项授权内置渲染工具，
      // 会话续接与上游的 unfiltered 模式继续使用同一组 MCP 配置。
      if (
        process.platform === 'win32' &&
        server?.name === ToolsServerName &&
        server.args.includes('tools-mcp') &&
        server.args[server.args.indexOf('--profile') + 1] === 'renderer'
      ) {
        for (const tool of ['hyperframes', 'scene_preview_check', 'job_wait', 'job_cancel', 'tool_help']) {
          mcp.push('-c', `mcp_servers.${server.name}.tools.${tool}.approval_mode="approve"`);
        }
      }
      const resume = session?.resume ? ['resume', session.id] : [];
      // 不拦命令时也不套 codex 自己的沙箱：macOS 上它也是 sandbox-exec，套在外面那层沙箱里起不来；Windows 上用户定的是全放开。
      if (unsafe || access.unfiltered) {
        return [
          'codex',
          'exec',
          '--skip-git-repo-check',
          '--dangerously-bypass-approvals-and-sandbox',
          ...mcp,
          ...m,
          '--json',
          ...resume,
          prompt,
        ];
      }
      return [
        'codex',
        '--ask-for-approval',
        'never',
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
        ...mcp,
        ...m,
        '--json',
        ...resume,
        prompt,
      ];
    }
    case 'claude': {
      let mode = [
        '--dangerously-skip-permissions',
        ...(Object.keys(claudeExtra).length > 0 ? ['--settings', marshal(claudeExtra)] : []),
      ];
      if (!unsafe && !access.unfiltered) {
        mode = [
          '--permission-mode',
          'acceptEdits',
          '--settings',
          claudeSettings({ ...access, mcp: server ? [server.name] : [] }, claudeExtra),
        ];
      }
      // --mcp-config 与 --tools 都吃多个值，后面必须紧跟一个选项（这里是 --mcp-config / --verbose），不然会把提示词吞掉。
      const mcp = server ? ['--mcp-config', mcpConfigJSON([server])] : [];
      return [
        'claude',
        '-p',
        ...mode,
        ...m,
        ...rendererToolLimits,
        ...mcp,
        '--verbose',
        '--output-format',
        'stream-json',
        '--prompt-suggestions',
        'false',
        ...claudeSession,
        prompt,
      ];
    }
    case 'qoder':
    case 'qoder-intl': {
      const qoderSession = session ? (session.resume ? ['-r', session.id] : ['--session-id', session.id]) : [];
      // 与 claude 同一套放行规则（qoder 的 --settings 认 claude 的 permissions 写法），外加关掉懒加载 MCP。
      // 以前用 dont_ask：它连镜头目录里写文件都拒、技能目录读不了、ls 都跑不了，渲染器一个 index.html 都写不出来（2026-11 实测）。
      // 系统沙箱按目录管住了读写（或 Windows 上全放开），渲染器里不再按命令白名单拦（拦了也没人能批准，只会白耗几轮）。
      if (unsafe || access.unfiltered) {
        const mcp = server ? ['--mcp-config', mcpConfigJSON([server])] : [];
        return [
          qoderBinary(tool),
          '-p',
          prompt,
          ...qoderSession,
          '--dangerously-skip-permissions',
          ...m,
          ...qoderRendererSources,
          ...rendererToolLimits,
          '--settings',
          JSON.stringify(qoderEagerSettings),
          ...mcp,
          '--output-format',
          'stream-json',
        ];
      }
      const settings = {
        ...(JSON.parse(claudeSettings({ ...access, mcp: server ? [server.name] : [] })) as Record<string, unknown>),
        ...qoderEagerSettings,
      };
      const mcp = server ? ['--mcp-config', mcpConfigJSON([server]), '--allowed-tools', 'mcp__' + server.name] : [];
      return [
        qoderBinary(tool),
        '-p',
        prompt,
        ...qoderSession,
        '--permission-mode',
        'accept_edits',
        ...m,
        ...qoderRendererSources,
        ...rendererToolLimits,
        '--settings',
        JSON.stringify(settings),
        ...mcp,
        '--output-format',
        'stream-json',
      ];
    }
    case 'codebuddy': {
      let mode = ['--permission-mode', 'acceptEdits'];
      if (!unsafe && server) {
        mode.push(
          '--settings',
          claudeSettings({ ...access, commands: [], readDirs: access.readDirs, mcp: [server.name] }),
        );
      }
      if (unsafe || access.unfiltered) mode = ['-y'];
      const mcp = server ? ['--mcp-config', mcpConfigJSON([server])] : [];
      return [
        'codebuddy',
        '-p',
        ...m,
        '--strict-mcp-config',
        ...mcp,
        '--verbose',
        '--output-format',
        'stream-json',
        ...mode,
        ...claudeSession,
        prompt,
      ];
    }
    case 'opencode': {
      // --standalone：opencode run 默认连到后台常驻的服务，配置（包括 OPENCODE_CONFIG_CONTENT 里的 MCP 与模型）
      // 取的是那个服务启动时的，这一次给的全被忽略（2.1.0 实测）。私有服务才读这一次的环境。
      const args = ['opencode', 'run', '--standalone', ...m];
      if (unsafe) args.push('--auto');
      if (session?.resume) args.push('-s', session.id);
      return [...args, '--format', 'json', prompt];
    }
    case 'mcode': {
      // 工作目录由 scene.run 设成镜头目录，--cwd 再写一遍：mcode 按它定工作区（技能、.mcp.json 都从这里找）。
      // exec 只有三档权限（smart / full / off），没有命令白名单：套了系统沙箱或 Windows 全放开时 full，否则 smart
      // （自动批准它认为安全的，要批准的在 exec 里没人能答，直接拒绝）。工具服务经镜头目录里的 .mcp.json 给（mcodeMcpJSON）。
      const mode = unsafe || access.unfiltered ? 'full' : 'smart';
      const resume = session?.resume ? ['--session', session.id] : [];
      return [
        'mcode',
        'exec',
        '--cwd',
        '.',
        '--permission',
        mode,
        ...m,
        ...resume,
        '--output-format',
        'stream-json',
        prompt,
      ];
    }
    case 'agy': {
      // Antigravity CLI（agy）headless 模式：套了系统沙箱或 Windows 全放开时 --dangerously-skip-permissions，
      // 其余平台用 accept-edits 加 --settings 放行白名单与 MCP 工具；工具服务经镜头目录的 .agents/mcp_config.json 给（stageAgyMcp）。
      const mode =
        unsafe || access.unfiltered
          ? ['--dangerously-skip-permissions']
          : ['--mode', 'accept-edits', '--settings', agySettings({ ...access, mcp: server ? [server.name] : [] })];
      const resume = session?.resume ? ['--conversation', session.id] : [];
      return ['agy', '-p', prompt, ...mode, ...m, ...resume, '--output-format', 'stream-json'];
    }
    case 'director':
      return directorCommand().argv;
    default:
      throw new Error(`未知工具：${tool}`);
  }
}

function directorCommand(): Invocation {
  const onset = onsetCommand();
  return { argv: [onset.command, ...onset.args, 'studio', 'agent'], stdin: '', env: onset.env };
}

export function resolveDirectorCompactAt(value: string | undefined, fallback: number): number | undefined {
  if (value === 'off') return undefined;
  if (value) return Number(value);
  return fallback;
}

function rendererCacheKey(workdir: string): string {
  // 同项目的镜头共用同一个缓存路由键，避免每个镜头随机 UUID 把 OpenAI/兼容服务的前缀缓存打散到不同节点。
  let dir = path.resolve(workdir);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'onset.conf'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 16);
  return `onset-render-${hash}`;
}

/** 渲染的完整调用；自带制作人的提示词、模型和密钥只经 stdin，外部工具沿用各自的命令行。 */
export function rendererLaunch(
  tool: string,
  prompt: string,
  unsafe: boolean,
  access: RendererAccess,
  model: string,
  session: RendererSession | null,
  workdir: string,
  env: Record<string, string | undefined>,
  options: AgentOptions = {},
  stage: 'full' | 'repair' | 'simple' = 'full',
): Invocation {
  if (tool !== DirectorTool) {
    return windowsPromptInput(
      tool,
      rendererInvocation(tool, prompt, unsafe, access, model, session, options, stage),
      prompt,
    );
  }
  const agentDir = directorDir({ ...process.env, ...env });
  const service = directorService(agentDir);
  if (!service) throw new Error(NoServiceMessage);
  const settings = stageOptions(effectiveOptions(DirectorTool, options), stage);
  const request: DirectorRequest = {
    profile: 'renderer',
    workdir,
    prompt,
    agent_dir: rendererDir(agentDir),
    service,
    model: model || undefined,
    thinking: settings.effort,
    compact_at: resolveDirectorCompactAt(settings.compact_at, DefaultDirectorRendererCompactAt),
    cache_key: rendererCacheKey(workdir),
    session_id: session?.id,
    resume: session?.resume || undefined,
    unsafe: unsafe || access.unfiltered || undefined,
    commands: access.commands,
    read_dirs: access.readDirs,
  };
  return { ...directorCommand(), stdin: JSON.stringify(request) + '\n' };
}

/** opencode 渲染器的工具服务经环境变量 OPENCODE_CONFIG_CONTENT 给（opencode run 没有 MCP 参数），合并用户自己的这个变量。 */
export function rendererEnv(
  tool: string,
  access: RendererAccess,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (tool !== 'opencode' || (!access.toolsServer && !access.skills)) return {};
  const own = parseConfig(env.OPENCODE_CONFIG_CONTENT);
  const config: Record<string, unknown> = { ...own };
  if (access.toolsServer) {
    const mcp = own.mcp && typeof own.mcp === 'object' ? (own.mcp as Record<string, unknown>) : {};
    config.mcp = { ...mcp, ...opencodeMcpConfig(access.toolsServer) };
  }
  // 只放行镜头的技能：opencode 按 permission.skill 过滤技能列表（2026-11 实测，项目根与用户级的都不再出现）。
  if (access.skills) {
    const permission =
      own.permission && typeof own.permission === 'object' ? (own.permission as Record<string, unknown>) : {};
    config.permission = {
      ...permission,
      skill: { '*': 'deny', ...Object.fromEntries(access.skills.map((name) => [name, 'allow'])) },
    };
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}
