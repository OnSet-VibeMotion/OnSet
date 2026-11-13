import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ModelOption, ModelsResponse } from '../types';

/** 每家工具的模型列表只取一次（后端也缓存）；同一页面上几个下拉框共用。 */
const cache = new Map<string, Promise<ModelsResponse>>();

export function loadModels(tool: string, refresh = false): Promise<ModelsResponse> {
  if (refresh || !cache.has(tool)) {
    const request = api<ModelsResponse>(`/api/agents/${tool}/models${refresh ? '?refresh=1' : ''}`).catch((err) => {
      cache.delete(tool);
      return { tool, models: [], error: String(err) } as ModelsResponse;
    });
    cache.set(tool, request);
  }
  return cache.get(tool)!;
}

export function useModels(tool: string): { models: ModelOption[]; error: string } {
  const [state, setState] = useState<{ tool: string; models: ModelOption[]; error: string }>({ tool: '', models: [], error: '' });
  useEffect(() => {
    if (!tool) return;
    let alive = true;
    void loadModels(tool).then((r) => alive && setState({ tool, models: r.models, error: r.error ?? '' }));
    return () => {
      alive = false;
    };
  }, [tool]);
  return state.tool === tool ? state : { models: [], error: '' };
}

const custom = '__custom__';

interface Props {
  tool: string;
  /** 当前值；空串是「默认」。 */
  value: string;
  /** 「默认」那一项的说明，例如「跟随设置（opus）」或「Codex 自己的默认」。 */
  defaultLabel: string;
  disabled?: boolean;
  id?: string;
  className?: string;
  ariaLabel?: string;
  onChange: (model: string) => void;
}

/**
 * 模型下拉框：列出这家工具现在能选的模型（工具自己报的），最后一项「其他…」可以手填。
 * 当前值不在列表里（手填过、列表没取到）时照样显示成一项，不会被悄悄换掉。
 */
export function ModelSelect({ tool, value, defaultLabel, disabled, id, className, ariaLabel, onChange }: Props) {
  const { models, error } = useModels(tool);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const known = models.some((m) => m.id === value);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== value) onChange(next);
  };

  if (editing) {
    return (
      <input
        id={id}
        className={'model-input ' + (className ?? '')}
        aria-label={ariaLabel}
        autoFocus
        placeholder="模型名，例如 opus"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <select
      id={id}
      className={className}
      aria-label={ariaLabel}
      value={value}
      disabled={disabled}
      title={error || (models.find((m) => m.id === value)?.description ?? '')}
      onChange={(e) => {
        const next = e.currentTarget.value;
        if (next === custom) {
          setDraft(value);
          setEditing(true);
          return;
        }
        onChange(next);
      }}
    >
      <option value="">{defaultLabel}</option>
      {value !== '' && !known && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id} title={m.description}>
          {m.label}
        </option>
      ))}
      <option value={custom}>其他…</option>
    </select>
  );
}
