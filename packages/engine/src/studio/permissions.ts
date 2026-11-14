/**
 * 一轮对话里编排工具请用户批准的调用（见 ../studioview/permissions.ts）：轮询收件目录、发 permission 事件、
 * 收界面的答复，以及每个项目「以后都允许」的命令前缀。
 *
 * 「以后都允许」记在项目的 Studio 状态目录（production/studio/permissions.json），不写
 * onset.conf：客户端不改项目文件；状态目录跟着项目走，又不进回退快照。
 * 下一轮开始时这些前缀并进编排工具的白名单；这一轮里同一前缀的后续请求直接放行，不再问。
 *
 * 设置页的「自动批准」（AUTO_APPROVE=on，全局或这个项目）打开时，所有请求都直接放行、不弹卡片，
 * 对话里留一行「已自动允许：…」。五家编排工具的审批（审批 MCP、ACP、codex app-server）都落到同一个收件目录，
 * 所以只在这里放行一处就够；工具自己的沙箱（例如 codex 的 workspace-write）照旧生效，这里只回答「要不要问」。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as config from '../config';
import { atomicWrite } from '../fsutil';
import { marshalIndent } from '../gojson';
import {
  KindPermission,
  KindPermissionResolved,
  listPermissionRequests,
  writePermissionResponse,
  type PermissionDecision,
  type PermissionRequest,
} from '../studioview';
import { studioRoot } from './turns';

const allowFile = 'permissions.json';

/** 项目里「以后都允许」的命令前缀。读不了或格式不对时当作没有。 */
export function allowedCommands(project: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(studioRoot(project), allowFile), 'utf8')) as { allowed_commands?: unknown };
    if (!Array.isArray(raw.allowed_commands)) return [];
    return config.parseAllowCommands(raw.allowed_commands.filter((x): x is string => typeof x === 'string').join(','));
  } catch {
    return [];
  }
}

/** 记下一个「以后都允许」的前缀；前缀不合法（带 shell 控制符）时抛错。 */
export function allowCommand(project: string, prefix: string): void {
  const [valid] = config.parseAllowCommands(prefix);
  if (!valid) throw new Error('没有可记下的命令前缀');
  const current = allowedCommands(project);
  if (current.includes(valid)) return;
  const file = path.join(studioRoot(project), allowFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, marshalIndent({ allowed_commands: [...current, valid] }) + '\n', 0o644);
}

/** 命令是否落在某个前缀下：与 claude 的 Bash(<前缀>:*) 同一个意思，前缀后面要么结束、要么是空白。 */
export function matchesPrefix(command: string, prefixes: readonly string[]): boolean {
  const trimmed = command.trim();
  return prefixes.some((prefix) => trimmed === prefix || trimmed.startsWith(prefix + ' '));
}

/** 等用户回答的一条请求。 */
export interface PendingPermission {
  inbox: string;
  turnID: string;
  request: PermissionRequest;
}

/** permission / permission-resolved 事件带的字段。 */
export interface PermissionEventData {
  id: string;
  tool_name?: string;
  command?: string;
  description?: string;
  suggestion?: string;
  input?: unknown;
  decision?: PermissionDecision;
}

export function permissionEventJSON(p: PermissionEventData): Record<string, unknown> {
  return {
    id: p.id,
    tool_name: p.tool_name || undefined,
    command: p.command || undefined,
    description: p.description || undefined,
    suggestion: p.suggestion || undefined,
    input: p.tool_name && p.tool_name !== 'Bash' ? p.input : undefined,
    decision: p.decision || undefined,
  };
}

type Emit = (turnID: string, event: { kind: string; permission?: PermissionEventData; text?: string }) => void;

/** 这个项目现在是不是自动批准。配置读不了时按不自动处理：宁可多问一次。 */
export function autoApprove(project: string): boolean {
  try {
    return config.load(project, null).autoApprove;
  } catch {
    return false;
  }
}

/** noticeMaxRunes 是「已自动允许」那一行里命令最多显示几个字。 */
const noticeMaxRunes = 40;

