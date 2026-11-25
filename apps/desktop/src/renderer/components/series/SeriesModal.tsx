import { useEffect, useState } from 'react';
import { api, del, errorText, post, put } from '../../api';
import type { ModeOption, Project, SeriesAssistResponse, SeriesItem, StylesResponse } from '../../types';
import { FilmStyleDialog, styleKey, useFilmStyles } from '../FilmStyles';
import type { ProjectSummary } from '../home/helpers';
import { Icon } from '../Icon';
import { SeriesAiAssist } from './SeriesAiAssist';
import { SeriesBriefTab } from './SeriesBriefTab';
import { SeriesEpisodesTab } from './SeriesEpisodesTab';
import { SeriesPresetTab } from './SeriesPresetTab';
import { SeriesPublishTemplateTab } from './SeriesPublishTemplateTab';
import { hasPublishTemplateContent } from './seriesAssistApi';
import {
  applyDraftToForm,
  buildAssistCurrent,
  buildSeriesSavePayload,
  initSeriesForm,
  type SeriesFormState,
} from './seriesForm';
import '../../series.css';

interface VoiceListEntry {
  name: string;
}

interface MotionCatalogSource {
  id: string;
  effects: { id: string; name: string }[];
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
  const [tab, setTab] = useState<'episodes' | 'preset' | 'brief' | 'publish'>(editing ? 'episodes' : 'preset');
  const [form, setForm] = useState<SeriesFormState>(() =>
    initSeriesForm(props.initial, props.styles, props.modes, props.defaultParent),
  );
  const [applySnapshot, setApplySnapshot] = useState<SeriesFormState | null>(null);
  const [voices, setVoices] = useState<string[]>([]);
  const [motionOptions, setMotionOptions] = useState<{ ref: string; name: string }[]>([]);
  const [motionPickerOpen, setMotionPickerOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');

  const films = useFilmStyles(styleOpen || form.filmStyle !== '');
  const styleLabel = form.filmStyle
    ? (films.data?.styles.find((s) => styleKey(s) === form.filmStyle)?.cn ?? form.filmStyle)
    : '不用整片风格';

  useEffect(() => {
    api<{ voices?: VoiceListEntry[] }>('/api/voices').then(
      (res) => setVoices((res.voices ?? []).map((v) => v.name)),
      () => setVoices([]),
    );
  }, []);

  useEffect(() => {
    if (!motionPickerOpen && form.motionEffects.length === 0) return;
    if (motionOptions.length > 0) return;
    api<{ sources?: MotionCatalogSource[] }>('/api/motion-effects').then(
      (res) =>
        setMotionOptions(
          (res.sources ?? []).flatMap((src) => src.effects.map((e) => ({ ref: `${src.id}:${e.id}`, name: e.name }))),
        ),
      () => {},
    );
  }, [motionPickerOpen, form.motionEffects.length, motionOptions.length]);

  const episodes = props.initial
    ? props.projects
        .filter((p) => p.series_id === props.initial!.id && !props.summaries[p.id]?.missing)
        .sort((a, b) => (a.episode ?? Number.MAX_SAFE_INTEGER) - (b.episode ?? Number.MAX_SAFE_INTEGER))
    : [];

  const updateForm = <K extends keyof SeriesFormState>(key: K, value: SeriesFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleApplyDraft = (draft: SeriesAssistResponse) => {
    setApplySnapshot({ ...form, publishForm: { ...form.publishForm } });
    setForm((prev) => applyDraftToForm(prev, draft, props.modes));
    setError('');
  };

  const handleUndoApply = () => {
    if (!applySnapshot) return;
    setForm(applySnapshot);
    setApplySnapshot(null);
  };

  const handleSave = async () => {
    const built = buildSeriesSavePayload(form, props.modes, editing);
    if (built.error || !built.payload) {
      setError(built.error ?? '表单校验失败');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = editing
        ? await put<SeriesItem>(`/api/series/${encodeURIComponent(props.initial!.id)}`, built.payload)
        : await post<SeriesItem>('/api/series', built.payload);
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

  const currentDraft = buildAssistCurrent(form, props.modes);
  const hasPublish = hasPublishTemplateContent(form.publishForm);

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
          <button
            role="tab"
            aria-selected={tab === 'publish'}
            className={tab === 'publish' ? 'on' : ''}
            onClick={() => setTab('publish')}
          >
            {hasPublish ? '发布模板 · 已填' : '发布模板'}
          </button>
        </nav>

        <div className="series-modal-body">
          <SeriesAiAssist
            editing={editing}
            styles={props.styles}
            modes={props.modes}
            filmStyles={films.data}
            current={currentDraft}
            canUndoApply={applySnapshot !== null}
            onApply={handleApplyDraft}
            onUndoApply={handleUndoApply}
          />

          {tab === 'episodes' && editing && (
            <SeriesEpisodesTab
              series={props.initial!}
              episodes={episodes}
              summaries={props.summaries}
              onStartNext={props.onStartNext}
              onOpenProject={props.onOpenProject}
              onClose={props.onClose}
            />
          )}

          {tab === 'preset' && (
            <SeriesPresetTab
              name={form.name}
              description={form.description}
              canvas={form.canvas}
              modeId={form.modeId}
              styleLabel={styleLabel}
              motionEffects={form.motionEffects}
              motionOptions={motionOptions}
              motionPickerOpen={motionPickerOpen}
              ttsVoice={form.ttsVoice}
              voices={voices}
              parentDir={form.parentDir}
              namingPattern={form.namingPattern}
              nextEpisode={form.nextEpisode}
              styles={props.styles}
              modes={props.modes}
              onNameChange={(v) => updateForm('name', v)}
              onDescriptionChange={(v) => updateForm('description', v)}
              onCanvasChange={(v) => updateForm('canvas', v)}
              onModeChange={(v) => updateForm('modeId', v)}
              onOpenStylePicker={() => setStyleOpen(true)}
              onToggleMotionPicker={() => setMotionPickerOpen((v) => !v)}
              onMotionEffectsChange={(v) => updateForm('motionEffects', v)}
              onVoiceChange={(v) => updateForm('ttsVoice', v)}
              onParentDirChange={(v) => updateForm('parentDir', v)}
              onNamingPatternChange={(v) => updateForm('namingPattern', v)}
              onNextEpisodeChange={(v) => updateForm('nextEpisode', v)}
            />
          )}

          {tab === 'brief' && (
            <SeriesBriefTab brief={form.brief} current={currentDraft} onChange={(v) => updateForm('brief', v)} />
          )}

          {tab === 'publish' && (
            <SeriesPublishTemplateTab
              loaded
              busy={saving}
              dirty={form.publishTouched}
              hideSave
              titlePattern={form.publishForm.titlePattern}
              hashtags={form.publishForm.hashtags}
              coverGuide={form.publishForm.coverGuide}
              footer={form.publishForm.footer}
              credits={form.publishForm.credits}
              onChange={(field, value) => {
                setForm((prev) => ({
                  ...prev,
                  publishForm: { ...prev.publishForm, [field]: value },
                  publishTouched: true,
                }));
              }}
            />
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
          selected={form.filmStyle}
          none={{ title: '不用整片风格', desc: '每期按各自文案决定，不提前锁定画风。' }}
          onPick={(v) => updateForm('filmStyle', v)}
          onClose={() => setStyleOpen(false)}
        />
      )}
    </div>
  );
}
