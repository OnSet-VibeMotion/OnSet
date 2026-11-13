/**
 * 编排工具要运行白名单外的命令时，在客户端里问用户。
 *
 * claude -p 遇到需要批准的工具调用时，可以交给一个 MCP 工具去问（--permission-prompts host +
 * --permission-prompt-tool）。这个 MCP 工具就是 am studio permission-mcp：它把请求写进这一轮收件目录的
 * permissions/ 子目录，等客户端写回答复；客户端后端轮询到请求就发 permission 事件，界面弹出卡片，
 * 用户点了之后后端写答复文件。走文件而不是 HTTP，理由与 am studio show 相同（见 ./index.ts）。
 *
 * claude 与 qoder 经这个审批 MCP 问（qoder 的 --permission-prompt-tool 帮助里没列，实测可用）；codebuddy、opencode、
 * codex 在客户端里改用双向协议（ACP、codex app-server，见 agentrun/acp.ts、codexapp.ts），它们的审批请求由
 * agentrun 直接写进同一个收件目录（studio/sessions.ts 的 spec.ask），后面的轮询、卡片、以后都允许完全相同。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { marshal } from '../gojson';

/** 收件目录里放审批请求与答复的子目录。不能直接放在收件目录里：切页请求的轮询会把读不懂的 .json 删掉。 */
export const PermissionsSubdir = 'permissions';
/** 会话事件：编排工具在等用户批准一条工具调用。 */
export const KindPermission = 'permission';
/** 会话事件：这条请求有了结果（允许、拒绝，或这一轮结束时没人回答）。 */
export const KindPermissionResolved = 'permission-resolved';
/** claude 的 --mcp-config 里给审批服务起的名字；工具名就是 mcp__<名字>__ask。 */
export const PermissionServerName = 'am_studio';
export const PermissionToolName = 'mcp__' + PermissionServerName + '__ask';

/** 一条审批请求。tool_name / input 原样来自 claude；command 与 suggestion 是给界面看的。 */
export interface PermissionRequest {
  id: string;
  tool_name: string;
  input: unknown;
  /** Bash 调用的命令行；其他工具为空。 */
  command?: string;
  /** Bash 调用自带的一句说明。 */
  description?: string;
  /** 「以后都允许」要记下的命令前缀；拼不出安全的前缀时为空，界面就不给这个选项。 */
  suggestion?: string;
}

export type PermissionDecision = 'allow' | 'always' | 'deny' | 'expired';

/** 后端写回的答复。 */
export interface PermissionResponse {
  decision: PermissionDecision;
  /** 拒绝时告诉编排工具的话。 */
  message?: string;
}

export function permissionsDir(inbox: string): string {
  return path.join(inbox, PermissionsSubdir);
}

function requestFile(inbox: string, id: string): string {
  return path.join(permissionsDir(inbox), id + '.request.json');
}

function responseFile(inbox: string, id: string): string {
  return path.join(permissionsDir(inbox), id + '.response.json');
}

