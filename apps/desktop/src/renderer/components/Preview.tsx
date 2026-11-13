import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api, errorText, post, rawURL } from '../api';
import type { Attachment, BeatState, Box, ProjectFilmStyle, ProjectState, ProjectUsage, Scene, TreeFile, Usage } from '../types';
import { cssSelector } from '../selector';
import { Icon } from './Icon';
import { MemoryTab } from './Memory';
import { FilmStyleDialog, FilmStylePicker, Poster, styleKey, useFilmStyles } from './FilmStyles';
import { Markdown } from './chat/Markdown';
import { ScriptTab } from './Script';
import { PublishTab } from './Publish';
import { FileTree } from './Sidebar';

export type Tab = 'script' | 'scene' | 'compose' | 'final' | 'style' | 'review' | 'publish' | 'memory' | 'file';

export const tabs: [Tab, string][] = [
  ['script', '口播稿'],
  ['scene', '镜头'],
  ['compose', '合成'],
  ['final', '成片'],
  ['style', '风格'],
  ['review', '复查'],
  ['publish', '发布'],
  ['memory', '记忆'],
  ['file', '文件'],
];

/** 顶栏中间的四个步骤，按制作顺序编号；其余页面（合成、复查、风格、记忆、文件）在顶栏右侧用小字列出。 */
export const stepTabs: Tab[] = ['script', 'scene', 'final', 'publish'];

/** 按钮触发的写任务：返回 task_id 的接口。App 负责发请求、提示与刷新任务列表。 */
export type RunAction = (path: string, payload?: Record<string, unknown>) => void;

interface Props {
  tab: Tab;
  /** 页面里的「去发布」这类按钮切页用。 */
  onTab?: (tab: Tab) => void;
  state: ProjectState | null;
  scenes: Scene[];
  usage: ProjectUsage | null;
  sceneId: string;
  filePath: string;
  tree: TreeFile[];
  /** 这一轮对话改过的文件，文件树里打点。 */
  recent: Set<string>;
  version: number;
  beat: BeatState | null;
  busy: string;
  onAttach: (attachment: Attachment) => void;
  /** 把一条消息交给对话：draftOnly 为 true 时只填进输入框。 */
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onFile: (path: string) => void;
  onScene: (id: string) => void;
  run: RunAction;
}

