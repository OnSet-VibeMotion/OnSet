import type { PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from '../Icon';
import type { HandleKind, SelectedInfo, StageRect } from './types';

interface ElementOverlayProps {
  hoverBox: { rect: StageRect; selector: string } | null;
  selected: SelectedInfo | null;
  selectedRect: StageRect | null;
  onStartTransform: (kind: HandleKind, e: ReactPointerEvent) => void;
}

export function ElementOverlay({ hoverBox, selected, selectedRect, onStartTransform }: ElementOverlayProps) {
  const thinVertical = !!selectedRect && selectedRect.width < 14 && selectedRect.height >= 24;
  const thinHorizontal = !!selectedRect && selectedRect.height < 14 && selectedRect.width >= 24;
  const handles: HandleKind[] = thinVertical
    ? ['n', 's']
    : thinHorizontal
      ? ['w', 'e']
      : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  return (
    <>
      {hoverBox && (
        <div
          className="se-hover-box"
          style={{
            left: hoverBox.rect.left,
            top: hoverBox.rect.top,
            width: hoverBox.rect.width,
            height: hoverBox.rect.height,
          }}
        >
          <span className="se-hover-tag">{hoverBox.selector}</span>
        </div>
      )}

      {selected && selectedRect && (
        <div
          className="se-select-box"
          data-selected-selector={selected.selector}
          style={{
            left: selectedRect.left,
            top: selectedRect.top,
            width: selectedRect.width,
            height: selectedRect.height,
          }}
          onPointerDown={(e) => onStartTransform('move', e)}
        >
          {handles.map((h) => (
            <button
              key={h}
              type="button"
              className={`se-handle ${h}`}
              aria-label={`缩放控制点 ${h}`}
              onPointerDown={(e) => onStartTransform(h, e)}
            />
          ))}
          <button
            type="button"
            className="se-rotate-handle"
            aria-label="旋转元素"
            title="拖动旋转（按住 Shift 按 15° 吸附）"
            onPointerDown={(e) => onStartTransform('rotate', e)}
          >
            <Icon name="rotate" size={12} />
          </button>
        </div>
      )}
    </>
  );
}
