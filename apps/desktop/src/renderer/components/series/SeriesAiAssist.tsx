import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../api';
import type {
  FilmStylesResponse,
  ModeOption,
  SeriesAssistDraft,
  SeriesAssistResponse,
  StylesResponse,
} from '../../types';
import { styleKey } from '../FilmStyles';
import { Icon } from '../Icon';
import { cancelSeriesAssist, isAbortError, nextSeriesAssistRequestId, requestSeriesAssist } from './seriesAssistApi';

function presetSummaryItems(
  draft: SeriesAssistResponse,
  styles: StylesResponse | null,
  modes: ModeOption[],
  filmStyles: FilmStylesResponse | null,
): { label: string; value: string }[] {
  const items: { label: string; value: string }[] = [];
  const d = draft.defaults;
  if (d.canvas) {
    const c = styles?.canvases.find((x) => x.id === d.canvas);
    items.push({ label: '画幅', value: c ? c.label : d.canvas });
  }
  if (d.delivery) {
    const m = modes.find((x) => x.delivery === d.delivery && x.narration === (d.narration || 'solo'));
    items.push({ label: '做法', value: m ? m.label : d.delivery });
  }
  if (d.film_style) {
    const s = filmStyles?.styles.find((x) => styleKey(x) === d.film_style);
    items.push({ label: '风格', value: s ? s.cn : d.film_style });
  }
  if (d.tts_voice) {
    items.push({ label: '音色', value: d.tts_voice });
  }
  if (d.motion_effects?.length) {
    items.push({ label: '常用动效', value: d.motion_effects.join('、') });
  }
  return items;
}

