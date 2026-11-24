import type { ReactNode } from 'react';
import { useState } from 'react';
import { rawURL } from '../../api';
import { playerProps } from '../../media';
import type { FilmStyle, ViewRequest } from '../../types';
import { Poster } from '../FilmStyles';
import { Icon } from '../Icon';
import { tabs } from '../Preview';
import { stationPageLabel } from '../Stations';
import { type MediaRef, type StylePick, stylePickMessage } from './model';

/** 回复里写到的音频、图片、视频：直接在对话里试听、看。 */
export function MediaStrip(props: {
  media: MediaRef[];
  mtimes: Map<string, number>;
  onOpenFile: (path: string) => void;
}) {
  const images = props.media.filter((m) => m.kind === 'image');
  const others = props.media.filter((m) => m.kind !== 'image');
  return (
    <div className="media-strip" aria-label="回复里提到的媒体">
      {others.map((m) => {
        const src = rawURL(m.path, props.mtimes.get(m.path));
        const name = m.path.split('/').pop();
        return (
          <div key={m.path} className={'media-item ' + m.kind} data-ctx-file={m.path}>
            <button className="link media-name" title={m.path} onClick={() => props.onOpenFile(m.path)}>
              {name}
            </button>
            {m.kind === 'audio' ? (
              <audio {...playerProps} preload="metadata" src={src} />
            ) : (
              <video {...playerProps} preload="metadata" src={src} />
            )}
          </div>
        );
      })}
      {images.length > 0 && (
        <div className="media-images">
          {images.map((m) => (
            <a
              key={m.path}
              href={rawURL(m.path, props.mtimes.get(m.path))}
              target="_blank"
              rel="noreferrer"
              title={m.path}
              data-ctx-file={m.path}
            >
              <img src={rawURL(m.path, props.mtimes.get(m.path))} alt={m.path.split('/').pop()} loading="lazy" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 编排工具推荐的风格：海报、名字、用在哪（全片默认或某一段）与理由，点了把选择发回去。
 * 认不出的标识照样列出，只是没有图。
 */
export function StylePicks(props: {
  picks: StylePick[];
  styles: Map<string, FilmStyle>;
  version: number;
  enabled: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div className="style-picks film-styles" role="group" aria-label="推荐的整片风格">
      {props.picks.map((pick) => {
        const style = props.styles.get(pick.key);
        const [source, slug] = pick.key.split('/');
        const name = style ? style.cn : pick.key;
        return (
          <figure
            key={pick.key + '\u0000' + pick.scope}
            className={'style-pick' + (pick.scope ? ' scoped' : '')}
            data-style={pick.key}
            data-scope={pick.scope || undefined}
          >
            <a
              className="style-pick-poster"
              href={`/api/film-styles/${encodeURIComponent(source)}/${encodeURIComponent(slug)}/poster.jpg?size=full`}
              target="_blank"
              rel="noreferrer"
              title="看大图"
            >
              <Poster
                style={
                  style ?? {
                    source,
                    slug,
                    order: '',
                    cn: pick.key,
                    en: '',
                    category_cn: source,
                    category_en: '',
                    uses: [],
                    summary: '',
                  }
                }
                version={props.version}
              />
            </a>
            <figcaption>
              <span className="style-pick-name">
                {name}
                {style?.en && <span className="style-pick-en">{style.en}</span>}
              </span>
              {pick.explicit && (
                <span className="style-pick-scope">{pick.scope ? `只用在：${pick.scope}` : '全片默认风格'}</span>
              )}
              <span className="style-pick-reason">{pick.reason || style?.summary || ''}</span>
              <button
                className="pill"
                disabled={!props.enabled}
                title={props.enabled ? '把这个选择发给 AI' : '只有最新一条回复的推荐可以点'}
                onClick={() => props.onPick(stylePickMessage(name, pick))}
              >
                {!pick.explicit ? '选这个风格' : pick.scope ? '用在这一段' : '设为整片风格'}
              </button>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/**
 * 已经答过的选项：只留选中的那一个，其余收起，点开还能看（不能再点）。
 * 用户没点选项、自己打字回复时，整组收成一行。
 */
export function AnsweredOptions(props: { picked?: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const others = props.picked ? props.count - 1 : props.count;
  return (
    <div className="answered-options">
      <div className="answered-line">
        {props.picked && (
          <span className="choice-picked" title="你选的">
            <Icon name="check" size={12} />
            {props.picked}
          </span>
        )}
        {others > 0 && (
          <button className="link answered-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '收起' : props.picked ? `另外 ${others} 个选项` : `${others} 个选项（你另外回复了）`}
          </button>
        )}
      </div>
      {open && <div className="answered-all">{props.children}</div>}
    </div>
  );
}

/** 切页请求的说法：「口播稿」「镜头 scene-003」「文件 production/treatment.md」。 */
export function viewLabel(view: ViewRequest): string {
  const label = tabs.find(([id]) => id === view.page)?.[1] ?? stationPageLabel(view.page) ?? view.page;
  return view.target ? `${label} ${view.target}` : label;
}

/** 用户的回复是哪个选项：选项原样发出，风格推荐发的是 stylePickMessage。认不出返回 undefined。 */
export function pickedOption(
  answer: string,
  choices: string[],
  picks: StylePick[],
  styles: Map<string, FilmStyle>,
): string | undefined {
  const choice = choices.find((c) => c.trim() === answer);
  if (choice) return choice;
  for (const pick of picks) {
    const name = styles.get(pick.key)?.cn ?? pick.key;
    if (stylePickMessage(name, pick) === answer) return pick.scope ? `${pick.scope}：${name}` : name;
  }
  return undefined;
}
