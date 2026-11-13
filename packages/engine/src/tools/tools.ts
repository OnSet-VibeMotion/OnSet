// 移植自 internal/tools/tools.go。
import fs from 'node:fs';
import { marshal } from '../gojson';

export const UserMessageMarker = '[[USER_MESSAGE]]';

/**
 * 所有合法的 AI CLI 工具名集合。
 * config、scene 等包共用此集合，新增工具时只需改这一处（加上
 * rendererInvocation、orchestratorInvocation、projectRulesFilename 的 switch）。
 * Go 里是 map[string]bool，这里用 Set：普通对象会让 "constructor" 之类的键查出真值。
 */
export const ValidTools: ReadonlySet<string> = new Set(['codex', 'claude', 'qoder', 'codebuddy', 'opencode']);

/**
 * 安全模式下渲染器需要、而默认权限模式不给的最小权限。
 *
 * 只有需要显式放行的工具才用得上：claude 的 acceptEdits 只自动批准文件编辑，
 * Bash 一律拦下，而 -p 模式下没有人来批准——实测渲染器因此跑不了
 * `npx hyperframes render` / `snapshot`，镜头直接渲染失败。
 */
export interface RendererAccess {
  /** 放行的命令前缀，例如 "am hyperframes"。 */
  commands?: string[];
  /** 镜头目录之外需要读取的目录（技能树），绝对路径。 */
  readDirs?: string[];
}

/**
 * 把 RendererAccess 译成 claude --settings 的 JSON。
 * .env 的读取禁令与执行契约一致：渲染器不得读取或打印凭据。
 * Go 里是 map[string]any，json.Marshal 按键排序，这里照那个顺序写。
 */
function claudeSettings(a: RendererAccess): string {
  const allow: string[] = [];
  for (const command of a.commands ?? []) allow.push('Bash(' + command + ':*)');
  for (const dir of a.readDirs ?? []) {
    // claude 的路径规则里，绝对路径要写成 // 开头。
    allow.push('Read(/' + dir + '/**)');
  }
  const dirs = [...(a.readDirs ?? [])];
  return marshal({
    permissions: {
      additionalDirectories: dirs,
      allow,
      deny: ['Read(**/.env)', 'Read(**/.env.*)'],
    },
  });
}

export function rendererInvocation(tool: string, prompt: string, unsafe: boolean, access: RendererAccess): string[] {
  switch (tool) {
    case 'codex':
      if (unsafe) return ['codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', prompt];
      return ['codex', '--ask-for-approval', 'never', 'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json', prompt];
    case 'claude': {
      let mode = ['--dangerously-skip-permissions'];
      if (!unsafe) mode = ['--permission-mode', 'acceptEdits', '--settings', claudeSettings(access)];
      return ['claude', '-p', ...mode, '--verbose', '--output-format', 'stream-json', '--prompt-suggestions', 'false', prompt];
    }
    case 'qoder': {
      let mode = ['--permission-mode', 'dont_ask'];
      if (unsafe) mode = ['--dangerously-skip-permissions'];
      return ['qoderclicn', '-p', prompt, ...mode, '--output-format', 'stream-json'];
    }
    case 'codebuddy': {
      let mode = ['--permission-mode', 'acceptEdits'];
      if (unsafe) mode = ['-y'];
      return ['codebuddy', '-p', '--verbose', '--output-format', 'stream-json', ...mode, prompt];
    }
    case 'opencode': {
      const args = ['opencode', 'run'];
      if (unsafe) args.push('--auto');
      return [...args, '--format', 'json', prompt];
    }
    default:
      throw new Error(`未知工具：${tool}`);
  }
}

/**
 * 安全模式下编排工具要放行的 Bash 命令前缀。
 *
 * 编排工具要跑 am 子命令、ffmpeg、TTS 与对齐 CLI，而各家「只批准文件编辑」的权限模式
 * 一律拦下 Bash（claude 的 acceptEdits、qoder 的 accept_edits），dont_ask 更是连写文件
 * 都拒——实测安全模式下整片制作因此一步都走不动。清单由调用方按项目配置算出，
 * 见 project.OrchestratorAccess。
 */
export interface OrchestratorAccess {
  commands?: string[];
  /**
   * 工作目录之外还要可写的目录（渲染记忆库）。只有靠沙箱限制写入
   * 的工具（codex）需要它：编排工具调用的 am memory remember 与 am scene run
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
   * am studio permission-mcp，问界面上的用户）；不给（am run）时照旧，白名单外的一律拒绝。
   * claude 与 qoder 支持（qoder 的帮助里没列，实测可用），其他工具忽略它。
   */
  permissionPrompt?: PermissionPrompt;
}

