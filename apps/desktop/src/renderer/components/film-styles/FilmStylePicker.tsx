import type { CSSProperties } from 'react';
import { useMemo, useState } from 'react';
import type { FilmStylesResponse } from '../../types';
import { hue, matches, Poster, styleKey } from './shared';

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
            styles: props.data!.styles.filter(
              (s) => s.source === source.id && s.category_cn === category && matches(s, q),
            ),
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
        <button
          role="menuitemradio"
          aria-checked={props.selected === ''}
          className={'fs-item none' + (props.selected === '' ? ' selected' : '')}
          onClick={() => props.onPick('')}
        >
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
                <a
                  className="fs-gallery"
                  href={source.gallery}
                  target="_blank"
                  rel="noreferrer"
                  title="每种风格的示例片"
                >
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
