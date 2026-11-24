import type { ReactElement, RefObject } from 'react';
import type { SkinView } from '../../types';
import type { CrewSignal } from '../chat/crew';
import { Icon } from '../Icon';
import type { CrewInfo, PieItem, Spot2, Who } from './crewState';
import { CH, CW, P, type Pt, pts, U, wallQuad } from './iso';
import { CrewPanel, sendPet } from './PetWidgets';
import { petFilter } from './person';
import { selectionMarker, selectionRing } from './props';
import { clockHands, consoleScreen, editScreens, storyboardWall } from './room';

export interface PetStageProps {
  signal: CrewSignal;
  skin: SkinView | null;
  shell: ReactElement;
  t: number;
  frame: number;
  dirArrived: boolean;
  anyFilming: boolean;
  editing: boolean;
  directorPos: [number, number];
  items: { k: number; el: ReactElement }[];
  spots: Spot2[];
  tags: { key: string; text: string; title: string; at: Pt }[];
  selected: Who | null;
  sel: CrewInfo | null;
  selFoot: Pt | null;
  selectedHeadAt: Pt | null;
  pie: Who | null;
  pieAt: Pt | null;
  pieItems: PieItem[];
  pieLabel: string;
  light: { part: string; label: string; color: string; opacity: number; lamps: boolean };
  scale: number;
  tx: number;
  ty: number;
  toScreen: (pt: Pt) => Pt;
  bubbleRef: RefObject<HTMLDivElement | null>;
  bubbleLeft: number;
  bubbleTop: number;
  tail: number;
  onChoose: (who: Who) => void;
  onClosePie: () => void;
  onCloseSelected: () => void;
  onCompose: () => void;
  onZoom: (factor: number) => void;
  onResetCam: () => void;
}

