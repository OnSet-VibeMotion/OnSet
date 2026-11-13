import { Fragment, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import type { Attachment, StoryboardResponse, StoryboardScene } from '../types';
import { Markdown } from './chat/Markdown';
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

function filmStyleName(style: string): string {
  if (style === 'none') return '不用整片风格';
  return style.split('/').pop() ?? style;
}

interface Props {
  version: number;
  busy: string;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onFile: (path: string) => void;
  onScene: (id: string) => void;
}

/** 分镜页：整片处理方案、按章节排的镜头与每个镜头的画面描述。只读，改分镜在对话里说。 */
export function StoryboardTab({ version, busy, onQuick, onFile, onScene }: Props) {
  const [board, setBoard] = useState<StoryboardResponse | null>(null);
  const [error, setError] = useState('');

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
          {pending && ready && (
            <button
              className="primary"
              id="storyboard-confirm"
              disabled={!!busy}
              title={busy ? 'AI 正在工作，等这一轮结束' : '确认分镜，开始渲染全部镜头'}
              onClick={() => onQuick('分镜我看过了，没问题，开始渲染。', [])}
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

      <ol className="sb-list">
        {scenes.map((sc, index) => {
          const chapterStart = sc.chapter && sc.chapter !== scenes[index - 1]?.chapter;
          return (
            <Fragment key={sc.id}>
              {chapterStart && (
                <li className="sb-chapter" aria-hidden="true">
                  {sc.chapter}
                </li>
              )}
              {sc.handoff && index > 0 && <Handoff scene={sc} />}
              <SceneCard scene={sc} index={index} version={version} onScene={onScene} />
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}

/** 两个镜头之间的交接：用什么手法、交界那一帧是什么样。 */
function Handoff({ scene }: { scene: StoryboardScene }) {
  const h = scene.handoff!;
  return (
    <li className="sb-handoff" title="上一个镜头怎么接到这个镜头">
      <span className="sb-handoff-device">
        ↓ {h.device_label || h.device}
        {h.style_shift && ` · 换画风：${h.style_shift_label || h.style_shift}`}
      </span>
      <span className="sb-handoff-bridge">{h.bridge}</span>
    </li>
  );
}

function SceneCard({ scene, index, version, onScene }: { scene: StoryboardScene; index: number; version: number; onScene: (id: string) => void }) {
  const no = String(index + 1).padStart(2, '0');
  return (
    <li className={`sb-scene${scene.rendered ? ' rendered' : ''}`} data-ctx-scene={scene.id} data-scene={scene.id}>
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
          {scene.film_style && <span className="sb-chip">{filmStyleName(scene.film_style)}</span>}
          {scene.anchor && <span title="这个镜头从哪里开始">从{scene.anchor}起</span>}
          <span className="sb-id">{scene.id}</span>
          {!scene.created && <span className="sb-todo">镜头目录还没建</span>}
          {scene.created && (
            <button className="link" onClick={() => onScene(scene.id)}>
              {scene.rendered ? '看画面' : '打开镜头'}
            </button>
          )}
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
