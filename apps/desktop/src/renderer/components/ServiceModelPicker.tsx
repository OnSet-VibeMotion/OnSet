import { useEffect, useId, useRef, useState } from 'react';
import '../service-model-picker.css';

/** 模型目录可能有上百项，用页面内的有界列表代替系统 datalist。仍允许手填目录外的模型。 */
export function ServiceModelPicker({ models, value, onChange }: { models: string[]; value: string; onChange: (model: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const listId = useId();
  const list = useRef<HTMLSpanElement>(null);
  const matches = models.filter((model) => model.toLowerCase().includes(query.trim().toLowerCase()));

  useEffect(() => {
    setOpen(models.length > 0);
    setQuery('');
    setActive(-1);
  }, [models]);

  useEffect(() => {
    if (active >= 0) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (model: string) => {
    onChange(model);
    setQuery('');
    setOpen(false);
    setActive(-1);
  };

  return (
    <span className="service-model-picker" onBlur={(e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
    }}>
      <span className="service-model-input">
        <input
          aria-label="模型"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && models.length > 0}
          aria-controls={listId}
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={value}
          placeholder={models.length > 0 ? '输入名称筛选模型，也可以直接填写' : '模型名'}
          onFocus={() => { setOpen(true); setQuery(''); setActive(-1); }}
          onChange={(e) => { onChange(e.target.value); setQuery(e.target.value); setOpen(true); setActive(-1); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              if (models.length === 0) return;
              e.preventDefault();
              setOpen(true);
              setActive((current) => matches.length === 0 ? -1 : e.key === 'ArrowDown'
                ? Math.min(current + 1, matches.length - 1)
                : current < 0 ? matches.length - 1 : Math.max(current - 1, 0));
            } else if (open && e.key === 'Enter') {
              e.preventDefault();
              if (active >= 0 && matches[active]) choose(matches[active]);
              else setOpen(false);
            } else if (open && e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        {models.length > 0 && <button
          type="button"
          className="service-model-toggle"
          aria-label={open ? '收起模型列表' : '展开模型列表'}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => { setOpen(!open); setQuery(''); setActive(-1); }}
        >{open ? '▴' : '▾'}</button>}
      </span>
      {open && models.length > 0 && <>
        <span className="service-model-count">{query ? `匹配 ${matches.length} / ${models.length} 个模型` : `${models.length} 个模型 · 滚动浏览，输入名称筛选`}</span>
        <span className="service-model-options" id={listId} role="listbox" aria-label="可选模型" ref={list}>
          {matches.map((model, index) => <button
            type="button"
            role="option"
            id={`${listId}-${index}`}
            key={model}
            tabIndex={-1}
            aria-selected={model === value}
            className={active === index ? 'active' : ''}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(model)}
          >{model}</button>)}
          {matches.length === 0 && <span className="service-model-empty">没有匹配的模型，可以直接使用输入的名称</span>}
        </span>
      </>}
    </span>
  );
}
