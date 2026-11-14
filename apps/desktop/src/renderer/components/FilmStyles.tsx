import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import type { FilmStyle, FilmStylesResponse } from '../types';
import '../film-styles.css';

/**
 * 整片风格的选择器：首页与「风格」页的「换风格」用弹窗（FilmStyleDialog），新建对话框与还没有风格的「风格」页内嵌网格（FilmStylePicker）。
 *
 * 风格来自多个风格来源，按「来源 → 分类」分组，每种风格的标识是「来源/目录名」。
 * 目录随 onset 下发，打开就有；海报在来源数据里。来源数据是前置资源，由用户在终端里
 * 运行 onset setup 准备，Studio 不下载：没准备好的来源显示占位块和提示。
 */

/** 风格的全局标识：来源/目录名。 */
export function styleKey(style: { source: string; slug: string }): string {
  return `${style.source}/${style.slug}`;
}

/**
 * 读风格目录；有来源没准备好时隔一会儿再看（用户可能正在终端里跑 onset setup）。
 * 读失败（多半是 Studio 在重启）时退避重试，已经读到的目录照常显示，不让一次失败一直挂在菜单上。
 */
export function useFilmStyles(active: boolean): { data: FilmStylesResponse | null; error: string; posterVersion: number } {
  const [data, setData] = useState<FilmStylesResponse | null>(null);
  const [error, setError] = useState('');
  const [posterVersion, setPosterVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    let cancelled = false;
    let lastReady = -1;
    let failures = 0;
    const load = async () => {
      try {
        const result = await api<FilmStylesResponse>('/api/film-styles');
        if (cancelled) return;
        setData(result);
        setError('');
        failures = 0;
        const ready = result.sources.filter((s) => s.ready).length;
        if (lastReady >= 0 && ready !== lastReady) setPosterVersion((v) => v + 1);
        lastReady = ready;
        if (ready < result.sources.length) timer = window.setTimeout(load, 10000);
      } catch (err) {
        if (cancelled) return;
        failures++;
        setError(`${errorText(err)}，正在重试…`);
        timer = window.setTimeout(load, Math.min(3000 * failures, 15000));
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active]);
  return { data, error, posterVersion };
}

/** 分类名换成稳定的色相，占位块与分类标题用。 */
function hue(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** 风格海报：16:9；没有图（来源数据没准备好或这种风格没有海报）时显示分类色占位块与风格名。 */
export function Poster(props: { style: FilmStyle; version?: number; full?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.version]);
  const query = new URLSearchParams();
  if (props.full) query.set('size', 'full');
  if (props.version) query.set('v', String(props.version));
  const src = `/api/film-styles/${encodeURIComponent(props.style.source)}/${encodeURIComponent(props.style.slug)}/poster.jpg${query.toString() ? '?' + query : ''}`;
  return (
    <span className="fs-poster" style={{ '--fs-hue': String(hue(props.style.category_cn)) } as CSSProperties}>
      {failed ? (
        <span className="fs-poster-fallback">{props.style.cn}</span>
      ) : (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

function matches(style: FilmStyle, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [style.cn, style.en, style.slug, style.source, style.category_cn, style.category_en, style.summary, ...(style.uses ?? [])].some((field) =>
    field.toLowerCase().includes(q),
  );
}

interface PickerProps {
  data: FilmStylesResponse | null;
  error: string;
  posterVersion: number;
  /** 选中的风格标识（来源/目录名），空表示不用整片风格。 */
  selected: string;
  onPick: (key: string) => void;
  /** 显示「不用整片风格」一项，选它时 onPick('')。 */
  none?: { title: string; desc: string };
  /** 网格布局：预览区「风格」页（还没有整片风格时）与新建对话框里用。 */
  layout: 'grid';
}

export function FilmStylePicker(props: PickerProps) {
  const [query, setQuery] = useState('');
  const sources = useMemo(() => {
    if (!props.data) return [];
    const q = query.trim();
    return props.data.sources
      .map((source) => ({
        source,
        groups: source.categories
          .map((category) => ({
            category,
            styles: props.data!.styles.filter((s) => s.source === source.id && s.category_cn === category && matches(s, q)),
          }))
          .filter((group) => group.styles.length > 0),
      }))
      .filter((entry) => entry.groups.length > 0);
  }, [props.data, query]);
  const several = (props.data?.sources.length ?? 0) > 1;
  return (
    <div className={'film-styles ' + props.layout}>
      <div className="fs-head">
        <input
          className="fs-search"
          type="search"
          placeholder="搜风格：油画、水墨、像素、数据…"
          value={query}
          onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="搜索整片风格"
        />
      </div>
      {props.error && !props.data && <p className="fs-note bad">{props.error}</p>}
      {props.none && !query.trim() && (
        <button role="menuitemradio" aria-checked={props.selected === ''} className={'fs-item none' + (props.selected === '' ? ' selected' : '')} onClick={() => props.onPick('')}>
          <span className="fs-poster fs-poster-none">
            <span className="fs-poster-fallback">Aa</span>
          </span>
          <span className="fs-text">
            <span className="fs-name">{props.none.title}</span>
            <span className="fs-desc">{props.none.desc}</span>
          </span>
          {props.selected === '' && <span className="fs-check">✓</span>}
        </button>
      )}
      {!props.data && !props.error && <p className="fs-note">正在读风格目录…</p>}
      {props.data && sources.length === 0 && <p className="fs-note">没有匹配「{query}」的风格。</p>}
      {sources.map(({ source, groups }) => (
        <section key={source.id} className="fs-source" data-source={source.id}>
          {(several || source.gallery || !source.ready) && (
            <div className="fs-source-head">
              <h3>{source.name}</h3>
              {source.gallery && (
                <a className="fs-gallery" href={source.gallery} target="_blank" rel="noreferrer" title="每种风格的示例片">
                  看图鉴 ↗
                </a>
              )}
            </div>
          )}
          {!source.ready && (
            <p className="fs-note bad" title={source.problem}>
              这个风格来源还没准备好，海报先显示占位，选了也装不上。在工具准备页的「以后可能用到」里装好它再来。
            </p>
          )}
          {groups.map((group) => (
            <section key={group.category} className="fs-group">
              <h4 style={{ '--fs-hue': String(hue(group.category)) } as CSSProperties}>{group.category}</h4>
              <div className="fs-list">
                {group.styles.map((style) => {
                  const key = styleKey(style);
                  return (
                    <button
                      key={key}
                      role="menuitemradio"
                      aria-checked={props.selected === key}
                      className={'fs-item' + (props.selected === key ? ' selected' : '')}
                      data-style={key}
                      onClick={() => props.onPick(key)}
                      title={style.summary}
                    >
                      <Poster style={style} version={props.posterVersion} />
                      <span className="fs-text">
                        <span className="fs-name">
                          {style.cn}
                          <span className="fs-en">{style.en}</span>
                        </span>
                        <span className="fs-desc">{style.uses.join(' · ')}</span>
                      </span>
                      {props.selected === key && <span className="fs-check">✓</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </section>
      ))}
    </div>
  );
}

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
  const specials = props.specials ?? (props.none ? [{ value: '', title: props.none.title, desc: props.none.desc, mark: 'Aa' }] : []);
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
      <section className="fs-dialog film-styles" role="dialog" aria-modal="true" aria-label={props.title} id="film-style-dialog">
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
                        className={'fs-item' + (pending === key ? ' selected' : '') + (props.selected === key ? ' current' : '')}
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
            <a className="fs-gallery" href={props.data.sources.find((s) => s.gallery)!.gallery} target="_blank" rel="noreferrer">
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

/**
 * 给一个镜头换风格：弹窗选好后不改文件（客户端不写项目文件），把要求写进输入框交给编排工具——
 * 它要改分镜计划里这个镜头的 film_style、没装的风格先装进项目，并给变成风格交界的地方挑过渡手法。
 * 镜头页与分镜页共用。
 */
export function SceneStyleDialog(props: {
  /** 对话里怎么称呼这个镜头，例如「镜头 03（scene-003）」。 */
  who: string;
  /** 镜头写的 film_style 原值：空是默认风格，none 是不用整片风格。 */
  current: string;
  /** 项目的默认风格。 */
  defaultStyle?: { key: string; cn: string };
  /** 已经装进项目的风格标识。 */
  installed: ReadonlySet<string>;
  /** 风格标识换成中文名（目录里没有时用）。 */
  nameOf?: (key: string) => string | undefined;
  onAsk: (text: string) => void;
  onClose: () => void;
}) {
  const films = useFilmStyles(true);
  const name = (key: string) => props.nameOf?.(key) ?? films.data?.styles.find((x) => styleKey(x) === key)?.cn ?? key;
  const pick = (value: string) => {
    let ask: string;
    if (value === '@default') ask = props.defaultStyle ? `把${props.who}改回默认风格「${props.defaultStyle.cn}」。` : `把${props.who}改回不写风格、自主定视觉。`;
    else if (value === 'none') ask = `把${props.who}改成不用整片风格、自主定视觉。`;
    else ask = `把${props.who}换成「${name(value)}」风格（${value}）。` + (props.installed.has(value) ? '' : '这种风格还没装进项目，先用 film_style_add() 装上。');
    props.onAsk(
      ask +
        '改分镜计划里这个镜头的 film_style 并重跑 scene_cues()（没有分镜计划的项目直接改镜头 scene.json 的 film_style）；它和相邻镜头的风格不同时，按「风格交界」挑一种过渡手法，让画法在画面里自然地换过去，不要硬切或叠化。',
    );
  };
  return (
    <FilmStyleDialog
      title={`${props.who} 换一种风格`}
      intro="选好后写进对话，由 AI 改分镜，并给前后的风格交界设计画面里的过渡。"
      confirm="写进对话"
      data={films.data}
      error={films.error}
      posterVersion={films.posterVersion}
      selected={props.current === '' ? '@default' : props.current}
      installed={props.installed}
      specials={[
        {
          value: '@default',
          title: props.defaultStyle ? `跟随默认风格：${props.defaultStyle.cn}` : '跟随默认风格',
          desc: props.defaultStyle ? '和全片大多数镜头一样。' : '项目还没有默认风格，镜头自主定视觉。',
          mark: '默',
        },
        { value: 'none', title: '不用整片风格', desc: '这个镜头按文案自己定配色、字体与动效。', mark: 'Aa' },
      ]}
      onPick={pick}
      onClose={props.onClose}
    />
  );
}
