/**
 * 输入框润色：把用户还没发出的一句话改得更清楚、更好执行，交还给用户自己决定发不发。
 *
 * 不写项目文件、不开对话轮次。提示词在 assets/optimizer/polish.md。
 */
import { extractJSONObject } from './extract';
import { missing, polishKeeps } from './guard';
import { fillTemplate, readTemplate } from './template';

/** 给模型看的材料。 */
export interface PolishInput {
  /** 用户写的原文。 */
  draft: string;
  /** 用户开着哪一页、哪个对象（studio.describeView 的结果）；没开页面为空。 */
  view?: string;
  /** 这条消息带着的引用的标签。 */
  quotes?: string[];
  /** 最近一条回复的末尾一段。 */
  lastReply?: string;
  /** 项目的做法（流程）与现在走到的那一站。 */
  flow?: string;
  station?: string;
}

export interface PolishResult {
  decision: 'skip' | 'rewrite';
  text: string;
  notes: string[];
}

/** 最近一条回复只给末尾这么多字：用户多半是在回答它最后的问题。 */
export const LastReplyLimit = 1500;

/** 改写稿的长度上限：原文的两倍，原文很短时也给到 400 字。 */
export function polishLimit(draft: string): number {
  return Math.max(400, [...draft].length * 2);
}

export function buildPolishPrompt(input: PolishInput, retryNote = ''): string {
  const reply = input.lastReply ?? '';
  const chars = [...reply];
  const evidence: Record<string, unknown> = { draft: input.draft };
  if (input.view) evidence.view = input.view;
  if (input.quotes && input.quotes.length > 0) evidence.quotes = input.quotes;
  if (reply !== '') evidence.last_reply = chars.length > LastReplyLimit ? '……' + chars.slice(-LastReplyLimit).join('') : reply;
  if (input.flow) evidence.flow = input.flow;
  if (input.station) evidence.station = input.station;
  let prompt = fillTemplate(readTemplate('polish.md'), evidence);
  if (retryNote !== '') prompt += `\n## 上一次的问题\n\n${retryNote}\n`;
  return prompt;
}

/** 解析与核对模型的回复。不合格时抛 PolishRejected，带着可以写进重试提示词的原因。 */
export function parsePolish(raw: string, draft: string): PolishResult {
  const obj = extractJSONObject(raw, 'text');
  if (!obj) throw new PolishRejected('回复里没有要求的 JSON 对象', '只输出一个 JSON 对象：{"decision": …, "text": …, "notes": […]}，前后不要写别的话。');
  const decision = obj.decision === 'skip' ? 'skip' : 'rewrite';
  const notes = Array.isArray(obj.notes) ? obj.notes.filter((n): n is string => typeof n === 'string' && n.trim() !== '').slice(0, 3) : [];
  if (decision === 'skip') return { decision, text: draft, notes: [] };
  const text = typeof obj.text === 'string' ? obj.text.trim() : '';
  if (text === '') throw new PolishRejected('改写稿是空的', '`text` 不能为空；不需要改时 decision 写 skip、text 原样照抄。');
  if (text === draft.trim()) return { decision: 'skip', text: draft, notes: [] };
  const limit = polishLimit(draft);
  if ([...text].length > limit) throw new PolishRejected(`改写稿太长（超过 ${limit} 字）`, `改写稿不要超过 ${limit} 字，只把原话说清楚，不要展开。`);
  const lost = missing(polishKeeps(draft), text);
  if (lost.length > 0) {
    throw new PolishRejected(`改写稿漏掉了 ${lost.join('、')}`, `改写稿漏掉了这些必须原样保留的内容：${lost.join('、')}。把它们一字不差地写回去。`);
  }
  return { decision, text, notes };
}

/** 模型的回复不合格。message 给用户看，retryNote 写进重试的提示词。 */
export class PolishRejected extends Error {
  constructor(
    message: string,
    readonly retryNote: string,
  ) {
    super(message);
    this.name = 'PolishRejected';
  }
}

/** 润色一次：不合格时带着原因再试一次，还不行就抛错（原文不动）。call 是一次模型调用。 */
export async function polish(input: PolishInput, call: (prompt: string) => Promise<string>): Promise<PolishResult> {
  let note = '';
  for (let attempt = 0; ; attempt++) {
    const raw = await call(buildPolishPrompt(input, note));
    try {
      return parsePolish(raw, input.draft);
    } catch (err) {
      if (!(err instanceof PolishRejected) || attempt >= 1) throw err;
      note = err.retryNote;
    }
  }
}
