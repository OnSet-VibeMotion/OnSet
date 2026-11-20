import fs from 'node:fs';
import path from 'node:path';
import { windowsPromptInput, windowsOrchestratorEffort } from './windows';
import { claudeOptionSettings, codexOptionOverrides, effectiveOptions, opencodeModel, optionArgs, type AgentOptions } from './options';
import { marshal, marshalIndent } from '../gojson';
import { defaultDir as directorDir, resolveService as directorService, rendererDir, NoServiceMessage, Tool as DirectorToolName, type Request as DirectorRequest } from '../director';
import { onsetCommand, WindowsBaseEnvKeys } from '../envutil';
import { pluginChildEnvs } from '../plugin/registry';

export const UserMessageMarker = '[[USER_MESSAGE]]';

/**
 * 所有合法的 AI CLI 工具名集合。
 * config、scene 等包共用此集合，新增工具时只需改这一处（加上
 * rendererInvocation、orchestratorInvocation、projectRulesFilename 的 switch）。
 * Go 里是 map[string]bool，这里用 Set：普通对象会让 "constructor" 之类的键查出真值。
 */
export const ValidTools: ReadonlySet<string> = new Set(['codex', 'claude', 'qoder', 'qoder-intl', 'codebuddy', 'opencode', 'mcode', 'director']);

/**
 * 能当渲染工具的工具；RENDERER、scene.json 的 renderer、记忆的 applies_when.renderers 按这张表校验。
 */
export const ValidRenderers: ReadonlySet<string> = new Set(['codex', 'claude', 'qoder', 'qoder-intl', 'codebuddy', 'opencode', 'mcode', 'director']);

/**
 * Qoder 有两个版本，账号与服务互不相通：国内版 `qoder`（命令 qoderclicn，状态在 ~/.qoder-cn）与国际版
 * `qoder-intl`（命令 qodercli，状态在 ~/.qoder）。两者的参数、输出流、会话与设置写法逐项相同（1.1.89 实测
 * --help 只差国内版多一个 config 子命令），所以除了命令名一律按同一家处理。
 */
export function isQoder(tool: string): boolean {
  return tool === 'qoder' || tool === 'qoder-intl';
}

/** Qoder 两个版本各自的命令名。 */
export function qoderBinary(tool: string): string {
  return tool === 'qoder-intl' ? 'qodercli' : 'qoderclicn';
}

/** 制作人的工具名（director.Tool）。 */
export const DirectorTool = DirectorToolName;

/** 按 claude 系 stream-json 解析的工具：制作人照这个格式输出，见 director。 */
export function claudeLikeStream(tool: string): boolean {
  return tool === 'claude' || isQoder(tool) || tool === 'codebuddy' || tool === DirectorTool;
}

/**
 * 安全模式下渲染器需要、而默认权限模式不给的最小权限。
 *
 * 只有需要显式放行的工具才用得上：claude 的 acceptEdits 只自动批准文件编辑，
 * Bash 一律拦下，而 -p 模式下没有人来批准——实测渲染器因此跑不了
 * `npx hyperframes render` / `snapshot`，镜头直接渲染失败。
 */
export interface RendererAccess {
  /** 放行的命令前缀，例如 "ls"。 */
  commands?: string[];
  /** 镜头目录之外需要读取的目录（技能树），绝对路径。 */
  readDirs?: string[];
  /** onset 的工具服务（--profile renderer）：渲染器只经它调用 HyperFrames，不在 Bash 里跑 onset。 */
  toolsServer?: McpServer;
  /**
   * 渲染器套在系统沙箱里（scene/sandbox.ts，macOS 上五家都套）：边界由沙箱按目录管，渲染器自己不再按命令白名单拦，
   * python3、sips、组合命令都能跑。
   */
  osSandbox?: boolean;
  /**
   * 渲染器自己不按命令白名单拦：套了系统沙箱时（边界由沙箱管），以及 Windows 上（没有系统沙箱，
   * 用户定的是全放开、先不要安全，2026-11）。拦了渲染途中也没人能批准，只是白耗几轮。
   */
  unfiltered?: boolean;
  /**
   * 镜头要用的技能（已链进镜头目录，scene.stageRendererSkills）的名字。opencode 会从镜头目录往上一直找到项目根的
   * .agents/skills，用 permission.skill 只放行这几个（rendererEnv）；其余几家按目录找，链在哪看见哪。
   */
  skills?: string[];
}

/**
 * 一个 stdio MCP 服务。客户端里的编排工具与渲染器经 onset 的工具服务（onset studio tools-mcp）调用 onset 的能力，
 * onset 不在它们的 PATH 里：以前它们会 which onset、strings onset 反推格式，每次都撞白名单打断用户。
 */
export interface McpServer {
  /** 配置里的服务名；claude 系的工具全名是 mcp__<名字>__<工具>。 */
  name: string;
  command: string;
  args: string[];
  /** 服务要的环境变量（onset 的设置、收件目录等）。各家把多少环境传给 MCP 服务不一，显式给最稳。 */
  env?: Record<string, string>;
}

/** 工具服务一次调用最多能等多久（秒），由起它的一方按客户端的超时定（toolsmcp 读它，缺省 600）。 */
export const ToolsMaxWaitEnv = 'ONSET_TOOLS_MAX_WAIT';

