import { useState } from 'react';
import { Icon } from '../Icon';
import type { TurnQuestion } from './model';

/**
 * 对话流内已完成的结构化提问历史回显：默认紧凑一行摘要，点击可展开查看完整原题、候选与勾选结果。
 */
export function QuestionSummary({ item }: { item: TurnQuestion }) {
  const [open, setOpen] = useState(false);
  const { request, resolution } = item;
  if (!resolution) return null;

  if (resolution.status === 'skipped') {
    return (
      <div className="question-summary muted" data-question-summary={request.id}>
        <span>已跳过问题卡片{request.title ? `（${request.title}）` : ''}，改为手动回复</span>
        <button type="button" className="link q-sum-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起' : '查看原题'}
        </button>
        {open && <QuestionDetail item={item} />}
      </div>
    );
  }

  if (resolution.status === 'expired' || resolution.status === 'cancelled') {
    return (
      <div className="question-summary muted" data-question-summary={request.id}>
        <span>
          {resolution.status === 'cancelled' ? '提问已取消' : '本轮结束，未提交回答'}
          {request.title ? `（${request.title}）` : ''}
        </span>
      </div>
    );
  }

  const answers = resolution.answers ?? [];
  const chips = request.questions.map((q) => {
    const ans = answers.find((a) => a.question_id === q.id);
    const parts: string[] = [];
    if (ans && ans.selected.length > 0) parts.push(ans.selected.join('、'));
    if (ans?.other) parts.push(parts.length > 0 ? `补充：${ans.other}` : ans.other);
    return {
      id: q.id,
      title: q.header || q.question,
      value: parts.join('；') || '未作答',
    };
  });

  return (
    <div className="question-summary" data-question-summary={request.id}>
      <div className="q-sum-head">
        <span className="q-sum-badge">
          <Icon name="check" size={12} />
          已确认 {request.questions.length} 项{request.title ? ` · ${request.title}` : ''}
        </span>
        <span className="spacer" />
        <button type="button" className="link q-sum-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '收起原题' : '查看原题'}
        </button>
      </div>
      <div className="q-sum-chips">
        {chips.map((chip) => (
          <span key={chip.id} className="q-sum-chip">
            <span className="q-sum-key">{chip.title}</span>
            <span className="q-sum-val">{chip.value}</span>
          </span>
        ))}
      </div>
      {resolution.note && <p className="q-sum-note">补充：{resolution.note}</p>}
      {open && <QuestionDetail item={item} />}
    </div>
  );
}

function QuestionDetail({ item }: { item: TurnQuestion }) {
  const answers = item.resolution?.answers ?? [];
  return (
    <div className="q-sum-detail">
      {item.request.questions.map((q, index) => {
        const ans = answers.find((a) => a.question_id === q.id);
        const picked = new Set(ans?.selected ?? []);
        return (
          <div key={q.id} className="q-sum-row">
            <div className="q-sum-q">
              {index + 1}. {q.question}
            </div>
            <div className="q-sum-opts">
              {q.options.map((opt) => (
                <span key={opt.label} className={'q-sum-opt' + (picked.has(opt.label) ? ' picked' : '')}>
                  {picked.has(opt.label) ? '✓ ' : ''}
                  {opt.label}
                </span>
              ))}
              {ans?.other && <span className="q-sum-opt picked">✓ 其他：{ans.other}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
