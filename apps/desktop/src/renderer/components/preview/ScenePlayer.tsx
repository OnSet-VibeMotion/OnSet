import type { MutableRefObject, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useRef } from 'react';
import type { Box, Scene } from '../../types';
import { Icon } from '../Icon';
import { SelectionBar } from './SelectionBar';
import { clock, FPS } from './shared';

export interface DragRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ScenePlayerProps {
  scene: Scene;
  version: number;
  hasHtml: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  resumeTimeRef: MutableRefObject<number | null>;
  time: number;
  duration: number;
  playing: boolean;
  drag: DragRect | null;
  dragging: boolean;
  onTime: (t: number) => void;
  onDuration: (d: number) => void;
  onPlaying: (playing: boolean) => void;
  onDrag: (drag: DragRect | null) => void;
  onDragging: (dragging: boolean) => void;
  onEnterEdit: () => void;
  onStep: (frames: number) => void;
  onToggle: () => void;
  toVideoBox: () => Box | undefined;
  onFix: () => void;
  onAttach: () => void;
}

export function ScenePlayer(props: ScenePlayerProps) {
  const {
    scene,
    version,
    hasHtml,
    videoRef,
    resumeTimeRef,
    time,
    duration,
    playing,
    drag,
    dragging,
    onTime,
    onDuration,
    onPlaying,
    onDrag,
    onDragging,
    onEnterEdit,
    onStep,
    onToggle,
    toVideoBox,
    onFix,
    onAttach,
  } = props;
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  const point = (e: ReactPointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  return (
    <div className="scene-stage">
      <div className="stage-frame" ref={frame}>
        <video
          ref={videoRef}
          preload="metadata"
          src={`/api/scenes/${encodeURIComponent(scene.id)}/asset?v=${scene.output_stamp ?? version}`}
          onLoadedMetadata={(e) => {
            onDuration(e.currentTarget.duration || 0);
            if (resumeTimeRef.current !== null) {
              const target = Math.max(0, Math.min(e.currentTarget.duration || 0, resumeTimeRef.current));
              resumeTimeRef.current = null;
              e.currentTarget.currentTime = target;
            }
          }}
          onTimeUpdate={(e) => onTime(e.currentTarget.currentTime)}
          onSeeked={(e) => onTime(e.currentTarget.currentTime)}
          onPlay={() => onPlaying(true)}
          onPause={() => onPlaying(false)}
        />
        {hasHtml && (
          <button
            type="button"
            className="stage-edit-btn"
            id="enter-html-edit"
            title="切换到实时 HTML 画面，直接拖拽调整元素或与 AI 局部修改"
            onClick={onEnterEdit}
          >
            <Icon name="edit" size={12} /> 编辑画面
          </button>
        )}
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
              videoRef.current?.pause();
              onDragging(true);
            }
            onDrag({ x0: start.x, y0: start.y, x1: p.x, y1: p.y });
          }}
          onPointerUp={() => {
            const start = press.current;
            press.current = null;
            onDragging(false);
            if (!start) return;
            if (start.moved) {
              if (!toVideoBox()) onDrag(null);
              return;
            }
            if (drag) onDrag(null);
            else onToggle();
          }}
          onPointerCancel={() => {
            press.current = null;
            onDragging(false);
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
        {drag && !dragging && (
          <SelectionBar
            drag={drag}
            frame={frame.current}
            onFix={onFix}
            onAttach={onAttach}
            onClear={() => onDrag(null)}
          />
        )}
      </div>
      <div className="transport">
        <button className="step" onClick={() => onStep(-1)} aria-label="后退一帧" title="后退一帧（←，Shift+← 10 帧）">
          <Icon name="prev" size={14} />
        </button>
        <button className="play" onClick={onToggle} aria-label={playing ? '暂停' : '播放'} title="播放 / 暂停（空格）">
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <button className="step" onClick={() => onStep(1)} aria-label="前进一帧" title="前进一帧（→，Shift+→ 10 帧）">
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
            const v = videoRef.current;
            if (v) v.currentTime = Number(e.currentTarget.value);
          }}
        />
        <span className="mono small muted">
          帧 {Math.round(time * FPS)} / {Math.round(duration * FPS)}
        </span>
      </div>
    </div>
  );
}