/**
 * 给能长时间等一次工具调用的客户端（claude、codex）放宽的等待上限：50 分钟。
 *
 * 渲染、整批渲染要几十分钟到几小时，编排会要求等 2400–3600 秒；上限一直是 600 秒（按 codex 默认 60 秒的 MCP 超时
 * 留余量定的），于是每 10 分钟醒来调一次 job_wait，每次都把四五十万 token 的上下文读一遍（2026-11：4 个项目里
 * 等待类调用 40 次，占编排读入的 7%，平均上下文 45 万）。claude 的 MCP 工具超时缺省约 27 小时、codex 认
 * mcp_servers.<名字>.tool_timeout_sec，两家都在配置里显式写上超时（longWaitTimeoutSeconds）。
 * 取 50 分钟不取 60：编排的缓存是 1 小时（longSessionEnv），等满一小时醒来缓存刚好过期。
 * qoder、codebuddy、opencode、mcode 的工具超时没有核实，照旧 600 秒。
 */
export const LongToolWaitSeconds = 3000;

/** 客户端那边的超时比工具服务的等待上限多留两分钟：工具服务等满后还要收拾、回话。 */
function longWaitTimeoutSeconds(server: McpServer): number {
  const wait = Number(server.env?.[ToolsMaxWaitEnv] ?? '');
  return Number.isFinite(wait) && wait > 0 ? wait + 120 : 0;
}

/** 工具服务给能长时间等的客户端：环境里写上放宽的等待上限。不是 onset 的工具服务原样返回。 */
export function longWaitServer(server: McpServer | undefined): McpServer | undefined {
  if (!server || server.name !== ToolsServerName) return server;
  return { ...server, env: { ...(server.env ?? {}), [ToolsMaxWaitEnv]: String(LongToolWaitSeconds) } };
}

/** onset 工具服务在配置里的名字。 */
export const ToolsServerName = 'onset';

/**
 * onset 的工具服务：executable 是 onset 的启动脚本（客户端的私有 shim，或终端里的 onset），workdir 是工具执行的目录。
 * env 只挑 onset 自己要的变量：整个子进程环境写进 MCP 配置会出现在命令行里，不安全模式下里面还有凭据。
 */
export function onsetToolsServer(executable: string, profile: 'orchestrator' | 'renderer', workdir: string, env: Record<string, string | undefined> = {}): McpServer {
  const picked: Record<string, string> = {};
  // 内置插件登记的子进程变量（plugin.PluginChildEnv）同样放行。
  const pluginKeys = new Set(pluginChildEnvs().map((e) => e.value.key));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^(ONSET_|HYPERFRAMES_|MEMORY|ORCHESTRATOR$|RENDERER$|ORCHESTRATOR_MODEL$|RENDERER_MODEL$|ORCHESTRATOR_OPTIONS$|RENDERER_OPTIONS$|TTS_|ALIGN_|SCENE_JOBS$|PATH$|HOME$|USER$|LANG$|TMPDIR$|XDG_DATA_HOME$)/.test(key) || WindowsBaseEnvKeys.includes(key) || pluginKeys.has(key) || process.platform === 'win32' && ['PRODUCER_EXPERIMENTAL_FAST_CAPTURE', 'DO_NOT_TRACK'].includes(key)) picked[key] = value;
  }
  // Windows 上 executable 是 onset.cjs，要用 Electron / Node 来跑（envutil.onsetCommand）。
  const onset = onsetCommand(executable);
  return { name: ToolsServerName, command: onset.command, args: [...onset.args, 'studio', 'tools-mcp', '--profile', profile, '--workdir', workdir], env: { ...picked, ...onset.env } };
}

/**
 * qoder 1.1.87 起缺省「懒加载」MCP：工具不进工具表，只能经 mcp_list / mcp_get / mcp_call 调。
 * 于是 --permission-prompt-tool 按名字找不到审批工具，白名单外的命令一律直接拒绝、不问用户
 * （报「Permission prompt tool "mcp__onset_studio__ask" was not found」，2026-11 实测）。
 * 只要有一处设置写了 mcp.lazyLoad 它就照设置来，所以经 --settings 关掉。
 */
const qoderEagerSettings = { mcp: { lazyLoad: false } };

/**
 * 制作端的 accept_edits 会自动批准镜头源码改写；用文件工具的 deny 再守一层角色边界。
 * 只限制实现代码，不拦 prompt.md / scene.json 或素材准备。Bash/脚本不是文件工具，
 * 不能把这当成系统沙箱；每轮的 scene-ownership 说明同时约束复制、同步和脚本写入。
 * 渲染器使用自己的设置，不能继承这些禁令。
 */
