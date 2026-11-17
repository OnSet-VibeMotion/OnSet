import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { creditTag, labelOf, modelDefault, optionChoices, optionVisible, parseOptions, shortLabel, withOption } from '../agentOptions';
import type { AgentOptionSpec, ModelOption } from '../types';
import { Icon } from './Icon';
import { useModels } from './ModelSelect';
import '../modelpicker.css';

interface Props {
  /** 这家工具：列模型、按模型收窄可选档位。 */
  tool: string;
  /** 自己选的模型；空是「默认」（跟随设置或那家工具自己的默认）。 */
  model: string;
  /** 「默认」一项的写法，例如「跟随设置（opus）」「默认模型」。 */
  defaultLabel: string;
  /** 「默认」实际是哪个模型（跟随设置时的那个）：codex 按它收窄推理档位，opencode 有它才附得上变体。 */
  fallbackModel?: string;
  specs: AgentOptionSpec[];
  /** 自己选的选项（effort=high,fast=on）；空是全部跟随 inheritedOptions。 */
  options: string;
  /** 没单独选的项跟着谁（设置里的选项）；空是那家工具自己的默认。 */
  inheritedOptions?: string;
  disabled?: boolean;
  id?: string;
  ariaLabel: string;
  onModel: (model: string) => void;
  onOptions: (options: string) => void;
}

interface Row {
  id: string;
  label: string;
  description?: string;
  /** 手填的模型名（列表里没有、按搜索框里的字用）。 */
  custom?: boolean;
  /** 工具报的模型（带额度倍率等）；「默认」与手填的没有。 */
  model?: ModelOption;
}

/**
 * 模型与调用选项的弹出框：上面搜索、中间一列模型（名字加一句说明，选中的打勾），底下一行一项选项
 * （推理强度的分段按钮、快速模式的开关、上下文长度的几档）。触发按钮放在输入框底部的胶囊里，写着「模型 · 中 · 快速」。
 * 弹出框挂在 body 上（输入框一带有裁切），按按钮的位置往上或往下开。
 */
export function ModelPicker({ tool, model, defaultLabel, fallbackModel = '', specs, options, inheritedOptions = '', disabled, id, ariaLabel, onModel, onOptions }: Props) {
  const { models, error } = useModels(tool);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const effectiveModel = model || fallbackModel;
  const chosen = models.find((m) => m.id === effectiveModel);
  const own = parseOptions(options);
  const from = parseOptions(inheritedOptions);

  // 按钮上的字：模型名，后面跟着已经定下的几项（自己选的或跟着设置的）。
  const modelName = model ? (models.find((m) => m.id === model)?.label ?? model) : defaultLabel;
  const summary = specs
    .map((spec) => {
      const value = own[spec.key] ?? from[spec.key] ?? '';
      if (value === '' || (spec.kind === 'toggle' && value !== 'on')) return '';
      return spec.kind === 'toggle' ? spec.label.replace(/模式$/, '') : shortLabel(spec, value);
    })
    .filter((s) => s !== '');

  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className="model-picker-trigger"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={error || undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-picker-name">{modelName}</span>
        {summary.map((s) => (
          <span key={s} className="model-picker-tag">
            {s}
          </span>
        ))}
        <Icon name="chevron" size={9} />
      </button>
      {open && button.current && (
        <Popover
          anchor={button.current}
          ariaLabel={ariaLabel}
          tool={tool}
          model={model}
          defaultLabel={defaultLabel}
          models={models}
          error={error}
          chosen={chosen}
          effectiveModel={effectiveModel}
          specs={specs}
          options={options}
          own={own}
          from={from}
          onClose={() => setOpen(false)}
          onModel={(next) => {
            setOpen(false);
            button.current?.focus();
            if (next !== model) onModel(next);
          }}
          onOptions={onOptions}
        />
      )}
    </>
  );
}

