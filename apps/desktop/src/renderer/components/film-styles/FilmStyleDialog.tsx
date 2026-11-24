import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FilmStylesResponse } from '../../types';
import { hue, matches, Poster, styleKey } from './shared';

interface DialogProps {
  data: FilmStylesResponse | null;
  error: string;
  posterVersion: number;
  /** 当前用的风格标识（来源/目录名），空表示不用整片风格。 */
  selected: string;
  /** 弹窗标题，比如「选整片风格」「换一种整片风格」。 */
  title: string;
  /** 标题下的一句说明。 */
  intro?: ReactNode;
  /** 显示「不用整片风格」一项，选它时 onPick('')。 */
  none?: { title: string; desc: string };
  /**
   * 排在海报墙最前面的几张横卡（比如镜头页的「跟随默认风格」「不用整片风格」），value 原样交给 onPick。
   * 给了它就不再显示 none。
   */
  specials?: Array<{ value: string; title: string; desc: string; mark: string }>;
  /** 已经装进项目的风格标识，海报上标「已装」。 */
  installed?: ReadonlySet<string>;
  /** 确认按钮上的字，默认「用这个风格」。 */
  confirm?: string;
  onPick: (key: string) => void;
  onClose: () => void;
}

/**
 * 整片风格弹窗：左边按「来源 → 分类」筛，中间是海报网格，底部是选中的那种风格的说明与确认。
 * 单击只是选中，确认（或双击、回车）才算数——几十种风格要来回比，单击就关掉的话只能一次看一种。
 */
