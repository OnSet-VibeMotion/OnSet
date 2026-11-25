import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../api';
import type { SeriesAssistDraft } from '../../types';
import { Icon } from '../Icon';
import { cancelSeriesAssist, isAbortError, requestSeriesAssist } from './seriesAssistApi';

export function SeriesBriefTab(props: { brief: string; current: SeriesAssistDraft; onChange: (next: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [prevBrief, setPrevBrief] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (ctrlRef.current) {
        ctrlRef.current.abort();
        ctrlRef.current = null;
        cancelSeriesAssist();
      }
    };
  }, []);

  const handlePolish = async () => {
    if (!props.brief.trim() && !props.current.name?.trim() && !props.current.description?.trim()) {
      setError('请先写几句专栏规范或想法，再点击 AI 润色。');
      return;
    }
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const res = await requestSeriesAssist(
        {
          mode: 'polish_brief',
          current: { ...props.current, brief: props.brief },
        },
        ctrl.signal,
      );
      if (res.brief.trim()) {
        setPrevBrief(props.brief);
        props.onChange(res.brief);
        setNote(res.rationale ? `已润色规范：${res.rationale}` : '已润色专栏规范，不满意可随时撤回上版。');
      } else {
        setError('模型返回了空规范，已保留你的原文。');
      }
    } catch (err) {
      if (isAbortError(err)) {
        setNote('已取消润色，原文未变动。');
      } else {
        setError(errorText(err));
      }
    } finally {
      if (ctrlRef.current === ctrl) ctrlRef.current = null;
      setBusy(false);
    }
  };

  const handleCancel = () => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    cancelSeriesAssist();
    setBusy(false);
    setNote('已取消润色，原文未变动。');
  };

  const handleUndo = () => {
    if (prevBrief === null) return;
    props.onChange(prevBrief);
    setPrevBrief(null);
    setNote('已撤回上一版专栏规范。');
    setError('');
  };

  return (
    <div className="series-form">
      <div className="series-brief-bar">
        <span className="series-brief-label">专栏视觉与口播规范（brief.md）</span>
        <div className="series-brief-actions">
          {prevBrief !== null && !busy && (
            <button type="button" className="pill series-mini-pill" onClick={handleUndo}>
              <Icon name="undo" size={11} />
              撤回上版
            </button>
          )}
          {busy ? (
            <button type="button" className="pill series-mini-pill" onClick={handleCancel}>
              取消
            </button>
          ) : (
            <button type="button" className="pill series-mini-pill series-ai-pill" onClick={() => void handlePolish()}>
              <Icon name="spark" size={11} />
              AI 润色规范
            </button>
          )}
        </div>
      </div>
      {busy && (
        <p className="series-ai-status">
          <span className="orb tiny" aria-hidden="true" />
          <span>正在整理与润色专栏规范…</span>
        </p>
      )}
      {note && !busy && <p className="series-ai-note">{note}</p>}
      {error && <p className="series-ai-error">{error}</p>}
      <label className="series-field">
        <span className="sr-only">专栏视觉与口播规范（brief.md）</span>
        <textarea
          aria-label="专栏视觉与口播规范（brief.md）"
          rows={10}
          value={props.brief}
          disabled={busy}
          placeholder={
            '写给本专栏每一期共用的规则，例如：\n- 口播开头 3 秒先抛反常识结论，不要寒暄\n- 全片主色板固定深灰底 + 琥珀高亮\n- 结尾固定留 3 秒引导关注与下期预告'
          }
          onChange={(e) => props.onChange(e.currentTarget.value)}
        />
      </label>
    </div>
  );
}