/** 审批服务的启动命令（MCP stdio）与工具名。 */
export interface PermissionPrompt {
  command: string;
  args: string[];
  /** MCP 配置里的服务名；工具名是 mcp__<server>__ask。 */
  server: string;
}

/**
 * 让工具把需要批准的调用交给审批服务（MCP）去问：claude 与 qoder 同一套参数。
 * --mcp-config 吃多个值，后面紧跟 --permission-prompt-tool 这个选项，才不会把提示词也吞进去。
 */
function permissionPromptArgs(p: PermissionPrompt): string[] {
  const mcp = { mcpServers: { [p.server]: { command: p.command, args: p.args } } };
  return ['--mcp-config', JSON.stringify(mcp), '--permission-prompt-tool', 'mcp__' + p.server + '__ask'];
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
export function interactiveInvocation(tool: string, o: Pick<OrchestratorOptions, 'unsafe' | 'access'>, env: Record<string, string | undefined> = {}): InteractiveInvocation | null {
  if (o.unsafe) return null;
  switch (tool) {
    case 'codebuddy':
      return {
        protocol: 'acp',
        argv: ['codebuddy', '--acp', '--permission-mode', 'acceptEdits', '--settings', claudeSettings({ commands: o.access?.commands })],
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
      return { protocol: 'acp', argv: ['opencode', 'acp'], env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, permission: { ...permission, bash: 'ask' } }) } };
    }
    case 'codex':
      return { protocol: 'codex-app', argv: ['codex', 'app-server'], env: {} };
  }
  return null;
}

/**
 * 报告该工具能否由调用方预先指定新会话的 id。
 * codex 与 opencode 不能，它们的 id 要从输出流的第一条事件里读。
 */
export function presetSessionID(tool: string): boolean {
  return tool === 'claude' || tool === 'qoder' || tool === 'codebuddy';
}

export interface Invocation {
  argv: string[];
  /** 要写进 stdin 的内容；空串表示不写。 */
  stdin: string;
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
export function orchestratorInvocation(tool: string, o: OrchestratorOptions): Invocation {
  const sessionID = o.sessionID ?? '';
  const workdir = o.workdir ?? '';
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
      const args = ['codex'];
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
      const args = [tool, '-p', '--verbose', '--output-format', 'stream-json'];
      if (tool === 'claude') args.push('--prompt-suggestions', 'false');
      if (o.unsafe && tool === 'claude') args.push('--dangerously-skip-permissions');
      else if (o.unsafe) args.push('-y');
      else args.push('--permission-mode', 'acceptEdits', '--settings', claudeSettings({ commands: access.commands }));
      if (!o.unsafe && tool === 'claude' && o.permissionPrompt) {
        args.push(...permissionPromptArgs(o.permissionPrompt), '--permission-prompts', 'host');
      }
      args.push(...claudeSession());
      args.push(o.prompt);
      return { argv: args, stdin: '' };
    }
    case 'qoder': {
      const args = ['qoderclicn', '-p', o.prompt, '--output-format', 'stream-json'];
      if (o.unsafe) {
        args.push('--dangerously-skip-permissions');
      } else {
        args.push('--permission-mode', 'accept_edits');
        for (const command of access.commands ?? []) args.push('--allowed-tools', 'Bash(' + command + ':*)');
        if (o.permissionPrompt) args.push(...permissionPromptArgs(o.permissionPrompt));
      }
      if (o.resume) args.push('-r', sessionID);
      else if (sessionID !== '') args.push('--session-id', sessionID);
      return { argv: args, stdin: '' };
    }
    case 'opencode': {
      // opencode 只认项目目录里的 opencode.json，规则集写法实测拦不住命令，
      // 全拒时无头运行直接挂起；安全模式下因此不加限制，见 README。
      const args = ['opencode', 'run', '--format', 'json'];
      if (o.unsafe) args.push('--auto');
      if (o.resume) args.push('-s', sessionID);
      args.push(o.prompt);
      return { argv: args, stdin: '' };
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
    case 'opencode':
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
    case 'codebuddy': {
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
  }
  const messages: string[] = [];
  for (const text of texts) {
    for (const l of text.split('\n')) if (l.startsWith(UserMessageMarker)) messages.push(l.slice(UserMessageMarker.length));
  }
  return messages;
}
