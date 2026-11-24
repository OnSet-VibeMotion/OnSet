import { useMemo, useState } from 'react';
import { canReveal, revealInFinder } from '../../reveal';
import type { Project } from '../../types';
import { Icon } from '../Icon';
import { type ProjectSummary, summaryText } from './helpers';

export function HomeRail(props: {
  projects: Project[];
  summaries: Record<string, ProjectSummary>;
  currentId: string;
  onOpen: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onBrowse: () => void;
  onBack?: () => void;
  onGuide?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);
  // 目录已经不在的项目（删掉或挪走了）不混在列表里，底部给一个一键清理。
  const missing = props.projects.filter((p) => props.summaries[p.id]?.missing);
  const recent = useMemo(
    () =>
      [...props.projects]
        .filter((p) => !props.summaries[p.id]?.missing)
        .sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''))
        .filter((p) => !query || p.name.includes(query) || p.path.includes(query)),
    [props.projects, props.summaries, query],
  );
  const cleanup = async () => {
    for (const p of missing) await props.onRemove(p.id);
  };
  return (
    <nav className="home-rail" aria-label="项目">
      <label className="rail-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          placeholder="搜索项目"
          aria-label="搜索项目"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
      </label>
      {props.onBack && (
        <button className="rail-btn" onClick={props.onBack}>
          <Icon name="prev" size={14} />
          回到当前项目
        </button>
      )}
      <button className="rail-btn" onClick={props.onBrowse}>
        <Icon name="folder" size={14} />
        打开文件夹…
      </button>
      {props.onGuide && (
        <button className="rail-btn" id="open-guide" onClick={props.onGuide}>
          <Icon name="route" size={14} />
          新手引导
        </button>
      )}
      <button className="rail-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        最近项目
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <ul className="rail-recent">
          {recent.length === 0 && <li className="rail-empty">{query ? '没有匹配的项目' : '还没有项目'}</li>}
          {recent.map((p) => {
            const summary = props.summaries[p.id];
            return (
              <li key={p.id} className={'rail-row' + (p.id === props.currentId ? ' on' : '')}>
                <button
                  className="rail-item"
                  title={p.path}
                  onClick={() => void props.onOpen(p.id)}
                  disabled={summary?.missing}
                >
                  <span
                    className={
                      'rail-dot' +
                      (summary?.busy
                        ? ' busy'
                        : summary && summary.total > 0 && summary.completed === summary.total
                          ? ' ok'
                          : '')
                    }
                  />
                  <span className="rail-name">
                    <span className="ellipsis">{p.name}</span>
                    <span className="rail-meta ellipsis">{summaryText(summary)}</span>
                  </span>
                </button>
                {canReveal && !summary?.missing && (
                  <button
                    className="rail-more rail-reveal"
                    aria-label={`在 Finder 中打开 ${p.name}`}
                    title="在 Finder 中打开"
                    onClick={() => revealInFinder('', p.id)}
                  >
                    <Icon name="folder" size={11} />
                  </button>
                )}
                <button
                  className="rail-more"
                  aria-label={`从最近项目移除 ${p.name}`}
                  title="从列表移除（不删文件）"
                  onClick={() => void props.onRemove(p.id)}
                >
                  <Icon name="close" size={10} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {missing.length > 0 && (
        <button className="rail-cleanup" onClick={() => void cleanup()} title={missing.map((p) => p.path).join('\n')}>
          清理 {missing.length} 个已不存在的项目
        </button>
      )}
    </nav>
  );
}