export function Preview(props: Props) {
  const scene = props.scenes.find((s) => s.id === props.sceneId) ?? null;
  return (
    <main className="pane center">
      {props.beat?.enabled && <BeatBanner beat={props.beat} version={props.version} run={props.run} />}
      <div className="preview-body">
        {props.tab === 'script' && (
          <ScriptTab version={props.version} busy={props.busy} onQuick={props.onQuick} onFile={props.onFile} onAttach={props.onAttach} />
        )}
        {props.tab === 'scene' && <SceneTab {...props} scene={scene} />}
        {props.tab === 'compose' && <ComposeTab {...props} scene={scene} />}
        {props.tab === 'final' && <FinalTab tree={props.tree} version={props.version} run={props.run} onTab={props.onTab} />}
        {props.tab === 'style' && <StyleTab version={props.version} run={props.run} scenes={props.scenes} onScene={props.onScene} />}
        {props.tab === 'review' && <ReviewTab tree={props.tree} version={props.version} run={props.run} />}
        {props.tab === 'publish' && <PublishTab version={props.version} run={props.run} />}
        {props.tab === 'memory' && <MemoryTab scene={scene} version={props.version} run={props.run} />}
        {props.tab === 'file' && <FilesTab tree={props.tree} recent={props.recent} path={props.filePath} version={props.version} onFile={props.onFile} />}
      </div>
      {/* 镜头条只在跟镜头有关的页面出现：口播稿、发布这些页面不需要它。 */}
      {(props.tab === 'scene' || props.tab === 'compose' || props.tab === 'final') && (
        <Timeline scenes={props.scenes} usage={props.usage} sceneId={props.sceneId} version={props.version} onScene={props.onScene} />
      )}
    </main>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

function BeatBanner({ beat, version, run }: { beat: BeatState; version: number; run: RunAction }) {
  if (beat.confirmed) return <div className="banner ok">卡点网格已确认。</div>;
  if (!beat.click) return <div className="banner">卡点模式：还没有试听轨，先在对话里让它跑 am beat analyze。</div>;
  return (
    <div className="banner beat" id="beat-banner">
      <span>试听草稿网格：每拍一声，重拍更高。重拍对不上就在对话里说，确认无误再导入。</span>
      <audio controls preload="none" src={rawURL(beat.click_path, version)} />
      <button className="primary" onClick={() => run('/api/commands/beat.confirm')}>
        确认网格
      </button>
    </div>
  );
}

const FPS = 30;

function sceneStatus(scene: Scene): 'ok' | 'stale' | 'todo' | 'rendering' {
  if (scene.rendering) return 'rendering';
  if (!scene.exists) return 'todo';
  return scene.stale ? 'stale' : 'ok';
}

const statusText = { ok: '已出片', stale: '输入改过，产物已过期', todo: '未出片', rendering: '渲染中' };

/** 镜头页的快捷动作：带上镜头编号直接发给编排工具，由它改项目文件、重渲染。 */
const quickActions: { label: string; needsOutput?: boolean; text: (id: string) => string }[] = [
  {
    label: '重做这个镜头',
    text: (id) =>
      `重做镜头 ${id}：保留文案、时长和与相邻镜头的交接约定，换一个更贴合文案的视觉方案。改好这个镜头的 prompt.md 后用 am scene run 重渲染它，渲染完用几句话说明新方案。`,
  },
  {
    label: '节奏放慢',
    needsOutput: true,
    text: (id) => `镜头 ${id} 的动画节奏放慢：元素出现更从容，关键信息多停留一会，总时长不变。改好后重渲染这个镜头。`,
  },
  {
    label: '节奏加快',
    needsOutput: true,
    text: (id) => `镜头 ${id} 的动画节奏加快：减少等待和空镜，信息更紧凑，总时长不变。改好后重渲染这个镜头。`,
  },
  {
    label: '文字太多',
    needsOutput: true,
    text: (id) => `镜头 ${id} 画面上的文字太多、读不过来：精简成关键词，信息交给画面和字幕，每块文字留够阅读时间。改好后重渲染这个镜头。`,
  },
];

function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 镜头时间线：宽度按时长比例，底部色条是出片状态。点哪个镜头就预览哪个。 */
function Timeline({ scenes, usage, sceneId, version, onScene }: { scenes: Scene[]; usage: ProjectUsage | null; sceneId: string; version: number; onScene: (id: string) => void }) {
  if (scenes.length === 0) return null;
  const total = scenes.reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0);
  // 镜头条就是缩略图：每格是那个镜头的画面，宽度按时长；状态只在出问题时用一道色条提示。
  return (
    <section className="timeline" aria-label="时间线">
      <div className="strip">
        {scenes.map((scene, index) => {
          const status = sceneStatus(scene);
          return (
            <button
              key={scene.id}
              className={`scene ${status}${scene.id === sceneId ? ' on' : ''}`}
              data-ctx-scene={scene.id}
              style={{ flex: `${scene.duration_seconds || 1} 1 0` }}
              title={`镜头 ${String(index + 1).padStart(2, '0')}（${scene.id}）${scene.duration_seconds ? ` · ${scene.duration_seconds.toFixed(1)} 秒` : ''} · ${statusText[status]}${scene.attempts ? ` · ${usageLabel(scene)}` : ''}`}
              aria-pressed={scene.id === sceneId}
              onClick={() => onScene(scene.id)}
            >
              {scene.exists && (
                <video
                  className="thumb"
                  muted
                  preload="metadata"
                  aria-hidden="true"
                  tabIndex={-1}
                  src={`/api/scenes/${encodeURIComponent(scene.id)}/asset?v=${version}#t=${Math.min(1, (scene.duration_seconds || 2) / 2)}`}
                />
              )}
              <span className="scene-no" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="sr-only">
                {scene.id} {statusText[status]}
              </span>
            </button>
          );
        })}
      </div>
      <span className="timeline-total" title={usage && (usage.attempts > 0 || usage.orchestrator.calls > 0) ? `本项目 ${tokenLabel(usage.total)}\n${projectUsageTitle(usage)}` : undefined}>
        {total > 0 ? clock(total).replace(/\.\d+$/, '') : ''}
      </span>
    </section>
  );
}

/** 选区旁的小工具条：贴在选区下沿，放不下就放到上沿，左右不出画面。 */
function SelectionBar(props: {
  drag: { x0: number; y0: number; x1: number; y1: number };
  frame: HTMLDivElement | null;
  onFix: () => void;
  onAttach: () => void;
  onClear: () => void;
}) {
  const { drag, frame } = props;
  const width = frame?.clientWidth ?? 0;
  const height = frame?.clientHeight ?? 0;
  const barW = 236;
  const barH = 36;
  const left = Math.max(8, Math.min(Math.min(drag.x0, drag.x1), width - barW - 8));
  const bottom = Math.max(drag.y0, drag.y1);
  const top = bottom + 8 + barH <= height - 8 ? bottom + 8 : Math.max(8, Math.min(drag.y0, drag.y1) - barH - 8);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClear]);

  return (
    <div className="selection-bar" style={{ left, top }}>
      <button id="fix-region" className="primary" onClick={props.onFix} title="带上这一帧和圈出的区域，在对话里说哪里不对">
        说说这里…
      </button>
      <button id="attach-region" onClick={props.onAttach} title="把这一帧和圈出的区域附到对话">
        附到对话
      </button>
      <button className="icon" onClick={props.onClear} aria-label="取消圈选" title="取消圈选（Esc）">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function SceneTab(props: Props & { scene: Scene | null }) {
  const { scene } = props;
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // 拖动中（还没松手）。按下没移动就松开算一次点击：有选区时清掉选区，没有就播放 / 暂停。
  const [dragging, setDragging] = useState(false);
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState('');
  const menu = useRef<HTMLDetailsElement>(null);
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number; maxHeight: number } | null>(null);

  // 菜单按视口定位（fixed）：外层容器会裁剪、时间线会盖住绝对定位的弹出层。
  // 下方放得下就往下开，否则往上开，高度不够时菜单内部滚动。
  const placeMenu = () => {
    const el = menu.current;
    const summary = el?.querySelector('summary');
    if (!el?.open || !summary) return setMenuPos(null);
    const r = summary.getBoundingClientRect();
    const gap = 8;
    const margin = 12;
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const right = Math.max(margin, window.innerWidth - r.right);
    if (below >= 360 || below >= above) setMenuPos({ top: r.bottom + gap, right, maxHeight: below });
    else setMenuPos({ bottom: window.innerHeight - r.top + gap, right, maxHeight: above });
  };

  useEffect(() => {
    if (!menuPos) return;
    const update = () => placeMenu();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [menuPos !== null]);

  // 「⋯」菜单点外面就收起；菜单里的输入框与按钮不收。
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = menu.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  useEffect(() => {
    if (menu.current) menu.current.open = false;
    setDrag(null);
    setDragging(false);
    setError('');
    setNote('');
    setFeedback('');
    setTime(0);
    setPlaying(false);
  }, [scene?.id]);

  // 键盘：← / → 逐帧（按住 Shift 一次 10 帧），空格播放 / 暂停。焦点在输入框、下拉框里时不拦截；
  // 空格落在按钮上时交给按钮自己。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      const v = video.current;
      if (!v) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const frames = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
        v.pause();
        v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + frames / FPS));
      } else if (e.key === ' ' && !target?.closest('button, summary, a')) {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!scene) return <Empty>{noSceneText(props.scenes)}</Empty>;
  const status = sceneStatus(scene);

  const step = (frames: number) => {
    const v = video.current;
    if (!v) return;
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + frames / FPS));
  };

  // 视频按 object-fit: contain 显示，算出画面实际占的矩形，才能把鼠标坐标换成视频像素。
  const toVideoBox = (): Box | undefined => {
    const v = video.current;
    if (!v || !drag || !v.videoWidth) return undefined;
    const scale = Math.min(v.clientWidth / v.videoWidth, v.clientHeight / v.videoHeight);
    const offsetX = (v.clientWidth - v.videoWidth * scale) / 2;
    const offsetY = (v.clientHeight - v.videoHeight * scale) / 2;
    const clamp = (value: number, limit: number) => Math.max(0, Math.min(limit, Math.round(value)));
    const x0 = clamp((Math.min(drag.x0, drag.x1) - offsetX) / scale, v.videoWidth);
    const y0 = clamp((Math.min(drag.y0, drag.y1) - offsetY) / scale, v.videoHeight);
    const x1 = clamp((Math.max(drag.x0, drag.x1) - offsetX) / scale, v.videoWidth);
    const y1 = clamp((Math.max(drag.y0, drag.y1) - offsetY) / scale, v.videoHeight);
    if (x1 - x0 < 4 || y1 - y0 < 4) return undefined;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  const capture = async (): Promise<Attachment | null> => {
    const v = video.current;
    if (!v) return null;
    setError('');
    try {
      const attachment = await api<Attachment>(`/api/scenes/${encodeURIComponent(scene.id)}/attachment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seconds: Number(v.currentTime.toFixed(3)), region: toVideoBox() }),
      });
      setDrag(null);
      return attachment;
    } catch (err) {
      setError(errorText(err));
      return null;
    }
  };

  const attach = async () => {
    const attachment = await capture();
    if (attachment) props.onAttach(attachment);
  };

  // 「修这一帧」：带上当前帧（和圈选）填进输入框，用户说清楚哪里不对再发。
  const fixFrame = async () => {
    const region = !!drag;
    const attachment = await capture();
    if (attachment) props.onQuick(region ? `镜头 ${scene.id} 圈出的这块：` : `镜头 ${scene.id} 这一帧的问题：`, [attachment], true);
  };

  // 👍 / 👎 写成一段记忆经历：当前帧时间、圈选区域（归一化）与说明。
  const sendFeedback = async (verdict: 'up' | 'down') => {
    const v = video.current;
    const box = toVideoBox();
    setError('');
    try {
      await post('/api/memory/actions/feedback', {
        scene_id: scene.id,
        verdict,
        note: note.trim(),
        seconds: v ? Number(v.currentTime.toFixed(3)) : undefined,
        region: box && v ? [box.x / v.videoWidth, box.y / v.videoHeight, box.w / v.videoWidth, box.h / v.videoHeight] : undefined,
      });
      setFeedback(verdict === 'down' ? '已记下 👎，下次整理时会参考。' : '已记下 👍。');
      setNote('');
      setDrag(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const point = (e: ReactPointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const index = props.scenes.findIndex((s) => s.id === scene.id);
  const number = String(index + 1).padStart(2, '0');

  // 镜头页只留画面、名字和「重新渲染」；圈选直接在画面上拖。附帧、快捷指令、反馈、校验与用量都收进「⋯」菜单。
  return (
    <div className="scene-tab" data-ctx-scene={scene?.id}>
      <div className="scene-layout">
        {scene.exists ? (
          <div className="scene-stage">
              <div className="stage-frame" ref={frame}>
                <video
                  ref={video}
                  preload="metadata"
                  src={`/api/scenes/${encodeURIComponent(scene.id)}/asset?v=${props.version}`}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  onSeeked={(e) => setTime(e.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                />
                {/* 画面上直接拖就是圈选（会先暂停），点一下是播放 / 暂停。 */}
                <div
                  className="select-layer"
                  title={drag ? '' : '点一下播放 / 暂停，拖动圈出一块'}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                    const p = point(e);
                    press.current = { x: p.x, y: p.y, moved: false };
                  }}
                  onPointerMove={(e) => {
                    const start = press.current;
                    if (!start || !(e.buttons & 1)) return;
                    const p = point(e);
                    if (!start.moved && Math.hypot(p.x - start.x, p.y - start.y) < 5) return;
                    if (!start.moved) {
                      start.moved = true;
                      video.current?.pause();
                      setDragging(true);
                    }
                    setDrag({ x0: start.x, y0: start.y, x1: p.x, y1: p.y });
                  }}
                  onPointerUp={() => {
                    const start = press.current;
                    press.current = null;
                    setDragging(false);
                    if (!start) return;
                    if (start.moved) {
                      if (!toVideoBox()) setDrag(null);
                      return;
                    }
                    if (drag) setDrag(null);
                    else toggle();
                  }}
                  onPointerCancel={() => {
                    press.current = null;
                    setDragging(false);
                  }}
                >
                  {drag && (
                    <i
                      className="select-box"
                      style={{
                        left: Math.min(drag.x0, drag.x1),
                        top: Math.min(drag.y0, drag.y1),
                        width: Math.abs(drag.x1 - drag.x0),
                        height: Math.abs(drag.y1 - drag.y0),
                      }}
                    />
                  )}
                </div>
                {drag && !dragging && <SelectionBar drag={drag} frame={frame.current} onFix={fixFrame} onAttach={attach} onClear={() => setDrag(null)} />}
              </div>
              <div className="transport">
                <button className="step" onClick={() => step(-1)} aria-label="后退一帧" title="后退一帧（←，Shift+← 10 帧）">
                  <Icon name="prev" size={14} />
                </button>
                <button className="play" onClick={toggle} aria-label={playing ? '暂停' : '播放'} title="播放 / 暂停（空格）">
                  <Icon name={playing ? 'pause' : 'play'} size={14} />
                </button>
                <button className="step" onClick={() => step(1)} aria-label="前进一帧" title="前进一帧（→，Shift+→ 10 帧）">
                  <Icon name="next" size={14} />
                </button>
                <span className="timecode">{clock(time)}</span>
                <span className="mono small muted">/ {clock(duration)}</span>
                <input
                  className="scrub"
                  type="range"
                  min={0}
                  max={duration || 0}
                  step={1 / FPS}
                  value={time}
                  aria-label="播放位置"
                  onChange={(e) => {
                    const v = video.current;
                    if (v) v.currentTime = Number(e.currentTarget.value);
                  }}
                />
                <span className="mono small muted">
                  帧 {Math.round(time * FPS)} / {Math.round(duration * FPS)}
                </span>
              </div>
          </div>
        ) : (
          <div className="scene-stage">
            <Empty>这个镜头还没有产物。点「渲染」，或在对话里让它处理。</Empty>
          </div>
        )}

        <aside className="scene-info">
          <span className="eyebrow">
            镜头 {number} / {String(props.scenes.length).padStart(2, '0')}
          </span>
          <h1 className="scene-title" title={scene.id}>
            镜头 {number}
          </h1>
          <p className="scene-meta">
            {scene.duration_seconds ? `${scene.duration_seconds.toFixed(1)} 秒 · ` : ''}
            <span className={'status-' + status}>{statusText[status]}</span>
          </p>
          <SceneStyle scene={scene} label={`镜头 ${number}`} version={props.version} onQuick={props.onQuick} />
          <div className="scene-actions">
            <button id="render-scene" className={scene.exists ? '' : 'primary'} onClick={() => props.run(`/api/scenes/${encodeURIComponent(scene.id)}/render`)}>
              {scene.exists ? '重新渲染' : '渲染'}
            </button>
            <details className="scene-menu" ref={menu} onToggle={placeMenu}>
              <summary aria-label="更多操作" title="更多操作">
                <Icon name="more" size={16} />
              </summary>
              <div className="scene-menu-body" style={menuPos ?? undefined}>
                {scene.exists && (
                  <div className="menu-group">
                    <button id="attach-frame" onClick={attach}>
                      附当前帧到对话
                    </button>
                    <button onClick={fixFrame} title="带上当前帧（和圈选的区域），在对话里说哪里不对">
                      修这一帧…
                    </button>
                  </div>
                )}
                <div className="menu-group quick-actions" role="group" aria-label="让编排工具">
                  <span className="menu-label">让编排工具</span>
                  {quickActions
                    .filter((action) => scene.exists || !action.needsOutput)
                    .map((action) => (
                      <button key={action.label} onClick={() => props.onQuick(action.text(scene.id), [])}>
                        {action.label}
                      </button>
                    ))}
                </div>
                {scene.exists && (
                  <div className="menu-group">
                    <span className="menu-label">记一笔（进记忆）</span>
                    <input
                      className="feedback-note"
                      value={note}
                      placeholder="说明（可选）"
                      aria-label="反馈说明"
                      onChange={(e) => setNote(e.currentTarget.value)}
                    />
                    <div className="menu-row">
                      <button title="记为好的经历" aria-label="赞" onClick={() => sendFeedback('up')}>
                        👍 这一镜好
                      </button>
                      <button title="记为需要改进的经历，下次整理时参考" aria-label="踩" onClick={() => sendFeedback('down')}>
                        👎 不满意
                      </button>
                    </div>
                  </div>
                )}
                <div className="menu-group">
                  <button onClick={() => props.run('/api/commands/scene.validate', { scene_id: scene.id })}>校验</button>
                  {scene.attempts > 0 && (
                    <span className="menu-note" title={usageTitle(scene)}>
                      {usageLabel(scene)}
                    </span>
                  )}
                </div>
              </div>
            </details>
          </div>
          {error && <p className="error-line">{error}</p>}
          {feedback && <p className="ok-line">{feedback}</p>}
        </aside>
      </div>
    </div>
  );
}

function ComposeTab(props: Props & { scene: Scene | null }) {
  const { scene } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const [picking, setPicking] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setPicking(false);
    setMissing(!props.tree.some((f) => scene && f.path === relativeScene(props.state, scene) + '/index.html'));
  }, [scene?.id, props.tree]);

  // iframe 与 Studio 同源，可以直接在合成页面上挂监听，取被点中元素的选择器。
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!picking || !doc || !scene) return;
    let hovered: HTMLElement | null = null;
    const over = (e: Event) => {
      hovered?.style.removeProperty('outline');
      hovered = e.target as HTMLElement;
      hovered.style.outline = '2px dashed #d9a35f';
    };
    const click = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      hovered?.style.removeProperty('outline');
      props.onAttach({
        scene_id: scene.id,
        selector: cssSelector(e.target as Element),
        source: relativeScene(props.state, scene) + '/index.html',
      });
      setPicking(false);
    };
    doc.addEventListener('mouseover', over, true);
    doc.addEventListener('click', click, true);
    return () => {
      hovered?.style.removeProperty('outline');
      doc.removeEventListener('mouseover', over, true);
      doc.removeEventListener('click', click, true);
    };
  }, [picking, scene?.id]);

  if (!scene) return <Empty>{noSceneText(props.scenes)}</Empty>;
  if (missing) return <Empty>镜头目录里还没有 index.html 合成文件。</Empty>;
  return (
    <div className="compose-tab">
      <div className="toolbar">
        <span className="scene-title">{scene.id}</span>
        <span className="small muted">合成实时预览：镜头目录里的 index.html</span>
        <span className="spacer" />
        <button className={picking ? 'armed' : ''} aria-pressed={picking} id="pick-element" onClick={() => setPicking(!picking)}>
          <Icon name="pointer" />
          {picking ? '取消选取' : '选元素附到对话'}
        </button>
      </div>
      <iframe
        ref={frame}
        className="compose-frame"
        title="合成预览"
        src={`/preview/scenes/${encodeURIComponent(scene.id)}/?v=${props.version}`}
      />
    </div>
  );
}

function relativeScene(state: ProjectState | null, scene: Scene): string {
  const root = state?.project.path ?? '';
  return scene.directory.startsWith(root + '/') ? scene.directory.slice(root.length + 1) : scene.directory;
}

const finalCandidates = ['final.mp4', 'production/final.mp4', 'production/audio/candidate.mp4', 'production/silent-master.mp4'];

const finalLabels: Record<string, string> = {
  'final.mp4': '成片',
  'production/final.mp4': '成片',
  'production/audio/candidate.mp4': '配音合成版',
  'production/silent-master.mp4': '无声母版',
};

/** 成片页：左边是片子，右边是复查摘要与下一步。复查的细节（交界帧、联系表）在「复查」页。 */
function FinalTab({ tree, version, run, onTab }: { tree: TreeFile[]; version: number; run: RunAction; onTab?: (tab: Tab) => void }) {
  const present = finalCandidates.filter((path) => tree.some((f) => f.path === path));
  const [chosen, setChosen] = useState('');
  const [review, setReview] = useState<ReviewResponse | null>(null);
  useEffect(() => {
    api<ReviewResponse>('/api/review').then(setReview, () => setReview({ available: false }));
  }, [version]);
  const current = present.includes(chosen) ? chosen : present[0];
  const report = review?.available ? review.report : undefined;
  const problems = reviewProblems(report);
  const seconds = report?.media?.duration_seconds;
  const num = (v?: number, digits = 1) => (v == null ? '—' : v.toFixed(digits).replace('-', '−'));
  return (
    <div className="final-tab">
      <div className="scene-layout">
        <div className="scene-stage">
          {current ? (
            <div className="stage-frame">
              <video controls preload="metadata" src={rawURL(current, version)} />
            </div>
          ) : (
            <Empty>还没有成片。镜头都出片后，可以先拼接无声母版。</Empty>
          )}
        </div>
        <aside className="scene-info">
          <span className="eyebrow">成片{seconds ? ` · ${clock(seconds).replace(/\.\d+$/, '')}` : ''}</span>
          <h1 className="scene-title">{current ? finalLabels[current] ?? current : '还没有成片'}</h1>
          {present.length > 1 && (
            <div className="final-versions" role="group" aria-label="版本">
              {present.map((path) => (
                <button key={path} className={path === current ? 'on' : ''} aria-pressed={path === current} title={path} onClick={() => setChosen(path)}>
                  {finalLabels[path] ?? path}
                </button>
              ))}
            </div>
          )}
          {report ? (
            <dl className="final-review">
              <dt>复查</dt>
              <dd className={problems.length ? 'bad' : 'ok'}>
                {problems.length ? (
                  <button className="link" onClick={() => onTab?.('review')}>
                    {problems.length} 个问题，去看
                  </button>
                ) : (
                  '没有问题'
                )}
              </dd>
              {report.expected_frames != null && (
                <>
                  <dt>帧数</dt>
                  <dd className="mono">
                    {report.counted_frames ?? '—'} / {report.expected_frames}
                  </dd>
                </>
              )}
              {report.loudness && (
                <>
                  <dt>响度</dt>
                  <dd className="mono">{num(report.loudness.integrated_lufs)} LUFS</dd>
                  <dt>真峰</dt>
                  <dd className="mono">{num(report.loudness.true_peak_dbtp)} dBTP</dd>
                </>
              )}
            </dl>
          ) : (
            <p className="scene-meta">还没有复查。</p>
          )}
          <div className="scene-actions">
            {current && problems.length === 0 && report && (
              <button
                className="primary"
                id="final-approve"
                title="确认后会把这次制作里记下的问题整理成经验（调用一次 AI），然后去发布页"
                onClick={() => {
                  run('/api/memory/actions/consolidate', { final: true });
                  onTab?.('publish');
                }}
              >
                确认可用，去发布
              </button>
            )}
            <button onClick={() => run('/api/review/run')}>{report ? '重新复查' : '复查'}</button>
          </div>
          <div className="final-more">
            <button className="link" onClick={() => run('/api/commands/project.concat')}>
              拼接无声母版
            </button>
            <button className="link" onClick={() => run('/api/render/all')}>
              渲染全部镜头
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * 镜头页里的风格一行：这个镜头用的是哪种风格，「换风格」打开风格弹窗。
 * 选好后不直接改文件（客户端不写项目文件），把要求写进输入框交给编排工具：它要改分镜计划、
 * 必要时 am film-style add，并给变成风格交界的地方挑过渡手法，再重跑 am scene cues。
 */
function SceneStyle(props: { scene: Scene; label: string; version: number; onQuick: Props['onQuick'] }) {
  const [info, setInfo] = useState<ProjectFilmStyle | null>(null);
  const [open, setOpen] = useState(false);
  const films = useFilmStyles(open);
  useEffect(() => {
    api<ProjectFilmStyle>('/api/film-style').then(setInfo, () => setInfo(null));
  }, [props.version]);
  if (!info) return null;
  const raw = info.scenes?.find((x) => x.id === props.scene.id)?.film_style ?? '';
  const extras = info.extras ?? [];
  const nameOf = (key: string) =>
    extras.find((x) => styleKey(x.manifest) === key)?.manifest.cn ?? films.data?.styles.find((x) => styleKey(x) === key)?.cn ?? key;
  let label: ReactNode;
  if (raw === '') label = info.manifest ? <>{info.manifest.cn}<span className="muted">（默认）</span></> : <span className="muted">自主定视觉</span>;
  else if (raw === 'none') label = <span className="muted">不用整片风格</span>;
  else label = <>{nameOf(raw)}{info.missing?.some((m) => m.scene === props.scene.id) && <span className="bad">（没装进项目）</span>}</>;
  const installed = new Set([...(info.manifest ? [styleKey(info.manifest)] : []), ...extras.map((x) => styleKey(x.manifest))]);
  const pick = (value: string) => {
    const who = `${props.label}（${props.scene.id}）`;
    let ask: string;
    if (value === '@default') ask = info.manifest ? `把${who}改回默认风格「${info.manifest.cn}」。` : `把${who}改回不写风格、自主定视觉。`;
    else if (value === 'none') ask = `把${who}改成不用整片风格、自主定视觉。`;
    else ask = `把${who}换成「${nameOf(value)}」风格（${value}）。`;
    props.onQuick(
      ask + '改分镜计划并重跑 am scene cues；它和相邻镜头的风格不同时，按「风格交界」挑一种过渡手法，让画法在画面里自然地换过去，不要硬切或叠化。',
      [],
      true,
    );
  };
  return (
    <>
      <p className="scene-style">
        <span className="muted">风格</span>
        <strong>{label}</strong>
        <button className="ghost small" id="scene-style" onClick={() => setOpen(true)}>
          换风格
        </button>
      </p>
      {open && (
        <FilmStyleDialog
          title={`${props.label} 换一种风格`}
          intro="选好后写进对话，由编排工具改分镜，并给前后的风格交界设计画面里的过渡。"
          confirm="写进对话"
          data={films.data}
          error={films.error}
          posterVersion={films.posterVersion}
          selected={raw === '' ? '@default' : raw}
          installed={installed}
          specials={[
            {
              value: '@default',
              title: info.manifest ? `跟随默认风格：${info.manifest.cn}` : '跟随默认风格',
              desc: info.manifest ? '和全片大多数镜头一样。' : '项目还没有默认风格，镜头自主定视觉。',
              mark: '默',
            },
            { value: 'none', title: '不用整片风格', desc: '这个镜头按文案自己定配色、字体与动效。', mark: 'Aa' },
          ]}
          onPick={pick}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** 镜头 id 换成镜头页用的编号（按镜头顺序，两位数）；找不到时原样返回。 */
function sceneNumber(scenes: Scene[], id: string): string {
  const index = scenes.findIndex((s) => s.id === id);
  return index < 0 ? id : '镜头 ' + String(index + 1).padStart(2, '0');
}

/**
 * 风格页：本项目的风格。默认风格（不写 film_style 的镜头用它）展示海报、适用题材、STYLE.md，
 * 可以换或去掉；下面是个别镜头点名用的其他风格，每种列出在用的镜头，可以添加、去掉。
 * 装、换、添加、去掉都是 am film-style 写任务，会占项目写锁，进度在右上角任务里。
 * 哪个镜头用哪种风格要改分镜计划与 scene.json，那是编排工具的事，这里只读。
 */
function StyleTab({ version, run, scenes, onScene }: { version: number; run: RunAction; scenes: Scene[]; onScene: (id: string) => void }) {
  const [info, setInfo] = useState<ProjectFilmStyle | null>(null);
  const [error, setError] = useState('');
  const [doc, setDoc] = useState('');
  const [docKey, setDocKey] = useState('');
  const [dialog, setDialog] = useState<'' | 'default' | 'extra'>('');
  const [confirmRemove, setConfirmRemove] = useState('');
  const films = useFilmStyles(dialog !== '' || info?.installed === false);
  useEffect(() => {
    api<ProjectFilmStyle>('/api/film-style').then(
      (result) => {
        setInfo(result);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version]);
  const extras = info?.extras ?? [];
  const shown = extras.find((x) => styleKey(x.manifest) === docKey);
  const docFile = shown ? shown.style_file : info?.style_file;
  useEffect(() => {
    setDoc('');
    if (docFile)
      fetch(rawURL(docFile, version))
        .then((r) => (r.ok ? r.text() : ''))
        .then(setDoc, () => setDoc(''));
  }, [docFile, version]);
  const rendered = scenes.some((scene) => scene.exists);
  const staleNote = rendered ? '已经渲染的镜头不会自动更新，要重渲染才会换成新风格（整批渲染时 am 会按输入指纹把它们判为过期）。' : '';
  const installedKeys = new Set([...(info?.manifest ? [styleKey(info.manifest)] : []), ...extras.map((x) => styleKey(x.manifest))]);
  const pickDefault = (slug: string) => {
    if (!slug) return;
    setDialog('');
    run('/api/film-style', { style: slug, replace: true });
  };
  const addExtra = (slug: string) => {
    if (!slug) return;
    setDialog('');
    run('/api/film-style', { style: slug, as: 'extra' });
  };
  const sceneLinks = (ids: string[]) =>
    ids.length === 0 ? (
      <span className="muted small">还没有镜头用它</span>
    ) : (
      <span className="style-scenes">
        {ids.map((id) => (
          <button key={id} className="chip" onClick={() => onScene(id)} title={id}>
            {sceneNumber(scenes, id)}
          </button>
        ))}
      </span>
    );
  const dialogs = (
    <>
      {dialog === 'default' && info?.manifest && (
        <FilmStyleDialog
          title="换默认风格"
          intro={<>不写风格的镜头都会换成新风格；点名了其他风格的镜头不受影响。{staleNote}</>}
          confirm="换成这个风格"
          data={films.data}
          error={films.error}
          posterVersion={films.posterVersion}
          selected={styleKey(info.manifest)}
          installed={installedKeys}
          onPick={pickDefault}
          onClose={() => setDialog('')}
        />
      )}
      {dialog === 'extra' && (
        <FilmStyleDialog
          title="添加一种风格"
          intro="装进项目后，在对话里告诉编排工具哪些镜头或段落用它；它会改分镜，并给风格交界设计画面里的过渡。"
          confirm="添加"
          data={films.data}
          error={films.error}
          posterVersion={films.posterVersion}
          selected=""
          installed={installedKeys}
          onPick={addExtra}
          onClose={() => setDialog('')}
        />
      )}
    </>
  );
  const others = (
    <section className="style-others">
      <header>
        <h4>其他风格</h4>
        <span className="muted small">个别镜头用；相邻镜头风格不同时，交界会在画面里换过去</span>
        <span className="spacer" />
        <button onClick={() => setDialog('extra')} id="add-film-style">
          添加一种风格
        </button>
      </header>
      {(info?.missing ?? []).map((m) => (
        <p key={m.scene + m.style} className="bad small">
          {sceneNumber(scenes, m.scene)} 点名的 {m.style} 没装进项目，渲染会失败：添加这种风格，或在对话里让编排工具改掉。
        </p>
      ))}
      {extras.length === 0 ? (
        <p className="muted small">还没有。想让某一段换一种画法（回忆、片中片、对照……），先在这里添加，再在对话里说哪几个镜头用它。</p>
      ) : (
        <div className="style-other-list film-styles">
          {extras.map((x) => {
            const key = styleKey(x.manifest);
            return (
              <article key={key} className={'style-other' + (docKey === key ? ' on' : '')} data-style={key}>
                {x.style ? <Poster style={x.style} /> : <span className="fs-poster" />}
                <div className="style-other-text">
                  <strong>
                    {x.manifest.cn} <span className="muted">{x.manifest.en}</span>
                  </strong>
                  {sceneLinks(x.scenes)}
                  <div className="toolbar">
                    <button className="ghost" onClick={() => setDocKey(docKey === key ? '' : key)}>
                      {docKey === key ? '看默认风格' : '看说明'}
                    </button>
                    {confirmRemove === key ? (
                      <>
                        <button className="danger" onClick={() => (setConfirmRemove(''), run('/api/film-style', { remove: true, style: key }))}>
                          确认去掉
                        </button>
                        <button className="ghost" onClick={() => setConfirmRemove('')}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        className="ghost"
                        disabled={x.scenes.length > 0}
                        title={x.scenes.length > 0 ? '还有镜头在用：先在对话里让编排工具把它们换掉' : ''}
                        onClick={() => setConfirmRemove(key)}
                      >
                        去掉
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
  if (error) return <Empty>{error}</Empty>;
  if (!info) return <Empty>正在读整片风格…</Empty>;
  if (!info.installed) {
    return (
      <div className="style-tab">
        {dialogs}
        <section className="style-intro">
          <div className="style-intro-head">
            <span className="style-badge">没有默认风格</span>
            <h3>各镜头按文案自己定视觉</h3>
          </div>
          <p>
            从风格来源里选一种作为默认风格，镜头都画成它：渲染器会遵守它的 STYLE.md（外观、材质、配色逻辑、字体、动效与镜头语法），内容仍来自每个镜头自己的文案。个别段落之后还可以换成别的风格。
            {staleNote}
          </p>
        </section>
        {extras.length > 0 && others}
        <FilmStylePicker layout="grid" data={films.data} error={films.error} posterVersion={films.posterVersion} selected="" onPick={pickDefault} />
      </div>
    );
  }
  const style = info.style;
  const manifest = info.manifest!;
  return (
    <div className="style-tab">
      {dialogs}
      <section className="style-intro film">
        {style && (
          <div className="film-styles">
            <Poster style={style} full />
          </div>
        )}
        <div className="style-intro-head">
          <span className="style-badge">默认风格</span>
          <h3>
            {manifest.cn} <span className="muted">{manifest.en}</span>
          </h3>
        </div>
        {style && (
          <p>
            {style.category_cn} · 适合 {style.uses.join('、')}
            <br />
            <span className="muted small">
              {style.summary}（来源 {manifest.source}，版本 {manifest.version.slice(0, 12)}）
            </span>
          </p>
        )}
        {scenes.length > 0 && <div className="style-used">{sceneLinks(info.default_scenes ?? [])}</div>}
        <div className="toolbar">
          <button onClick={() => setDialog('default')}>换默认风格</button>
          {confirmRemove === '@default' ? (
            <>
              <span className="muted small">去掉后不写风格的镜头回到自主定视觉。{staleNote}</span>
              <button
                className="danger"
                onClick={() => {
                  setConfirmRemove('');
                  run('/api/film-style', { remove: true });
                }}
              >
                确认去掉
              </button>
              <button onClick={() => setConfirmRemove('')}>取消</button>
            </>
          ) : (
            <button onClick={() => setConfirmRemove('@default')}>去掉默认风格</button>
          )}
        </div>
      </section>
      {others}
      {doc ? (
        <section className="style-doc">
          {shown && (
            <p className="style-doc-head muted small">
              {shown.manifest.cn} 的 STYLE.md
            </p>
          )}
          <Markdown text={doc} />
        </section>
      ) : (
        <Empty>正在读 STYLE.md…</Empty>
      )}
    </div>
  );
}

/** production/review/review.json（review.Report）。问题字段是 problems；issues 是早期写法，照样认。 */
interface ReviewResponse {
  available: boolean;
  report?: {
    ok?: boolean;
    problems?: string[];
    issues?: unknown[];
    hints?: unknown[];
    expected_frames?: number;
    counted_frames?: number;
    media?: { duration_seconds?: number };
    loudness?: { integrated_lufs?: number; true_peak_dbtp?: number };
  } & Record<string, unknown>;
}

const reviewProblems = (r?: ReviewResponse['report']) => [...(r?.problems ?? []), ...(r?.issues ?? [])];

function ReviewTab({ tree, version, run }: { tree: TreeFile[]; version: number; run: RunAction }) {
  const [review, setReview] = useState<ReviewResponse | null>(null);
  useEffect(() => {
    api<ReviewResponse>('/api/review').then(setReview, () => setReview({ available: false }));
  }, [version]);
  const sheets = tree.filter((f) => /^production\/review\/.*\.png$/.test(f.path));
  const list = (title: string, items?: unknown[]) =>
    items && items.length > 0 ? (
      <section>
        <h4>{title}</h4>
        <ul className="issues">
          {items.map((item, index) => (
            <li key={index}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
          ))}
        </ul>
      </section>
    ) : null;
  return (
    <div className="review-tab">
      <div className="toolbar">
        <span className="small muted">am review 的结果：音画时长、交界帧、联系表与响度。</span>
        <span className="spacer" />
        <button className="primary" onClick={() => run('/api/review/run')}>
          运行复查
        </button>
      </div>
      {!review?.available ? (
        <Empty>还没有复查报告。</Empty>
      ) : (
        <>
          {list('问题', reviewProblems(review.report))}
          {list('提示', review.report?.hints)}
          {!reviewProblems(review.report).length && !review.report?.hints?.length && <p className="ok-line">没有发现问题。</p>}
        </>
      )}
      <div className="gallery wide">
        {sheets.map((sheet) => (
          <figure key={sheet.path}>
            <img src={rawURL(sheet.path, version)} alt="" loading="lazy" />
            <figcaption>{sheet.path.split('/').pop()}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

const videoExt = /\.(mp4|mov|webm)$/i;
const imageExt = /\.(png|jpe?g|webp|gif|svg)$/i;
const audioExt = /\.(wav|mp3|m4a|aac|flac|ogg|opus)$/i;

interface FileResponse {
  path: string;
  size: number;
  binary: boolean;
  content: string;
}

export function FileView({ path, version }: { path: string; version: number }) {
  const [file, setFile] = useState<FileResponse | null>(null);
  const [error, setError] = useState('');
  const media = videoExt.test(path) || imageExt.test(path) || audioExt.test(path);
  useEffect(() => {
    setFile(null);
    setError('');
    if (!path || media) return;
    api<FileResponse>('/api/files?path=' + encodeURIComponent(path)).then(setFile, (err) => setError(errorText(err)));
  }, [path, version]);

  if (!path) return <Empty>在左边的文件树里选一个文件。</Empty>;
  return (
    <div className="file-tab">
      <div className="toolbar">
        <code className="path">{path}</code>
        <span className="spacer" />
        <a className="button" href={rawURL(path, version)} target="_blank" rel="noreferrer">
          新窗口打开
        </a>
      </div>
      {videoExt.test(path) && (
        <div className="stage-frame">
          <video controls preload="metadata" src={rawURL(path, version)} />
        </div>
      )}
      {imageExt.test(path) && <img className="file-image" src={rawURL(path, version)} alt="" />}
      {audioExt.test(path) && <audio controls src={rawURL(path, version)} />}
      {error && <p className="error-line">{error}</p>}
      {file && (file.binary ? <Empty>二进制文件或超过 2 MB，不显示内容。</Empty> : <pre className="text" id="file-content" data-ctx-source={path} data-ctx-label={path.split('/').pop()}>
            {file.content}
          </pre>)}
    </div>
  );
}

/** 文件页：左边文件树，右边内容。文件树原来常驻左侧栏，现在只在这里出现。 */
function FilesTab(props: { tree: TreeFile[]; recent: Set<string>; path: string; version: number; onFile: (path: string) => void }) {
  const changed = props.tree.filter((f) => props.recent.has(f.path)).length;
  return (
    <div className="files-tab">
      <aside className="files-tree" aria-label="文件">
        {changed > 0 && <div className="recent-count">本轮改动 {changed} 个文件</div>}
        <FileTree files={props.tree} selected={props.path} recent={props.recent} onFile={props.onFile} />
      </aside>
      <div className="files-view">
        <FileView path={props.path} version={props.version} />
      </div>
    </div>
  );
}

/** 没有选中镜头时的提示：新项目还没有镜头，也就没有时间线。 */
export function noSceneText(scenes: Scene[]): string {
  return scenes.length > 0 ? '在下方时间线里选一个镜头。' : '还没有镜头。点右上「开始制作」，分镜完成后镜头会出现在下方的时间线里。';
}

/** 紧凑写法：12.3M token · $4.17 · 2 次渲染。 */
function usageLabel(scene: Scene): string {
  const u = scene.usage;
  const total = (u?.input_tokens ?? 0) + (u?.output_tokens ?? 0);
  if (!u || !u.source) return `${scene.attempts} 次渲染 · 未读到用量`;
  const parts = [`${compact(total)} token${u.partial ? '+' : ''}`];
  if (u.cost_usd != null) parts.push(`$${u.cost_usd.toFixed(2)}`);
  parts.push(`${scene.attempts} 次渲染`);
  return parts.join(' · ');
}

function usageTitle(scene: Scene): string {
  const u = scene.usage;
  if (!u || !u.source) return '渲染工具没有报用量';
  return `全部 ${scene.attempts} 次渲染合计：输入 ${(u.input_tokens ?? 0).toLocaleString()}（其中缓存 ${(u.cached_input_tokens ?? 0).toLocaleString()}）· 输出 ${(u.output_tokens ?? 0).toLocaleString()}${u.partial ? '；有的尝试没读到用量，这是下限' : ''}`;
}

/** 紧凑写法：12.3M token · $4.17；没读到用量时如实说。 */
function tokenLabel(u: Usage): string {
  if (!u.source) return u.partial ? '未读到用量' : '0 token';
  const parts = [`${compact((u.input_tokens ?? 0) + (u.output_tokens ?? 0))} token${u.partial ? '+' : ''}`];
  if (u.cost_usd != null) parts.push(`$${u.cost_usd.toFixed(2)}`);
  return parts.join(' · ');
}

const usageSources: Record<string, string> = { run: 'am run', studio: 'Studio 对话', consolidate: '整理记忆' };

function projectUsageTitle(u: ProjectUsage): string {
  const lines = [`渲染：${u.attempts} 次尝试 · ${tokenLabel(u.renders)}`, `编排：${u.orchestrator.calls} 次调用 · ${tokenLabel(u.orchestrator.total)}`];
  for (const [source, value] of Object.entries(u.orchestrator.by_source ?? {})) {
    lines.push(`  ${usageSources[source] ?? source}：${tokenLabel(value)}`);
  }
  if (u.total.partial) lines.push('有的调用没读到用量或费用，这是下限');
  return lines.join('\n');
}

function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
