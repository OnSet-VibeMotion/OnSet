import { useState } from 'react';
import type { MemoryRow, MemoryState, MemorySuspect } from '../../types';
import { MemoryApplications } from '../MemoryApplications';
import type { RunAction } from '../Preview';
import { checkText, type Labels, label, statusText } from './helpers';

export function MemoryCard({
  memory,
  labels,
  weak,
  retest,
  suspect,
  renderer,
  run,
}: {
  memory: MemoryRow;
  labels: Labels;
  weak: boolean;
  retest: MemoryState['status']['retest'];
  suspect: MemorySuspect[];
  renderer: string;
  run: RunAction;
}) {
  const [open, setOpen] = useState(false);
  const stats = Object.entries(memory.stats ?? {});
  const recalled = stats.reduce((n, [, s]) => n + s.recalled, 0);
  const passed = stats.reduce((n, [, s]) => n + s.passed_first_try, 0);
  const guards = memory.kind === 'lesson' ? checkText(labels, memory.checked_by) : '';
  const examRenderer = memory.applies_when.renderers?.includes(renderer)
    ? renderer
    : memory.applies_when.renderers?.[0] || renderer;
  const facts = [
    guards && `防止：${guards}`,
    memory.applies_when.features?.length &&
      `适用：${memory.applies_when.features.map((f) => label(labels?.features, f)).join('、')}`,
    (memory.applies_when.renderers?.length || memory.applies_when.models?.length) &&
      `只给 ${[...(memory.applies_when.renderers ?? []), ...(memory.applies_when.models ?? [])].join('、')}`,
    memory.kind === 'preference' && (memory.scope ? '只用于本项目' : '用于所有项目'),
    memory.from_episodes?.length && `来自 ${memory.from_episodes.length} 次失败`,
    recalled > 0 && `用过 ${recalled} 次，${passed} 次一次通过`,
  ].filter(Boolean);
  return (
    <div className="memory-card">
      <div className="memory-card-head">
        <p className="memory-desc">{memory.description}</p>
        <div className="memory-card-actions">
          {statusText[memory.status] && <span className="memory-badge">{statusText[memory.status]}</span>}
          {weak && (
            <span className="memory-badge warn" title="最近用上它的镜头通过率不比没用时高">
              效果不明显
            </span>
          )}
          {suspect.length > 0 && (
            <span
              className="memory-badge warn"
              title={suspect
                .map((x) => `${x.renderer}：用了 ${x.recalled} 次，其中 ${x.harmful} 次它要防的问题照样出现`)
                .join('\n')}
            >
              可能没用
            </span>
          )}
          {memory.status === 'trial' && (
            <>
              {memory.kind === 'lesson' && memory.examinable && (
                <button
                  className="primary"
                  onClick={() => run('/api/memory/actions/exam', { renderers: [examRenderer], trial: memory.name })}
                >
                  只考这条
                </button>
              )}
              {(memory.kind === 'preference' || !memory.examinable) && (
                <button className="primary" onClick={() => run('/api/memory/actions/promote', { name: memory.name })}>
                  确认
                </button>
              )}
              <button onClick={() => run('/api/memory/actions/reject', { name: memory.name })}>不要</button>
            </>
          )}
          {memory.status === 'active' && weak && (
            <button onClick={() => run('/api/memory/actions/retire', { name: memory.name })}>停用</button>
          )}
          {['dormant', 'rejected'].includes(memory.status) && memory.kind === 'lesson' && memory.examinable && (
            <button onClick={() => run('/api/memory/actions/exam', { renderers: [examRenderer], name: memory.name })}>
              重新考试
            </button>
          )}
          {memory.status === 'active' &&
            suspect
              .filter((x) => !retest.some((r) => x.renderer.split('/')[0] === r.renderer))
              .map((x) => (
                <button
                  key={'s' + x.renderer}
                  onClick={() =>
                    run('/api/memory/actions/exam', { renderers: [x.renderer.split('/')[0]], name: memory.name })
                  }
                >
                  重考（{x.renderer.split('/')[0]}）
                </button>
              ))}
          {retest.map((r) => (
            <button
              key={r.renderer}
              title={`当初在 ${r.renderer} 上用 ${r.examined_models.join('、')} 考过，现在是 ${r.current_model}`}
              onClick={() => run('/api/memory/actions/exam', { renderers: [r.renderer], name: memory.name })}
            >
              换了模型，重考（{r.renderer}）
            </button>
          ))}
        </div>
      </div>
      {facts.length > 0 && <p className="small muted">{facts.join(' · ')}</p>}
      {memory.revised_by?.map((next) => (
        <p className="small muted" key={next.name}>
          {next.status === 'active' ? '已有生效修订' : next.status === 'trial' ? '有修订版在试用' : '修订版暂未生效'}：
          {next.description}
        </p>
      ))}
      {memory.status === 'trial' && memory.kind === 'lesson' && !memory.examinable && (
        <p className="small muted">这条要看相邻镜头的衔接才能判断有没有用，没法自动考试，需要你确认。</p>
      )}
      {memory.rejected_reason && <p className="error-line">{memory.rejected_reason}</p>}
      {memory.kind === 'lesson' && (
        <MemoryApplications memory={memory} featureLabels={labels?.features ?? {}} run={run} />
      )}
      <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起全文' : '查看全文'}
      </button>
      {open && (
        <>
          <pre className="memory-body">{memory.body}</pre>
          <p className="small muted mono">
            {memory.name}
            {memory.revises ? ` · 修订自 ${memory.revises}` : ''}
            {memory.verified_by?.length ? ` · 考试 ${memory.verified_by.join('、')}` : ''}
          </p>
        </>
      )}
    </div>
  );
}
