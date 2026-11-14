import { useState } from 'react';
import type { ExamResult, MemoryState } from '../types';
import { ExamPlayer } from './ExamPlayer';

export function ExamReview({ exam, version, state }: { exam: ExamResult; version: number; state: MemoryState }) {
  const regression = exam.questions.find((q) => exam.cells.some((a) => a.question === q.id && a.arm === 'control' && a.passed &&
    exam.cells.some((b) => b.question === q.id && b.renderer === a.renderer && b.repeat === a.repeat && b.arm === 'trial' && !b.passed)));
  const [questionID, setQuestionID] = useState(regression?.id ?? exam.questions[0]?.id ?? '');
  const question = exam.questions.find((q) => q.id === questionID) ?? regression ?? exam.questions[0];
  const [renderer, setRenderer] = useState(exam.renderers[0] ?? '');
  const selectedRenderer = exam.renderers.includes(renderer) ? renderer : exam.renderers[0];
  const [repeat, setRepeat] = useState(1);
  const repeats = [...new Set(exam.cells.filter((c) => c.question === question?.id && c.renderer === selectedRenderer).map((c) => c.repeat))].sort((a, b) => a - b);
  const selectedRepeat = repeats.includes(repeat) ? repeat : repeats[0];
  const pick = (arm: 'control' | 'trial') => exam.cells.find((c) => c.question === question?.id && c.renderer === selectedRenderer && c.repeat === selectedRepeat && c.arm === arm) ?? null;
  const control = pick('control');
  const trial = pick('trial');
  const verdict = exam.verdict;
  const bothPassed = !verdict.invalid && !verdict.needs_human && !verdict.pass && exam.cells.length > 0 && exam.cells.every((c) => c.passed && !c.invalid);
  const conclusion = verdict.invalid ? '考试无效' : exam.cells.some((c) => c.incomplete) ? '检查依据不完整' : verdict.needs_human ? '暂不能下结论' : verdict.pass ? '考试通过' : bothPassed ? '未发现额外改善' : '考试未通过';
  const difference = !control || !trial || control.invalid || trial.invalid || control.incomplete || trial.incomplete ? '本题结果不完整，不能比较'
    : trial.problems < control.problems ? `带上后少了 ${control.problems - trial.problems} 处问题`
      : trial.problems > control.problems ? `带上后多了 ${trial.problems - control.problems} 处问题` : '两组查出的问题数量相同';
  return <div className="exam-review">
    <div className="exam-review-heading"><strong>{conclusion}</strong><span className="small muted">{exam.id} · {exam.questions.length} 道题 · {exam.applied === 'promoted' ? '经验已生效' : '本场未新增生效经验'}</span></div>
    {exam.evaluation_note && <p role="status">{exam.evaluation_note}</p>}
    <ul className="exam-lessons">{exam.trials.map((name) => <li key={name}>{state.memories.find((m) => m.name === name)?.description || name}</li>)}</ul>
    {bothPassed && <p className="exam-no-gain">两组都通过了本场检查，因此尚未证明这条经验带来额外改善。先核对检查是否覆盖原问题，再加入相关新镜头或做观看对照；重复相同满分题不能增加改善证据。</p>}
    {verdict.reasons.length > 0 && <details className="exam-reasons"><summary>为什么得出这个结论</summary><ul>{verdict.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul></details>}
    <div className="exam-question-picker" role="tablist" aria-label="选择考试镜头">{exam.questions.map((q) => <button key={q.id} role="tab" aria-selected={question?.id === q.id} onClick={() => setQuestionID(q.id)}>{q.id} · {q.scene_id}{q.holdout ? ' · 留出' : ''}</button>)}</div>
    <div className="exam-pair-heading"><h4>{question?.scene_id} · {difference}</h4>
      {exam.renderers.length > 1 && <select aria-label="对照渲染工具" value={selectedRenderer} onChange={(e) => setRenderer(e.currentTarget.value)}>{exam.renderers.map((r) => <option key={r}>{r}</option>)}</select>}
      {repeats.length > 1 && <select aria-label="对照重复次数" value={selectedRepeat} onChange={(e) => setRepeat(Number(e.currentTarget.value))}>{repeats.map((r) => <option key={r} value={r}>第 {r} 次</option>)}</select>}
    </div>
    {question?.text && <p className="exam-question-text">{question.text}</p>}
    <ExamPlayer key={`${exam.id}-${question?.id}-${selectedRenderer}-${selectedRepeat}`} control={control} trial={trial} version={version} labels={state.labels?.checks ?? {}} descriptions={Object.fromEntries(state.memories.map((m) => [m.name, m.description]))} />
    <p className="small muted">左边保留其他生效记忆，右边按召回条件加入待考经验。检查结果只说明对应问题，观看效果请结合画面判断。</p>
    <details><summary>查看整场评分</summary><p>对照 {verdict.control_score.toFixed(1)} 分 → 试用 {verdict.trial_score.toFixed(1)} 分。多条合考只说明整组效果。</p></details>
  </div>;
}
