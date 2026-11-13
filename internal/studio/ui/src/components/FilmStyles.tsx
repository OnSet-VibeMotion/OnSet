import { useEffect, useMemo, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import type { FilmStyle, FilmStylesResponse } from '../types';
import '../film-styles.css';

/**
 * 整片风格的选择器，首页菜单、新建对话框与预览区「风格」页共用。
 *
 * 风格来自多个风格来源，按「来源 → 分类」分组，每种风格的标识是「来源/目录名」。
 * 目录随 am 下发，打开就有；海报在来源数据里。来源数据是前置资源，由用户在终端里
 * 运行 am setup 准备，Studio 不下载：没准备好的来源显示占位块和提示。
 */

/** 风格的全局标识：来源/目录名。 */
export function styleKey(style: { source: string; slug: string }): string {
  return `${style.source}/${style.slug}`;
}

/** 读风格目录；有来源没准备好时隔一会儿再看（用户可能正在终端里跑 am setup）。 */
export function useFilmStyles(active: boolean): { data: FilmStylesResponse | null; error: string; posterVersion: number } {
  const [data, setData] = useState<FilmStylesResponse | null>(null);
  const [error, setError] = useState('');
  const [posterVersion, setPosterVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    let timer = 0;
    let cancelled = false;
    let lastReady = -1;
    const load = async () => {
      try {
        const result = await api<FilmStylesResponse>('/api/film-styles');
        if (cancelled) return;
        setData(result);
        setError('');
        const ready = result.sources.filter((s) => s.ready).length;
        if (lastReady >= 0 && ready !== lastReady) setPosterVersion((v) => v + 1);
        lastReady = ready;
        if (ready < result.sources.length) timer = window.setTimeout(load, 10000);
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

/** 风格海报：16:9；没有图（来源数据没准备好或这种风格没有海报）时显示分类色占位块与风格名。 */
export function Poster(props: { style: FilmStyle; version?: number; full?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.version]);
  const query = new URLSearchParams();
  if (props.full) query.set('size', 'full');
  if (props.version) query.set('v', String(props.version));
  const src = `/api/film-styles/${encodeURIComponent(props.style.source)}/${encodeURIComponent(props.style.slug)}/poster.jpg${query.toString() ? '?' + query : ''}`;
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
  return [style.cn, style.en, style.slug, style.source, style.category_cn, style.category_en, style.summary, ...style.uses].some((field) =>
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
  /** menu：首页下拉菜单里的单列；grid：预览区与新建对话框里的网格。 */
  layout: 'menu' | 'grid';
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
      </div>
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
      {props.data && sources.length === 0 && <p class="fs-note">没有匹配「{query}」的风格。</p>}
      {sources.map(({ source, groups }) => (
        <section key={source.id} class="fs-source" data-source={source.id}>
          {(several || source.gallery || !source.ready) && (
            <div class="fs-source-head">
              <h3>{source.name}</h3>
              {source.gallery && (
                <a class="fs-gallery" href={source.gallery} target="_blank" rel="noreferrer" title="每种风格的示例片">
                  看图鉴 ↗
                </a>
              )}
            </div>
          )}
          {!source.ready && (
            <p class="fs-note bad" title={source.problem}>
              这个风格来源还没准备好，海报先显示占位，选了也装不上。在终端运行 <code>am setup</code> 准备好再来。
            </p>
          )}
          {groups.map((group) => (
            <section key={group.category} class="fs-group">
              <h4 style={{ '--fs-hue': String(hue(group.category)) }}>{group.category}</h4>
              <div class="fs-list">
                {group.styles.map((style) => {
                  const key = styleKey(style);
                  return (
                    <button
                      key={key}
                      role="menuitemradio"
                      aria-checked={props.selected === key}
                      class={'fs-item' + (props.selected === key ? ' selected' : '')}
                      data-style={key}
                      onClick={() => props.onPick(key)}
                      title={style.summary}
                    >
                      <Poster style={style} version={props.posterVersion} />
                      <span class="fs-text">
                        <span class="fs-name">
                          {style.cn}
                          <span class="fs-en">{style.en}</span>
                        </span>
                        <span class="fs-desc">{style.uses.join(' · ')}</span>
                      </span>
                      {props.selected === key && <span class="fs-check">✓</span>}
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
