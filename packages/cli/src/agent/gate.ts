/**
 * 制作人的权限闸门：每次工具调用之前问一遍（pi 的 tool_call 事件）。
 *
 * 与其他几家编排工具同一套规矩：
 * - bash 只放行白名单前缀（orchestratorAccess 加「以后都允许」的前缀），带 shell 控制符的整条不算；
 *   参数里指向凭据（.env、制作人的数据目录）的直接拒绝，可能间接读到的改成问用户（secrets.ts）；
 * - 文件工具只在项目里（与记忆库、音色库这类可写目录）直接放行，.env 与制作人的数据目录一律不读不写；
 * - onset 自己的工具一律放行（它们本来就是给编排工具用的）；
 * - 其余的在客户端里经收件目录问用户（与审批 MCP、双向协议同一条路），不在客户端里（onset run）直接拒绝。
 *
 * --unsafe 时什么都不拦，与其他几家的 --unsafe 相同。
 */
import fs from 'node:fs';
import path from 'node:path';
import { commandAllowed } from '@onset/engine/agentrun';
import * as studioview from '@onset/engine/studioview';
import { AgentDirReason, checkCommand, EnvFileReason, isEnvFile } from './secrets';
import type { Gate } from './types';

export interface GateOptions {
  workdir: string;
  unsafe: boolean;
  commands: readonly string[];
  /** 工作目录之外也能读写的目录。 */
  writableDirs: readonly string[];
  /** 镜头技能、共享素材只允许读取。 */
  readDirs?: readonly string[];
  /** 制作人的数据目录（API key、会话）：bash 与文件工具都碰不得。空表示没有。 */
  agentDir?: string;
  /** onset 的工具名：一律放行。 */
  onsetTools: ReadonlySet<string>;
  /** 这一轮的收件目录（ONSET_STUDIO_INBOX）；空表示不在客户端里，白名单外的一律拒绝。 */
  inbox: string;
  /** 等用户答复的轮询间隔（毫秒），测试调小。 */
  pollInterval?: number;
}

/** pi 的文件工具，以及各自的路径参数。 */
const readTools = new Set(['read', 'grep', 'find', 'ls']);
const writeTools = new Set(['write', 'edit']);

/** 存在的最近一层上级目录解析成真实路径，再接回剩下的部分：macOS 的 /var 是 /private/var 的链接。 */
function realish(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

function inside(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function describe(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') return `命令 ${String(input.command ?? '')}`;
  if (typeof input.path === 'string') return `${toolName} ${input.path}`;
  return toolName;
}

export function newGate(o: GateOptions): Gate {
  const workdir = realish(path.resolve(o.workdir));
  const roots = [workdir, ...o.writableDirs.filter((d) => d !== '').map((d) => realish(path.resolve(d)))];
  const readable = (o.readDirs ?? []).filter((d) => d !== '').map((d) => realish(path.resolve(d)));
  const agentDir = o.agentDir ? realish(path.resolve(o.agentDir)) : '';
  const scope = { workdir, agentDir, realish };
  const allowed = [...o.commands];

  const ask = async (toolName: string, input: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string | null> => {
    if (o.inbox === '') return `安全模式下不允许${describe(toolName, input)}。换一种在白名单内的做法。`;
    // 审批卡片按 claude 的工具名显示（Bash 带命令行、能记「以后都允许」的前缀）。
    const shown = toolName === 'bash' ? 'Bash' : toolName;
    const req = studioview.writePermissionRequest(o.inbox, shown, input);
    const resp = (await studioview.waitPermissionResponse(o.inbox, req.id, o.pollInterval ?? studioview.PermissionPollInterval, signal)) ?? { decision: 'expired' as const };
    if (resp.decision === 'allow') return null;
    if (resp.decision === 'always') {
      // 后端把前缀记进项目的 permissions.json，下一轮并进白名单；这一轮里先记在这里。
      if (req.suggestion) allowed.push(req.suggestion);
      return null;
    }
    if (resp.message) return resp.message;
    return resp.decision === 'expired' ? '这一轮已经结束，没人批准这条调用。' : '用户拒绝了这条调用。换一种不需要它的做法；确实非它不可时，先在回复里说明为什么要用它。';
  };

  return async (toolName, input, signal) => {
    if (o.unsafe) return null;
    if (o.onsetTools.has(toolName)) return null;
    if (toolName === 'bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      // 先看碰不碰凭据：指向凭据的不管在不在白名单里都直接拒绝（不弹审批卡片，免得用户随手点了允许）。
      const secret = checkCommand(command, scope);
      if (secret?.kind === 'deny') return secret.reason;
      if (secret === null && commandAllowed(command, allowed)) return null;
      return ask(toolName, input, signal);
    }
    if (readTools.has(toolName) || writeTools.has(toolName)) {
      const raw = typeof input.path === 'string' && input.path !== '' ? input.path : '.';
      const target = realish(path.resolve(workdir, raw));
      if (isEnvFile(target)) return EnvFileReason;
      if (agentDir !== '' && inside(target, agentDir)) return AgentDirReason;
      if (roots.some((root) => inside(target, root))) return null;
      if (readTools.has(toolName) && readable.some((root) => inside(target, root))) return null;
      return ask(toolName, input, signal);
    }
    return ask(toolName, input, signal);
  };
}