function qoderOrchestratorSettings(workdir: string): string {
  const deny: string[] = [];
  const root = path.resolve(workdir || '.').replaceAll('\\', '/');
  for (const dir of ['scenes', 'production/shared']) {
    for (const ext of ['html', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx']) {
      // Qoder 的文件写规则统一用 Edit（也覆盖 Write）；// 开头表示绝对路径。
      deny.push(`Edit(/${root}/${dir}/**/*.${ext})`);
    }
  }
  return marshal({ ...qoderEagerSettings, permissions: { deny } });
}

/**
 * qoder 渲染器不读用户级设置：用户级技能目录里有几十个与渲染无关的技能（飞书、百炼……，实测 74 个），
 * 其中还有旧版的 hyperframes，会与项目钉死的版本混在一起；用户级的钩子也不该在渲染里跑。
 * 镜头要用的技能由 scene.run 链进镜头目录的 .qoder/skills（stageRendererSkills），qoder 的 Skill 工具照常可用。
 * 模型不受影响：onset 的渲染模型设置经 -m 传。
 */
const qoderRendererSources = ['--setting-sources', 'project,local'];

/**
 * 渲染器只给这几样内置工具，只挂 onset 的工具服务（2026-11 实测，claude 2.1.325 用 haiku 跑一次空任务）：
 * 不限的话 claude 带着 117 个工具（Cron、Workflow、RemoteTrigger、用户自己装的 chrome-devtools、open-design、
 * claude.ai 的连接器……），第一次调用 47.6K token；限了之后 11 个、24.1K。渲染器每一步都要把这些定义重读一遍，
 * 一个镜头二三十步。onset 的工具也从「先 ToolSearch 再调」变成直接可调。
 * 默认工具集里本来就没有 Glob、Grep（渲染器一直用 Bash 搜），这里也不加。
 * codebuddy 只加 --strict-mcp-config：它的 --tools 连 MCP 工具一起藏起来，写上 mcp__onset__* 也没用（实测）。
 */
export const RendererBuiltinTools = 'Bash,Read,Write,Edit,Skill';
const rendererToolLimits = ['--strict-mcp-config', '--tools', RendererBuiltinTools];

/** claude / qoder / codebuddy 的 --mcp-config：几个服务合在一份 JSON 里。 */
function mcpConfig(servers: McpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    const timeout = longWaitTimeoutSeconds(s);
    // claude 的 MCP 配置认每个服务自己的 timeout（毫秒，覆盖 MCP_TOOL_TIMEOUT）。
    mcpServers[s.name] = { command: s.command, args: s.args, ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}), ...(timeout > 0 ? { timeout: timeout * 1000 } : {}) };
  }
  return { mcpServers };
}

function mcpConfigJSON(servers: McpServer[]): string {
  return marshal(mcpConfig(servers));
}

/** codex 的 -c 覆盖项（TOML 值）：mcp_servers.<名字>.command / args / env。 */
export function codexMcpOverrides(server: McpServer): string[] {
  const toml = (v: string) => JSON.stringify(v);
  // Windows 的 ProgramFiles(x86) 不是合法的 TOML 裸键；解析失败时 Codex 会把整张 env 表当作字符串。
  // 只修正 Windows 上的特殊键，其他平台与已有合法裸键保持原样。
  const envKey = (key: string) => process.platform === 'win32' && !/^[A-Za-z0-9_-]+$/.test(key) ? toml(key) : key;
  const out = ['-c', `mcp_servers.${server.name}.command=${toml(server.command)}`, '-c', `mcp_servers.${server.name}.args=[${server.args.map(toml).join(',')}]`];
  const env = server.env ?? {};
  if (Object.keys(env).length > 0) out.push('-c', `mcp_servers.${server.name}.env={${Object.entries(env).map(([k, v]) => `${envKey(k)}=${toml(v)}`).join(',')}}`);
  const timeout = longWaitTimeoutSeconds(server);
  if (timeout > 0) out.push('-c', `mcp_servers.${server.name}.tool_timeout_sec=${timeout}`);
  return out;
}

/** opencode 的 mcp 配置项（OPENCODE_CONFIG_CONTENT 里）。 */
export function opencodeMcpConfig(server: McpServer): Record<string, unknown> {
  return { [server.name]: { type: 'local', command: [server.command, ...server.args], enabled: true, ...(server.env ? { environment: server.env } : {}) } };
}

/**
 * MiniMax Code（mcode）的 MCP：`mcode exec` 没有给 MCP 的参数，只读工作目录的 `.mcp.json`、数据目录的 `mcp.json`
 * 与 ACP 会话里给的（0.6.12 实测）。数据目录（MINIMAX_DATA_DIR）里还有登录态，不能换；渲染器于是由 scene.run
 * 在镜头目录里临时写一份 `.mcp.json`（stageMcodeMcp），编排工具在客户端里一律走 ACP（interactiveInvocation）。
 * 格式与 claude 的 --mcp-config 相同，工具全名也是 mcp__<服务>__<工具>。
 */
export const McodeMcpFile = '.mcp.json';

export function mcodeMcpJSON(server: McpServer): string {
  return marshalIndent(mcpConfig([server])) + '\n';
}

/**
 * 把 RendererAccess 译成 claude --settings 的 JSON。
 * .env 的读取禁令与执行契约一致：渲染器不得读取或打印凭据。
 * Go 里是 map[string]any，json.Marshal 按键排序，这里照那个顺序写。
 */
function claudeSettings(a: RendererAccess & { mcp?: string[] }, extra: Record<string, unknown> = {}): string {
  const allow: string[] = [];
  for (const command of a.commands ?? []) allow.push('Bash(' + command + ':*)');
  // 整个服务放行：mcp__<名字> 匹配它的全部工具。
  for (const server of a.mcp ?? []) allow.push('mcp__' + server);
  for (const dir of a.readDirs ?? []) {
    // claude 的路径规则里，绝对路径要写成 // 开头。
    allow.push('Read(/' + dir + '/**)');
  }
  const dirs = [...(a.readDirs ?? [])];
  return marshal({
    ...extra,
    permissions: {
      additionalDirectories: dirs,
      allow,
      // onset 只经工具服务调用；它不在 PATH 里，这里再明确拒绝一次，免得弹审批卡片。
      // 技能目录只读：acceptEdits 连 additionalDirectories 里的编辑也自动批准；qoder 经镜头目录里的技能链接
      // （scene.stageRendererSkills）改的也是这里的真文件——规则按真实路径匹配，链接绕不过去（2026-11 实测）。
      deny: ['Bash(onset:*)', 'Read(**/.env)', 'Read(**/.env.*)', ...dirs.flatMap((dir) => ['Edit(/' + dir + '/**)', 'Write(/' + dir + '/**)'])],
    },
  });
}