export function PetStage(props: PetStageProps) {
  const {
    signal,
    skin,
    shell,
    t,
    frame,
    dirArrived,
    anyFilming,
    editing,
    directorPos,
    items,
    spots,
    tags,
    selected,
    sel,
    selFoot,
    selectedHeadAt,
    pie,
    pieAt,
    pieItems,
    pieLabel,
    light,
    scale,
    tx,
    ty,
    toScreen,
    bubbleRef,
    bubbleLeft,
    bubbleTop,
    tail,
    onChoose,
    onClosePie,
    onCloseSelected,
    onCompose,
    onZoom,
    onResetCam,
  } = props;
  const mood = signal.mood;

  return (
    <>
      <div
        className="pet-stage"
        style={{ width: CW, height: CH, transform: `translate(${tx}px, ${ty}px) scale(${scale})` }}
      >
        <svg
          className="pet-room"
          viewBox={`0 0 ${CW} ${CH}`}
          width={CW}
          height={CH}
          aria-hidden="true"
          style={{ filter: petFilter(skin) }}
        >
          <defs>
            <radialGradient id="pet-glow">
              <stop offset="0" className="pet-glow-stop" stopOpacity="0.4" />
              <stop offset="1" className="pet-glow-stop" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="pet-lamp">
              <stop offset="0" stopColor="#ffd9a0" stopOpacity="0.55" />
              <stop offset="1" stopColor="#ffd9a0" stopOpacity="0" />
            </radialGradient>
          </defs>
          {shell}
          {clockHands(new Date())}
          {storyboardWall(mood === 'storyboarding' && dirArrived, frame)}
          {consoleScreen(mood === 'running' && dirArrived, frame)}
          {editScreens(editing, frame)}
          {anyFilming ? (
            <g className="pet-light">
              <polygon points={pts(wallQuad('back', 2.9, 5.8, 0, 2.7))} className="pet-lit-paper" />
              <polygon points={pts([P(2.7, 0.55, 2.35), P(3.7, 0.2, 0), P(4.9, 1.0, 0)])} />
              <polygon points={pts([P(6.05, 0.55, 2.35), P(5.0, 0.2, 0), P(3.8, 1.0, 0)])} />
              <ellipse cx={P(4.35, 0.65)[0]} cy={P(4.35, 0.65)[1]} rx={1.9 * U} ry={0.95 * U} fill="url(#pet-glow)" />
            </g>
          ) : null}
          <ellipse
            cx={P(directorPos[0], directorPos[1])[0]}
            cy={P(directorPos[0], directorPos[1])[1]}
            rx={0.9 * U}
            ry={0.45 * U}
            fill="url(#pet-glow)"
          />
          {selFoot ? selectionRing(selFoot, t) : null}
          {items.map((item) => item.el)}
          {selectedHeadAt ? selectionMarker(selectedHeadAt, t) : null}
          {/* 昼夜：一层整体的光，夜里台灯与屏幕亮起来。 */}
          <rect
            x={0}
            y={0}
            width={CW}
            height={CH}
            fill={light.color}
            opacity={light.opacity}
            style={{ mixBlendMode: 'multiply' }}
            pointerEvents="none"
          />
          {light.lamps ? (
            <g pointerEvents="none" style={{ mixBlendMode: 'screen' }}>
              <ellipse
                cx={P(3.9, 3.9, 1.1)[0]}
                cy={P(3.9, 3.9, 1.1)[1]}
                rx={1.6 * U}
                ry={1.1 * U}
                fill="url(#pet-lamp)"
              />
              <ellipse
                cx={P(0.4, 1.2, 1.2)[0]}
                cy={P(0.4, 1.2, 1.2)[1]}
                rx={1.2 * U}
                ry={0.9 * U}
                fill="url(#pet-lamp)"
                opacity={0.6}
              />
              <ellipse
                cx={P(6.7, 0.3, 1.6)[0]}
                cy={P(6.7, 0.3, 1.6)[1]}
                rx={1.2 * U}
                ry={0.8 * U}
                fill="url(#pet-lamp)"
                opacity={0.5}
              />
            </g>
          ) : null}
        </svg>
        {signal.project
          ? spots.map((spot) => (
              <button
                key={spot.key}
                className="pet-spot"
                data-spot={spot.key}
                data-selected={spot.key === selected ? 'true' : 'false'}
                title={spot.label}
                aria-label={spot.label}
                style={{ left: spot.left, top: spot.top, width: spot.width, height: spot.height }}
                onClick={() =>
                  spot.key === 'storyboard' ? sendPet({ kind: 'open', page: 'storyboard' }) : onChoose(spot.key as Who)
                }
              />
            ))
          : null}
      </div>
      {tags.map((tag) => {
        const [x, y] = toScreen(tag.at);
        return (
          <span key={tag.key} className="pet-tag" data-tag={tag.key} title={tag.title} style={{ left: x, top: y + 2 }}>
            {tag.text}
          </span>
        );
      })}
      <div
        ref={bubbleRef}
        className="pet-bubble"
        hidden={pie !== null}
        style={{ left: bubbleLeft, top: bubbleTop, ['--tail' as string]: `${tail}px` }}
      >
        <span className="pet-line">{signal.line}</span>
      </div>
      {pie && pieAt ? (
        <div
          className="pet-pie"
          data-who={pie}
          style={{ left: pieAt[0], top: pieAt[1] }}
          role="menu"
          aria-label={pieLabel}
        >
          {pieItems.map((item, k) => {
            const angle =
              -Math.PI / 2 + (((k - (pieItems.length - 1) / 2) * Math.PI) / Math.max(4, pieItems.length + 1)) * 1.6;
            const r = 62;
            return (
              <button
                key={item.label}
                className="pet-pie-item"
                role="menuitem"
                style={{ left: Math.cos(angle) * r * 1.35, top: Math.sin(angle) * r, animationDelay: `${k * 30}ms` }}
                onClick={() => {
                  onClosePie();
                  if (item.compose) onCompose();
                  else if (item.command) sendPet(item.command);
                }}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      ) : null}
      {sel && selected ? <CrewPanel info={sel} who={selected} onClose={onCloseSelected} /> : null}
      <div className="pet-cam" onDoubleClick={(event) => event.stopPropagation()}>
        <button title="放大" aria-label="放大" onClick={() => onZoom(1.25)}>
          +
        </button>
        <button title="缩小" aria-label="缩小" onClick={() => onZoom(0.8)}>
          −
        </button>
        <button title="回到全景" aria-label="回到全景" data-cam="reset" onClick={onResetCam}>
          ⌂
        </button>
      </div>
      <span className="pet-clock" title="工作室的光跟着这台电脑的时间走">
        {light.label}
      </span>
    </>
  );
}

export function PetFoot({
  signal,
  filmingCount,
  composing,
  onToggleCompose,
}: {
  signal: CrewSignal;
  filmingCount: number;
  composing: boolean;
  onToggleCompose: () => void;
}) {
  return (
    <div className="pet-foot">
      <span className="pet-project">{signal.project || '片场'}</span>
      <span className="pet-legend">{filmingCount > 0 ? `${filmingCount} 个镜头在拍` : ''}</span>
      {signal.project ? (
        <span className="pet-actions" onDoubleClick={(event) => event.stopPropagation()}>
          {signal.running ? (
            <button
              className="pet-act"
              data-act="stop"
              title="停下这一轮"
              aria-label="停下这一轮"
              onClick={() => sendPet({ kind: 'stop' })}
            >
              <Icon name="stop" size={11} />
            </button>
          ) : null}
          <button
            className="pet-act"
            data-act="say"
            data-on={composing ? 'true' : 'false'}
            title="对制作人说一句"
            aria-label="对制作人说一句"
            onClick={onToggleCompose}
          >
            <Icon name="edit" size={11} />
          </button>
          <button
            className="pet-act"
            data-act="focus"
            title="回到客户端"
            aria-label="回到客户端"
            onClick={() => sendPet({ kind: 'focus' })}
          >
            <Icon name="panel" size={11} />
          </button>
        </span>
      ) : null}
      <button
        className="pet-close"
        title="收起桌宠（菜单「窗口 → 场记桌宠」再打开）"
        onClick={() => sendPet({ kind: 'hide' })}
      >
        ×
      </button>
      <span
        className="pet-grip"
        title="拖动改大小"
        aria-hidden="true"
        onDoubleClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
          sendPet({ kind: 'resize', phase: 'start' });
        }}
        onPointerUp={() => sendPet({ kind: 'resize', phase: 'end' })}
        onPointerCancel={() => sendPet({ kind: 'resize', phase: 'end' })}
      />
    </div>
  );
}
