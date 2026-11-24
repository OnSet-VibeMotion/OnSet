import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ElementEdit, SceneEdits } from '../../types';
import type { HandleKind, SelectedInfo, StageFit, StageRect } from './types';

export interface TransformDragOptions {
  kind: HandleKind;
  e: ReactPointerEvent;
  selected: SelectedInfo;
  selectedRect: StageRect;
  stageEl: HTMLDivElement | null;
  fit: StageFit;
  getDraft: () => SceneEdits;
  pushUndo: (snapshot: SceneEdits) => void;
  updateElement: (selector: string, patch: Partial<ElementEdit>, recordUndo?: boolean) => void;
}

/** 变换拖拽：移动、8 点缩放、旋转。 */
export function beginTransformDrag({
  kind,
  e,
  selected,
  selectedRect,
  stageEl,
  fit,
  getDraft,
  pushUndo,
  updateElement,
}: TransformDragOptions): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const sel = selected.selector;
  const startX = e.clientX;
  const startY = e.clientY;
  const cur = getDraft().elements[sel] ?? { selector: sel };
  const startDx = cur.dx ?? 0;
  const startDy = cur.dy ?? 0;
  const startSx = cur.scaleX ?? 1;
  const startSy = cur.scaleY ?? 1;
  const startRot = cur.rotate ?? 0;
  const startW = Math.max(12, selectedRect.width);
  const startH = Math.max(12, selectedRect.height);
  const stageBox = stageEl?.getBoundingClientRect();
  const centerX = (stageBox?.left ?? 0) + selectedRect.left + selectedRect.width / 2;
  const centerY = (stageBox?.top ?? 0) + selectedRect.top + selectedRect.height / 2;
  const startAngle = Math.atan2(startY - centerY, startX - centerX);
  let pushed = false;

  const onMove = (ev: PointerEvent) => {
    const mx = ev.clientX - startX;
    const my = ev.clientY - startY;
    if (!pushed && Math.hypot(mx, my) >= 2) {
      pushed = true;
      pushUndo(getDraft());
    }
    if (!pushed) return;
    if (kind === 'move') {
      updateElement(sel, {
        dx: Math.round((startDx + mx / fit.scale) * 10) / 10,
        dy: Math.round((startDy + my / fit.scale) * 10) / 10,
      });
    } else if (kind === 'rotate') {
      const angle = Math.atan2(ev.clientY - centerY, ev.clientX - centerX);
      let deg = startRot + ((angle - startAngle) * 180) / Math.PI;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      else deg = Math.round(deg * 10) / 10;
      updateElement(sel, { rotate: deg });
    } else {
      let rx = 1;
      let ry = 1;
      if (kind.includes('e')) rx = Math.max(0.1, (startW + mx * 2) / startW);
      if (kind.includes('w')) rx = Math.max(0.1, (startW - mx * 2) / startW);
      if (kind.includes('s')) ry = Math.max(0.1, (startH + my * 2) / startH);
      if (kind.includes('n')) ry = Math.max(0.1, (startH - my * 2) / startH);
      const corner = kind.length === 2;
      if (corner && !ev.shiftKey) {
        const uniform = Math.abs(rx - 1) >= Math.abs(ry - 1) ? rx : ry;
        rx = uniform;
        ry = uniform;
      }
      const clampScale = (v: number) => Math.round(Math.max(0.1, Math.min(10, v)) * 100) / 100;
      updateElement(sel, {
        scaleX: kind === 'n' || kind === 's' ? startSx : clampScale(startSx * rx),
        scaleY: kind === 'e' || kind === 'w' ? startSy : clampScale(startSy * ry),
      });
    }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