/**
 * 各家指定模型的参数；model 为空时什么都不加，用那家工具自己的默认模型。
 * codex 用 -c model=…（TOML 字符串）而不是 -m：它是全局配置覆盖，exec 与 exec resume 都认。
 */
export function modelArgs(tool: string, model: string): string[] {
  if (model === '') return [];
  switch (tool) {
    case 'director':
      // 模型在 stdin 的请求里给（director.Request.model）。
      return [];
    case 'codex':
      return ['-c', 'model=' + JSON.stringify(model)];
    case 'qoder':
    case 'qoder-intl':
    case 'opencode':
      return ['-m', model];
    default:
      return ['--model', model];
  }
}

/**
 * 渲染器的会话：id 为空时不指定；resume 为真时续接 id 那个会话（渲染中途异常退出后接着做，scene/resume.ts）。
 * 新会话预先指定 id 只有 claude、qoder、codebuddy 支持（presetSessionID），codex、opencode 的会话号从输出流读。
 * 各家的写法与编排工具相同（orchestratorInvocation）。
 */
export interface RendererSession {
  id: string;
  resume: boolean;
}

export function rendererInvocation(tool: string, prompt: string, unsafe: boolean, access: RendererAccess, model = '', session: RendererSession | null = null, options: AgentOptions = {}): string[] {
  const server = tool === 'claude' || tool === 'codex' ? longWaitServer(access.toolsServer) : access.toolsServer;
  // 调用选项（推理强度、快速模式、上下文长度，见 options.ts）跟着模型参数一起放。
  const m = [...modelArgs(tool, tool === 'opencode' ? opencodeModel(model, options) : model), ...(tool === 'codex' ? codexOptionOverrides(options) : optionArgs(tool, options))];
  const claudeExtra = tool === 'claude' ? claudeOptionSettings(options) : {};
  if (session && session.id === '') session = null;
  if (session && !session.resume && !presetSessionID(tool)) throw new Error(`${tool} 不支持预先指定会话 id`);
  /** claude 系：新会话 --session-id，续接 --resume。 */
  const claudeSession = session ? (session.resume ? ['--resume', session.id] : ['--session-id', session.id]) : [];
  switch (tool) {
    case 'codex': {
      const mcp = server ? codexMcpOverrides(server) : [];
      // Windows Codex 的 MCP 审批独立于 shell 策略。只逐项授权内置渲染工具，
      // 会话续接与上游的 unfiltered 模式继续使用同一组 MCP 配置。
      if (process.platform === 'win32' && server?.name === ToolsServerName && server.args.includes('tools-mcp') && server.args[server.args.indexOf('--profile') + 1] === 'renderer') {
        for (const tool of ['hyperframes', 'scene_preview_check', 'job_wait', 'job_cancel', 'tool_help']) mcp.push('-c', `mcp_servers.${server.name}.tools.${tool}.approval_mode="approve"`);
      }
      const resume = session?.resume ? ['resume', session.id] : [];
      // 不拦命令时也不套 codex 自己的沙箱：macOS 上它也是 sandbox-exec，套在外面那层沙箱里起不来；Windows 上用户定的是全放开。
      if (unsafe || access.unfiltered) return ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...mcp, ...m, '--json', ...resume, prompt];
      return ['codex', '--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', ...mcp, ...m, '--json', ...resume, prompt];
    }
    case 'claude': {
      let mode = ['--dangerously-skip-permissions', ...(Object.keys(claudeExtra).length > 0 ? ['--settings', marshal(claudeExtra)] : [])];
      if (!unsafe && !access.unfiltered) mode = ['--permission-mode', 'acceptEdits', '--settings', claudeSettings({ ...access, mcp: server ? [server.name] : [] }, claudeExtra)];
      // --mcp-config 与 --tools 都吃多个值，后面必须紧跟一个选项（这里是 --mcp-config / --verbose），不然会把提示词吞掉。
      const mcp = server ? ['--mcp-config', mcpConfigJSON([server])] : [];
      return ['claude', '-p', ...mode, ...m, ...rendererToolLimits, ...mcp, '--verbose', '--output-format', 'stream-json', '--prompt-suggestions', 'false', ...claudeSession, prompt];
    }
    case 'qoder':
    case 'qoder-intl': {
      const qoderSession = session ? (session.resume ? ['-r', session.id] : ['--session-id', session.id]) : [];
      // 与 claude 同一套放行规则（qoder 的 --settings 认 claude 的 permissions 写法），外加关掉懒加载 MCP。
      // 以前用 dont_ask：它连镜头目录里写文件都拒、技能目录读不了、ls 都跑不了，渲染器一个 index.html 都写不出来（2026-11 实测）。
      // 系统沙箱按目录管住了读写（或 Windows 上全放开），渲染器里不再按命令白名单拦（拦了也没人能批准，只会白耗几轮）。
      if (unsafe || access.unfiltered) {
        const mcp = server ? ['--mcp-config', mcpConfigJSON([server])] : [];
        return [qoderBinary(tool), '-p', prompt, ...qoderSession, '--dangerously-skip-permissions', ...m, ...qoderRendererSources, ...rendererToolLimits, '--settings', JSON.stringify(qoderEagerSettings), ...mcp, '--output-format', 'stream-json'];
      }
      const settings = { ...(JSON.parse(claudeSettings({ ...access, mcp: server ? [server.name] : [] })) as Record<string, unknown>), ...qoderEagerSettings };
      const mcp = server ? ['--mcp-config', mcpConfigJSON([server]), '--allowed-tools', 'mcp__' + server.name] : [];
      return [qoderBinary(tool), '-p', prompt, ...qoderSession, '--permission-mode', 'accept_edits', ...m, ...qoderRendererSources, ...rendererToolLimits, '--settings', JSON.stringify(settings), ...mcp, '--output-format', 'stream-json'];
    }
    case 'codebuddy': {
      let mode = ['--permission-mode', 'acceptEdits'];
      if (!unsafe && server) mode.push('--settings', claudeSettings({ ...access, commands: [], readDirs: access.readDirs, mcp: [server.name] }));
      if (unsafe || access.unfiltered) mode = ['-y'];
      const mcp = server ? ['--mcp-config', mcpConfigJSON([server])] : [];
      return ['codebuddy', '-p', ...m, '--strict-mcp-config', ...mcp, '--verbose', '--output-format', 'stream-json', ...mode, ...claudeSession, prompt];
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
      return ['mcode', 'exec', '--cwd', '.', '--permission', mode, ...m, ...resume, '--output-format', 'stream-json', prompt];
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

/** 渲染的完整调用；自带制作人的提示词、模型和密钥只经 stdin，外部工具沿用各自的命令行。 */
export function rendererLaunch(tool: string, prompt: string, unsafe: boolean, access: RendererAccess, model: string, session: RendererSession | null, workdir: string, env: Record<string, string | undefined>, options: AgentOptions = {}, stage: 'full' | 'repair' = 'full'): Invocation {
  if (tool !== DirectorTool) return windowsPromptInput(tool, rendererInvocation(tool, prompt, unsafe, access, model, session, options), prompt);
  const agentDir = directorDir({ ...process.env, ...env });
  const service = directorService(agentDir);
  if (!service) throw new Error(NoServiceMessage);
  const settings = effectiveOptions(DirectorTool, options);
  const request: DirectorRequest = {
    profile: 'renderer', workdir, prompt, agent_dir: rendererDir(agentDir), service,
    model: model || undefined,
    thinking: stage === 'repair' ? settings.repair_effort ?? settings.effort : settings.effort,
    compact_at: settings.compact_at ? Number(settings.compact_at) : undefined,
    session_id: session?.id, resume: session?.resume || undefined,
    unsafe: unsafe || access.unfiltered || undefined, commands: access.commands, read_dirs: access.readDirs,
  };
  return { ...directorCommand(), stdin: JSON.stringify(request) + '\n' };
}

/** opencode 渲染器的工具服务经环境变量 OPENCODE_CONFIG_CONTENT 给（opencode run 没有 MCP 参数），合并用户自己的这个变量。 */
export function rendererEnv(tool: string, access: RendererAccess, env: Record<string, string | undefined>): Record<string, string> {
  if (tool !== 'opencode' || (!access.toolsServer && !access.skills)) return {};
  const own = parseConfig(env.OPENCODE_CONFIG_CONTENT);
  const config: Record<string, unknown> = { ...own };
  if (access.toolsServer) {
    const mcp = own.mcp && typeof own.mcp === 'object' ? (own.mcp as Record<string, unknown>) : {};
    config.mcp = { ...mcp, ...opencodeMcpConfig(access.toolsServer) };
  }
  // 只放行镜头的技能：opencode 按 permission.skill 过滤技能列表（2026-11 实测，项目根与用户级的都不再出现）。
  if (access.skills) {
    const permission = own.permission && typeof own.permission === 'object' ? (own.permission as Record<string, unknown>) : {};
    config.permission = { ...permission, skill: { '*': 'deny', ...Object.fromEntries(access.skills.map((name) => [name, 'allow'])) } };
  }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

function parseConfig(text: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(text ?? '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 用户自己的配置不是 JSON：不合并。
  }
  return {};
}

/**
 * 安全模式下编排工具要放行的 Bash 命令前缀。
 *
 * 编排工具要跑 onset 子命令、ffmpeg、TTS 与对齐 CLI，而各家「只批准文件编辑」的权限模式
 * 一律拦下 Bash（claude 的 acceptEdits、qoder 的 accept_edits），dont_ask 更是连写文件
 * 都拒——实测安全模式下整片制作因此一步都走不动。清单由调用方按项目配置算出，
 * 见 project.OrchestratorAccess。
 */
export interface OrchestratorAccess {
  commands?: string[];
  /**
   * 工作目录之外还要可写的目录（渲染记忆库）。只有靠沙箱限制写入
   * 的工具（codex）需要它：编排工具调用的 onset memory remember 与 onset scene run
   * 要往用户级的记忆库写，workspace-write 沙箱默认只放行工作目录。
   * 不存在的目录不传，codex 对它的处理没有实测过。
   */
  writableDirs?: string[];
}

/** 一次编排调用的全部输入。 */
export interface OrchestratorOptions {
  workdir?: string;
  prompt: string;
  unsafe?: boolean;
  /**
   * 非空且 Resume 为 false 时，表示让工具用这个 id 开新会话（只有
   * presetSessionID 为 true 的工具支持）；resume 为 true 时表示续接这个会话。
   */
  sessionID?: string;
  resume?: boolean;
  access?: OrchestratorAccess;
  /**
   * 安全模式下需要批准的调用交给谁问。给了就让 claude 把审批交给这个 MCP 服务（客户端里是
   * onset studio permission-mcp，问界面上的用户）；不给（onset run）时照旧，白名单外的一律拒绝。
   * claude 与 qoder 支持（qoder 的帮助里没列，实测可用），其他工具忽略它。
   */
  permissionPrompt?: PermissionPrompt;
  /** onset 的工具服务（--profile orchestrator）：客户端里给，编排工具只经它调用 onset。 */
  toolsServer?: McpServer;
  /** 模型（config 的 orchestratorModel）；空用那家工具自己的默认，见 modelArgs。 */
  model?: string;
  /** 调用选项（config 的 orchestratorOptions，见 options.ts）；空用那家工具自己的默认。 */
  options?: AgentOptions;
  /** 制作人的数据目录（凭据）；只有 director 用，空时按环境算（director.defaultDir）。 */
  agentDir?: string;
}

/** Claude Code 主会话缓存时长的开关（v2.1.242 起认，旧版本忽略）。 */
export const ClaudeCacheTTLEnv = 'CLAUDE_CODE_PROMPT_CACHE_TTL';

/**
 * 编排长会话要的额外环境：claude 的主会话缓存改成 1 小时。
 *
 * Claude Code 用 API key、云服务商或按量计费时，非交互（-p）的主会话缓存默认只活 5 分钟，订阅登录才默认 1 小时
 * （code.claude.com/docs/en/prompt-caching）。编排一轮里常常等镜头渲染十几分钟，缓存一过期，下一次调用就按 1.25 倍
 * 写入价把几十万 token 的整段上下文重写一遍；1 小时缓存写入是 2 倍、读两次就回本。2026-11 本机（订阅登录）实测
 * 编排与渲染的缓存写入本来就全是 1 小时的，所以这只对按 API 计费的用户有影响。
 * 只给编排：渲染器的调用一步接一步、很少空闲超过 5 分钟，写入价翻倍反而更贵。用户自己设了就不动。
 */
export function longSessionEnv(tool: string, env: Record<string, string | undefined>): Record<string, string> {
  if (tool !== 'claude' || (env[ClaudeCacheTTLEnv] ?? '') !== '') return {};
  return { [ClaudeCacheTTLEnv]: '1h' };
}

/** 审批服务的启动命令（MCP stdio）与工具名。 */
export interface PermissionPrompt {
  command: string;
  args: string[];
  /** 启动它要的环境变量（Windows 上用 Electron 跑 onset.cjs 时的 ELECTRON_RUN_AS_NODE 等，见 envutil.onsetCommand）。 */
  env?: Record<string, string>;
  /** MCP 配置里的服务名；工具名是 mcp__<server>__ask。 */
  server: string;
}

/**
 * 让工具把需要批准的调用交给审批服务（MCP）去问：claude 与 qoder 同一套参数。
 * --mcp-config 吃多个值，后面紧跟 --permission-prompt-tool 这个选项，才不会把提示词也吞进去。
 */
function mcpArgs(p: PermissionPrompt | undefined, tools: McpServer | undefined): string[] {
  const servers: McpServer[] = [];
  if (p) servers.push({ name: p.server, command: p.command, args: p.args, ...(p.env && Object.keys(p.env).length > 0 ? { env: p.env } : {}) });
  if (tools) servers.push(tools);
  if (servers.length === 0) return [];
  const out = ['--mcp-config', mcpConfigJSON(servers)];
  if (p) out.push('--permission-prompt-tool', 'mcp__' + p.server + '__ask');
  return out;
}

/** 双向协议的调用：ACP（opencode、codebuddy）或 codex app-server。 */
export interface InteractiveInvocation {
  protocol: 'acp' | 'codex-app';
  argv: string[];
  /** 要加进子进程环境的变量。 */
  env: Record<string, string>;
}

/**
 * 客户端里、安全模式下要能中途问用户时，codebuddy、opencode、codex 换成双向协议：它们的一次性模式
 * （-p、run、exec）要么不能把审批交出来，要么根本不拦命令。claude、qoder 照旧走一次性模式加审批 MCP，
 * 返回 null；--unsafe 不拦任何东西，也返回 null。
 *
 * - codebuddy --acp：权限设置与 -p 模式相同（acceptEdits + 白名单 --settings），白名单外的调用发
 *   session/request_permission。
 * - opencode acp：opencode 只认配置里的 permission，经 OPENCODE_CONFIG_CONTENT 把 bash 设成 ask（2026-11
 *   用 2.1.0 实测会来问）；白名单由 agentrun 在收到请求时先过一遍，不写进 opencode 的规则。
 * - codex app-server：审批策略与沙箱在 thread/start 里给，见 agentrun/codexapp.ts。
 */
export function interactiveInvocation(tool: string, o: Pick<OrchestratorOptions, 'unsafe' | 'access' | 'toolsServer' | 'model' | 'options'>, env: Record<string, string | undefined> = {}): InteractiveInvocation | null {
  // mcode 的 exec 挂不上工具服务（见 mcodeMcpJSON），所以客户端里不安全模式也走 ACP，权限模式在会话里设（agentrun/acp.ts）。
  if (tool === 'mcode') return { protocol: 'acp', argv: ['mcode', 'acp'], env: {} };
  if (o.unsafe) return null;
  switch (tool) {
    case 'codebuddy':
      return {
        protocol: 'acp',
        argv: ['codebuddy', '--acp', ...modelArgs('codebuddy', o.model ?? ''), ...optionArgs('codebuddy', o.options ?? {}), '--permission-mode', 'acceptEdits', '--settings', claudeSettings({ commands: o.access?.commands, mcp: o.toolsServer ? [o.toolsServer.name] : [] })],
        env: {},
      };
    case 'opencode': {
      let config: Record<string, unknown> = {};
      try {
        const own = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
        if (own && typeof own === 'object' && !Array.isArray(own)) config = own as Record<string, unknown>;
      } catch {
        // 用户自己的 OPENCODE_CONFIG_CONTENT 不是 JSON：不合并，只给我们这一条。
      }
      const permission = config.permission && typeof config.permission === 'object' ? (config.permission as Record<string, unknown>) : {};
      // opencode acp 没有 -m：模型经同一份配置的 model 给；acp.ts 在 session/new 之后还会按 configOptions 再核对一次。
      const model = o.model ? { model: opencodeModel(o.model, o.options ?? {}) } : {};
      return { protocol: 'acp', argv: ['opencode', 'acp'], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, ...model, permission: { ...permission, bash: 'ask' } }) } };
    }
    case 'codex':
      // 模型、推理强度与服务档位在 thread/start、thread/resume、turn/start 里给，见 agentrun/codexapp.ts。
      return { protocol: 'codex-app', argv: ['codex', 'app-server'], env: {} };
  }
  return null;
}

