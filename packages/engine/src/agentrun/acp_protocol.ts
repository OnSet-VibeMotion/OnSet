/**
 * ACP 协议消息、审批与用量解析的纯辅助函数。
 */
import { BasisTotalInput, type McpServer, newUsage } from '../tools';
import type { PermissionAnswer } from './interactive';

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 把一段 ACP content（ContentBlock 或 ToolCallContent 数组）里的文字拼起来。 */
export function acpText(content: unknown): string {
  if (Array.isArray(content))
    return content
      .map(acpText)
      .filter((s) => s !== '')
      .join('\n');
  const c = obj(content);
  if (c.type === 'text') return str(c.text);
  if (c.type === 'content') return acpText(c.content);
  if (c.type === 'diff') return `${str(c.path)} 已修改`;
  return '';
}

/** 审批请求里的工具调用 → 界面要的 (toolName, input)：shell 命令一律当 Bash，界面据此显示命令、记前缀。 */
export function acpPermissionTool(toolCall: unknown): { toolName: string; input: unknown } {
  const t = obj(toolCall);
  const raw = obj(t.rawInput);
  const command = str(raw.command) || str(raw.CommandLine);
  if (command !== '' || t.kind === 'execute') {
    const title = str(t.title);
    const desc = title !== '' && title !== command ? title : str(raw.description) || str(raw.toolSummary) || undefined;
    return { toolName: 'Bash', input: { command: command || title, description: desc } };
  }
  return {
    toolName: str(t.name) || str(t.title) || str(t.kind) || 'tool',
    input: t.rawInput ?? { title: str(t.title) },
  };
}

/** 判断 ACP 审批请求是不是调用 onset 自己的工具服务（如 agy 的 mcp_onset_* 或 call_mcp_tool）。 */
export function isAcpToolsServerCall(toolCall: unknown, server: McpServer | undefined): boolean {
  if (!server) return false;
  const t = obj(toolCall);
  const name = str(t.name);
  if (name.startsWith(`mcp_${server.name}_`) || name.startsWith(`mcp__${server.name}__`)) return true;
  if (name === 'call_mcp_tool' && str(obj(t.rawInput).ServerName) === server.name) return true;
  return false;
}

/** 用户的回答 → ACP 的选项。always 也只答「这一次」：「以后都允许」由客户端自己记，不写进对方的配置。 */
export function acpOutcome(options: unknown, answer: PermissionAnswer): Obj {
  const list = Array.isArray(options) ? options.map(obj) : [];
  const pick = (...kinds: string[]) => {
    for (const kind of kinds) {
      const found = list.find((o) => o.kind === kind);
      if (found) return str(found.optionId);
    }
    return '';
  };
  const allow = answer.decision === 'allow' || answer.decision === 'always';
  const optionId = allow ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always');
  if (optionId === '') return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId } };
}

/** ACP 一轮结束时报的用量（opencode 2.1 与 agy 1.5 实测：inputTokens 不含缓存，cachedRead/WriteTokens 另算；agy 的 outputTokens 已含 thoughtTokens）。 */
export function acpUsage(usage: unknown, turns = 1, singleRequest = false): ReturnType<typeof newUsage> | null {
  const u = obj(usage);
  if (typeof u.inputTokens !== 'number' && typeof u.outputTokens !== 'number') return null;
  const n = (v: unknown) => (typeof v === 'number' ? v : 0);
  const input = n(u.inputTokens) + n(u.cachedReadTokens) + n(u.cachedWriteTokens);
  const output = n(u.outputTokens);
  const thought = n(u.thoughtTokens);
  const total = typeof u.totalTokens === 'number' ? u.totalTokens : 0;
  // agy 的 outputTokens 已含 thoughtTokens（totalTokens === input + outputTokens），不要重复加。
  const outputIncludesThought = thought > 0 && total > 0 && input + output === total;
  const out = newUsage();
  out.input_tokens = input;
  out.cached_input_tokens = n(u.cachedReadTokens);
  out.output_tokens = outputIncludesThought ? output : output + thought;
  out.turns = Math.max(1, Math.trunc(turns));
  if (singleRequest && input > 0) out.last_request_input_tokens = input;
  out.source = 'acp usage';
  out.basis = BasisTotalInput;
  return out;
}

/**
 * codebuddy 的用量：每次模型请求推一条 usage_update，_meta.usage 是 OpenAI 式的 prompt_tokens（含缓存命中）
 * 与 completion_tokens；同一条消息会推好几次，按消息编号去重后相加（2026-11 用 codebuddy 2.168 实测）。
 */
export class CodebuddyUsage {
  private readonly seen = new Map<string, Obj>();

  add(update: Obj): void {
    const meta = obj(update._meta);
    const usage = obj(meta.usage);
    if (typeof usage.prompt_tokens !== 'number') return;
    const key = str(meta['codebuddy.ai/messageId']) || str(meta['codebuddy.ai/requestId']) || String(this.seen.size);
    this.seen.set(key, usage);
  }

  total(): ReturnType<typeof newUsage> | null {
    if (this.seen.size === 0) return null;
    const n = (v: unknown) => (typeof v === 'number' ? v : 0);
    const out = newUsage();
    out.input_tokens = 0;
    out.output_tokens = 0;
    out.cached_input_tokens = 0;
    for (const u of this.seen.values()) {
      out.input_tokens += n(u.prompt_tokens);
      out.output_tokens += n(u.completion_tokens);
      out.cached_input_tokens += n(obj(u.prompt_tokens_details).cached_tokens) || n(u.prompt_cache_hit_tokens);
    }
    out.turns = this.seen.size;
    out.source = 'codebuddy usage_update';
    out.basis = BasisTotalInput;
    return out;
  }
}
