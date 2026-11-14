import type { ExamResult } from '../types';
import '../human-acceptance.css';

export function HumanAcceptance({ exam }: { exam: ExamResult }) {
  const acceptance = exam.human_acceptance;
  if (!acceptance) return null;
  const scenes = acceptance.question_ids.map((id) => {
    const question = exam.questions.find((q) => q.id === id);
    return question ? `${id} · ${question.scene_id}` : id;
  });
  return <section className="human-acceptance" aria-label="人工验收结论">
    <div className="human-acceptance-heading"><strong>进化完成</strong><span>人工验收通过</span></div>
    <p>{acceptance.description}</p>
    <p className="small">已验收 {exam.id} · {scenes.join('、')}。这条经验正在生效，后续渲染符合适用条件的镜头会继续带上。</p>
    <details><summary>查看验收记录</summary><p>{acceptance.note}</p><blockquote>{acceptance.user_statement}</blockquote><p className="small muted">{acceptance.accepted_at}</p></details>
    <p className="small muted">机器检查备注和原始评分保留如下；人工验收只涵盖上面列出的镜头。</p>
    {exam.original_verdict && <details><summary>原始机器判卷记录</summary>
      <p>对照 {exam.original_verdict.control_score} 分 → 试用 {exam.original_verdict.trial_score} 分</p>
      <ul>{exam.original_verdict.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>
    </details>}
  </section>;
}
