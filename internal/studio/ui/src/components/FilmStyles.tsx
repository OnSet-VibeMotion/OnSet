import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import type { FilmStyle, FilmStylesResponse } from '../types';
import '../film-styles.css';

/**
 * 整片风格（lemo-opuscar 风格库）的选择器，首页菜单与预览区「风格」页共用。
 *
 * 风格目录随 am 下发，打开就有；海报要从风格库下载（第一次约 23 MB，后台进行），
 * 没下完的显示带分类色的占位块，下完自动换上。
 */

/** 读风格目录；海报还在下载时每 3 秒再问一次，下完给图片换一个版本号绕过缓存。 */
export function useFilmStyles(active: boolean): { data: FilmStylesResponse | null; error: string; posterVersion: number } {
  const [data, setData] = useState<FilmStylesResponse | null>(null);
  const [error, setError] = useState('');
  const [posterVersion, setPosterVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    let cancelled = false;
    let last = '';
    const load = async () => {
      try {
        const result = await api<FilmStylesResponse>('/api/film-styles');
        if (cancelled) return;
        setData(result);
        setError('');
        if (last && last !== result.posters) setPosterVersion((v) => v + 1);
        last = result.posters;
        if (result.posters === 'downloading') timer = window.setTimeout(load, 3000);
      } catch (err) {
        if (!cancelled) setError(errorText(err));
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

/** 风格海报：16:9；没有图（还没下载或下载失败）时显示分类色占位块与风格名。 */
export function Poster(props: { style: FilmStyle; version?: number; full?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.version]);
  const query = new URLSearchParams();
  if (props.full) query.set('size', 'full');
  if (props.version) query.set('v', String(props.version));
  const src = `/api/film-styles/${encodeURIComponent(props.style.slug)}/poster.jpg${query.toString() ? '?' + query : ''}`;
  return (
    <span class="fs-poster" style={{ '--fs-hue': String(hue(props.style.category_cn)) }}>
      {failed ? (
        <span class="fs-poster-fallback">{props.style.cn}</span>
      ) : (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      )}
    </span>
  );
}

function matches(style: FilmStyle, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [style.cn, style.en, style.slug, style.category_cn, style.category_en, style.line_cn, ...style.uses].some((field) => field.toLowerCase().includes(q));
}

interface PickerProps {
  data: FilmStylesResponse | null;
  error: string;
  posterVersion: number;
  selected: string;
  onPick: (slug: string) => void;
  /** 显示「不用整片风格」一项，选它时 onPick('')。 */
  none?: { title: string; desc: string };
  /** menu：首页下拉菜单里的单列；grid：预览区里的网格。 */
  layout: 'menu' | 'grid';
}

export function FilmStylePicker(props: PickerProps) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    if (!props.data) return [];
    return props.data.categories
      .map((category) => ({ category, styles: props.data!.styles.filter((s) => s.category_cn === category && matches(s, query.trim())) }))
      .filter((group) => group.styles.length > 0);
  }, [props.data, query]);
  return (
    <div class={'film-styles ' + props.layout}>
      <div class="fs-head">
        <input
          class="fs-search"
          type="search"
          placeholder="搜风格：油画、水墨、像素、数据…"
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          aria-label="搜索整片风格"
        />
        {props.data && (
          <a class="fs-gallery" href={props.data.gallery} target="_blank" rel="noreferrer" title="每种风格的 demo 片">
            看图鉴 ↗
          </a>
        )}
      </div>
      {props.data?.posters === 'downloading' && <p class="fs-note">海报下载中（第一次约 23 MB），先显示占位…</p>}
      {props.data?.posters === 'error' && (
        <p class="fs-note bad" title={props.data.posters_error}>
          海报没下载下来，先显示占位；风格照样可以选。
        </p>
      )}
      {props.error && <p class="fs-note bad">{props.error}</p>}
      {props.none && !query.trim() && (
        <button role="menuitemradio" aria-checked={props.selected === ''} class={'fs-item none' + (props.selected === '' ? ' selected' : '')} onClick={() => props.onPick('')}>
          <span class="fs-poster fs-poster-none">
            <span class="fs-poster-fallback">Aa</span>
          </span>
          <span class="fs-text">
            <span class="fs-name">{props.none.title}</span>
            <span class="fs-desc">{props.none.desc}</span>
          </span>
          {props.selected === '' && <span class="fs-check">✓</span>}
        </button>
      )}
      {!props.data && !props.error && <p class="fs-note">正在读风格目录…</p>}
      {props.data && groups.length === 0 && <p class="fs-note">没有匹配「{query}」的风格。</p>}
      {groups.map((group) => (
        <section key={group.category} class="fs-group">
          <h4 style={{ '--fs-hue': String(hue(group.category)) }}>{group.category}</h4>
          <div class="fs-list">
            {group.styles.map((style) => (
              <button
                key={style.slug}
                role="menuitemradio"
                aria-checked={props.selected === style.slug}
                class={'fs-item' + (props.selected === style.slug ? ' selected' : '')}
                data-style={style.slug}
                onClick={() => props.onPick(style.slug)}
                title={style.line_cn}
              >
                <Poster style={style} version={props.posterVersion} />
                <span class="fs-text">
                  <span class="fs-name">
                    {style.cn}
                    <span class="fs-en">{style.en}</span>
                  </span>
                  <span class="fs-desc">{style.uses.join(' · ')}</span>
                </span>
                {props.selected === style.slug && <span class="fs-check">✓</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
