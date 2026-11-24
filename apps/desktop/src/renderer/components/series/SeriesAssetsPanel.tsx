import { useCallback, useEffect, useState } from 'react';
import { api, del, errorText, post, put } from '../../api';
import type { AssetSyncStatus, ProjectAssetCandidate, SeriesAssetsResponse } from '../../types';
import { Icon } from '../Icon';
import '../../series.css';

const kindLabel: Record<string, string> = {
  shared: '共用组件',
  cast: '常驻角色',
  bumper: '片头/片尾',
  audio: '固定音频',
  cover: '封面素材',
  directions: '语气指导',
  publish_template: '发布模板',
};

const statusLabel: Record<string, string> = {
  synced: '已同步',
  missing: '未拉取',
  update_available: '专栏有更新',
  local_modified: '本地已修改',
  conflict: '两边都有改动',
};

export function SeriesAssetsPanel(props: {
  seriesId: string;
  seriesName: string;
  episode?: string;
  onSynced?: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'sync' | 'promote' | 'publish'>('sync');
  const [data, setData] = useState<SeriesAssetsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // 自定义沉淀表单
  const [promoteKind, setPromoteKind] = useState<'shared' | 'cast' | 'bumper' | 'audio' | 'cover'>('bumper');
  const [promoteName, setPromoteName] = useState('intro');
  const [promoteFrom, setPromoteFrom] = useState('');

  // 发布模板表单
  const [titlePattern, setTitlePattern] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [footer, setFooter] = useState('');
  const [coverGuide, setCoverGuide] = useState('');
  const [credits, setCredits] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api<SeriesAssetsResponse>(`/api/series/${encodeURIComponent(props.seriesId)}/assets`);
      setData(res);
      const tpl = res.publish_template;
      setTitlePattern(tpl?.title_pattern ?? '');
      setHashtags((tpl?.default_hashtags ?? []).join(' '));
      setFooter(tpl?.description_footer ?? '');
      setCoverGuide(tpl?.cover_guidelines ?? '');
      setCredits((tpl?.credits_lines ?? []).join('\n'));
    } catch (err) {
      setError(errorText(err));
    }
  }, [props.seriesId]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncOne = async (item: AssetSyncStatus, replace = false) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await post('/api/series/project/sync', { kind: item.kind, name: item.name, replace });
      setNotice(`已同步 ${kindLabel[item.kind] ?? item.kind}「${item.name}」到本项目`);
      await load();
      props.onSynced?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const syncAll = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const res = await post<{ synced?: unknown[] }>('/api/series/project/sync', { all: true });
      setNotice(`已同步 ${(res.synced ?? []).length} 项专栏资产到本项目`);
      await load();
      props.onSynced?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const promote = async (kind: ProjectAssetCandidate['kind'], name: string, from: string, replace = false) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await post('/api/series/project/promote', { kind, name: name.trim(), from: from.trim(), replace });
      setNotice(`已沉淀 ${kindLabel[kind]}「${name.trim()}」回专栏`);
      await load();
    } catch (err) {
      const msg = errorText(err);
      if (!replace && msg.includes('replace')) {
        setError(`${msg}（可点「覆盖沉淀」确认更新专栏版本）`);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  const removeAsset = async (item: AssetSyncStatus) => {
    if (item.kind === 'directions' || item.kind === 'publish_template') return;
    setBusy(true);
    setError('');
    try {
      await del(`/api/series/${encodeURIComponent(props.seriesId)}/assets/${item.kind}/${encodeURIComponent(item.name)}`);
      setNotice(`已从专栏库移除 ${item.key}（不影响已有项目）`);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const savePublishTemplate = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await put(`/api/series/${encodeURIComponent(props.seriesId)}/publish-template`, {
        title_pattern: titlePattern.trim(),
        default_hashtags: hashtags.split(/\s+/).filter(Boolean),
        description_footer: footer.trim(),
        cover_guidelines: coverGuide.trim(),
        credits_lines: credits
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      });
      setNotice('已保存专栏发布模板');
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const statuses = data?.sync_status ?? [];
  const candidates = data?.project_candidates ?? [];
  const hasUpdates = statuses.some((s) => s.status === 'missing' || s.status === 'update_available');

  return (
    <div className="series-backdrop" role="dialog" aria-modal="true" aria-label={`专栏资产：${props.seriesName}`}>
      <div className="series-modal">
        <header className="series-modal-head">
          <div>
            <h2>
              {props.seriesName}
              {props.episode ? ` · EP${String(props.episode).padStart(2, '0')}` : ''}
            </h2>
            <p className="series-modal-sub">拉取专栏跨期资产、把本期成品沉淀回专栏，或维护系列发布模板。</p>
          </div>
          <button className="series-icon-btn" aria-label="关闭" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <nav className="series-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'sync'} className={tab === 'sync' ? 'on' : ''} onClick={() => setTab('sync')}>
            专栏资产同步 ({statuses.length})
          </button>
          <button role="tab" aria-selected={tab === 'promote'} className={tab === 'promote' ? 'on' : ''} onClick={() => setTab('promote')}>
            沉淀回专栏
          </button>
          <button role="tab" aria-selected={tab === 'publish'} className={tab === 'publish' ? 'on' : ''} onClick={() => setTab('publish')}>
            发布模板
          </button>
        </nav>

        <div className="series-modal-body">
          {tab === 'sync' && (
            <div className="series-episodes">
              <div className="series-ep-bar">
                <span className="series-ep-hint">实体拷贝进本项目，老期数指纹不受专栏更新影响。</span>
                {hasUpdates && (
                  <button className="pill primary-pill" disabled={busy} onClick={() => void syncAll()}>
                    一键同步全部更新
                  </button>
                )}
              </div>
              {statuses.length === 0 ? (
                <p className="series-empty">这个专栏还没有跨期资产。可以在「沉淀回专栏」里把本期做好的组件、片头片尾或音频沉淀进来。</p>
              ) : (
                <ul className="series-ep-list">
                  {statuses.map((item) => (
                    <li key={item.key} className="series-asset-row">
                      <div className="series-ep-info">
                        <strong>
                          <span className="series-ep-badge mono">{kindLabel[item.kind] ?? item.kind}</span> {item.name}
                          {item.bumper_mode && (
                            <span className="series-asset-mode">
                              {item.bumper_mode === 'template' ? 'HTML 模板' : '成片 MP4'}
                            </span>
                          )}
                        </strong>
                        <span>
                          {item.target_path} · {statusLabel[item.status] ?? item.status}
                        </span>
                      </div>
                      <div className="series-foot-right">
                        {(item.status === 'missing' || item.status === 'update_available') && (
                          <button className="pill primary-pill" disabled={busy} onClick={() => void syncOne(item, false)}>
                            拉取
                          </button>
                        )}
                        {(item.status === 'conflict' || item.status === 'local_modified') && (
                          <button className="pill" disabled={busy} onClick={() => void syncOne(item, true)}>
                            用专栏覆盖
                          </button>
                        )}
                        {item.kind !== 'directions' && item.kind !== 'publish_template' && (
                          <button className="series-icon-btn" title="从专栏库删除" disabled={busy} onClick={() => void removeAsset(item)}>
                            <Icon name="trash" size={12} />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === 'promote' && (
            <div className="series-form">
              {candidates.length > 0 && (
                <div className="series-episodes">
                  <span className="series-ep-hint">当前项目可一键沉淀的资产：</span>
                  <ul className="series-ep-list">
                    {candidates.map((c) => (
                      <li key={`${c.kind}:${c.name}`} className="series-asset-row">
                        <div className="series-ep-info">
                          <strong>
                            <span className="series-ep-badge mono">{kindLabel[c.kind]}</span> {c.name}
                          </strong>
                          <span>{c.from}</span>
                        </div>
                        <div className="series-foot-right">
                          <button className="pill" disabled={busy} onClick={() => void promote(c.kind, c.name, c.from, true)}>
                            沉淀到专栏
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="series-grid">
                <label className="series-field">
                  <span>资产类型</span>
                  <select value={promoteKind} onChange={(e) => setPromoteKind(e.currentTarget.value as typeof promoteKind)}>
                    <option value="bumper">片头/片尾（成片 MP4 或 HTML 模板）</option>
                    <option value="shared">共用组件（production/shared）</option>
                    <option value="cast">常驻角色包（cast）</option>
                    <option value="audio">固定音频 / BGM</option>
                    <option value="cover">系列封面素材</option>
                  </select>
                </label>
                <label className="series-field">
                  <span>专栏资产名（英文短横线）</span>
                  <input value={promoteName} placeholder="如 intro / outro / brand-badge" onChange={(e) => setPromoteName(e.currentTarget.value)} />
                </label>
              </div>
              <label className="series-field">
                <span>项目内源路径（目录或单个文件）</span>
                <input
                  value={promoteFrom}
                  placeholder="例如：scenes/scene-001 或 assets/bgm/theme.mp3"
                  onChange={(e) => setPromoteFrom(e.currentTarget.value)}
                />
              </label>
              <div className="series-foot-right">
                <button
                  className="pill primary-pill"
                  disabled={busy || !promoteName.trim()}
                  onClick={() => void promote(promoteKind, promoteName, promoteFrom, false)}
                >
                  沉淀回专栏
                </button>
                <button
                  className="pill"
                  disabled={busy || !promoteName.trim()}
                  onClick={() => void promote(promoteKind, promoteName, promoteFrom, true)}
                >
                  覆盖沉淀
                </button>
              </div>
            </div>
          )}

          {tab === 'publish' && (
            <div className="series-form">
              <label className="series-field">
                <span>标题模板</span>
                <input value={titlePattern} placeholder="例如：【EP{nn}】{title}" onChange={(e) => setTitlePattern(e.currentTarget.value)} />
              </label>
              <label className="series-field">
                <span>固定话题标签（空格分隔）</span>
                <input value={hashtags} placeholder="例如：#AI硬核拆解 #科普动画" onChange={(e) => setHashtags(e.currentTarget.value)} />
              </label>
              <label className="series-field">
                <span>系列封面视觉规范</span>
                <textarea rows={3} value={coverGuide} placeholder="例如：左上角固定 EP 编号黄铜徽章，右下角留主题主视觉" onChange={(e) => setCoverGuide(e.currentTarget.value)} />
              </label>
              <label className="series-field">
                <span>简介固定脚标</span>
                <textarea rows={3} value={footer} placeholder="例如：订阅本专栏，每周更新底层技术拆解。" onChange={(e) => setFooter(e.currentTarget.value)} />
              </label>
              <label className="series-field">
                <span>固定素材署名（每行一条）</span>
                <textarea rows={2} value={credits} placeholder="例如：片头音乐：XXX（CC BY 4.0）" onChange={(e) => setCredits(e.currentTarget.value)} />
              </label>
              <div className="series-foot-right">
                <button className="pill primary-pill" disabled={busy} onClick={() => void savePublishTemplate()}>
                  保存发布模板
                </button>
              </div>
            </div>
          )}
        </div>

        {notice && <p className="series-notice">{notice}</p>}
        {error && <p className="series-error">{error}</p>}
      </div>
    </div>
  );
}
