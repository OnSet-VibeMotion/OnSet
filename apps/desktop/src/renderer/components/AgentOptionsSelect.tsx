import { useState } from 'react';
import { labelOf, optionChoices, optionVisible, parseOptions, withOption } from '../agentOptions';
import type { AgentOptionSpec } from '../types';
import { useModels } from './ModelSelect';

const custom = '__custom__';

/** 胶囊里放不下整名，前面只写两三个字。 */
const shortNames: Record<string, string> = { effort: '推理', fast: '快速', context: '上下文' };

interface Props {
  /** 这家工具（列模型、按模型收窄可选档位用）。 */
  tool: string;
  specs: AgentOptionSpec[];
  /** 自己的选项文字；空是全部跟随 inherited（或那家工具自己的默认）。 */
  value: string;
  /** 没单独选的项跟着谁：设置里的选项、全局的选项；空是那家工具自己的默认。 */
  inherited?: string;
  /** 跟着 inherited 时「默认」一项的写法，例如「跟随设置」「和其他项目一样」。 */
  inheritLabel?: string;
  /** 现在选的模型（空是默认模型）：codex 按它收窄推理档位，opencode 没选模型时附不上变体。 */
  model: string;
  /** 输入框底部的胶囊里：每一项前面写短名（推理·高）；不然写全名（推理强度：高），几个下拉框排成一列也分得清。 */
  compact?: boolean;
  disabled?: boolean;
  idPrefix?: string;
  ariaPrefix?: string;
  onChange: (value: string) => void;
}

/**
 * 一家工具的调用选项：推理强度、快速模式、上下文长度……每家能调的由后端给（/api/agents 的 option_specs），
 * 这里只按种类画下拉框。每一项都有「默认 / 跟随」：不选就用那家工具自己的默认，或跟着设置里的值。
 */
export function AgentOptionsSelect({ tool, specs, value, inherited = '', inheritLabel = '跟随设置', model, compact, disabled, idPrefix, ariaPrefix = '', onChange }: Props) {
  const { models } = useModels(specs.length > 0 ? tool : '');
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  if (specs.length === 0) return null;
  const own = parseOptions(value);
  const from = parseOptions(inherited);
  const chosen = models.find((m) => m.id === model) ?? (model === '' ? models.find(m => m.isDefault) : undefined);

  return (
    <>
      {specs.map((spec) => {
        const current = own[spec.key] ?? '';
        if (!optionVisible(spec, chosen, own[spec.key] ?? from[spec.key] ?? '')) return null;
        const prefix = compact ? `${shortNames[spec.key] ?? spec.label}·` : `${spec.label}：`;
        const id = idPrefix ? `${idPrefix}-${spec.key}` : undefined;
        const aria = `${ariaPrefix}${spec.label}`;
        if (spec.requiresModel && model === '') {
          return (
            <select key={spec.key} id={id} aria-label={aria} disabled title={spec.hint}>
              <option>{prefix}先选模型</option>
            </select>
          );
        }
        if (editing === spec.key) {
          const commit = () => {
            setEditing('');
            const next = draft.trim();
            if (/^[1-9][0-9]{0,8}$/.test(next) && next !== current) onChange(withOption(value, spec.key, next));
          };
          return (
            <input
              key={spec.key}
              id={id}
              className="model-input"
              aria-label={aria}
              autoFocus
              inputMode="numeric"
              placeholder="token 数，例如 200000"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing('');
              }}
            />
          );
        }
        const inheritedValue = from[spec.key] ?? '';
        const fallback = inheritedValue !== '' ? `${inheritLabel}（${labelOf(spec, inheritedValue)}）` : '默认';
        return (
          <select
            key={spec.key}
            id={id}
            aria-label={aria}
            value={current}
            disabled={disabled}
            title={spec.hint}
            onChange={(e) => {
              const next = e.currentTarget.value;
              if (next === custom) {
                setDraft(current);
                setEditing(spec.key);
                return;
              }
              onChange(withOption(value, spec.key, next));
            }}
          >
            <option value="">
              {prefix}
              {fallback}
            </option>
            {optionChoices(spec, chosen, current).map((c) => (
              <option key={c.value} value={c.value}>
                {prefix}
                {c.label}
              </option>
            ))}
            {spec.kind === 'number' && !(spec.perModel && chosen?.contextWindows) && <option value={custom}>{prefix}其他…</option>}
          </select>
        );
      })}
    </>
  );
}