/**
 * 自动允许的通知只说一句是什么：命令常是多行脚本、heredoc，整段贴进对话会占好几屏。
 * 只取第一行非空内容、压掉连续空白，超出 noticeMaxRunes 截断加「…」；多行的也加「…」。
 */
export function noticeSubject(text: string): string {
  const lines = text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const chars = [...first];
  if (chars.length > noticeMaxRunes) return `${chars.slice(0, noticeMaxRunes).join('')}…`;
  return lines.length > 1 ? `${first} …` : first;
}

/**
 * 看一遍收件目录：新请求里命令落在「以后都允许」前缀下的直接放行，其余发 permission 事件、记进 pending。
 */
export function pollPermissions(project: string, inbox: string, turnID: string, pending: Map<string, PendingPermission>, seen: Set<string>, emit: Emit): void {
  let allowed: string[] | null = null;
  let auto: boolean | null = null;
  for (const { request, answered } of listPermissionRequests(inbox)) {
    if (answered || seen.has(request.id)) continue;
    seen.add(request.id);
    // 每次有新请求才读一次配置：一轮进行中在设置页打开自动批准，下一条请求就不再问。
    auto ??= autoApprove(project);
    if (auto) {
      writePermissionResponse(inbox, request.id, { decision: 'allow' });
      emit(turnID, { kind: 'notice', text: `已自动允许：${noticeSubject(request.command || request.description || request.tool_name || '一次调用')}` });
      continue;
    }
    allowed ??= allowedCommands(project);
    if (request.command && matchesPrefix(request.command, allowed)) {
      writePermissionResponse(inbox, request.id, { decision: 'allow' });
      continue;
    }
    pending.set(request.id, { inbox, turnID, request });
    emit(turnID, {
      kind: KindPermission,
      permission: {
        id: request.id,
        tool_name: request.tool_name,
        command: request.command,
        description: request.description,
        suggestion: request.suggestion,
        input: request.input,
      },
    });
  }
}

/** 界面的答复。always 记下前缀再放行；返回 false 表示这条请求已经不在等（答过了、这一轮结束了）。 */
export function answerPermission(
  project: string,
  pending: Map<string, PendingPermission>,
  id: string,
  decision: 'allow' | 'always' | 'deny',
  message: string,
  emit: Emit,
): boolean {
  const item = pending.get(id);
  if (!item) return false;
  if (decision === 'always') {
    const prefix = item.request.suggestion ?? '';
    if (prefix === '') throw new Error('这条调用拼不出安全的命令前缀，只能允许这一次');
    allowCommand(project, prefix);
  }
  if (!writePermissionResponse(item.inbox, id, { decision, message })) {
    pending.delete(id);
    return false;
  }
  pending.delete(id);
  emit(item.turnID, { kind: KindPermissionResolved, permission: { id, decision } });
  // 同一轮里已经在等、命令也落在新前缀下的，一并放行。
  if (decision === 'always') {
    const prefix = [item.request.suggestion!];
    for (const [otherID, other] of [...pending]) {
      if (other.turnID === item.turnID && other.request.command && matchesPrefix(other.request.command, prefix)) {
        writePermissionResponse(other.inbox, otherID, { decision: 'allow' });
        pending.delete(otherID);
        emit(other.turnID, { kind: KindPermissionResolved, permission: { id: otherID, decision: 'allow' } });
      }
    }
  }
  return true;
}

/** 这一轮结束：还在等的请求一律答成 expired，编排工具进程多半已经退出，答了也无妨。 */
export function expirePermissions(pending: Map<string, PendingPermission>, turnID: string, emit: Emit): void {
  for (const [id, item] of [...pending]) {
    if (item.turnID !== turnID) continue;
    writePermissionResponse(item.inbox, id, { decision: 'expired' });
    pending.delete(id);
    emit(turnID, { kind: KindPermissionResolved, permission: { id, decision: 'expired' } });
  }
}