/** 先写临时名再改名，轮询时不会读到写了一半的文件。 */
function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(4).toString('hex') + '.tmp');
  fs.writeFileSync(tmp, body, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

/** 命令的第一个词要再带一个子命令才有意义的那几个（git status 与 git push 不是一回事）。 */
const twoWordCommands = new Set(['git', 'npm', 'npx', 'pnpm', 'yarn', 'uv', 'pip', 'pip3', 'brew', 'docker', 'cargo', 'go', 'gh']);
/** 拼前缀时遇到这些字符就放弃：带了的话一条「前缀」就能拼出任意命令（与 parseAllowCommands 同一张表）。 */
const shellControl = /[;&|`$<>()\\"'*\n]/;

/**
 * 「以后都允许」记下的命令前缀：命令的第一个词，git、npm 这类再带上子命令。
 * 命令里有管道、重定向、变量这类 shell 控制符时不给前缀——只记第一个词会把整条复合命令都放行。
 */
export function commandPrefix(command: string): string {
  const trimmed = command.trim();
  if (trimmed === '' || shellControl.test(trimmed)) return '';
  const words = trimmed.split(/\s+/);
  const first = words[0];
  if (first.includes('=') || first.includes('/')) return '';
  if (twoWordCommands.has(first)) return words.length > 1 && /^[a-z][\w-]*$/.test(words[1]) ? first + ' ' + words[1] : '';
  return first;
}

let lastStamp = 0n;

function nextStamp(): bigint {
  let n = BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
  if (n <= lastStamp) n = lastStamp + 1n;
  lastStamp = n;
  return n;
}

/** 写一条审批请求；返回请求编号。 */
export function writePermissionRequest(inbox: string, toolName: string, input: unknown): PermissionRequest {
  // 编号以纳秒级时间开头、补零到 20 位，按名字排序就是写入顺序（同一毫秒里的两条也不乱）。
  const id = String(nextStamp()).padStart(20, '0') + '-' + crypto.randomBytes(4).toString('hex');
  const obj = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const command = toolName === 'Bash' && typeof obj.command === 'string' ? obj.command : '';
  const description = toolName === 'Bash' && typeof obj.description === 'string' ? obj.description : '';
  const req: PermissionRequest = {
    id,
    tool_name: toolName,
    input,
    command: command || undefined,
    description: description || undefined,
    suggestion: command ? commandPrefix(command) || undefined : undefined,
  };
  writeAtomic(requestFile(inbox, id), marshal(req) + '\n');
  return req;
}

/** 后端写答复。已经答过的不再改：用户连点两下只算第一下。返回是否写入。 */
export function writePermissionResponse(inbox: string, id: string, response: PermissionResponse): boolean {
  if (!fs.existsSync(requestFile(inbox, id)) || fs.existsSync(responseFile(inbox, id))) return false;
  writeAtomic(responseFile(inbox, id), marshal({ decision: response.decision, message: response.message || undefined }) + '\n');
  return true;
}

function readJSON<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** 收件目录里的全部审批请求（按编号排序，编号以时间开头），以及各自有没有答复。 */
export function listPermissionRequests(inbox: string): Array<{ request: PermissionRequest; answered: boolean }> {
  let names: string[];
  try {
    names = fs.readdirSync(permissionsDir(inbox)).filter((name) => name.endsWith('.request.json'));
  } catch {
    return [];
  }
  const out: Array<{ request: PermissionRequest; answered: boolean }> = [];
  for (const name of names.sort()) {
    const request = readJSON<PermissionRequest>(path.join(permissionsDir(inbox), name));
    if (!request || typeof request.id !== 'string') continue;
    out.push({ request, answered: fs.existsSync(responseFile(inbox, request.id)) });
  }
  return out;
}

/** 等答复，每 interval 毫秒看一次；signal 中止时返回 null。 */
export async function waitPermissionResponse(inbox: string, id: string, interval: number, signal?: AbortSignal): Promise<PermissionResponse | null> {
  for (;;) {
    if (signal?.aborted) return null;
    const response = readJSON<PermissionResponse>(responseFile(inbox, id));
    if (response && typeof response.decision === 'string') return response;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * 把答复译成 claude 的 --permission-prompt-tool 要的结果：允许时原样带回 input（updatedInput 必填），
 * 拒绝时给一句它能照着改的话。
 */
export function permissionToolResult(request: Pick<PermissionRequest, 'input'>, response: PermissionResponse): string {
  if (response.decision === 'allow' || response.decision === 'always') {
    return JSON.stringify({ behavior: 'allow', updatedInput: request.input ?? {} });
  }
  let message = response.message || '';
  if (message === '') {
    message =
      response.decision === 'expired'
        ? '这一轮已经结束，没人批准这条调用。'
        : '用户拒绝了这条调用。换一种不需要它的做法；确实非它不可时，先在回复里说明为什么要用它。';
  }
  return JSON.stringify({ behavior: 'deny', message });
}

/** 审批请求的轮询间隔（毫秒），与切页请求相同。 */
export const PermissionPollInterval = 300;

/**
 * am studio permission-mcp 的 MCP 服务：stdio 上按行收发 JSON-RPC，只提供一个工具 ask。
 * claude 遇到需要批准的调用时调 ask（参数是 tool_name、input），这里写请求、等客户端答复，
 * 再把答复译成 claude 要的结果。
 *
 * 收件目录（ViewInboxEnv）不在时直接拒绝：只有客户端会给 claude 挂这个服务，
 * 不在客户端里却被调到，说明配置错了，放行比拒绝危险。
 */
export async function servePermissionMCP(
  lines: AsyncIterable<string>,
  write: (line: string) => void,
  inbox: string,
  signal?: AbortSignal,
): Promise<void> {
  const send = (msg: Record<string, unknown>): void => write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const pending: Promise<void>[] = [];
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    const id = msg.id;
    if (id === undefined) continue; // 通知（notifications/initialized 等）不用回。
    switch (msg.method) {
      case 'initialize':
        send({
          id,
          result: {
            protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: PermissionServerName, version: '1' },
          },
        });
        break;
      case 'tools/list':
        send({
          id,
          result: {
            tools: [
              {
                name: 'ask',
                description: '在 ArticleToMotion 客户端里请用户批准一次工具调用（只供权限审批使用）',
                inputSchema: {
                  type: 'object',
                  properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
                  required: ['tool_name', 'input'],
                },
              },
            ],
          },
        });
        break;
      case 'tools/call': {
        const args = (msg.params?.arguments ?? {}) as { tool_name?: unknown; input?: unknown };
        const toolName = typeof args.tool_name === 'string' ? args.tool_name : '';
        const input = args.input ?? {};
        const answer = async (): Promise<void> => {
          let text: string;
          if (inbox === '') {
            text = permissionToolResult({ input }, { decision: 'deny', message: '不在 ArticleToMotion 客户端里，没有人能批准这条调用。' });
          } else {
            const req = writePermissionRequest(inbox, toolName, input);
            const response = (await waitPermissionResponse(inbox, req.id, PermissionPollInterval, signal)) ?? { decision: 'expired' as const };
            text = permissionToolResult(req, response);
          }
          send({ id, result: { content: [{ type: 'text', text }] } });
        };
        // 不等这一条答完再读下一行：claude 可能并行发几条调用。
        pending.push(answer());
        break;
      }
      case 'ping':
        send({ id, result: {} });
        break;
      default:
        send({ id, error: { code: -32601, message: 'method not found: ' + String(msg.method) } });
    }
  }
  await Promise.all(pending);
}
