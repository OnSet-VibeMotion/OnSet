import path from 'node:path';
import { onsetCommand, WindowsBaseEnvKeys } from '../envutil';
import { marshal, marshalIndent } from '../gojson';
import { pluginChildEnvs } from '../plugin/registry';

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

/** 编排工具服务紧凑模式开关：直出核心主链路，其余扩展工具经 onset_call 路由（避开 agy ACP 约 32 KB 工具声明上限）。 */
export const ToolsCompactEnv = 'ONSET_TOOLS_COMPACT';

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
export function longWaitServer(server: McpServer | undefined, seconds = LongToolWaitSeconds): McpServer | undefined {
  if (!server || server.name !== ToolsServerName) return server;
  return { ...server, env: { ...(server.env ?? {}), [ToolsMaxWaitEnv]: String(seconds) } };
}

/** onset 工具服务在配置里的名字。 */
export const ToolsServerName = 'onset';

/**
 * onset 的工具服务：executable 是 onset 的启动脚本（客户端的私有 shim，或终端里的 onset），workdir 是工具执行的目录。
 * env 只挑 onset 自己要的变量：整个子进程环境写进 MCP 配置会出现在命令行里，不安全模式下里面还有凭据。
 */
export function onsetToolsServer(
  executable: string,
  profile: 'orchestrator' | 'renderer',
  workdir: string,
  env: Record<string, string | undefined> = {},
): McpServer {
  const picked: Record<string, string> = {};
  // 内置插件登记的子进程变量（plugin.PluginChildEnv）同样放行。
  const pluginKeys = new Set(pluginChildEnvs().map((e) => e.value.key));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      /^(ONSET_|HYPERFRAMES_|MEMORY|ORCHESTRATOR$|RENDERER$|ORCHESTRATOR_MODEL$|RENDERER_MODEL$|ORCHESTRATOR_OPTIONS$|RENDERER_OPTIONS$|TTS_|ALIGN_|SCENE_JOBS$|PATH$|HOME$|USER$|LANG$|TMPDIR$|XDG_DATA_HOME$)/.test(
        key,
      ) ||
      WindowsBaseEnvKeys.includes(key) ||
      pluginKeys.has(key) ||
      (process.platform === 'win32' && ['PRODUCER_EXPERIMENTAL_FAST_CAPTURE', 'DO_NOT_TRACK'].includes(key))
    ) {
      picked[key] = value;
    }
  }
  // Windows 上 executable 是 onset.cjs，要用 Electron / Node 来跑（envutil.onsetCommand）。
  const onset = onsetCommand(executable);
  return {
    name: ToolsServerName,
    command: onset.command,
    args: [...onset.args, 'studio', 'tools-mcp', '--profile', profile, '--workdir', workdir],
    env: { ...picked, ...onset.env },
  };
}

/**
 * qoder 1.1.87 起缺省「懒加载」MCP：工具不进工具表，只能经 mcp_list / mcp_get / mcp_call 调。
 * 于是 --permission-prompt-tool 按名字找不到审批工具，白名单外的命令一律直接拒绝、不问用户
 * （报「Permission prompt tool "mcp__onset_studio__ask" was not found」，2026-11 实测）。
 * 只要有一处设置写了 mcp.lazyLoad 它就照设置来，所以经 --settings 关掉。
 */
export const qoderEagerSettings = { mcp: { lazyLoad: false } };

/**
 * 制作端的 accept_edits 会自动批准镜头源码改写；用文件工具的 deny 再守一层角色边界。
 * 只限制实现代码，不拦 prompt.md / scene.json 或素材准备。Bash/脚本不是文件工具，
 * 不能把这当成系统沙箱；每轮的 scene-ownership 说明同时约束复制、同步和脚本写入。
 * 渲染器使用自己的设置，不能继承这些禁令。
 */