function Popover(props: {
  anchor: HTMLElement;
  ariaLabel: string;
  tool: string;
  model: string;
  defaultLabel: string;
  models: ModelOption[];
  error: string;
  chosen: ModelOption | undefined;
  effectiveModel: string;
  specs: AgentOptionSpec[];
  options: string;
  own: Record<string, string>;
  from: Record<string, string>;
  onClose: () => void;
  onModel: (model: string) => void;
  onOptions: (options: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (m: ModelOption) => q === '' || [m.id, m.label, m.description ?? ''].some((t) => t.toLowerCase().includes(q));
    const out: Row[] = [];
    const builtin = props.models.find((m) => m.isDefault);
    if (q === '') out.push({ id: '', label: props.defaultLabel, description: builtin ? `不指定，由设置或这家工具自己决定（工具默认 ${builtin.label}）` : '不指定，由设置或这家工具自己决定' });
    // 手填过、列表里没有的当前模型照样列出来，不被悄悄换掉。
    if (props.model !== '' && !props.models.some((m) => m.id === props.model) && (q === '' || props.model.toLowerCase().includes(q))) out.push({ id: props.model, label: props.model });
    for (const m of props.models) if (match(m)) out.push({ id: m.id, label: m.label, ...(m.description ? { description: m.description } : {}), model: m });
    // 列表里没有的模型名：按搜索框里的字用。
    const typed = query.trim();
    if (typed !== '' && /^[A-Za-z0-9._:/@#\[\]+-]+$/.test(typed) && !out.some((r) => r.id === typed)) out.push({ id: typed, label: `使用「${typed}」`, description: '列表里没有的模型名，原样交给工具', custom: true });
    return out;
  }, [query, props.models, props.model, props.defaultLabel]);

  useEffect(() => setActive(0), [query]);

  // 按按钮的位置开：下面放不下就往上开（输入框在窗口底部）；左右不出窗口。
  useLayoutEffect(() => {
    const place = () => {
      const r = props.anchor.getBoundingClientRect();
      const width = Math.min(380, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom - 8;
      const above = r.top - 8;
      if (below >= 420 || below >= above) setPlace({ left, top: r.bottom + 6, maxHeight: Math.max(below - 6, 200) });
      else setPlace({ left, bottom: window.innerHeight - r.top + 6, maxHeight: Math.max(above - 6, 200) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [props.anchor]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (box.current?.contains(target) || props.anchor.contains(target)) return;
      props.onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [props.onClose, props.anchor]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      props.onClose();
      props.anchor.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLElement).classList.contains('model-picker-search-input')) {
      e.preventDefault();
      const row = rows[active];
      if (row) props.onModel(row.id);
    }
  };

  const visibleSpecs = props.specs.filter((spec) => optionVisible(spec, props.chosen, props.own[spec.key] ?? ''));

  return createPortal(
    <div
      ref={box}
      className="model-picker"
      role="dialog"
      aria-label={props.ariaLabel}
      style={place ? { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight } : { visibility: 'hidden' }}
      onKeyDown={onKey}
    >
      <label className="model-picker-search">
        <Icon name="search" size={14} />
        <input className="model-picker-search-input" autoFocus placeholder="搜索模型…" aria-label="搜索模型" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </label>
      <ul ref={list} className="model-picker-list" role="listbox" aria-label="模型">
        {rows.map((row, i) => {
          const selected = !row.custom && row.id === props.model;
          return (
            <li
              key={(row.custom ? 'custom:' : '') + row.id}
              data-index={i}
              role="option"
              aria-selected={selected}
              className={'model-picker-item' + (i === active ? ' active' : '') + (selected ? ' selected' : '')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.onModel(row.id)}
            >
              <span className="model-picker-text">
                <span className="model-picker-label">{row.label}</span>
                {row.description && (
                  <span className="model-picker-desc" title={row.description}>
                    {row.description}
                  </span>
                )}
              </span>
              {row.model && <ModelMeta model={row.model} />}
              {selected && <Icon name="check" size={14} />}
            </li>
          );
        })}
        {rows.length === 0 && <li className="model-picker-empty">没有匹配的模型</li>}
        {props.error && props.models.length === 0 && query === '' && <li className="model-picker-empty">{props.error}</li>}
      </ul>
      {visibleSpecs.length > 0 && (
        <div className="model-picker-options">
          {visibleSpecs.map((spec) => (
            <OptionRow
              key={spec.key}
              spec={spec}
              chosen={props.chosen}
              hasModel={props.effectiveModel !== ''}
              current={props.own[spec.key] ?? ''}
              inherited={props.from[spec.key] ?? ''}
              onChange={(value) => props.onOptions(withOption(props.options, spec.key, value))}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** 模型行右边的额度：「8.00x 额度」，打折时划掉原价，免费与活动单独标出。 */
function ModelMeta({ model }: { model: ModelOption }) {
  const tag = creditTag(model);
  if (!tag) return null;
  return (
    <span className="model-picker-meta" title="每次请求消耗的额度倍率">
      {tag.promotion && <span className="model-picker-promo">{tag.promotion}</span>}
      {tag.before && <s className="model-picker-before">{tag.before}</s>}
      <span className={'model-picker-credit' + (model.free ? ' free' : '')}>{model.free ? tag.text : `${tag.text} 额度`}</span>
    </span>
  );
}

/** 一项选项：推理强度、上下文长度是一排分段按钮（第一段是「默认」），快速模式是开关。 */
function OptionRow({ spec, chosen, hasModel, current, inherited, onChange }: { spec: AgentOptionSpec; chosen: ModelOption | undefined; hasModel: boolean; current: string; inherited: string; onChange: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const effective = current || inherited;
  const title = spec.hint + (inherited !== '' ? `（设置里是「${labelOf(spec, inherited)}」）` : '');

  let control;
  if (spec.requiresModel && !hasModel) {
    control = <span className="model-picker-note">先选模型</span>;
  } else if (spec.kind === 'toggle') {
    const on = effective === 'on';
    control = (
      <button type="button" role="switch" aria-checked={on} aria-label={spec.label} className={'model-picker-switch' + (on ? ' on' : '')} onClick={() => onChange(on ? 'off' : 'on')}>
        <i />
      </button>
    );
  } else if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (/^[1-9][0-9]{0,8}$/.test(next)) onChange(next);
    };
    control = (
      <input
        className="model-picker-number"
        aria-label={spec.label}
        autoFocus
        inputMode="numeric"
        placeholder="token 数"
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            // 经 blur 提交一次：直接 commit 的话卸下输入框时的 blur 会再提交一遍。
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setDraft('');
            setEditing(false);
          }
        }}
      />
    );
  } else {
    const choices = optionChoices(spec, chosen, current);
    // 不选时这个模型实际用哪一档（qoder 的模型表给）；跟着设置时以设置为准。
    const builtin = modelDefault(spec, chosen);
    control = (
      <div className="model-picker-segments" role="radiogroup" aria-label={spec.label}>
        <button
          type="button"
          role="radio"
          aria-checked={current === ''}
          className={current === '' ? 'on' : ''}
          title={inherited !== '' ? `跟随设置（${labelOf(spec, inherited)}）` : builtin !== '' ? `这个模型默认用「${labelOf(spec, builtin)}」` : '由工具自己决定'}
          onClick={() => onChange('')}
        >
          {inherited !== '' ? `跟随·${shortLabel(spec, inherited)}` : builtin !== '' ? `默认·${shortLabel(spec, builtin)}` : '默认'}
        </button>
        {choices.map((c) => (
          <button key={c.value} type="button" role="radio" aria-checked={current === c.value} className={current === c.value ? 'on' : ''} title={c.label} onClick={() => onChange(c.value)}>
            {shortLabel(spec, c.value)}
          </button>
        ))}
        {spec.kind === 'number' && !(chosen?.contextWindows && chosen.contextWindows.length > 0) && (
          <button
            type="button"
            title="填一个 token 数，例如 384000"
            onClick={() => {
              setDraft('');
              setEditing(true);
            }}
          >
            自定义
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="model-picker-option" title={title}>
      <span className="model-picker-option-label">{spec.label}</span>
      {control}
    </div>
  );
}
