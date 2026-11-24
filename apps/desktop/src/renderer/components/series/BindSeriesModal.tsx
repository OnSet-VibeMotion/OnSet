import { useState } from 'react';
import { errorText, post } from '../../api';
import type { Project, SeriesItem } from '../../types';
import { Icon } from '../Icon';
import '../../series.css';

/** 把已有项目原地归入某个专栏（不挪动磁盘目录，期号可选），或从专栏移出。 */
export function BindSeriesModal(props: {
  project: Project;
  seriesList: SeriesItem[];
  onDone: () => Promise<void>;
  onClose: () => void;
}) {
  const [seriesId, setSeriesId] = useState(props.project.series_id ?? props.seriesList[0]?.id ?? '');
  const [episode, setEpisode] = useState(props.project.episode ? String(props.project.episode) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleBind = async () => {
    if (!seriesId) {
      setError('请先选择一个专栏');
      return;
    }
    let ep: number | undefined;
    const rawEp = episode.trim();
    if (rawEp !== '') {
      const parsed = /^[1-9]\d*$/.test(rawEp) ? Number(rawEp) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        setError('期号必须是正整数，或者留空作为番外篇');
        return;
      }
      ep = parsed;
    }
    setSaving(true);
    setError('');
    try {
      await post(`/api/series/${encodeURIComponent(seriesId)}/bind`, {
        project_id: props.project.id,
        ...(ep !== undefined ? { episode: ep } : {}),
      });
      await props.onDone();
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const handleUnbind = async () => {
    setSaving(true);
    setError('');
    try {
      await post('/api/series/unbind', { project_id: props.project.id });
      await props.onDone();
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="series-backdrop" role="dialog" aria-modal="true" aria-label={`设置专栏归属：${props.project.name}`}>
      <div className="series-modal series-modal-sm">
        <header className="series-modal-head">
          <div>
            <h2>归入专栏</h2>
            <p className="series-modal-sub">只写入项目内的专栏标记，不改原文件夹位置与名称。</p>
          </div>
          <button className="series-icon-btn" aria-label="关闭" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="series-modal-body">
          <div className="series-form">
            <div className="series-project-pill">
              <Icon name="folder" size={13} />
              <span className="ellipsis">{props.project.name}</span>
            </div>
            <label className="series-field">
              <span>选择专栏</span>
              <select value={seriesId} onChange={(e) => setSeriesId(e.currentTarget.value)}>
                {props.seriesList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="series-field">
              <span>期号（可选，留空表示番外篇）</span>
              <input
                type="number"
                min={1}
                value={episode}
                placeholder="例如：1"
                onChange={(e) => setEpisode(e.currentTarget.value)}
              />
            </label>
          </div>
        </div>
        {error && <p className="series-error">{error}</p>}
        <footer className="series-modal-foot">
          <div className="series-foot-left">
            {props.project.series_id && (
              <button className="pill" onClick={() => void handleUnbind()} disabled={saving}>
                移出专栏
              </button>
            )}
          </div>
          <div className="series-foot-right">
            <button className="pill" onClick={props.onClose} disabled={saving}>
              取消
            </button>
            <button className="pill primary-pill" onClick={() => void handleBind()} disabled={saving || !seriesId}>
              {saving ? '保存中…' : '确定'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