export function SeriesAiAssist(props: {
  editing: boolean;
  styles: StylesResponse | null;
  modes: ModeOption[];
  filmStyles: FilmStylesResponse | null;
  current: SeriesAssistDraft;
  canUndoApply: boolean;
  onApply: (draft: SeriesAssistResponse) => void;
  onUndoApply: () => void;
}) {
  const [expanded, setExpanded] = useState(!props.editing);
  const [idea, setIdea] = useState('');
  const [instruction, setInstruction] = useState('');
  const [draft, setDraft] = useState<SeriesAssistResponse | null>(null);
  const [busyMode, setBusyMode] = useState<'draft' | 'refine' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const ctrlRef = useRef<AbortController | null>(null);
  const reqIdRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (ctrlRef.current) {
        ctrlRef.current.abort();
        ctrlRef.current = null;
        cancelSeriesAssist(reqIdRef.current ?? undefined);
        reqIdRef.current = null;
      }
    };
  }, []);

  const runAssist = async (mode: 'draft' | 'refine', customInstruction?: string) => {
    const cleanIdea = idea.trim();
    const cleanInst = (customInstruction ?? instruction).trim();
    if (mode === 'draft' && !cleanIdea && !props.current.name?.trim() && !props.current.description?.trim()) {
      setError('请先用一句话描述你想做的专栏（题材、受众、平台、调性）。');
      return;
    }
    if (mode === 'refine' && !cleanInst) {
      setError('请填写你想微调的方向，或直接点一条快捷建议。');
      return;
    }
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    const reqId = nextSeriesAssistRequestId();
    ctrlRef.current = ctrl;
    reqIdRef.current = reqId;
    setBusyMode(mode);
    setError('');
    setNotice('');
    try {
      const baseCurrent: SeriesAssistDraft = draft
        ? {
            name: draft.name,
            description: draft.description,
            naming_pattern: draft.naming_pattern,
            defaults: draft.defaults,
            brief: draft.brief,
            publish_template: draft.publish_template,
          }
        : props.current;
      const res = await requestSeriesAssist(
        {
          mode,
          request_id: reqId,
          ...(cleanIdea ? { idea: cleanIdea } : {}),
          ...(mode === 'refine' ? { instruction: cleanInst } : {}),
          current: baseCurrent,
        },
        ctrl.signal,
      );
      setDraft(res);
      if (mode === 'refine') setInstruction('');
    } catch (err) {
      if (isAbortError(err)) {
        setNotice('已取消生成，表单里已有内容未受影响。');
      } else {
        setError(errorText(err));
      }
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null;
        reqIdRef.current = null;
      }
      setBusyMode(null);
    }
  };

  const handleCancel = () => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    cancelSeriesAssist(reqIdRef.current ?? undefined);
    reqIdRef.current = null;
    setBusyMode(null);
    setNotice('已取消生成，表单里已有内容未受影响。');
  };

  const presets = draft ? presetSummaryItems(draft, props.styles, props.modes, props.filmStyles) : [];
  const tpl = draft?.publish_template;
  const briefLines = draft?.brief ? draft.brief.split('\n').filter((l) => l.trim() !== '') : [];

  return (
    <section className="series-ai-box" aria-label="AI 专栏助手">
      <div className="series-ai-head">
        <span className="series-ai-title">
          <Icon name="spark" size={12} />
          {props.editing ? 'AI 辅助润色专栏方案' : 'AI 辅助创建专栏'}
        </span>
        {draft?.tool && (
          <span className="series-ai-by">{draft.model ? `${draft.tool} · ${draft.model}` : draft.tool}</span>
        )}
        <span className="series-ai-spacer" />
        {props.canUndoApply && (
          <button type="button" className="series-link-btn" onClick={props.onUndoApply}>
            <Icon name="undo" size={11} />
            撤回 AI 填充
          </button>
        )}
        <button type="button" className="series-link-btn" onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起' : '展开'}
        </button>
      </div>

      {expanded && (
        <div className="series-ai-body">
          <div className="series-ai-row">
            <input
              aria-label="用一句话描述你想做的专栏"
              value={idea}
              disabled={busyMode !== null}
              placeholder="用一句话描述你想做的专栏（题材、受众、平台、调性）"
              onChange={(e) => setIdea(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && busyMode === null) {
                  e.preventDefault();
                  void runAssist('draft');
                }
              }}
            />
            {busyMode !== null ? (
              <button type="button" className="pill" onClick={handleCancel}>
                取消
              </button>
            ) : (
              <button type="button" className="pill primary-pill" onClick={() => void runAssist('draft')}>
                <Icon name="spark" size={11} />
                AI 生成草案
              </button>
            )}
          </div>

          {busyMode !== null && (
            <p className="series-ai-status">
              <span className="orb tiny" aria-hidden="true" />
              <span>{busyMode === 'draft' ? '正在根据描述生成专栏草案…' : '正在按补充意见润色草案…'}</span>
            </p>
          )}
          {notice && busyMode === null && <p className="series-ai-note">{notice}</p>}
          {error && <p className="series-ai-error">{error}</p>}

          {draft && (
            <div className="series-ai-card" role="region" aria-label="AI 草案预览">
              <div className="series-ai-card-head">
                <div>
                  <strong>{draft.name || '未命名草案'}</strong>
                  {draft.description && <p className="series-ai-desc">{draft.description}</p>}
                </div>
                {draft.naming_pattern && <span className="series-ai-tag mono">{draft.naming_pattern}</span>}
              </div>

              {presets.length > 0 && (
                <div className="series-ai-pills">
                  {presets.map((item) => (
                    <span key={item.label} className="series-ai-chip-readonly">
                      <em>{item.label}</em>
                      {item.value}
                    </span>
                  ))}
                </div>
              )}

              {draft.rationale && <p className="series-ai-rationale">{draft.rationale}</p>}

              {draft.warnings.length > 0 && (
                <ul className="series-ai-warnings">
                  {draft.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}

              {(briefLines.length > 0 || tpl) && (
                <div className="series-ai-highlights">
                  {briefLines.length > 0 && (
                    <div className="series-ai-hl-block">
                      <span className="series-ai-hl-title">专栏规范要点（{briefLines.length} 行）</span>
                      <p className="series-ai-hl-text">{briefLines.slice(0, 3).join(' · ')}</p>
                    </div>
                  )}
                  {tpl && (
                    <div className="series-ai-hl-block">
                      <span className="series-ai-hl-title">发布模板要点</span>
                      <p className="series-ai-hl-text">
                        {[
                          tpl.title_pattern ? `标题：${tpl.title_pattern}` : '',
                          tpl.default_hashtags?.length ? tpl.default_hashtags.join(' ') : '',
                          tpl.cover_guidelines ? `封面：${tpl.cover_guidelines}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {draft.followups.length > 0 && (
                <div className="series-ai-followups">
                  {draft.followups.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="series-ai-chip"
                      disabled={busyMode !== null}
                      onClick={() => void runAssist('refine', chip)}
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              )}

              <div className="series-ai-refine">
                <input
                  aria-label="补充意见"
                  value={instruction}
                  disabled={busyMode !== null}
                  placeholder="补充意见，例如：偏 B 站横屏硬核科普，不要太营销"
                  onChange={(e) => setInstruction(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && busyMode === null) {
                      e.preventDefault();
                      void runAssist('refine');
                    }
                  }}
                />
                <button
                  type="button"
                  className="pill"
                  disabled={busyMode !== null}
                  onClick={() => void runAssist('refine')}
                >
                  再润色一轮
                </button>
              </div>

              <div className="series-ai-card-foot">
                <button
                  type="button"
                  className="pill primary-pill"
                  disabled={busyMode !== null}
                  onClick={() => {
                    props.onApply(draft);
                    setNotice('已回填全部字段到下方表单（含规范与发布模板），可继续微调或随时撤回。');
                  }}
                >
                  <Icon name="check" size={11} />
                  一键回填表单
                </button>
                <button type="button" className="series-link-btn" onClick={() => setDraft(null)}>
                  收起草案
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