/**
 * 报告该工具能否由调用方预先指定新会话的 id。
 * codex 与 opencode 不能，它们的 id 要从输出流的第一条事件里读。
 */
export function presetSessionID(tool: string): boolean {
  return tool === 'claude' || isQoder(tool) || tool === 'codebuddy';
}

export interface Invocation {
  argv: string[];
  /** 要写进 stdin 的内容；空串表示不写。 */
  stdin: string;
  /** 要加进子进程环境的变量（opencode 的工具服务经 OPENCODE_CONFIG_CONTENT 给）。 */
  env?: Record<string, string>;
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 返回编排调用的命令行与要写进 stdin 的内容。
 *
 * 所有工具都输出结构化流（stream-json / JSONL），由 agentrun 解析。
 * 调用方负责把进程的工作目录设为 o.workdir：opencode 2.x 的 run 已经没有 --dir。
 */
export function orchestratorInvocation(tool: string, o: OrchestratorOptions, env: Record<string, string | undefined> = {}): Invocation {
  // 能长时间等一次工具调用的两家放宽等待上限（LongToolWaitSeconds），少醒来轮询几次。
  if (tool === 'claude' || tool === 'codex') o = { ...o, toolsServer: longWaitServer(o.toolsServer) };
  const sessionID = o.sessionID ?? '';
  const workdir = o.workdir ?? '';
  const options = o.options ?? {};
  const m = [...modelArgs(tool, tool === 'opencode' ? opencodeModel(o.model ?? '', options) : (o.model ?? '')), ...(tool === 'codex' ? [] : optionArgs(tool, options))];
  const access = o.access ?? {};
  if (o.resume && sessionID === '') throw new Error('续接会话需要 session id');
  if (sessionID !== '' && !o.resume && !presetSessionID(tool)) throw new Error(`${tool} 不支持预先指定会话 id`);
  const claudeSession = (): string[] => {
    if (o.resume) return ['--resume', sessionID];
    if (sessionID !== '') return ['--session-id', sessionID];
    return [];
  };
  switch (tool) {
    case 'codex': {
      // 用户选的推理强度优先于 Windows 上的缺省（ONSET_WINDOWS_ORCHESTRATOR_EFFORT）。
      const effort = effectiveOptions('codex', options).effort ? undefined : windowsOrchestratorEffort(env);
      const args = ['codex', ...(o.toolsServer ? codexMcpOverrides(o.toolsServer) : []), ...m, ...codexOptionOverrides(options), ...(effort ? ['-c', 'model_reasoning_effort=' + marshal(effort)] : [])];
      if (o.unsafe) {
        args.push('exec', '--skip-git-repo-check', '--cd', workdir, '--dangerously-bypass-approvals-and-sandbox');
      } else {
        // workspace-write 沙箱默认断网，TTS 要连外网；codex 没有命令白名单，靠沙箱限制写入范围。
        args.push(
          '--ask-for-approval', 'never', '-c', 'sandbox_workspace_write.network_access=true',
          'exec', '--skip-git-repo-check', '--cd', workdir, '--sandbox', 'workspace-write',
        );
        for (const dir of access.writableDirs ?? []) if (isDir(dir)) args.push('--add-dir', dir);
      }
      args.push('--json');
      if (o.resume) args.push('resume', sessionID);
      args.push('-');
      return { argv: args, stdin: o.prompt };
    }
    case 'claude':
    case 'codebuddy': {
      const permission = !o.unsafe && tool === 'claude' ? o.permissionPrompt : undefined;
      // --mcp-config 吃多个值，后面必须紧跟一个选项，不然会把提示词吞掉：放在 --verbose 前面。
      const args = [tool, '-p', ...m, ...mcpArgs(permission, o.toolsServer), ...(permission ? ['--permission-prompts', 'host'] : []), '--verbose', '--output-format', 'stream-json'];
      if (tool === 'claude') {
        // 片场质检用自己的抽帧工具。用户级 Chrome DevTools MCP 可能连到已有的浏览器会话。
        if (o.toolsServer || permission) args.push('--disallowed-tools', 'mcp__chrome-devtools__*');
        args.push('--prompt-suggestions', 'false');
      }
      const extra = tool === 'claude' ? claudeOptionSettings(options) : {};
      if (o.unsafe && tool === 'claude') args.push('--dangerously-skip-permissions', ...(Object.keys(extra).length > 0 ? ['--settings', marshal(extra)] : []));
      else if (o.unsafe) args.push('-y');
      else args.push('--permission-mode', 'acceptEdits', '--settings', claudeSettings({ commands: access.commands, mcp: o.toolsServer ? [o.toolsServer.name] : [] }, extra));
      args.push(...claudeSession());
      args.push(o.prompt);
      return windowsPromptInput(tool, args, o.prompt);
    }
    case 'qoder':
    case 'qoder-intl': {
      const args = [qoderBinary(tool), '-p', o.prompt, ...m, '--output-format', 'stream-json'];
      if (o.unsafe) {
        args.push('--dangerously-skip-permissions');
      } else {
        args.push('--permission-mode', 'accept_edits');
        for (const command of access.commands ?? []) args.push('--allowed-tools', 'Bash(' + command + ':*)');
        if (o.toolsServer) args.push('--allowed-tools', 'mcp__' + o.toolsServer.name);
        if (o.toolsServer || o.permissionPrompt) args.push('--settings', qoderOrchestratorSettings(workdir));
        args.push(...mcpArgs(o.permissionPrompt, o.toolsServer));
      }
      if (o.resume) args.push('-r', sessionID);
      else if (sessionID !== '') args.push('--session-id', sessionID);
      return { argv: args, stdin: '' };
    }
    case 'director': {
      // 制作人是 onset 自己（onset studio agent），请求经 stdin 给，见 director.Request。
      // 不能按名字找 onset：编排工具的 PATH 最前面是只会报错的那个 onset（envutil.addToolsLocation）。
      const onset = onsetCommand();
      const agentDir = o.agentDir || directorDir({ ...process.env, ...env });
      const request = {
        workdir,
        prompt: o.prompt,
        session_id: sessionID || undefined,
        resume: o.resume || undefined,
        model: o.model || undefined,
        thinking: effectiveOptions(DirectorTool, options).effort,
        unsafe: o.unsafe || undefined,
        commands: access.commands && access.commands.length > 0 ? access.commands : undefined,
        writable_dirs: access.writableDirs && access.writableDirs.length > 0 ? access.writableDirs : undefined,
        agent_dir: agentDir,
        // 在用的模型服务连同 key 由这里（父进程）读出、经 stdin 交下去；客户端里经 safeStorage 解密（director.useKeyCodec）。
        // 制作人与它跑的命令都不读磁盘上的凭据，见 director.resolveService。
        service: directorService(agentDir) ?? undefined,
      };
      return { argv: [onset.command, ...onset.args, 'studio', 'agent'], stdin: JSON.stringify(request) + '\n', env: onset.env };
    }
    case 'mcode': {
      // onset run 这类一次性调用：exec 没有命令白名单，安全模式用 smart（它自己判断哪些要批准，exec 里没人答就拒绝）。
      // 工具服务挂不上（只认 .mcp.json，不往项目根写），客户端里编排一律走 ACP，见 interactiveInvocation。
      const args = ['mcode', 'exec', '--cwd', workdir || '.', '--permission', o.unsafe ? 'full' : 'smart', ...m, '--output-format', 'stream-json'];
      if (o.resume) args.push('--session', sessionID);
      args.push('--input', '-');
      return { argv: args, stdin: o.prompt };
    }
    case 'opencode': {
      // opencode 只认项目目录里的 opencode.json，规则集写法实测拦不住命令，
      // 全拒时无头运行直接挂起；安全模式下因此不加限制，见 README。
      // --standalone 的理由同渲染器：不然工具服务的配置被后台常驻服务忽略。
      const args = ['opencode', 'run', '--standalone', ...m, '--format', 'json'];
      if (o.unsafe) args.push('--auto');
      if (o.resume) args.push('-s', sessionID);
      args.push(o.prompt);
      return { argv: args, stdin: '', env: rendererEnv('opencode', { toolsServer: o.toolsServer }, env) };
    }
    default:
      throw new Error(`未知工具：${tool}`);
  }
}

/**
 * 返回该工具会自动从工作目录向上递归读取的项目级指令文件名。
 *
 * 名字必须逐个工具核对，不能统一成 AGENTS.md：Claude Code 官方文档明写
 * "Claude Code reads CLAUDE.md, not AGENTS.md"，CodeBuddy 读的是产品名派生的
 * CODEBUDDY.md。写错文件名不会报错，只会让规则静默失效。
 */
export function projectRulesFilename(tool: string): string {
  switch (tool) {
    case 'codex':
    case 'qoder':
    case 'qoder-intl':
    case 'opencode':
    case 'mcode':
    case 'director':
      return 'AGENTS.md';
    case 'claude':
      return 'CLAUDE.md';
    case 'codebuddy':
      return 'CODEBUDDY.md';
    default:
      throw new Error(`未知工具：${tool}`);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function extractUserMessages(tool: string, line: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (parsed !== null && !asObject(parsed)) return [];
  const event = asObject(parsed) ?? {};
  const texts: string[] = [];
  switch (tool) {
    case 'codex': {
      const item = asObject(event.item);
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') texts.push(item.text);
      break;
    }
    case 'claude':
    case 'qoder':
    case 'qoder-intl':
    case 'codebuddy':
    case 'director': {
      const content = asObject(event.message)?.content;
      if (event.type === 'assistant' && Array.isArray(content)) {
        for (const raw of content) {
          const block = asObject(raw);
          if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        }
      }
      break;
    }
    case 'opencode': {
      const part = asObject(event.part);
      if (event.type === 'text' && typeof part?.text === 'string') texts.push(part.text);
      break;
    }
    case 'mcode': {
      const item = asObject(event.item);
      if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.content === 'string') texts.push(item.content);
      break;
    }
  }
  const messages: string[] = [];
  for (const text of texts) {
    for (const l of text.split('\n')) if (l.startsWith(UserMessageMarker)) messages.push(l.slice(UserMessageMarker.length));
  }
  return messages;
}
