import { useState } from 'react';
import type { MemoryState } from '../../types';
import { describe, when } from './helpers';

/** 本项目最近的事，写成一句话。 */
export function ActivitySection({ state }: { state: MemoryState }) {
  const [more, setMore] = useState(false);
  const events = state.timeline.filter((e) =>
    e.type === 'episode' ? e.project === state.project : !e.project || e.project === state.project,
  );
  const shown = more ? events : events.slice(0, 8);
  return (
    <section className="memory-section">
      <h4>渲染记录</h4>
      {events.length === 0 ? (
        <p className="small muted">这个项目还没有渲染记录。</p>
      ) : (
        <ol className="memory-activity">
          {shown.map((event, index) => {
            const { text, tone } = describe(event, state.labels);
            return (
              <li key={index} className={tone}>
                <span className="memory-time">{when(event.time)}</span>
                <span>{text}</span>
              </li>
            );
          })}
        </ol>
      )}
      {events.length > 8 && (
        <button className="link small" onClick={() => setMore(!more)}>
          {more ? '收起' : `显示全部 ${events.length} 条`}
        </button>
      )}
    </section>
  );
}
