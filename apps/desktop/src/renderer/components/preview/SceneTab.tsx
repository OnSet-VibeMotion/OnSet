import { useEffect, useRef, useState } from 'react';
import { api, errorText, post } from '../../api';
import type { Attachment, Box, ProjectState, Scene, TreeFile } from '../../types';
import { SceneActivityPanel } from '../RenderActivity';
import { SceneEditor } from '../SceneEditor';
import { SceneBrief } from '../Storyboard';
import { SceneMenu } from './SceneMenu';
import { type DragRect, ScenePlayer } from './ScenePlayer';
import { SceneStyle } from './SceneStyle';
import {
  type BuiltinTab,
  Empty,
  FPS,
  noSceneText,
  type RunAction,
  relativeScene,
  sceneStatus,
  statusText,
} from './shared';

export interface SceneTabProps {
  scene: Scene | null;
  scenes: Scene[];
  state: ProjectState | null;
  tree: TreeFile[];
  version: number;
  busy: string;
  onTab?: (tab: BuiltinTab) => void;
  onAttach: (attachment: Attachment) => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean, appendDraft?: boolean) => void;
  onRegisterExitGuard?: (guard: ((proceed: () => void) => boolean) | null) => void;
  run: RunAction;
}

export function SceneTab(props: SceneTabProps) {
  const { scene } = props;
  const video = useRef<HTMLVideoElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editing, setEditing] = useState(false);
  const resumeTimeRef = useRef<number | null>(null);
  const [drag, setDrag] = useState<DragRect | null>(null);
  // 拖动中（还没松手）。按下没移动就松开算一次点击：有选区时清掉选区，没有就播放 / 暂停。
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [feedback, setFeedback] = useState('');

  useEffect(() => {
    setDrag(null);
    setDragging(false);
    setEditing(false);
    resumeTimeRef.current = null;
    setError('');
    setNote('');
    setFeedback('');
    setTime(0);
    setPlaying(false);
  }, [scene?.id]);

  // 键盘：← / → 逐帧（按住 Shift 一次 10 帧），空格播放 / 暂停。焦点在输入框、下拉框里时不拦截；
  // 空格落在按钮上时交给按钮自己。进入 HTML 编辑模式时由 SceneEditor 接管。
  useEffect(() => {
    if (editing) return;
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
  }, [editing]);

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
    if (attachment)
      props.onQuick(region ? `镜头 ${scene.id} 圈出的这块：` : `镜头 ${scene.id} 这一帧的问题：`, [attachment], true);
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
        region:
          box && v
            ? [box.x / v.videoWidth, box.y / v.videoHeight, box.w / v.videoWidth, box.h / v.videoHeight]
            : undefined,
      });
      setFeedback(verdict === 'down' ? '已记下 👎，下次整理时会参考。' : '已记下 👍。');
      setNote('');
      setDrag(null);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  };

  const index = props.scenes.findIndex((s) => s.id === scene.id);
  const number = String(index + 1).padStart(2, '0');
  const sceneRel = relativeScene(props.state, scene);
  const hasHtml = props.tree.some((f) => f.path === sceneRel + '/index.html');
  const enterEdit = () => {
    video.current?.pause();
    setPlaying(false);
    setDrag(null);
    setEditing(true);
  };
  const exitEdit = () => {
    resumeTimeRef.current = time;
    setEditing(false);
  };

  // 镜头页只留画面、名字和「重新渲染」；圈选直接在画面上拖。附帧、快捷指令、反馈、校验与用量都收进「⋯」菜单。
  return (
    <div className="scene-tab" data-ctx-scene={scene?.id}>
      <div className="scene-layout">
        {editing && hasHtml ? (
          <div className="scene-stage">
            <SceneEditor
              scene={scene}
              sceneRel={sceneRel}
              initialTime={time}
              duration={duration || scene.duration_seconds || 0}
              version={props.version}
              busy={props.busy}
              onTimeChange={setTime}
              onExit={exitEdit}
              onRegisterExitGuard={props.onRegisterExitGuard}
              onQuick={props.onQuick}
              run={props.run}
            />
          </div>
        ) : scene.exists ? (
          <ScenePlayer
            scene={scene}
            version={props.version}
            hasHtml={hasHtml}
            videoRef={video}
            resumeTimeRef={resumeTimeRef}
            time={time}
            duration={duration}
            playing={playing}
            drag={drag}
            dragging={dragging}
            onTime={setTime}
            onDuration={setDuration}
            onPlaying={setPlaying}
            onDrag={setDrag}
            onDragging={setDragging}
            onEnterEdit={enterEdit}
            onStep={step}
            onToggle={toggle}
            toVideoBox={toVideoBox}
            onFix={() => void fixFrame()}
            onAttach={() => void attach()}
          />
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
          <SceneBrief
            sceneId={scene.id}
            version={props.version}
            onStoryboard={props.onTab ? () => props.onTab!('storyboard') : undefined}
            busy={props.busy}
            onQuick={props.onQuick}
          />
          <SceneStyle scene={scene} label={`镜头 ${number}`} version={props.version} onQuick={props.onQuick} />
          <SceneActivityPanel scene={scene} />
          <div className="scene-actions">
            {hasHtml && !editing && (
              <button id="toggle-html-edit" onClick={enterEdit}>
                编辑画面
              </button>
            )}
            <button
              id="render-scene"
              className={scene.exists ? '' : 'primary'}
              onClick={() => props.run(`/api/scenes/${encodeURIComponent(scene.id)}/render`)}
            >
              {scene.exists ? '重新渲染' : '渲染'}
            </button>
            <SceneMenu
              scene={scene}
              note={note}
              onNote={setNote}
              onAttach={() => void attach()}
              onFixFrame={() => void fixFrame()}
              onQuick={props.onQuick}
              onFeedback={(verdict) => void sendFeedback(verdict)}
              onTab={props.onTab}
              run={props.run}
            />
          </div>
          {error && <p className="error-line">{error}</p>}
          {feedback && <p className="ok-line">{feedback}</p>}
        </aside>
      </div>
    </div>
  );
}