export function FilmStyleDialog(props: DialogProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [pending, setPending] = useState(props.selected);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  const q = query.trim();
  const styles = props.data?.styles ?? [];
  const matched = useMemo(() => styles.filter((s) => matches(s, q)), [styles, q]);
  const rail = useMemo(
    () =>
      (props.data?.sources ?? []).map((source) => ({
        source,
        categories: source.categories.map((name) => ({
          id: `${source.id}\u0000${name}`,
          name,
          count: matched.filter((s) => s.source === source.id && s.category_cn === name).length,
        })),
      })),
    [props.data, matched],
  );
  const groups = rail.flatMap(({ source, categories }) =>
    categories
      .filter((c) => !category || c.id === category)
      .map((c) => ({ ...c, source, styles: matched.filter((s) => s.source === source.id && s.category_cn === c.name) }))
      .filter((g) => g.styles.length > 0),
  );
  const several = (props.data?.sources.length ?? 0) > 1;
  const current = pending ? styles.find((s) => styleKey(s) === pending) : undefined;
  const changed = pending !== props.selected;
  const apply = (key = pending) => {
    props.onPick(key);
    props.onClose();
  };
  const specials =
    props.specials ?? (props.none ? [{ value: '', title: props.none.title, desc: props.none.desc, mark: 'Aa' }] : []);
  const showSpecials = specials.length > 0 && !q && !category;
  const special = specials.find((x) => x.value === pending);

  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
      else if (e.key === 'Enter' && !e.isComposing && changed) apply();
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  });

  return (
    <div className="modal-backdrop fs-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <section
        className="fs-dialog film-styles"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        id="film-style-dialog"
      >
        <header className="fs-dialog-head">
          <div className="fs-dialog-title">
            <h2>{props.title}</h2>
            {props.intro && <p>{props.intro}</p>}
          </div>
          <input
            ref={search}
            className="fs-search"
            type="search"
            placeholder="搜风格：油画、水墨、像素、数据…"
            value={query}
            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
            aria-label="搜索整片风格"
          />
          <button className="ghost icon fs-close" onClick={props.onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="fs-dialog-body">
          <nav className="fs-rail" aria-label="风格分类">
            <button className={'fs-rail-item' + (category === '' ? ' on' : '')} onClick={() => setCategory('')}>
              <span>全部</span>
              <span className="fs-count">{matched.length}</span>
            </button>
            {rail.map(({ source, categories }) => (
              <div key={source.id} className="fs-rail-source">
                {several && <h3>{source.name}</h3>}
                {categories.map((c) => (
                  <button
                    key={c.id}
                    className={'fs-rail-item' + (category === c.id ? ' on' : '')}
                    style={{ '--fs-hue': String(hue(c.name)) } as CSSProperties}
                    disabled={c.count === 0}
                    onClick={() => setCategory(c.id)}
                  >
                    <span className="fs-dot" />
                    <span className="fs-rail-name">{c.name}</span>
                    <span className="fs-count">{c.count}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="fs-gallery-pane">
            {props.error && !props.data && <p className="fs-note bad">{props.error}</p>}
            {!props.data && !props.error && <p className="fs-note">正在读风格目录…</p>}
            {props.data?.sources
              .filter((s) => !s.ready)
              .map((s) => (
                <p key={s.id} className="fs-note bad" title={s.problem}>
                  「{s.name}」还没准备好，海报先显示占位，选了也装不上。在工具准备页的「以后可能用到」里装好它再来。
                </p>
              ))}
            {showSpecials && (
              <div className="fs-specials">
                {specials.map((item) => (
                  <button
                    key={item.value}
                    role="radio"
                    aria-checked={pending === item.value}
                    className={'fs-item none' + (pending === item.value ? ' selected' : '')}
                    data-special={item.value}
                    onClick={() => setPending(item.value)}
                    onDoubleClick={() => apply(item.value)}
                  >
                    <span className="fs-poster fs-poster-none">
                      <span className="fs-poster-fallback">{item.mark}</span>
                    </span>
                    <span className="fs-text">
                      <span className="fs-name">{item.title}</span>
                      <span className="fs-desc">{item.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {props.data && groups.length === 0 && <p className="fs-note">没有匹配「{query}」的风格。</p>}
            {groups.map((group) => (
              <section key={group.id} className="fs-group">
                <h4 style={{ '--fs-hue': String(hue(group.name)) } as CSSProperties}>
                  {group.name}
                  {several && <span className="fs-group-source">{group.source.name}</span>}
                </h4>
                <div className="fs-cards" role="radiogroup" aria-label={group.name}>
                  {group.styles.map((style) => {
                    const key = styleKey(style);
                    return (
                      <button
                        key={key}
                        role="radio"
                        aria-checked={pending === key}
                        className={
                          'fs-item' + (pending === key ? ' selected' : '') + (props.selected === key ? ' current' : '')
                        }
                        data-style={key}
                        onClick={() => setPending(key)}
                        onDoubleClick={() => apply(key)}
                        title={style.summary}
                      >
                        <Poster style={style} version={props.posterVersion} />
                        {props.selected === key ? (
                          <span className="fs-current">正在用</span>
                        ) : (
                          props.installed?.has(key) && <span className="fs-current installed">已装</span>
                        )}
                        <span className="fs-text">
                          <span className="fs-name">{style.cn}</span>
                          <span className="fs-en">{style.en}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>

        <footer className="fs-dialog-foot">
          <div className="fs-detail">
            {current ? (
              <>
                <strong>
                  {current.cn} <span className="fs-en">{current.en}</span>
                </strong>
                <span className="fs-desc">
                  {current.category_cn} · 适合 {current.uses.join('、')}
                </span>
                {current.summary && <span className="fs-summary">{current.summary}</span>}
              </>
            ) : special ? (
              <>
                <strong>{special.title}</strong>
                <span className="fs-summary">{special.desc}</span>
              </>
            ) : (
              <span className="fs-summary">点一张海报看看，双击直接用。</span>
            )}
          </div>
          {props.data?.sources.find((s) => s.gallery) && (
            <a
              className="fs-gallery"
              href={props.data.sources.find((s) => s.gallery)!.gallery}
              target="_blank"
              rel="noreferrer"
            >
              看示例片 ↗
            </a>
          )}
          <button onClick={props.onClose}>取消</button>
          <button className="primary" id="film-style-confirm" disabled={!changed} onClick={() => apply()}>
            {props.confirm ?? '用这个风格'}
          </button>
        </footer>
      </section>
    </div>
  );
}
