import { useEffect, useMemo, useRef, useState } from 'react';
import './question.css';
import type { QuestionAnswerItem, QuestionAsk, QuestionItem, QuestionSubmitPayload } from '../../types';
import { Icon } from '../Icon';
import {
  clearQuestionDraft,
  isQuestionAnswered,
  loadQuestionDraft,
  type QuestionDraft,
  saveQuestionDraft,
} from './questionDraft';

export interface QuestionCardProps {
  ask: QuestionAsk;
  queueIndex?: number;
  queueTotal?: number;
  disabled?: boolean;
  onSubmit: (payload: QuestionSubmitPayload) => Promise<void> | void;
  onSkip?: () => Promise<void> | void;
}

export function QuestionCard(props: QuestionCardProps) {
  const { ask, disabled = false } = props;
  const total = ask.questions.length;
  const [draft, setDraft] = useState<QuestionDraft>(() => loadQuestionDraft(ask.id));
  const [mode, setMode] = useState<'all' | 'step'>(() => (total >= 4 ? 'step' : 'all'));
  const [activeIdx, setActiveIdx] = useState(0);
  const [showNote, setShowNote] = useState(() => draft.note !== '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const otherInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const sections = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    const next = loadQuestionDraft(ask.id);
    setDraft(next);
    setMode(ask.questions.length >= 4 ? 'step' : 'all');
    setActiveIdx(0);
    setShowNote(next.note !== '');
    setError('');
  }, [ask.id, ask.questions.length]);

  useEffect(() => {
    saveQuestionDraft(ask.id, draft);
  }, [ask.id, draft]);

  const answeredCount = useMemo(
    () => ask.questions.filter((q) => isQuestionAnswered(q, draft)).length,
    [ask.questions, draft],
  );
  const missingRequired = useMemo(
    () => ask.questions.filter((q) => q.required !== false && !isQuestionAnswered(q, draft)),
    [ask.questions, draft],
  );
  const ready = missingRequired.length === 0;

  const focusQuestion = (index: number) => {
    setActiveIdx(index);
    if (mode === 'all') {
      const id = ask.questions[index]?.id;
      if (id) sections.current[id]?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const toggleOption = (q: QuestionItem, label: string, index: number) => {
    if (disabled || submitting) return;
    setError('');
    setDraft((prev) => {
      const current = prev.selected[q.id] ?? [];
      if (q.multi_select) {
        const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
        return { ...prev, selected: { ...prev.selected, [q.id]: next } };
      }
      return {
        ...prev,
        selected: { ...prev.selected, [q.id]: [label] },
        otherActive: { ...prev.otherActive, [q.id]: false },
      };
    });
    if (!q.multi_select && mode === 'step' && index < total - 1) {
      const nextUnanswered = ask.questions.findIndex((other, i) => i > index && !isQuestionAnswered(other, draft));
      if (nextUnanswered >= 0) setActiveIdx(nextUnanswered);
    }
  };

  const toggleOther = (q: QuestionItem) => {
    if (disabled || submitting) return;
    setError('');
    const willEnable = q.multi_select ? !draft.otherActive[q.id] : true;
    setDraft((prev) => ({
      ...prev,
      selected: q.multi_select ? prev.selected : { ...prev.selected, [q.id]: [] },
      otherActive: { ...prev.otherActive, [q.id]: willEnable },
    }));
    if (willEnable) window.setTimeout(() => otherInputs.current[q.id]?.focus(), 0);
  };

  const changeOtherText = (q: QuestionItem, value: string) => {
    setError('');
    setDraft((prev) => ({
      ...prev,
      selected: !q.multi_select && value.trim() !== '' ? { ...prev.selected, [q.id]: [] } : prev.selected,
      otherActive: { ...prev.otherActive, [q.id]: value.trim() !== '' ? true : !!prev.otherActive[q.id] },
      otherText: { ...prev.otherText, [q.id]: value },
    }));
  };

  const submit = async () => {
    if (disabled || submitting) return;
    if (missingRequired.length > 0) {
      const first = missingRequired[0];
      const idx = ask.questions.findIndex((q) => q.id === first.id);
      setError(`请先完成「${first.header || first.question}」`);
      if (idx >= 0) focusQuestion(idx);
      return;
    }
    const answers: QuestionAnswerItem[] = ask.questions.map((q) => {
      const other = q.allow_other === false ? '' : draft.otherActive[q.id] ? (draft.otherText[q.id] ?? '').trim() : '';
      const selected = !q.multi_select && other !== '' ? [] : (draft.selected[q.id] ?? []);
      return {
        question_id: q.id,
        label: q.header || q.question,
        selected,
        ...(other ? { other } : {}),
      };
    });
    setSubmitting(true);
    setError('');
    try {
      await props.onSubmit({
        status: 'answered',
        answers,
        ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      });
      clearQuestionDraft(ask.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const skip = async () => {
    if (disabled || submitting || !props.onSkip) return;
    setSubmitting(true);
    setError('');
    try {
      await props.onSkip();
      clearQuestionDraft(ask.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const visibleQuestions =
    mode === 'step' && total > 1 ? [ask.questions[Math.min(activeIdx, total - 1)]] : ask.questions;

  return (
    <section
      className="question-card"
      data-question={ask.id}
      aria-label={ask.title ? `请你确认：${ask.title}` : `请你确认 ${total} 个问题`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <header className="q-head">
        <span className="q-badge">{ask.deferred ? '待你确认' : '需要你确认'}</span>
        {ask.title && <span className="q-title ellipsis">{ask.title}</span>}
        <span className="spacer" />
        {props.queueTotal && props.queueTotal > 1 && (
          <span className="q-counter">
            第 {(props.queueIndex ?? 0) + 1}/{props.queueTotal} 组
          </span>
        )}
        <span className="q-progress">
          已答 {answeredCount}/{total} 题
        </span>
        {total > 1 && (
          <button
            type="button"
            className="q-mode"
            onClick={() => setMode((m) => (m === 'all' ? 'step' : 'all'))}
            title={mode === 'all' ? '切换为逐题步进' : '展开全部问题'}
          >
            {mode === 'all' ? '逐题' : '全部'}
          </button>
        )}
      </header>

      {total > 1 && (
        <nav className="q-tabs" aria-label="问题列表">
          {ask.questions.map((q, index) => {
            const done = isQuestionAnswered(q, draft);
            const active = mode === 'step' && index === activeIdx;
            return (
              <button
                key={q.id}
                type="button"
                className={'q-tab' + (done ? ' done' : '') + (active ? ' active' : '')}
                onClick={() => focusQuestion(index)}
              >
                <span className="q-tab-mark" aria-hidden="true">
                  {done ? <Icon name="check" size={10} /> : index + 1}
                </span>
                <span>{q.header || `第 ${index + 1} 题`}</span>
              </button>
            );
          })}
        </nav>
      )}

      <div className="q-body">
        {visibleQuestions.map((q) => {
          const index = ask.questions.findIndex((item) => item.id === q.id);
          const picked = draft.selected[q.id] ?? [];
          const otherOn = !!draft.otherActive[q.id];
          const otherVal = draft.otherText[q.id] ?? '';
          return (
            <div
              key={q.id}
              className="q-item"
              data-question-item={q.id}
              ref={(el) => {
                sections.current[q.id] = el;
              }}
            >
              <div className="q-item-head">
                <span className="q-prompt">
                  {total > 1 ? `${index + 1}. ` : ''}
                  {q.question}
                </span>
                <span className="q-kind">
                  {q.multi_select ? '可多选' : '单选'}
                  {q.required === false ? ' · 可跳过' : ''}
                </span>
              </div>
              <div className="q-options" role={q.multi_select ? 'group' : 'radiogroup'} aria-label={q.question}>
                {q.options.map((opt) => {
                  const checked = picked.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      role={q.multi_select ? 'checkbox' : 'radio'}
                      aria-checked={checked}
                      disabled={disabled || submitting}
                      className={'q-opt' + (checked ? ' selected' : '')}
                      onClick={() => toggleOption(q, opt.label, index)}
                    >
                      <span className={'q-mark ' + (q.multi_select ? 'box' : 'dot')} aria-hidden="true">
                        {checked && (q.multi_select ? <Icon name="check" size={10} /> : <i />)}
                      </span>
                      <span className="q-opt-body">
                        <span className="q-opt-line">
                          <span className="q-opt-label">{opt.label}</span>
                          {opt.recommended && <span className="q-rec">推荐</span>}
                        </span>
                        {opt.description && <span className="q-opt-desc">{opt.description}</span>}
                      </span>
                    </button>
                  );
                })}
                {q.allow_other !== false && (
                  <div className={'q-other' + (otherOn ? ' selected' : '')}>
                    <button
                      type="button"
                      role={q.multi_select ? 'checkbox' : 'radio'}
                      aria-checked={otherOn}
                      disabled={disabled || submitting}
                      className="q-other-trigger"
                      onClick={() => toggleOther(q)}
                    >
                      <span className={'q-mark ' + (q.multi_select ? 'box' : 'dot')} aria-hidden="true">
                        {otherOn && (q.multi_select ? <Icon name="check" size={10} /> : <i />)}
                      </span>
                      <span className="q-opt-label">其他（自定义填写）</span>
                    </button>
                    {otherOn && (
                      <input
                        ref={(el) => {
                          otherInputs.current[q.id] = el;
                        }}
                        type="text"
                        className="q-other-input"
                        disabled={disabled || submitting}
                        value={otherVal}
                        placeholder={q.other_placeholder || '输入你的具体想法…'}
                        aria-label={`${q.header || q.question}自定义回答`}
                        onChange={(event) => changeOtherText(q, event.target.value)}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showNote ? (
        <div className="q-note-wrap">
          <input
            type="text"
            className="q-note-input"
            disabled={disabled || submitting}
            value={draft.note}
            placeholder="补充一句额外要求（可选）…"
            aria-label="补充说明"
            onChange={(event) => setDraft((prev) => ({ ...prev, note: event.target.value }))}
          />
        </div>
      ) : (
        <button type="button" className="link q-add-note" onClick={() => setShowNote(true)}>
          + 添加补充说明（可选）
        </button>
      )}

      {error && (
        <p className="q-error" role="alert">
          {error}
        </p>
      )}

      <footer className="q-foot">
        {props.onSkip && (
          <button type="button" className="ghost" disabled={disabled || submitting} onClick={() => void skip()}>
            跳过，改手动输入
          </button>
        )}
        <span className="spacer" />
        {mode === 'step' && total > 1 && activeIdx > 0 && (
          <button type="button" className="ghost" onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}>
            上一题
          </button>
        )}
        {mode === 'step' && total > 1 && activeIdx < total - 1 && (
          <button type="button" onClick={() => setActiveIdx((i) => Math.min(total - 1, i + 1))}>
            下一题
          </button>
        )}
        <button
          type="button"
          className="primary"
          disabled={disabled || submitting || !ready}
          onClick={() => void submit()}
          title={ready ? '提交全部回答（⌘↵）' : '请先完成必答题'}
        >
          {submitting ? '提交中…' : total > 1 ? `提交全部回答 (${answeredCount}/${total})` : '提交回答'}
        </button>
      </footer>
    </section>
  );
}
