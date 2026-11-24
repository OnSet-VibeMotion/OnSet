import { type RefObject, useLayoutEffect, useMemo, useState } from 'react';
import { POPOVER_H, POPOVER_W, type StageRect } from './types';

/** 测量悬浮卡片实际高度，并计算其在舞台内的安全定位与防裁切最大高度。 */
export function usePopoverPosition(
  popoverRef: RefObject<HTMLDivElement | null>,
  selectedSelector: string | undefined,
  editTab: 'ai' | 'props',
  selectedRect: StageRect | null,
  stageSize: { w: number; h: number },
): { left: number; top: number; maxHeight: number } | null {
  const [popoverHeight, setPopoverHeight] = useState(POPOVER_H);

  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el || !selectedSelector) return;
    const measure = () => {
      if (el.offsetHeight > 0) setPopoverHeight(el.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [popoverRef, selectedSelector, editTab]);

  return useMemo(() => {
    if (!selectedRect) return null;
    const pad = 10;
    const topBarBottom = 48;
    const availH = Math.max(120, stageSize.h - topBarBottom - pad);
    const effectiveH = Math.min(popoverHeight || POPOVER_H, availH);
    const maxLeft = Math.max(pad, stageSize.w - POPOVER_W - pad);
    const rightSpace = stageSize.w - (selectedRect.left + selectedRect.width + 14);
    const left =
      rightSpace >= POPOVER_W
        ? Math.min(maxLeft, selectedRect.left + selectedRect.width + 14)
        : Math.max(pad, Math.min(maxLeft, selectedRect.left - POPOVER_W - 14));
    const maxTop = Math.max(topBarBottom, stageSize.h - effectiveH - pad);
    const top = Math.max(topBarBottom, Math.min(maxTop, selectedRect.top));
    return { left, top, maxHeight: availH };
  }, [selectedRect, stageSize, popoverHeight]);
}
