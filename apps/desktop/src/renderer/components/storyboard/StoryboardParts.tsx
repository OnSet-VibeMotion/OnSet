import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Attachment, StoryboardResponse, StoryboardScene, StoryboardStyle } from '../../types';
import { Markdown } from '../chat/Markdown';
import { PromptCheckPanel } from '../PromptCheck';
import { ranges, roleHints, StyleThumb, sameStyle, sceneNo } from './helpers';

export type OnQuick = (text: string, attachments: Attachment[], draftOnly?: boolean) => void;

/**
 * 全片的画风：默认风格与个别段落换上的风格各用在哪几个镜头。
 * 点一组跳到它的第一个镜头；风格本身（装、换默认、去掉）在「风格」页。
 */
export function StyleOverview({ board, onStyles }: { board: StoryboardResponse; onStyles?: () => void }) {
  const groups: { style: StoryboardStyle; indexes: number[] }[] = [];
  board.scenes.forEach((sc, index) => {
    const id = sc.style.key || sc.style.kind;
    const group = groups.find((g) => (g.style.key || g.style.kind) === id);
    if (group) group.indexes.push(index);
    else groups.push({ style: sc.style, indexes: [index] });
  });
  const boundaries = board.scenes.filter((sc, i) => i > 0 && !sameStyle(board.scenes[i - 1].style, sc.style)).length;
  const onlyFree = groups.length === 1 && groups[0].style.kind === 'free';
  const jump = (index: number) => {
    const id = board.scenes[index]?.id;
    if (id) {
      document
        .querySelector(`#storyboard [data-scene="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };
  return (
    <section className="sb-styles" id="storyboard-styles" aria-label="画风">
      <header className="sb-styles-head">
        <span className="eyebrow">画风</span>
        <span className="sb-styles-sum">
          {onlyFree
            ? '还没有整片风格，每个镜头按文案自己定视觉'
            : groups.length === 1
              ? '全片一种画风'
              : `${groups.length} 种画风 · ${boundaries} 处风格交界`}
        </span>
        {onStyles && (
          <button className="link" onClick={onStyles}>
            {board.default_style ? '风格页' : '选整片风格'}
          </button>
        )}
      </header>
      {!onlyFree && (
        <ul className="sb-styles-list">
          {groups.map((g) => (
            <li key={g.style.key || g.style.kind}>
              <button
                className={'sb-style-group' + (g.style.missing ? ' missing' : '')}
                onClick={() => jump(g.indexes[0])}
                title="跳到这种画风的第一个镜头"
              >
                <StyleThumb style={g.style} />
                <span className="sb-style-group-text">
                  <strong>
                    {g.style.cn}
                    {g.style.kind === 'default' && <span className="sb-style-default">默认</span>}
                  </strong>
                  <span>
                    {g.indexes.length} 个镜头 · {ranges(g.indexes)}
                    {g.style.missing && <span className="bad"> · 还没装进项目</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 两个镜头之间的交接：用什么手法、交界那一帧是什么样。
 * 风格交界（from 不为空）另写画风从哪种换到哪种、用哪种过渡；计划里没写过渡手法时照实标出，scene_cues 会拒绝它。
 */
export function Handoff({
  scene,
  from,
  planned,
}: {
  scene: StoryboardScene;
  from: StoryboardStyle | null;
  planned: boolean;
}) {
  const h = scene.handoff;
  const unplanned = from && planned && !h?.style_shift;
  return (
    <li
      className={'sb-handoff' + (from ? ' style-shift' : '') + (unplanned ? ' unplanned' : '')}
      title="上一个镜头怎么接到这个镜头"
    >
      {from && (
        <span className="sb-handoff-style">
          <StyleThumb style={from} />
          <span>{from.cn}</span>
          <span aria-hidden="true">→</span>
          <StyleThumb style={scene.style} />
          <span>{scene.style.cn}</span>
          {h?.style_shift ? (
            <em>{h.style_shift_label || h.style_shift}</em>
          ) : unplanned ? (
            <em className="bad">还没写画风怎么换过去</em>
          ) : null}
        </span>
      )}
      {h && <span className="sb-handoff-device">↓ {h.device_label || h.device}</span>}
      {h && <span className="sb-handoff-bridge">{h.bridge}</span>}
    </li>
  );
}

export function SceneCard(props: {
  scene: StoryboardScene;
  index: number;
  version: number;
  /** 没用默认风格（点名了别的或不用整片风格）：卡片左边加一道线，一眼看出哪几段换了画风。 */
  offDefault: boolean;
  onScene: (id: string) => void;
  onRestyle: () => void;
  busy: string;
  onQuick: OnQuick;
  onChanged: () => void;
}) {
  const { scene, index, version, onScene } = props;
  const no = sceneNo(index);
  return (
    <li
      className={`sb-scene${scene.rendered ? ' rendered' : ''}${props.offDefault ? ' off-default' : ''}`}
      data-ctx-scene={scene.id}
      data-scene={scene.id}
    >
      <div className="sb-side">
        <span className="sb-no">{no}</span>
        {scene.rendered && (
          <button className="sb-thumb" onClick={() => onScene(scene.id)} title="打开这个镜头">
            <video
              muted
              preload="metadata"
              tabIndex={-1}
              aria-hidden="true"
              src={`/api/scenes/${encodeURIComponent(scene.id)}/asset?v=${version}#t=${Math.min(1, (scene.seconds || 2) / 2)}`}
            />
          </button>
        )}
      </div>
      <div className="sb-main">
        <h3 className="sb-summary">{scene.summary || scene.id}</h3>
        <div className="sb-meta">
          {scene.seconds ? <span>{scene.seconds.toFixed(1)} 秒</span> : null}
          {scene.visual_role && (
            <span className="sb-chip" title={roleHints[scene.visual_role] ?? ''}>
              {scene.visual_role}
            </span>
          )}
          {scene.anchor && <span title="这个镜头从哪里开始">从{scene.anchor}起</span>}
          <span className="sb-id">{scene.id}</span>
          {!scene.created && <span className="sb-todo">镜头目录还没建</span>}
          {scene.created && (
            <button className="link" onClick={() => onScene(scene.id)}>
              {scene.rendered ? '看画面' : '打开镜头'}
            </button>
          )}
        </div>
        <div className={'sb-style' + (scene.style.missing ? ' missing' : '')}>
          <StyleThumb style={scene.style} />
          <span className="sb-style-name">
            {scene.style.cn}
            {scene.style.kind === 'default' && <span className="muted">（默认）</span>}
            {scene.style.missing && <span className="bad">（还没装进项目）</span>}
          </span>
          <button className="link" onClick={props.onRestyle}>
            换风格
          </button>
        </div>
        {scene.text && (
          <blockquote
            className="sb-text"
            data-ctx-source={`${scene.dir}/scene.json`}
            data-ctx-label={`镜头 ${no} 的口播`}
            data-ctx-whole=""
          >
            {scene.text}
          </blockquote>
        )}
        {scene.prompt ? (
          <details
            className="sb-prompt"
            data-ctx-source={scene.prompt.path}
            data-ctx-label={`镜头 ${no} 的画面描述`}
            data-ctx-whole=""
          >
            <summary>画面描述</summary>
            <Markdown text={scene.prompt.content} />
          </details>
        ) : (
          scene.created && <p className="sb-todo">画面描述还没写</p>
        )}
        <PromptCheckPanel
          scene={scene}
          label={`镜头 ${no}`}
          busy={props.busy}
          onChanged={props.onChanged}
          onQuick={props.onQuick}
        />
      </div>
    </li>
  );
}

