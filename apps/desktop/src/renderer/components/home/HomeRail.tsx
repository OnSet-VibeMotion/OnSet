import { useMemo, useState } from 'react';
import { canReveal, revealInFinder } from '../../reveal';
import type { Project, SeriesItem } from '../../types';
import { Icon } from '../Icon';
import { type ProjectSummary, summaryText } from './helpers';

export function HomeRail(props: {
  projects: Project[];
  summaries: Record<string, ProjectSummary>;
  currentId: string;
  seriesList?: SeriesItem[];
  activeSeriesId?: string;
  onSelectSeries?: (item: SeriesItem) => void;
  onCreateSeries?: () => void;
  onManageSeries?: (item: SeriesItem) => void;
  onBindProject?: (project: Project) => void;
  onOpen: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onBrowse: () => void;
  onBack?: () => void;
  onGuide?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [seriesOpen, setSeriesOpen] = useState(true);
  const [open, setOpen] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const seriesList = props.seriesList ?? [];

  // 目录已经不在的项目（删掉或挪走了）不混在列表里，底部给一个一键清理。
  const missing = props.projects.filter((p) => props.summaries[p.id]?.missing);
  const visibleProjects = useMemo(
    () =>
      [...props.projects]
        .filter((p) => !props.summaries[p.id]?.missing)
        .filter((p) => !query || p.name.includes(query) || p.path.includes(query)),
    [props.projects, props.summaries, query],
  );

  const seriesIds = useMemo(() => new Set(seriesList.map((s) => s.id)), [seriesList]);

  const projectsBySeries = useMemo(() => {
    const map = new Map<string, Project[]>();
    for (const s of seriesList) map.set(s.id, []);
    for (const p of visibleProjects) {
      if (p.series_id && map.has(p.series_id)) map.get(p.series_id)!.push(p);
    }
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          (a.episode ?? Number.MAX_SAFE_INTEGER) - (b.episode ?? Number.MAX_SAFE_INTEGER) ||
          (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? ''),
      );
    }
    return map;
  }, [seriesList, visibleProjects]);

  const ungrouped = useMemo(
    () =>
      visibleProjects
        .filter((p) => !p.series_id || !seriesIds.has(p.series_id))
        .sort((a, b) => (b.last_opened_at ?? '').localeCompare(a.last_opened_at ?? '')),
    [visibleProjects, seriesIds],
  );

  const cleanup = async () => {
    for (const p of missing) await props.onRemove(p.id);
  };

  const renderProjectRow = (p: Project, showEpBadge: boolean) => {
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
            <span className="ellipsis">
              {showEpBadge && p.episode && (
                <span className="rail-ep-tag mono">EP{String(p.episode).padStart(2, '0')}</span>
              )}
              {p.name}
            </span>
            <span className="rail-meta ellipsis">{summaryText(summary)}</span>
          </span>
        </button>
        {props.onBindProject && seriesList.length > 0 && !summary?.missing && (
          <button
            className={'rail-more rail-bind' + (canReveal ? '' : ' no-reveal')}
            aria-label={`设置 ${p.name} 的专栏归属`}
            title={p.series_id ? '调整专栏 / 期号' : '归入专栏'}
            onClick={() => props.onBindProject!(p)}
          >
            <Icon name="layers" size={11} />
          </button>
        )}
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

      {props.onCreateSeries && (
        <>
          <div className="rail-section-head">
            <button className="rail-head" aria-expanded={seriesOpen} onClick={() => setSeriesOpen(!seriesOpen)}>
              专栏
              <Icon name="chevron" size={11} />
            </button>
            <button className="rail-add-series" aria-label="新建专栏" title="新建专栏" onClick={props.onCreateSeries}>
              <Icon name="plus" size={12} />
            </button>
          </div>
          {seriesOpen && (
            <div className="rail-series-group">
              {seriesList.length === 0 ? (
                <div className="rail-empty">还没有专栏</div>
              ) : (
                seriesList.map((s) => {
                  const items = projectsBySeries.get(s.id) ?? [];
                  const isExpanded = !collapsed[s.id];
                  const active = props.activeSeriesId === s.id;
                  return (
                    <div key={s.id} className="rail-series-group">
                      <div className={'rail-series-row' + (active ? ' active' : '')}>
                        <button
                          className="rail-series-toggle"
                          aria-expanded={isExpanded}
                          onClick={() => setCollapsed((c) => ({ ...c, [s.id]: !c[s.id] }))}
                          title={s.description || s.name}
                        >
                          <Icon name="layers" size={12} />
                          <span className="ellipsis">{s.name}</span>
                          <span className="rail-series-count">{items.length}</span>
                        </button>
                        <div className="rail-series-actions">
                          {props.onSelectSeries && (
                            <button
                              className="rail-add-series"
                              aria-label={`在「${s.name}」新建下一期`}
                              title={`在「${s.name}」新建第 ${s.next_episode} 期`}
                              onClick={() => props.onSelectSeries!(s)}
                            >
                              <Icon name="plus" size={11} />
                            </button>
                          )}
                          {props.onManageSeries && (
                            <button
                              className="rail-add-series"
                              aria-label={`管理专栏「${s.name}」`}
                              title="专栏设置与期数"
                              onClick={() => props.onManageSeries!(s)}
                            >
                              <Icon name="settings" size={11} />
                            </button>
                          )}
                        </div>
                      </div>
                      {isExpanded && items.length > 0 && (
                        <ul className="rail-series-children">{items.map((p) => renderProjectRow(p, true))}</ul>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </>
      )}

      <button className="rail-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {seriesList.length > 0 ? '独立项目' : '最近项目'}
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <ul className="rail-recent">
          {ungrouped.length === 0 && (
            <li className="rail-empty">
              {query ? '没有匹配的项目' : seriesList.length > 0 ? '没有未归类的项目' : '还没有项目'}
            </li>
          )}
          {ungrouped.map((p) => renderProjectRow(p, false))}
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
