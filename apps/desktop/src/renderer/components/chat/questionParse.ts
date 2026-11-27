import type { QuestionAnswerItem, QuestionAsk, QuestionItem, QuestionOption } from '../../types';

const questionsFence = /```questions\s*\n([\s\S]*?)```/g;
const choicesFence = /```choices\s*\n([\s\S]*?)```/g;

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function normalizeItems(rawQuestions: unknown[]): QuestionItem[] {
  const used = new Set<string>();
  const out: QuestionItem[] = [];
  for (let i = 0; i < rawQuestions.length && out.length < 6; i++) {
    const q = asObj(rawQuestions[i]);
    const question = trimStr(q.question);
    if (!question || !Array.isArray(q.options)) continue;
    const seen = new Set<string>();
    const options: QuestionOption[] = [];
    for (const rawOpt of q.options) {
      const opt = typeof rawOpt === 'string' ? { label: rawOpt } : asObj(rawOpt);
      const label = trimStr(opt.label);
      if (!label || seen.has(label)) continue;
      seen.add(label);
      const id = trimStr(opt.id);
      const description = trimStr(opt.description);
      options.push({
        ...(id ? { id } : {}),
        label,
        ...(description ? { description } : {}),
        ...(opt.recommended === true ? { recommended: true } : {}),
      });
      if (options.length >= 8) break;
    }
    if (options.length < 2) continue;
    let id = trimStr(q.id) || `q${out.length + 1}`;
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    used.add(id);
    const header = trimStr(q.header);
    const multi = q.multi_select === true || q.multiSelect === true;
    const required = q.required === false ? false : true;
    const allowOther = q.allow_other === false || q.allowOther === false ? false : true;
    const placeholder = trimStr(q.other_placeholder) || trimStr(q.otherPlaceholder);
    out.push({
      id,
      ...(header ? { header } : {}),
      question,
      ...(multi ? { multi_select: true } : {}),
      ...(required ? {} : { required: false }),
      options,
      ...(allowOther ? {} : { allow_other: false }),
      ...(placeholder ? { other_placeholder: placeholder } : {}),
    });
  }
  return out;
}

function parseLines(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const label = line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, '').trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function precedingPrompt(
  text: string,
  blockStart: number,
  fallbackIndex: number,
): { header: string; question: string } {
  const before = text.slice(0, blockStart);
  const lines = before
    .split('\n')
    .map((line) =>
      line
        .replace(/^[#>*\-\s]+/, '')
        .replace(/\*\*/g, '')
        .trim(),
    )
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? `问题 ${fallbackIndex}`;
  const cleaned =
    last
      .replace(/^\d+[.)、]\s*/, '')
      .replace(/[:：]\s*$/, '')
      .trim() || `问题 ${fallbackIndex}`;
  const header = [...cleaned].length > 8 ? [...cleaned].slice(0, 8).join('') : cleaned;
  return { header, question: cleaned };
}

/** 统计回复里合法 choices 代码块的数量。 */
export function countChoicesBlocks(text: string): number {
  let count = 0;
  for (const match of text.matchAll(choicesFence)) {
    if (parseLines(match[1]).length > 0) count++;
  }
  return count;
}

/**
 * 解析回复中的结构化多题提问（通道 2 兜底）：
 * 1. 优先解析 ```questions JSON 块；
 * 2. 若回复含 2 个及以上 ```choices 块，自动抓取每个块前的标题/问句升格为多题卡片，不再丢弃后续块。
 */
export function parseQuestionsBlock(text: string, stableId = 'prose'): QuestionAsk | null {
  for (const match of text.matchAll(questionsFence)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      const obj = asObj(parsed);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(obj.questions) ? obj.questions : null;
      if (!list) continue;
      const questions = normalizeItems(list);
      if (questions.length === 0) continue;
      const title = trimStr(obj.title);
      return {
        id: `prose-${stableId}`,
        ...(title ? { title } : {}),
        questions,
        source: 'prose',
      };
    } catch {
      // 畸形 JSON 跳过，保留原代码块给用户看。
    }
  }
  const choiceMatches = [...text.matchAll(choicesFence)];
  if (choiceMatches.length < 2) return null;
  const questions: QuestionItem[] = [];
  choiceMatches.forEach((match, idx) => {
    const labels = parseLines(match[1]).slice(0, 8);
    if (labels.length < 2) return;
    const { header, question } = precedingPrompt(text, match.index ?? 0, idx + 1);
    questions.push({
      id: `q${questions.length + 1}`,
      header,
      question,
      options: labels.map((label) => ({ label })),
    });
  });
  if (questions.length < 2) return null;
  return { id: `prose-${stableId}`, questions: questions.slice(0, 6), source: 'prose' };
}

/** 仅剥离被 parseQuestionsBlock 从多块 ```choices 升格接管的块（每块至少 2 项，最多 6 块），其余块保留原文。 */
export function stripPromotedChoices(text: string): string {
  let stripped = 0;
  return text.replace(choicesFence, (full, body: string) => {
    if (stripped >= 6 || parseLines(body).length < 2) return full;
    stripped++;
    return '';
  });
}

/** 仅剥离回复正文里被 parseQuestionsBlock 接管展示的第一块合法 ```questions 代码块，其余块与畸形块保留原文。 */
export function stripValidQuestions(text: string): string {
  let stripped = false;
  return text.replace(questionsFence, (full, body: string) => {
    if (stripped) return full;
    try {
      const parsed = JSON.parse(body) as unknown;
      const obj = asObj(parsed);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(obj.questions) ? obj.questions : null;
      if (list && normalizeItems(list).length > 0) {
        stripped = true;
        return '';
      }
    } catch {
      // 保留畸形块。
    }
    return full;
  });
}

/** 把多题作答结果格式化为清晰可读的中文消息（用于通道 2 发送下一轮）。 */
export function formatQuestionAnswersForChat(
  ask: Pick<QuestionAsk, 'title' | 'questions'>,
  answers: QuestionAnswerItem[],
  note?: string,
): string {
  const answeredCount = answers.filter((a) => a.selected.length > 0 || (a.other ?? '') !== '').length;
  const head = ask.title
    ? `已完成「${ask.title}」（${answeredCount}/${ask.questions.length} 题）：`
    : `已完成选择（${answeredCount}/${ask.questions.length} 题）：`;
  const lines = [head];
  ask.questions.forEach((q, idx) => {
    const ans = answers.find((item) => item.question_id === q.id);
    const title = q.header || q.question;
    const parts: string[] = [];
    if (ans && ans.selected.length > 0) parts.push(ans.selected.join('、'));
    if (ans?.other) parts.push(parts.length > 0 ? `补充：${ans.other}` : `其他：${ans.other}`);
    lines.push(`${idx + 1}. [${title}]：${parts.length > 0 ? parts.join('；') : '（未作答）'}`);
  });
  if (note && note.trim()) lines.push(`补充说明：${note.trim()}`);
  return lines.join('\n');
}
