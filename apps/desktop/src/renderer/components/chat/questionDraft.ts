import type { QuestionAnswerItem, QuestionItem } from '../../types';

export interface QuestionDraft {
  selected: Record<string, string[]>;
  otherActive: Record<string, boolean>;
  otherText: Record<string, string>;
  note: string;
}

export const emptyQuestionDraft: QuestionDraft = { selected: {}, otherActive: {}, otherText: {}, note: '' };

function draftKey(id: string): string {
  return `onset:qdraft:${id}`;
}

/** 仅按自有属性读取，防止 question.id 为 constructor / __proto__ / toString 等继承键名时抛错或串值。 */
export function draftSelected(draft: QuestionDraft, id: string): string[] {
  if (!Object.hasOwn(draft.selected, id)) return [];
  const val = draft.selected[id];
  return Array.isArray(val) ? val : [];
}

export function draftOtherActive(draft: QuestionDraft, id: string): boolean {
  return Object.hasOwn(draft.otherActive, id) && draft.otherActive[id] === true;
}

export function draftOtherText(draft: QuestionDraft, id: string): string {
  if (!Object.hasOwn(draft.otherText, id)) return '';
  const val = draft.otherText[id];
  return typeof val === 'string' ? val : '';
}

export function loadQuestionDraft(id: string): QuestionDraft {
  try {
    const raw = window.sessionStorage.getItem(draftKey(id));
    if (!raw) return emptyQuestionDraft;
    const parsed = JSON.parse(raw) as Partial<QuestionDraft>;
    return {
      selected:
        parsed.selected && typeof parsed.selected === 'object' && !Array.isArray(parsed.selected)
          ? parsed.selected
          : {},
      otherActive:
        parsed.otherActive && typeof parsed.otherActive === 'object' && !Array.isArray(parsed.otherActive)
          ? parsed.otherActive
          : {},
      otherText:
        parsed.otherText && typeof parsed.otherText === 'object' && !Array.isArray(parsed.otherText)
          ? parsed.otherText
          : {},
      note: typeof parsed.note === 'string' ? parsed.note : '',
    };
  } catch {
    return emptyQuestionDraft;
  }
}

export function saveQuestionDraft(id: string, draft: QuestionDraft): void {
  try {
    window.sessionStorage.setItem(draftKey(id), JSON.stringify(draft));
  } catch {
    // 隐私模式或存储受限时忽略草稿缓存。
  }
}

export function clearQuestionDraft(id: string): void {
  try {
    window.sessionStorage.removeItem(draftKey(id));
  } catch {
    // 忽略。
  }
}

export function isQuestionAnswered(q: QuestionItem, draft: QuestionDraft): boolean {
  const picked = draftSelected(draft, q.id);
  const other = draftOtherActive(draft, q.id) ? draftOtherText(draft, q.id).trim() : '';
  return picked.length > 0 || other !== '';
}

export function buildQuestionAnswers(questions: QuestionItem[], draft: QuestionDraft): QuestionAnswerItem[] {
  return questions.map((q) => {
    const other =
      q.allow_other === false ? '' : draftOtherActive(draft, q.id) ? draftOtherText(draft, q.id).trim() : '';
    const selected = !q.multi_select && other !== '' ? [] : draftSelected(draft, q.id);
    return { question_id: q.id, label: q.header || q.question, selected, ...(other ? { other } : {}) };
  });
}

export function radioStepForKey(key: string): -1 | 0 | 1 {
  if (key === 'ArrowDown' || key === 'ArrowRight') return 1;
  if (key === 'ArrowUp' || key === 'ArrowLeft') return -1;
  return 0;
}
