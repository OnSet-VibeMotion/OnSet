import type { Project, SeriesItem } from '../../types';
import type { ProjectSummary } from '../home/helpers';
import { summaryText } from '../home/helpers';
import { Icon } from '../Icon';

export function SeriesEpisodesTab(props: {
  series: SeriesItem;
  episodes: Project[];
  summaries: Record<string, ProjectSummary>;
  onStartNext?: (item: SeriesItem) => void;
  onOpenProject?: (projectId: string) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="series-episodes">
      <div className="series-ep-bar">
        <span className="series-ep-hint">下一期建议编号：EP{String(props.series.next_episode).padStart(2, '0')}</span>
        {props.onStartNext && (
          <button
            className="pill primary-pill"
            onClick={() => {
              props.onStartNext!(props.series);
              props.onClose();
            }}
          >
            <Icon name="plus" size={11} />
            新建下一期
          </button>
        )}
      </div>
      {props.episodes.length === 0 ? (
        <p className="series-empty">这个专栏还没有期数。点右上角「新建下一期」，或在左侧把已有项目归入本专栏。</p>
      ) : (
        <ul className="series-ep-list">
          {props.episodes.map((p) => {
            const summary = props.summaries[p.id];
            return (
              <li key={p.id}>
                <button
                  className="series-ep-row"
                  onClick={() => {
                    if (props.onOpenProject) {
                      void props.onOpenProject(p.id);
                      props.onClose();
                    }
                  }}
                >
                  <span className="series-ep-badge mono">
                    {p.episode ? `EP${String(p.episode).padStart(2, '0')}` : '番外'}
                  </span>
                  <span className="series-ep-info">
                    <strong>{p.name}</strong>
                    <span>{summaryText(summary) || p.path}</span>
                  </span>
                  <Icon name="next" size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
