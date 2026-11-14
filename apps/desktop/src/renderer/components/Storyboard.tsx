import { confirmGate } from './Progress';
import { Fragment, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { Attachment, FilmStyle, StoryboardResponse, StoryboardScene, StoryboardStyle } from '../types';
import { Markdown } from './chat/Markdown';
import { Poster, SceneStyleDialog } from './FilmStyles';
import '../storyboard.css';

/** 分镜相关的文件：聊天与文件树点到它们时打开分镜页。 */
export const storyboardFiles = ['production/scene-plan.json', 'production/scene-plan.md', 'production/treatment.md'];

/** 视觉角色的一句话说明（制作提示词第五阶段「视觉负载与节奏预算」）。 */
const roleHints: Record<string, string> = {
  语境: '交代场景、对象或问题从哪里来',
  证据: '截图、数据、原文、对比结果',
  机制: '流程、结构、因果',
  节奏: '过渡、呼吸、情绪停顿',
};

const lookNames: [keyof NonNullable<StoryboardResponse['look']>, string][] = [
  ['background', '底色'],
  ['surface', '承载面'],
  ['ink', '正文'],
  ['accent', '强调'],
  ['accent_2', '第二强调'],
];

function duration(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function sceneNo(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/** 镜头编号连成段：01–03、07。 */
function ranges(indexes: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < indexes.length; i++) {
    let j = i;
    while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++;
    out.push(j > i ? `${sceneNo(indexes[i])}–${sceneNo(indexes[j])}` : sceneNo(indexes[i]));
    i = j;
  }
  return out.join('、');
}

/** 风格的小海报：只有「来源/目录名」时也能画（Poster 只用来源、目录名与分类）。 */
function StyleThumb({ style }: { style: StoryboardStyle | { key: string; cn: string; category_cn?: string } }) {
  if (!style.key) return <span className="sb-style-thumb free">Aa</span>;
  const [source, ...rest] = style.key.split('/');
  const film = { source, slug: rest.join('/'), cn: style.cn, category_cn: style.category_cn ?? '' } as FilmStyle;
  return (
    <span className="sb-style-thumb">
      <Poster style={film} />
    </span>
  );
}

/** 镜头之间换没换画风只看实际用的风格（与 scene_cues 的风格交界判定相同）。 */
function sameStyle(a: StoryboardStyle, b: StoryboardStyle): boolean {
  return a.key === b.key;
}

interface Props {
  version: number;
  busy: string;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onFile: (path: string) => void;
  onScene: (id: string) => void;
  /** 打开「风格」页。 */
  onStyles?: () => void;
}

/** 分镜页：整片处理方案、按章节排的镜头与每个镜头的画面描述。只读，改分镜在对话里说。 */
export function StoryboardTab({ version, busy, onQuick, onFile, onScene, onStyles }: Props) {
  const [board, setBoard] = useState<StoryboardResponse | null>(null);
  const [error, setError] = useState('');
  const [restyle, setRestyle] = useState<{ scene: StoryboardScene; no: string } | null>(null);

  useEffect(() => {
    api<StoryboardResponse>('/api/storyboard').then(
      (result) => {
        setBoard(result);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version]);

  if (error) return <div className="empty">{error}</div>;
  if (!board) return <div className="empty">正在读取…</div>;
  if (board.scenes.length === 0 && !board.treatment) {
    return (
      <div className="empty" id="storyboard-empty">
        还没有分镜。配音确认后，AI 会把口播拆成镜头、写好每个镜头的画面描述；写好后显示在这里，你确认之后才开始渲染。
        {board.parse_error && <p className="bad">分镜计划写错了：{board.parse_error}</p>}
      </div>
    );
  }

  const scenes = board.scenes;
  const rendered = scenes.filter((s) => s.rendered).length;
  const ready = scenes.length > 0 && scenes.every((s) => s.created);
  const pending = rendered === 0;
  const total = scenes.length > 0 && scenes.every((s) => s.seconds) ? scenes.reduce((sum, s) => sum + (s.seconds ?? 0), 0) : 0;
  const chapters = new Set(scenes.map((s) => s.chapter).filter(Boolean)).size;
  const source = board.doc_path || board.plan_path;
  const look = lookNames.filter(([key]) => board.look?.[key]);

  return (
    <div className="storyboard-tab" id="storyboard">
      <header className="sb-head">
        <span className="eyebrow">分镜{pending ? ' · 待确认' : ` · 已出片 ${rendered}/${scenes.length}`}</span>
        <h1 className="sb-title">{scenes.length > 0 ? `${scenes.length} 个镜头` : '整片处理方案'}</h1>
        <div className="sb-stats">
          {total > 0 && <span>{duration(total)}</span>}
          {chapters > 0 && <span>{chapters} 章</span>}
          {look.length > 0 && (
            <span className="sb-look" title="全片配色">
              {look.map(([key, name]) => (
                <i key={key} style={{ background: board.look![key] }} title={`${name} ${board.look![key]}`} />
              ))}
            </span>
          )}
          {source && (
            <button className="link" onClick={() => onFile(source)} title={`在文件页查看原文：${source}`}>
              原文
            </button>
          )}
        </div>
        <div className="sb-actions">
          <button onClick={() => onQuick('分镜要改：', [], true)}>提修改意见</button>
          {pending && ready && board.gate && (
            <button
              className="primary"
              id="storyboard-confirm"
              disabled={!!busy}
              title={busy ? 'AI 正在工作，等这一轮结束' : '确认分镜，开始渲染全部镜头'}
              onClick={() => board.gate && void confirmGate(board.gate.id, onQuick, board.gate.confirm)}
            >
              确认，开始渲染
            </button>
          )}
        </div>
        {pending && ready && <p className="sb-note">确认之前不会渲染。哪个镜头不对，右键它引用到对话里说。</p>}
        {board.parse_error && <p className="sb-note bad">分镜计划写错了：{board.parse_error}。下面按已有的镜头目录列出。</p>}
      </header>

      {board.treatment && (
        <details className="sb-treatment" data-ctx-source={board.treatment.path} data-ctx-label="整片处理方案" data-ctx-whole="">
          <summary>整片处理方案</summary>
          <Markdown text={board.treatment.content} />
        </details>
      )}

      {scenes.length > 0 && <StyleOverview board={board} onStyles={onStyles} />}

      <ol className="sb-list">
        {scenes.map((sc, index) => {
          const chapterStart = sc.chapter && sc.chapter !== scenes[index - 1]?.chapter;
          const prev = index > 0 ? scenes[index - 1] : null;
          const shift = prev && !sameStyle(prev.style, sc.style) ? prev.style : null;
          return (
            <Fragment key={sc.id}>
              {chapterStart && (
                <li className="sb-chapter" aria-hidden="true">
                  {sc.chapter}
                </li>
              )}
              {(sc.handoff || shift) && index > 0 && <Handoff scene={sc} from={shift} planned={!!board.plan_path && !board.parse_error} />}
              <SceneCard
                scene={sc}
                index={index}
                version={version}
                offDefault={sc.style.kind === 'named' || (sc.style.kind === 'none' && !!board.default_style)}
                onScene={onScene}
                onRestyle={() => setRestyle({ scene: sc, no: sceneNo(index) })}
              />
            </Fragment>
          );
        })}
      </ol>
      {restyle && (
        <SceneStyleDialog
          who={`镜头 ${restyle.no}（${restyle.scene.id}）`}
          current={restyle.scene.film_style ?? ''}
          defaultStyle={board.default_style}
          installed={new Set(board.installed_styles)}
          nameOf={(key) => scenes.find((x) => x.style.key === key)?.style.cn}
          onAsk={(text) => onQuick(text, [], true)}
          onClose={() => setRestyle(null)}
        />
      )}
    </div>
  );
}

/**
 * 全片的画风：默认风格与个别段落换上的风格各用在哪几个镜头。
 * 点一组跳到它的第一个镜头；风格本身（装、换默认、去掉）在「风格」页。
 */
function StyleOverview({ board, onStyles }: { board: StoryboardResponse; onStyles?: () => void }) {
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
    if (id) document.querySelector(`#storyboard [data-scene="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  return (
    <section className="sb-styles" id="storyboard-styles" aria-label="画风">
      <header className="sb-styles-head">
        <span className="eyebrow">画风</span>
        <span className="sb-styles-sum">
          {onlyFree ? '还没有整片风格，每个镜头按文案自己定视觉' : groups.length === 1 ? '全片一种画风' : `${groups.length} 种画风 · ${boundaries} 处风格交界`}
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
              <button className={'sb-style-group' + (g.style.missing ? ' missing' : '')} onClick={() => jump(g.indexes[0])} title="跳到这种画风的第一个镜头">
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
function Handoff({ scene, from, planned }: { scene: StoryboardScene; from: StoryboardStyle | null; planned: boolean }) {
  const h = scene.handoff;
  const unplanned = from && planned && !h?.style_shift;
  return (
    <li className={'sb-handoff' + (from ? ' style-shift' : '') + (unplanned ? ' unplanned' : '')} title="上一个镜头怎么接到这个镜头">
      {from && (
        <span className="sb-handoff-style">
          <StyleThumb style={from} />
          <span>{from.cn}</span>
          <span aria-hidden="true">→</span>
          <StyleThumb style={scene.style} />
          <span>{scene.style.cn}</span>
          {h?.style_shift ? <em>{h.style_shift_label || h.style_shift}</em> : unplanned ? <em className="bad">还没写画风怎么换过去</em> : null}
        </span>
      )}
      {h && <span className="sb-handoff-device">↓ {h.device_label || h.device}</span>}
      {h && <span className="sb-handoff-bridge">{h.bridge}</span>}
    </li>
  );
}

function SceneCard(props: {
  scene: StoryboardScene;
  index: number;
  version: number;
  /** 没用默认风格（点名了别的或不用整片风格）：卡片左边加一道线，一眼看出哪几段换了画风。 */
  offDefault: boolean;
  onScene: (id: string) => void;
  onRestyle: () => void;
}) {
  const { scene, index, version, onScene } = props;
  const no = sceneNo(index);
  return (
    <li className={`sb-scene${scene.rendered ? ' rendered' : ''}${props.offDefault ? ' off-default' : ''}`} data-ctx-scene={scene.id} data-scene={scene.id}>
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
          <blockquote className="sb-text" data-ctx-source={`${scene.dir}/scene.json`} data-ctx-label={`镜头 ${no} 的口播`} data-ctx-whole="">
            {scene.text}
          </blockquote>
        )}
        {scene.prompt ? (
          <details className="sb-prompt" data-ctx-source={scene.prompt.path} data-ctx-label={`镜头 ${no} 的画面描述`} data-ctx-whole="">
            <summary>画面描述</summary>
            <Markdown text={scene.prompt.content} />
          </details>
        ) : (
          scene.created && <p className="sb-todo">画面描述还没写</p>
        )}
      </div>
    </li>
  );
}

/** 镜头页右栏：这个镜头在分镜里想画什么，对照着看画面。 */
export function SceneBrief({ sceneId, version, onStoryboard }: { sceneId: string; version: number; onStoryboard?: () => void }) {
  const [item, setItem] = useState<StoryboardScene | null>(null);
  useEffect(() => {
    let live = true;
    api<StoryboardResponse>('/api/storyboard').then(
      (board) => live && setItem(board.scenes.find((s) => s.id === sceneId) ?? null),
      () => live && setItem(null),
    );
    return () => {
      live = false;
    };
  }, [sceneId, version]);
  if (!item || (!item.summary && !item.prompt)) return null;
  return (
    <div className="scene-brief" id="scene-brief">
      {item.summary && <p className="scene-brief-summary">{item.summary}</p>}
      <div className="scene-brief-links">
        {item.prompt && (
          <details className="scene-brief-prompt" data-ctx-source={item.prompt.path} data-ctx-label="画面描述" data-ctx-whole="">
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
    </div>
  );
}