/** 镜头页右栏：这个镜头在分镜里想画什么，对照着看画面。 */
export function SceneBrief({
  sceneId,
  version,
  onStoryboard,
  busy,
  onQuick,
}: {
  sceneId: string;
  version: number;
  onStoryboard?: () => void;
  busy?: string;
  onQuick?: OnQuick;
}) {
  const [item, setItem] = useState<StoryboardScene | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let live = true;
    void api<StoryboardResponse>('/api/storyboard').then(
      (board) => live && setItem(board.scenes.find((s) => s.id === sceneId) ?? null),
      () => live && setItem(null),
    );
    return () => {
      live = false;
    };
  }, [sceneId, version, reloads]);
  if (!item || (!item.summary && !item.prompt)) return null;
  return (
    <div className="scene-brief" id="scene-brief">
      {item.summary && <p className="scene-brief-summary">{item.summary}</p>}
      <div className="scene-brief-links">
        {item.prompt && (
          <details
            className="scene-brief-prompt"
            data-ctx-source={item.prompt.path}
            data-ctx-label="画面描述"
            data-ctx-whole=""
          >
            <summary>画面描述</summary>
            <Markdown text={item.prompt.content} />
          </details>
        )}
        {onStoryboard && (
          <button className="link" onClick={onStoryboard}>
            在分镜里看
          </button>
        )}
      </div>
      {onQuick && (
        <PromptCheckPanel
          scene={item}
          label={`镜头 ${item.id}`}
          busy={busy ?? ''}
          onChanged={() => setReloads((n) => n + 1)}
          onQuick={onQuick}
        />
      )}
    </div>
  );
}
