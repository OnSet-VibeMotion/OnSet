import { Fragment, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import '../storyboard.css';
import type { Attachment, StoryboardResponse, StoryboardScene } from '../types';
import { Markdown } from './chat/Markdown';
import { SceneStyleDialog } from './FilmStyles';
import { confirmGate } from './Progress';
import { CheckAllButton } from './PromptCheck';
import { duration, lookNames, sameStyle, sceneNo } from './storyboard/helpers';
import { Handoff, SceneCard, StyleOverview } from './storyboard/StoryboardParts';

export { SceneBrief } from './storyboard/StoryboardParts';

/** 分镜相关的文件：聊天与文件树点到它们时打开分镜页。 */
export const storyboardFiles = ['production/scene-plan.json', 'production/scene-plan.md', 'production/treatment.md'];

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
  // 画面描述检查跑完、采用或丢掉之后重读一遍（检查不占项目写锁，不会触发整页刷新）。
  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((n) => n + 1);

  useEffect(() => {
    void api<StoryboardResponse>('/api/storyboard').then(
      (result) => {
        setBoard(result);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version, reloads]);

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
  const total =
    scenes.length > 0 && scenes.every((s) => s.seconds) ? scenes.reduce((sum, s) => sum + (s.seconds ?? 0), 0) : 0;
  const chapters = new Set(scenes.map((s) => s.chapter).filter(Boolean)).size;
  const motionScenes = scenes.filter((s) => (s.motion_effects?.length ?? 0) > 0).length;
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
          {scenes.length > 0 && (
            <span>
              已指定动效：{motionScenes} / {scenes.length} 镜
            </span>
          )}
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
          <CheckAllButton scenes={scenes} onChanged={reload} />
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
        {board.parse_error && (
          <p className="sb-note bad">分镜计划写错了：{board.parse_error}。下面按已有的镜头目录列出。</p>
        )}
      </header>

      {board.treatment && (
        <details
          className="sb-treatment"
          data-ctx-source={board.treatment.path}
          data-ctx-label="整片处理方案"
          data-ctx-whole=""
        >
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
              {(sc.handoff || shift) && index > 0 && (
                <Handoff scene={sc} from={shift} planned={!!board.plan_path && !board.parse_error} />
              )}
              <SceneCard
                scene={sc}
                index={index}
                version={version}
                offDefault={sc.style.kind === 'named' || (sc.style.kind === 'none' && !!board.default_style)}
                onScene={onScene}
                onRestyle={() => setRestyle({ scene: sc, no: sceneNo(index) })}
                busy={busy}
                onQuick={onQuick}
                onChanged={reload}
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
