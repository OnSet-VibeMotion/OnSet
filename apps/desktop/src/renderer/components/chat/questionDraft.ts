import type { QuestionItem } from '../../types';

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

export function loadQuestionDraft(id: string): QuestionDraft {
  try {
    const raw = window.sessionStorage.getItem(draftKey(id));
    if (!raw) return emptyQuestionDraft;
    const parsed = JSON.parse(raw) as Partial<QuestionDraft>;
    return {
      selected: parsed.selected && typeof parsed.selected === 'object' ? parsed.selected : {},
      otherActive: parsed.otherActive && typeof parsed.otherActive === 'object' ? parsed.otherActive : {},
      otherText: parsed.otherText && typeof parsed.otherText === 'object' ? parsed.otherText : {},
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
  const picked = draft.selected[q.id] ?? [];
  const other = draft.otherActive[q.id] ? (draft.otherText[q.id] ?? '').trim() : '';
  return picked.length > 0 || other !== '';
}
