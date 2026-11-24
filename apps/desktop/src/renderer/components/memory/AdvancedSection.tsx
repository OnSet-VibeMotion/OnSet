import { useState } from 'react';
import type { MemoryState } from '../../types';
import { ExamReview as ExamMatrix } from '../ExamReview';
import type { RunAction } from '../Preview';
import { describe, when } from './helpers';
import { RunsSection, ScoreCurve } from './RunsSection';

export function AdvancedSection({ state, version, run }: { state: MemoryState; version: number; run: RunAction }) {
  const [renderers, setRenderers] = useState('claude,codex');
  const [examIndex, setExamIndex] = useState(state.exams.length - 1);
  const [rollbackTo, setRollbackTo] = useState(0);
  const [allProjects, setAllProjects] = useState(false);
  const exam =
    state.exams[examIndex < 0 ? state.exams.length - 1 : Math.min(examIndex, state.exams.length - 1)] ?? null;
  const previous = state.snapshots.filter((id) => id !== state.status.snapshot);
  const others = state.timeline.filter((e) => e.type === 'episode' && e.project !== state.project);
  return (
    <>
      <p className="small muted">
        记忆库 {state.dir} · 当前存档 #{state.status.snapshot || '—'}
        {state.pinned > 0 ? `（项目钉在 #${state.pinned}）` : ''} · 共 {state.status.episodes} 段经历 · 每个镜头最多注入{' '}
        {state.budget} 字
      </p>

      <RunsSection runs={state.runs} />

      <section className="memory-section">
        <div className="toolbar">
          <h4>考试</h4>
          <span className="small muted">新经验先用这些渲染工具做对照考试，通过了才生效</span>
          <span className="spacer" />
          <input
            className="memory-input mono"
            value={renderers}
            aria-label="参加考试的渲染工具"
            onChange={(e) => setRenderers(e.currentTarget.value)}
          />
          <button
            onClick={() =>
              run('/api/memory/actions/exam', {
                renderers: renderers
                  .split(',')
                  .map((r) => r.trim())
                  .filter(Boolean),
              })
            }
          >
            考试
          </button>
          {state.exams.length > 1 && (
            <select
              value={examIndex}
              aria-label="选择考试"
              onChange={(e) => setExamIndex(Number(e.currentTarget.value))}
            >
              {state.exams.map((x, i) => (
                <option key={x.id} value={i}>
                  {x.id}
                </option>
              ))}
            </select>
          )}
        </div>
        {exam ? (
          <ExamMatrix exam={exam} version={version} state={state} />
        ) : (
          <p className="small muted">还没有考试。</p>
        )}
        {state.exams.length > 0 && <ScoreCurve exams={state.exams} />}
      </section>

      <section className="memory-section">
        <div className="toolbar">
          <h4>存档与回退</h4>
          <span className="small muted">记忆每次变化都存一份，可以整体退回到之前的某一份</span>
          <span className="spacer" />
          {previous.length > 0 ? (
            <>
              <select
                value={rollbackTo}
                aria-label="回退目标快照"
                onChange={(e) => setRollbackTo(Number(e.currentTarget.value))}
              >
                <option value={0}>回退到…</option>
                {previous.map((id) => (
                  <option key={id} value={id}>
                    存档 #{id}
                  </option>
                ))}
              </select>
              <button disabled={!rollbackTo} onClick={() => run('/api/memory/actions/rollback', { to: rollbackTo })}>
                回退
              </button>
            </>
          ) : (
            <span className="small muted">还没有可回退的存档</span>
          )}
        </div>
      </section>

      {others.length > 0 && (
        <section className="memory-section">
          <label className="small">
            <input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.currentTarget.checked)} />{' '}
            显示其他项目最近的 {others.length} 次渲染
          </label>
          {allProjects && (
            <ol className="memory-activity">
              {others.map((event, index) => {
                const { text, tone } = describe(event, state.labels);
                return (
                  <li key={index} className={tone}>
                    <span className="memory-time">{when(event.time)}</span>
                    <span className="muted">{event.project || '（未记项目）'}</span>
                    <span>{text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
