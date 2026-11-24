import { useEffect, useState } from 'react';
import { api, del, errorText, post, put } from '../../api';
import type { ModeOption, Project, SeriesItem, StylesResponse } from '../../types';
import { FilmStyleDialog, styleKey, useFilmStyles } from '../FilmStyles';
import type { ProjectSummary } from '../home/helpers';
import { summaryText } from '../home/helpers';
import { Icon } from '../Icon';
import '../../series.css';

interface VoiceListEntry {
  name: string;
}

export function SeriesModal(props: {
  /** null 表示新建专栏；传入已有对象表示编辑/管理。 */
  initial: SeriesItem | null;
  styles: StylesResponse | null;
  modes: ModeOption[];
  defaultParent: string;
  projects: Project[];
  summaries: Record<string, ProjectSummary>;
  onSaved: (item: SeriesItem) => Promise<void>;
  onDeleted: (id: string) => Promise<void>;
  onStartNext?: (item: SeriesItem) => void;
  onOpenProject?: (projectId: string) => Promise<void>;
  onClose: () => void;
}) {
  const editing = props.initial !== null;
  const [tab, setTab] = useState<'episodes' | 'preset' | 'brief'>(editing ? 'episodes' : 'preset');
  const [name, setName] = useState(props.initial?.name ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  const [parentDir, setParentDir] = useState(props.initial?.parent_dir ?? props.defaultParent);
  const [namingPattern, setNamingPattern] = useState(props.initial?.naming_pattern ?? 'EP{nn}-{title}');
  const [nextEpisode, setNextEpisode] = useState(String(props.initial?.next_episode ?? 1));
  const [canvas, setCanvas] = useState(props.initial?.defaults.canvas ?? props.styles?.default_canvas ?? '');
  const [modeId, setModeId] = useState(() => {
    if (!props.initial) return props.modes[0]?.id ?? 'speech';
    const d = props.initial.defaults;
    const hit = props.modes.find(
      (m) => m.delivery === (d.delivery || 'speech') && m.narration === (d.narration || 'solo'),
    );
    return hit?.id ?? props.modes[0]?.id ?? 'speech';
  });
  const [filmStyle, setFilmStyle] = useState(props.initial?.defaults.film_style ?? '');
  const [ttsVoice, setTtsVoice] = useState(props.initial?.defaults.tts_voice ?? '');
  const [brief, setBrief] = useState(props.initial?.brief ?? '');
  const [voices, setVoices] = useState<string[]>([]);
  const [styleOpen, setStyleOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const films = useFilmStyles(styleOpen || filmStyle !== '');
  const styleLabel = filmStyle
    ? (films.data?.styles.find((s) => styleKey(s) === filmStyle)?.cn ?? filmStyle)
    : '不用整片风格';

  useEffect(() => {
    api<{ voices?: VoiceListEntry[] }>('/api/voices').then(
      (res) => setVoices((res.voices ?? []).map((v) => v.name)),
      () => setVoices([]),
    );
  }, []);

  const episodes = props.initial
    ? props.projects
        .filter((p) => p.series_id === props.initial!.id && !props.summaries[p.id]?.missing)
        .sort((a, b) => (a.episode ?? Number.MAX_SAFE_INTEGER) - (b.episode ?? Number.MAX_SAFE_INTEGER))
    : [];

  const handleSave = async () => {
    const cleanName = name.trim();
    if (!cleanName) {
      setError('请填写专栏名称');
      return;
    }
    const parsedEp = Number.parseInt(nextEpisode, 10);
    if (!Number.isInteger(parsedEp) || parsedEp < 1) {
      setError('下一期期号必须是正整数');
      return;
    }
    const mode = props.modes.find((m) => m.id === modeId) ?? props.modes[0];
    const payload = {
      name: cleanName,
      description: description.trim(),
      parent_dir: parentDir.trim(),
      naming_pattern: namingPattern.trim() || 'EP{nn}-{title}',
      next_episode: parsedEp,
      defaults: {
        canvas: canvas || undefined,
        delivery: mode?.delivery || undefined,
        narration: mode?.narration || undefined,
        film_style: filmStyle || undefined,
        tts_voice: ttsVoice.trim() || undefined,
      },
      brief,
    };
    setSaving(true);
    setError('');
    try {
      const saved = editing
        ? await put<SeriesItem>(`/api/series/${encodeURIComponent(props.initial!.id)}`, payload)
        : await post<SeriesItem>('/api/series', payload);
      await props.onSaved(saved);
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!props.initial) return;
    setSaving(true);
    setError('');
    try {
      await del(`/api/series/${encodeURIComponent(props.initial.id)}`);
      await props.onDeleted(props.initial.id);
      props.onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="series-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={editing ? `专栏：${props.initial!.name}` : '新建专栏'}
    >
      <div className="series-modal">
        <header className="series-modal-head">
          <div>
            <h2>{editing ? props.initial!.name : '新建专栏'}</h2>
            <p className="series-modal-sub">
              {editing
                ? `标识：${props.initial!.id} · 共 ${episodes.length} 期`
                : '把同系列视频的画幅、风格、音色、保存目录与规范收在一起。'}
            </p>
          </div>
          <button className="series-icon-btn" aria-label="关闭" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <nav className="series-tabs" role="tablist">
          {editing && (
            <button
              role="tab"
              aria-selected={tab === 'episodes'}
              className={tab === 'episodes' ? 'on' : ''}
              onClick={() => setTab('episodes')}
            >
              期数总览 ({episodes.length})
            </button>
          )}
          <button
            role="tab"
            aria-selected={tab === 'preset'}
            className={tab === 'preset' ? 'on' : ''}
            onClick={() => setTab('preset')}
          >
            开片预设
          </button>
          <button
            role="tab"
            aria-selected={tab === 'brief'}
            className={tab === 'brief' ? 'on' : ''}
            onClick={() => setTab('brief')}
          >
            专栏规范
          </button>
        </nav>

        <div className="series-modal-body">
          {tab === 'episodes' && editing && (
            <div className="series-episodes">
              <div className="series-ep-bar">
                <span className="series-ep-hint">
                  下一期建议编号：EP{String(props.initial!.next_episode).padStart(2, '0')}
                </span>
                {props.onStartNext && (
                  <button
                    className="pill primary-pill"
                    onClick={() => {
                      props.onStartNext!(props.initial!);
                      props.onClose();
                    }}
                  >
                    <Icon name="plus" size={11} />
                    新建下一期
                  </button>
                )}
              </div>
              {episodes.length === 0 ? (
                <p className="series-empty">
                  这个专栏还没有期数。点右上角「新建下一期」，或在左侧把已有项目归入本专栏。
                </p>
              ) : (
                <ul className="series-ep-list">
                  {episodes.map((p) => {
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
          )}

          {tab === 'preset' && (
            <div className="series-form">
              <label className="series-field">
                <span>专栏名称</span>
                <input value={name} placeholder="例如：AI 硬核拆解" onChange={(e) => setName(e.currentTarget.value)} />
              </label>
              <label className="series-field">
                <span>一句话定位（可选）</span>
                <input
                  value={description}
                  placeholder="例如：每周一条 3 分钟原理动画科普"
                  onChange={(e) => setDescription(e.currentTarget.value)}
                />
              </label>
              <div className="series-grid">
                <label className="series-field">
                  <span>默认画幅</span>
                  <select value={canvas} onChange={(e) => setCanvas(e.currentTarget.value)}>
                    <option value="">跟随默认</option>
                    {props.styles?.canvases.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}（{c.width}×{c.height}）
                      </option>
                    ))}
                  </select>
                </label>
                <label className="series-field">
                  <span>默认做法</span>
                  <select value={modeId} onChange={(e) => setModeId(e.currentTarget.value)}>
                    {props.modes.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="series-grid">
                <div className="series-field">
                  <span>默认整片风格</span>
                  <button type="button" className="series-picker-btn" onClick={() => setStyleOpen(true)}>
                    <span>{styleLabel}</span>
                    <Icon name="chevron" size={10} />
                  </button>
                </div>
                <label className="series-field">
                  <span>默认音色（可选）</span>
                  {voices.length > 0 ? (
                    <select value={ttsVoice} onChange={(e) => setTtsVoice(e.currentTarget.value)}>
                      <option value="">跟随全局默认音色</option>
                      {voices.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={ttsVoice}
                      placeholder="音色库里的名字，留空跟随全局"
                      onChange={(e) => setTtsVoice(e.currentTarget.value)}
                    />
                  )}
                </label>
              </div>
              <label className="series-field">
                <span>默认保存父目录</span>
                <input
                  value={parentDir}
                  placeholder="新建每期视频默认放到这里"
                  onChange={(e) => setParentDir(e.currentTarget.value)}
                />
              </label>
              <div className="series-grid">
                <label className="series-field">
                  <span>期号命名模板</span>
                  <input
                    value={namingPattern}
                    placeholder="EP{nn}-{title}"
                    onChange={(e) => setNamingPattern(e.currentTarget.value)}
                  />
                </label>
                <label className="series-field">
                  <span>下一期期号</span>
                  <input
                    type="number"
                    min={1}
                    value={nextEpisode}
                    onChange={(e) => setNextEpisode(e.currentTarget.value)}
                  />
                </label>
              </div>
            </div>
          )}

          {tab === 'brief' && (
            <div className="series-form">
              <label className="series-field">
                <span>专栏视觉与口播规范（brief.md）</span>
                <textarea
                  rows={10}
                  value={brief}
                  placeholder={
                    '写给本专栏每一期共用的规则，例如：\n- 口播开头 3 秒先抛反常识结论，不要寒暄\n- 全片主色板固定深灰底 + 琥珀高亮\n- 结尾固定留 3 秒引导关注与下期预告'
                  }
                  onChange={(e) => setBrief(e.currentTarget.value)}
                />
              </label>
            </div>
          )}
        </div>

        {error && <p className="series-error">{error}</p>}

        <footer className="series-modal-foot">
          <div className="series-foot-left">
            {editing && !confirmDelete && (
              <button className="pill danger-pill" onClick={() => setConfirmDelete(true)} disabled={saving}>
                删除专栏
              </button>
            )}
            {editing && confirmDelete && (
              <span className="series-confirm">
                <span>只删专栏配置，不会删任何视频文件。</span>
                <button className="pill danger-pill" onClick={() => void handleDelete()} disabled={saving}>
                  确认删除
                </button>
                <button className="pill" onClick={() => setConfirmDelete(false)} disabled={saving}>
                  取消
                </button>
              </span>
            )}
          </div>
          <div className="series-foot-right">
            <button className="pill" onClick={props.onClose} disabled={saving}>
              取消
            </button>
            <button className="pill primary-pill" onClick={() => void handleSave()} disabled={saving}>
              {saving ? '保存中…' : editing ? '保存修改' : '创建专栏'}
            </button>
          </div>
        </footer>
      </div>
      {styleOpen && (
        <FilmStyleDialog
          title="选一种专栏默认风格"
          intro="这个专栏新建的每一期都会默认带入这一种整片风格。"
          data={films.data}
          error={films.error}
          posterVersion={films.posterVersion}
          selected={filmStyle}
          none={{ title: '不用整片风格', desc: '每期按各自文案决定，不提前锁定画风。' }}
          onPick={setFilmStyle}
          onClose={() => setStyleOpen(false)}
        />
      )}
    </div>
  );
}