export function qoderOrchestratorSettings(workdir: string): string {
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
export const qoderRendererSources = ['--setting-sources', 'project,local'];

/**
 * 渲染器只给这几样内置工具，只挂 onset 的工具服务（2026-11 实测，claude 2.1.325 用 haiku 跑一次空任务）：
 * 不限的话 claude 带着 117 个工具（Cron、Workflow、RemoteTrigger、用户自己装的 chrome-devtools、open-design、
 * claude.ai 的连接器……），第一次调用 47.6K token；限了之后 11 个、24.1K。渲染器每一步都要把这些定义重读一遍，
 * 一个镜头二三十步。onset 的工具也从「先 ToolSearch 再调」变成直接可调。
 * 默认工具集里本来就没有 Glob、Grep（渲染器一直用 Bash 搜），这里也不加。
 * codebuddy 只加 --strict-mcp-config：它的 --tools 连 MCP 工具一起藏起来，写上 mcp__onset__* 也没用（实测）。
 */
export const RendererBuiltinTools = 'Bash,Read,Write,Edit,Skill';
export const rendererToolLimits = ['--strict-mcp-config', '--tools', RendererBuiltinTools];

/** claude / qoder / codebuddy 的 --mcp-config：几个服务合在一份 JSON 里。 */
function mcpConfig(servers: McpServer[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    const timeout = longWaitTimeoutSeconds(s);
    // claude 的 MCP 配置认每个服务自己的 timeout（毫秒，覆盖 MCP_TOOL_TIMEOUT）。
    mcpServers[s.name] = {
      command: s.command,
      args: s.args,
      ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      ...(timeout > 0 ? { timeout: timeout * 1000 } : {}),
    };
  }
  return { mcpServers };
}

export function mcpConfigJSON(servers: McpServer[]): string {
  return marshal(mcpConfig(servers));
}

/** codex 的 -c 覆盖项（TOML 值）：mcp_servers.<名字>.command / args / env。 */
export function codexMcpOverrides(server: McpServer): string[] {
  const toml = (v: string) => JSON.stringify(v);
  // Windows 的 ProgramFiles(x86) 不是合法的 TOML 裸键；解析失败时 Codex 会把整张 env 表当作字符串。
  // 只修正 Windows 上的特殊键，其他平台与已有合法裸键保持原样。
  const envKey = (key: string) => (process.platform === 'win32' && !/^[A-Za-z0-9_-]+$/.test(key) ? toml(key) : key);
  const out = [
    '-c',
    `mcp_servers.${server.name}.command=${toml(server.command)}`,
    '-c',
    `mcp_servers.${server.name}.args=[${server.args.map(toml).join(',')}]`,
  ];
  const env = server.env ?? {};
  if (Object.keys(env).length > 0) {
    out.push(
      '-c',
      `mcp_servers.${server.name}.env={${Object.entries(env)
        .map(([k, v]) => `${envKey(k)}=${toml(v)}`)
        .join(',')}}`,
    );
  }
  const timeout = longWaitTimeoutSeconds(server);
  if (timeout > 0) out.push('-c', `mcp_servers.${server.name}.tool_timeout_sec=${timeout}`);
  return out;
}

/** opencode 的 mcp 配置项（OPENCODE_CONFIG_CONTENT 里）。 */
export function opencodeMcpConfig(server: McpServer): Record<string, unknown> {
  return {
    [server.name]: {
      type: 'local',
      command: [server.command, ...server.args],
      enabled: true,
      ...(server.env ? { environment: server.env } : {}),
    },
  };
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
 * Antigravity CLI（agy）的 MCP：headless `-p` 模式没有 --mcp-config 参数，从工作区的 `.agents/mcp_config.json` 读。
 * 渲染器由 scene.run 在镜头目录里临时写一份（stageAgyMcp），渲染完删掉；客户端里的编排一律走 `agy acp`（interactiveInvocation），
 * MCP 服务经 session/new / session/load 的 mcpServers 传入。
 * 默认 MCP 工具超时只有 180 秒，这里显式拉长到 720 秒（或按 longWaitTimeoutSeconds）；渲染档位的 5 个工具标为 eager，
 * 直接注册成 mcp_onset_<工具>，不必每轮先读磁盘 schema 再 call_mcp_tool。
 */
export const AgyMcpFile = path.join('.agents', 'mcp_config.json');

const agyRendererEagerTools = ['hyperframes', 'scene_preview_check', 'job_wait', 'job_cancel', 'tool_help'];

export function agyMcpJSON(server: McpServer): string {
  const env = { ...(server.env ?? {}) };
  if (server.name === ToolsServerName && !env[ToolsMaxWaitEnv]) {
    env[ToolsMaxWaitEnv] = '600';
  }
  const timeout = longWaitTimeoutSeconds({ ...server, env }) || 720;
  const isRenderer =
    server.args.includes('tools-mcp') && server.args[server.args.indexOf('--profile') + 1] === 'renderer';
  if (server.name === ToolsServerName && !isRenderer && !env[ToolsCompactEnv]) {
    env[ToolsCompactEnv] = '1';
  }
  const entry: Record<string, unknown> = {
    command: server.command,
    args: server.args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    timeoutSeconds: timeout,
    ...(isRenderer ? { tools: Object.fromEntries(agyRendererEagerTools.map((t) => [t, { eager: true }])) } : {}),
  };
  return marshalIndent({ mcpServers: { [server.name]: entry } }) + '\n';
}

/**
 * 把访问权限译成 Antigravity CLI `--settings` 的 JSON（v1.5.13 实测）。
 * 规则格式为 action(target)：command(<前缀>)、mcp(<服务>/*)、read_file(<目录>)、write_file(<目录>)。
 * 显式设 toolPermission 为 request-review，避免用户全局的 always-proceed 绕开安全模式。
 */
export function agySettings(a: RendererAccess & { mcp?: string[] }): string {
  const allow: string[] = [];
  for (const command of a.commands ?? []) allow.push(`command(${command})`);
  for (const server of a.mcp ?? []) allow.push(`mcp(${server}/*)`);
  for (const dir of a.readDirs ?? []) allow.push(`read_file(${dir})`);
  const deny: string[] = ['command(onset)', 'read_file(.env)'];
  for (const dir of a.readDirs ?? []) deny.push(`write_file(${dir})`);
  return marshal({ permissions: { allow, deny }, toolPermission: 'request-review' });
}

/**
 * 把 RendererAccess 译成 claude --settings 的 JSON。
 * .env 的读取禁令与执行契约一致：渲染器不得读取或打印凭据。
 * Go 里是 map[string]any，json.Marshal 按键排序，这里照那个顺序写。
 */
export function claudeSettings(a: RendererAccess & { mcp?: string[] }, extra: Record<string, unknown> = {}): string {
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
      deny: [
        'Bash(onset:*)',
        'Read(**/.env)',
        'Read(**/.env.*)',
        ...dirs.flatMap((dir) => ['Edit(/' + dir + '/**)', 'Write(/' + dir + '/**)']),
      ],
    },
  });
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
export function mcpArgs(p: PermissionPrompt | undefined, tools: McpServer | undefined): string[] {
  const servers: McpServer[] = [];
  if (p)
    servers.push({
      name: p.server,
      command: p.command,
      args: p.args,
      ...(p.env && Object.keys(p.env).length > 0 ? { env: p.env } : {}),
    });
  if (tools) servers.push(tools);
  if (servers.length === 0) return [];
  const out = ['--mcp-config', mcpConfigJSON(servers)];
  if (p) out.push('--permission-prompt-tool', 'mcp__' + p.server + '__ask');
  return out;
}

export function parseConfig(text: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(text ?? '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 用户自己的配置不是 JSON：不合并。
  }
  return {};
}
