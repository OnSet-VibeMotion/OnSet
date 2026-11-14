import type { MemoryState } from '../types';
import { describeStep } from './RenderActivity';

/** 同一份进度用于记忆与进化页；完成数量是已交卷格数，不估算模型剩余时间。 */
export function ExamProgressPanel({ state }: { state: MemoryState }) {
  const exams = (state.exam_progress ?? []).filter((e) => e.status !== 'completed');
  return <>{exams.map((exam) => {
    const done = exam.cells.filter((c) => c.status === 'completed').length;
    const running = exam.cells.filter((c) => c.status === 'running').length;
    return <section className="exam-progress" key={exam.id} aria-label="考试进度">
      <h3>{exam.id} · {exam.status === 'running' ? '正在考试' : exam.status === 'cancelled' ? '已取消' : '执行失败'}</h3>
      <p role="status">已完成 {done} / {exam.cells.length} 组 · {running} 组正在作答</p>
      <progress value={done} max={exam.cells.length || 1} aria-label="已完成的考试组数" />
      <p className="small muted">对照组使用现有记忆，试用组按召回条件加入待考经验。全部作答并检查完后才判分；完成进度不代表通过。</p>
      <h4>本场考什么</h4>
      <ul>{exam.trials.map((m) => <li key={m.name}>{m.description || m.name} · {(m.checks ?? []).map((id) => state.labels?.checks[id] ?? id).join('、')}</li>)}</ul>
      {exam.questions.map((q) => <details key={q.id} open>
        <summary>{q.id} · {q.scene_id}{q.holdout ? ' · 留出题' : ' · 历史错题'}</summary>
        {q.text && <p>{q.text}</p>}
        <ul>{exam.cells.filter((c) => c.question === q.id).map((c) => <li key={`${c.renderer}-${c.arm}-${c.repeat}`}>
          {c.renderer} · {c.arm === 'control' ? '对照组' : '试用组'} · 第 {c.repeat} 次：
          {c.status === 'queued' ? '等待空位' : c.status === 'running' ? '作答与检查中' : c.status === 'cancelled' ? '未开始，已取消' :
            c.result?.invalid ? '执行无效' : c.result?.passed ? '检查通过' : `查出 ${c.result?.problems ?? 0} 项问题`}
          {c.result?.error && <p className="small">{c.result.error}</p>}
          {c.activity && c.activity.steps.length > 0 && <details>
            <summary>查看过程 · 共 {c.activity.step_count} 步</summary>
            <ol className="exam-progress-steps">{c.activity.steps.slice(-12).map((step, i) => {
              const view = describeStep(step, '');
              return <li key={i}>{view.verb} {view.target}</li>;
            })}</ol>
          </details>}
        </li>)}</ul>
      </details>)}
      {exam.error && <p role="alert">{exam.error}</p>}
    </section>;
  })}</>;
}
