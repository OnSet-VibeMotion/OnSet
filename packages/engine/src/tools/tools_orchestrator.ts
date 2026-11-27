import fs from 'node:fs';
import { defaultDir as directorDir, resolveService as directorService } from '../director';
import { onsetCommand } from '../envutil';
import { marshal } from '../gojson';
import {
  type AgentOptions,
  claudeOptionSettings,
  codexOptionOverrides,
  DefaultDirectorOrchestratorCompactAt,
  effectiveOptions,
  opencodeModel,
  optionArgs,
} from './options';
import { DirectorTool, type Invocation, modelArgs, presetSessionID, qoderBinary } from './tools_catalog';
import {
  agySettings,
  claudeSettings,
  codexMcpOverrides,
  longWaitServer,
  type McpServer,
  mcpArgs,
  type PermissionPrompt,
  qoderEagerSettings,
  qoderOrchestratorSettings,
} from './tools_mcp';
import { rendererEnv, resolveDirectorCompactAt } from './tools_render';
import { windowsOrchestratorEffort, windowsPromptInput } from './windows';

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
export function interactiveInvocation(
  tool: string,
  o: Pick<OrchestratorOptions, 'unsafe' | 'access' | 'toolsServer' | 'model' | 'options'>,
  env: Record<string, string | undefined> = {},
): InteractiveInvocation | null {
  // mcode 的 exec 挂不上工具服务（见 mcodeMcpJSON），所以客户端里不安全模式也走 ACP，权限模式在会话里设（agentrun/acp.ts）。
  if (tool === 'mcode') return { protocol: 'acp', argv: ['mcode', 'acp'], env: {} };
  // agy 的 -p 没有 --mcp-config 参数（只读工作区 .agents/mcp_config.json，不往项目根写），所以客户端里不论安全与否都走 ACP。
  if (tool === 'agy') {
    return {
      protocol: 'acp',
      argv: ['agy', 'acp', ...(o.unsafe ? ['--dangerously-skip-permissions'] : [])],
      env: {},
    };
  }
  if (o.unsafe) return null;
  switch (tool) {
    case 'codebuddy':
      return {
        protocol: 'acp',
        argv: [
          'codebuddy',
          '--acp',
          ...modelArgs('codebuddy', o.model ?? ''),
          ...optionArgs('codebuddy', o.options ?? {}),
          '--permission-mode',
          'acceptEdits',
          '--settings',
          claudeSettings({ commands: o.access?.commands, mcp: o.toolsServer ? [o.toolsServer.name] : [] }),
        ],
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
      const permission =
        config.permission && typeof config.permission === 'object'
          ? (config.permission as Record<string, unknown>)
          : {};
      // opencode acp 没有 -m：模型经同一份配置的 model 给；acp.ts 在 session/new 之后还会按 configOptions 再核对一次。
      const model = o.model ? { model: opencodeModel(o.model, o.options ?? {}) } : {};
      return {
        protocol: 'acp',
        argv: ['opencode', 'acp'],
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, ...model, permission: { ...permission, bash: 'ask' } }),
        },
      };
    }
    case 'codex':
      // 模型、推理强度与服务档位在 thread/start、thread/resume、turn/start 里给，见 agentrun/codexapp.ts。
      return { protocol: 'codex-app', argv: ['codex', 'app-server'], env: {} };
  }
  return null;
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
export function orchestratorInvocation(
  tool: string,
  o: OrchestratorOptions,
  env: Record<string, string | undefined> = {},
): Invocation {
  // 能长时间等一次工具调用的两家放宽等待上限（LongToolWaitSeconds），少醒来轮询几次。
  if (tool === 'claude' || tool === 'codex') o = { ...o, toolsServer: longWaitServer(o.toolsServer) };
  const sessionID = o.sessionID ?? '';
  const workdir = o.workdir ?? '';
  const options = o.options ?? {};
  const m = [
    ...modelArgs(tool, tool === 'opencode' ? opencodeModel(o.model ?? '', options) : (o.model ?? '')),
    ...(tool === 'codex' ? [] : optionArgs(tool, options)),
  ];
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
      const args = [
        'codex',
        ...(o.toolsServer ? codexMcpOverrides(o.toolsServer) : []),
        ...m,
        ...codexOptionOverrides(options),
        ...(effort ? ['-c', 'model_reasoning_effort=' + marshal(effort)] : []),
      ];
      if (o.unsafe) {
        args.push('exec', '--skip-git-repo-check', '--cd', workdir, '--dangerously-bypass-approvals-and-sandbox');
      } else {
        // workspace-write 沙箱默认断网，TTS 要连外网；codex 没有命令白名单，靠沙箱限制写入范围。
        args.push(
          '--ask-for-approval',
          'never',
          '-c',
          'sandbox_workspace_write.network_access=true',
          'exec',
          '--skip-git-repo-check',
          '--cd',
          workdir,
          '--sandbox',
          'workspace-write',
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
      const args = [
        tool,
        '-p',
        ...m,
        ...mcpArgs(permission, o.toolsServer),
        ...(permission ? ['--permission-prompts', 'host'] : []),
        '--verbose',
        '--output-format',
        'stream-json',
      ];
      if (tool === 'claude') {
        // 片场质检用自己的抽帧工具，提问统一走 mcp__onset__studio_ask（原生 AskUserQuestion 在 -p 无头模式下无法收集答案）。
        if (o.toolsServer || permission) args.push('--disallowed-tools', 'mcp__chrome-devtools__*,AskUserQuestion');
        args.push('--prompt-suggestions', 'false');
      }
      const extra = tool === 'claude' ? claudeOptionSettings(options) : {};
      if (o.unsafe && tool === 'claude') {
        args.push(
          '--dangerously-skip-permissions',
          ...(Object.keys(extra).length > 0 ? ['--settings', marshal(extra)] : []),
        );
      } else if (o.unsafe) args.push('-y');
      else {
        args.push(
          '--permission-mode',
          'acceptEdits',
          '--settings',
          claudeSettings({ commands: access.commands, mcp: o.toolsServer ? [o.toolsServer.name] : [] }, extra),
        );
      }
      args.push(...claudeSession());
      args.push(o.prompt);
      return windowsPromptInput(tool, args, o.prompt);
    }
    case 'qoder':
    case 'qoder-intl': {
      const args = [qoderBinary(tool), '-p', o.prompt, ...m, '--output-format', 'stream-json'];
      if (o.unsafe) {
        args.push('--dangerously-skip-permissions');
        if (o.toolsServer) {
          args.push('--settings', marshal(qoderEagerSettings));
          args.push(...mcpArgs(undefined, o.toolsServer));
        }
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
      const directorSettings = effectiveOptions(DirectorTool, options);
      const request = {
        workdir,
        prompt: o.prompt,
        session_id: sessionID || undefined,
        resume: o.resume || undefined,
        model: o.model || undefined,
        thinking: directorSettings.effort,
        compact_at: resolveDirectorCompactAt(directorSettings.compact_at, DefaultDirectorOrchestratorCompactAt),
        unsafe: o.unsafe || undefined,
        commands: access.commands && access.commands.length > 0 ? access.commands : undefined,
        writable_dirs: access.writableDirs && access.writableDirs.length > 0 ? access.writableDirs : undefined,
        agent_dir: agentDir,
        // 在用的模型服务连同 key 由这里（父进程）读出、经 stdin 交下去；客户端里经 safeStorage 解密（director.useKeyCodec）。
        // 制作人与它跑的命令都不读磁盘上的凭据，见 director.resolveService。
        service: directorService(agentDir) ?? undefined,
      };
      return {
        argv: [onset.command, ...onset.args, 'studio', 'agent'],
        stdin: JSON.stringify(request) + '\n',
        env: onset.env,
      };
    }
    case 'mcode': {
      // onset run 这类一次性调用：exec 没有命令白名单，安全模式用 smart（它自己判断哪些要批准，exec 里没人答就拒绝）。
      // 工具服务挂不上（只认 .mcp.json，不往项目根写），客户端里编排一律走 ACP，见 interactiveInvocation。
      const args = [
        'mcode',
        'exec',
        '--cwd',
        workdir || '.',
        '--permission',
        o.unsafe ? 'full' : 'smart',
        ...m,
        '--output-format',
        'stream-json',
      ];
      if (o.resume) args.push('--session', sessionID);
      args.push('--input', '-');
      return { argv: args, stdin: o.prompt };
    }
    case 'agy': {
      // onset run 这类一次性调用走 headless -p；客户端里编排一律走 ACP（interactiveInvocation）。
      const mode = o.unsafe
        ? ['--dangerously-skip-permissions']
        : [
            '--mode',
            'accept-edits',
            '--settings',
            agySettings({ commands: access.commands, mcp: o.toolsServer ? [o.toolsServer.name] : [] }),
          ];
      const args = [
        'agy',
        '-p',
        o.prompt,
        ...mode,
        ...m,
        ...(o.resume ? ['--conversation', sessionID] : []),
        '--output-format',
        'stream-json',
      ];
      return windowsPromptInput('agy', args, o.prompt);
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
