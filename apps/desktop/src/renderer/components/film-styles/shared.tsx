import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../../api';
import type { FilmStyle, FilmStylesResponse } from '../../types';

/** 风格的全局标识：来源/目录名。 */
export function styleKey(style: { source: string; slug: string }): string {
  return `${style.source}/${style.slug}`;
}

/**
 * 读风格目录；有来源没准备好时隔一会儿再看（用户可能正在终端里跑 onset setup）。
 * 读失败（多半是 Studio 在重启）时退避重试，已经读到的目录照常显示，不让一次失败一直挂在菜单上。
 */
export function useFilmStyles(active: boolean): {
  data: FilmStylesResponse | null;
  error: string;
  posterVersion: number;
} {
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
        if (ready < result.sources.length) timer = window.setTimeout(() => void load(), 10000);
      } catch (err) {
        if (cancelled) return;
        failures++;
        setError(`${errorText(err)}，正在重试…`);
        timer = window.setTimeout(() => void load(), Math.min(3000 * failures, 15000));
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
export function hue(text: string): number {
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

export function matches(style: FilmStyle, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return [
    style.cn,
    style.en,
    style.slug,
    style.source,
    style.category_cn,
    style.category_en,
    style.summary,
    ...(style.uses ?? []),
  ].some((field) => field.toLowerCase().includes(q));
}
