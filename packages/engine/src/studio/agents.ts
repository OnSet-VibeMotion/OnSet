/**
 * 编排工具与渲染工具的选择。移植自 internal/studio/agents.go。
 * agentChoice 的校验、sessionConfig 与 overrideAgents 在 sessions.ts（会话与任务都要用，放一处免得循环导入）。
 */
import * as agentrun from '../agentrun';
import * as config from '../config';
import { envMap, lookPath } from '../envutil';
import * as tools from '../tools';
import { DecodeError, decodeJSON, fieldString, goMap, methodNotAllowed, writeError, writeJSON } from './http';
import { emit, kindNotice, sessionMetaJSON, updateMeta, validateChoice, type AgentChoice, type Session } from './sessions';
import type { Server } from './studio';

/**
 * agentOrder 是网页上编排工具的展示顺序与名称。取值必须都在 tools.ValidTools 里，
 * 「agentOrder 覆盖全部工具」的测试守着两边一致。
 */
export const agentOrder: readonly { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'qoder', label: 'Qoder' },
  { id: 'codebuddy', label: 'CodeBuddy' },
  { id: 'opencode', label: 'OpenCode' },
];

/** 从请求体读出 {tool, renderer}（Go 里内嵌在各请求结构里的 agentChoice）。 */
export function decodeChoice(body: Record<string, unknown>): AgentChoice {
  return { tool: fieldString(body, 'tool'), renderer: fieldString(body, 'renderer') };
}

/** withDefaults 用项目配置补齐没选的那一项。 */
export function withDefaults(choice: AgentChoice, cfg: config.Config): AgentChoice {
  return { tool: choice.tool || cfg.orchestrator, renderer: choice.renderer || cfg.renderer };
}

interface AgentInfo {
  id: string;
  label: string;
  command: string;
  installed: boolean;
  path?: string;
}

/** executable 从调用矩阵取工具的命令名，不在这里另写一份。 */
export function executable(tool: string): string {
  try {
    const { argv } = tools.orchestratorInvocation(tool, { workdir: '.', prompt: '-', sessionID: agentrun.newSessionID(tool) });
    return argv.length > 0 ? argv[0] : tool;
  } catch {
    return tool;
  }
}

/** agentsAPI 列出五家工具在本机是否装好，以及项目配置里的默认选择。 */
export function agentsAPI(s: Server, request: Request): Response {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const pathValue = envMap().PATH ?? '';
  const agents: AgentInfo[] = agentOrder.map((a) => {
    const info: AgentInfo = { id: a.id, label: a.label, command: executable(a.id), installed: false };
    try {
      info.path = lookPath(info.command, pathValue);
      info.installed = true;
    } catch {
      // 没装。
    }
    return info;
  });
  const result: Record<string, unknown> = { agents, orchestrator: '', renderer: '' };
  try {
    const p = s.currentProject();
    try {
      const cfg = config.load(p.path, null);
      result.orchestrator = cfg.orchestrator;
      result.renderer = cfg.renderer;
    } catch (err) {
      result.config_error = (err as Error).message;
    }
  } catch {
    // 没有打开项目：默认选择留空。
  }
  return writeJSON(200, goMap(result));
}

/**
 * switchSessionAgents 改一个会话的编排工具或渲染工具，从下一轮起生效。换编排工具时原 CLI 会话
 * 对新工具没有意义，清掉会话 id，下一轮按续接失败的路子带上对话记录开新会话。
 */
export async function switchSessionAgents(request: Request, sess: Session): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  let choice: AgentChoice;
  try {
    choice = decodeChoice(await decodeJSON(request));
  } catch (err) {
    if (err instanceof DecodeError) return writeError(400, 'invalid_json', '请求不是合法 JSON');
    throw err;
  }
  try {
    validateChoice(choice);
  } catch (err) {
    return writeError(400, 'invalid_agent', (err as Error).message);
  }
  if (sess.meta.running_turn) return writeError(409, 'turn_running', '这一轮还在进行，结束后再换工具');
  const switched = choice.tool !== '' && choice.tool !== sess.meta.tool;
  updateMeta(sess, (meta) => {
    if (choice.tool !== '') meta.tool = choice.tool;
    if (choice.renderer !== '') meta.renderer = choice.renderer;
    if (switched) meta.cli_session_id = undefined;
  });
  if (switched) emit(sess, '', { kind: kindNotice, text: '编排工具改为 ' + choice.tool + '，下一轮会带上之前的对话记录开新会话' });
  return writeJSON(200, sessionMetaJSON(sess.meta));
}
