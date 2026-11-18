/**
 * 编排会话太长时，下一轮换一个新的 CLI 会话接着做（分段交接）。
 *
 * 整片制作一直续接同一个 CLI 会话，工具输出、看过的图一路攒在上下文里：2026-11 实测一个会话 392 次调用，
 * 单次调用的上下文从 6.7 万涨到 42 万，另一个涨到 58 万。缓存命中率再高，每次调用也要把整段上下文按缓存价读一遍，
 * 花费与「上下文长度 × 调用次数」成正比。换新会话时只带制作说明、对话记录、偏好与交接说明（几万 token），
 * 进度以项目文件为准，让编排重新读文件，不靠旧会话里记得的帧号与路径。
 *
 * 只在一轮开始时换：这时不需要旧会话的缓存（换的成本是新会话第一次写入那几万 token），也不打断进行中的工作。
 * 压缩、清理旧工具结果这类在会话里动手的办法要编排工具自己开放，外部 CLI 大多不给，所以这里用换会话。
 */
import type { Entry } from '../ledger';

/** 平均每次调用的上下文到这么多 token 就换：几次实测的长会话都是在这之后才到 30–58 万。 */
export const RotateContextTokens = 200_000;

/**
 * 不报 token 的工具（qoder 只报额度）按累计调用次数换：上面那个 392 次的会话，平均上下文在约 250 次时过了 20 万。
 */
export const RotateCalls = 250;

/** 要换时给出原因（用户看得懂的一句话），不换返回空串。entries 是项目账本，cliSession 是现在续接的 CLI 会话。 */
export function rotationReason(entries: readonly Entry[] | null, cliSession: string): string {
  if (cliSession === '' || !entries) return '';
  let calls = 0;
  let last: Entry | null = null;
  for (const entry of entries) {
    if (entry.session !== cliSession || !entry.usage || !entry.usage.source) continue;
    calls += entry.usage.turns ?? 0;
    last = entry;
  }
  if (!last?.usage) return '';
  const context = last.usage.last_request_input_tokens;
  if (context !== undefined && context > 0) {
    return context >= RotateContextTokens ? `上一次模型请求读了约 ${Math.round(context / 10_000)} 万 token` : '';
  }
  const turns = last.usage.turns ?? 0;
  const input = last.usage.input_tokens ?? 0;
  // Codex app-server 的 turns 是 Studio 用户轮次，旧账没有单次模型请求量。
  if (last.usage.source !== 'codex app-server' && turns > 0 && input > 0) {
    const average = input / turns;
    if (average >= RotateContextTokens) return `上一轮平均每次调用要读约 ${Math.round(average / 10_000)} 万 token 的上下文`;
    return '';
  }
  if (calls >= RotateCalls) return `这个会话已经调用了 ${calls} 次`;
  return '';
}

/**
 * 换新会话时接在对话记录后面的交接说明。进度以项目文件为准：旧会话里看过的工具输出、帧号、路径都不在了，
 * 摘要式的记忆最容易丢的正是这类精确细节。待办清单是上一个会话最后的清单，照着接着做。
 */
export function handoffNote(reason: string, plan: readonly { text: string; status: string }[] | undefined): string {
  let note =
    `这是同一件事换了一个新会话接着做（${reason}，再续接下去每一步都更贵）。上一个会话里的工具输出、看过的图都不在了：` +
    '接着做之前先读项目文件确认做到哪一步（制作路线、分镜计划、各镜头的 scene.json 与产物），' +
    '对话记录里提到的帧号、路径、数字一律以文件为准，不要凭记忆。';
  const items = (plan ?? []).filter((item) => item.text.trim() !== '');
  if (items.length > 0) {
    note += '\n\n上一个会话最后的待办清单：\n' + items.map((item) => `- [${item.status === 'completed' ? 'x' : ' '}] ${item.text}${item.status === 'in_progress' ? '（进行中）' : ''}`).join('\n');
  }
  return note;
}
