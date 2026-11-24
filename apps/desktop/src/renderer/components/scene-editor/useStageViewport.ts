import { type MutableRefObject, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Scene, SceneEdits } from '../../types';
import { safeQuery } from './dom';
import { type OrigElementMaps, seekIframeDoc } from './iframeBridge';
import type { HFWindow, StageFit, StageRect } from './types';

interface UseStageViewportOptions {
  stageRef: RefObject<HTMLDivElement | null>;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  scene: Scene;
  duration: number;
  initialTime: number;
  onTimeChange: (seconds: number) => void;
  draftEdits: SceneEdits;
  draftRef: MutableRefObject<SceneEdits>;
  selectedSelector: string | undefined;
  setSelectedRect: (rect: StageRect | null) => void;
}

export function useStageViewport({
  stageRef,
  iframeRef,
  scene,
  duration,
  initialTime,
  onTimeChange,
  draftEdits,
  draftRef,
  selectedSelector,
  setSelectedRect,
}: UseStageViewportOptions) {
  const [stageSize, setStageSize] = useState({ w: 640, h: 360 });
  const [compSize, setCompSize] = useState({ w: 1920, h: 1080 });
  const [compDuration, setCompDuration] = useState(duration || scene.duration_seconds || 0);
  const [time, setTime] = useState(initialTime);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const origMapsRef = useRef<OrigElementMaps>({
    text: new Map(),
    nodes: new Map(),
    opacity: new Map(),
  });
  const timeRef = useRef(time);
  timeRef.current = time;

  const totalDuration = compDuration || duration || scene.duration_seconds || 0;

  // 等比缩放画布铺进舞台，居中对齐，与 <video object-fit: contain> 逐像素一致。
  const fit: StageFit = useMemo(() => {
    const scale = Math.min(stageSize.w / compSize.w, stageSize.h / compSize.h) || 1;
    const width = compSize.w * scale;
    const height = compSize.h * scale;
    return { scale, offsetX: (stageSize.w - width) / 2, offsetY: (stageSize.h - height) / 2, width, height };
  }, [stageSize, compSize]);

  // 跟踪舞台尺寸，实时更新画布缩放比。
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setStageSize({ w: el.clientWidth, h: el.clientHeight });
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stageRef]);

  const toStageRect = useCallback(
    (domRect: DOMRect): StageRect => ({
      left: fit.offsetX + domRect.left * fit.scale,
      top: fit.offsetY + domRect.top * fit.scale,
      width: Math.max(2, domRect.width * fit.scale),
      height: Math.max(2, domRect.height * fit.scale),
    }),
    [fit],
  );

  const seekIframe = useCallback(
    (seconds: number, edits: SceneEdits = draftRef.current) => {
      seekIframeDoc(iframeRef.current, seconds, edits, origMapsRef.current);
    },
    [iframeRef, draftRef],
  );

  const refreshSelectedRect = useCallback(
    (selector: string | undefined) => {
      if (!selector) return setSelectedRect(null);
      const doc = iframeRef.current?.contentDocument;
      if (!doc) return setSelectedRect(null);
      const el = safeQuery(doc, selector);
      if (!el) return setSelectedRect(null);
      setSelectedRect(toStageRect(el.getBoundingClientRect()));
    },
    [iframeRef, setSelectedRect, toStageRect],
  );

  const onIframeLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    const win = iframeRef.current?.contentWindow as HFWindow | null;
    if (!doc || !win) return;
    origMapsRef.current.text.clear();
    origMapsRef.current.nodes.clear();
    origMapsRef.current.opacity.clear();
    const root = doc.querySelector<HTMLElement>('[data-composition-id]') ?? doc.getElementById('root');
    const w = Number(root?.getAttribute('data-width')) || win.ONSET_SCENE?.width_px || 1920;
    const h = Number(root?.getAttribute('data-height')) || win.ONSET_SCENE?.height_px || 1080;
    const dur =
      Number(root?.getAttribute('data-duration')) ||
      win.ONSET_SCENE?.duration_seconds ||
      duration ||
      scene.duration_seconds ||
      0;
    setCompSize({ w, h });
    if (dur > 0) setCompDuration(dur);
    setLoaded(true);
    seekIframe(timeRef.current, draftRef.current);
  };

  // 草稿改动或加载完时同步刷新 iframe 与选中框。
  useEffect(() => {
    if (!loaded) return;
    seekIframe(timeRef.current, draftEdits);
    refreshSelectedRect(selectedSelector);
  }, [loaded, draftEdits, seekIframe, refreshSelectedRect, selectedSelector]);

  // 舞台尺寸变化时重算选中框位置。
  useEffect(() => {
    if (selectedSelector) refreshSelectedRect(selectedSelector);
  }, [fit, selectedSelector, refreshSelectedRect]);

  // 编辑模式下的实时播放循环。
  useEffect(() => {
    if (!playing || !loaded || totalDuration <= 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = timeRef.current + dt;
      if (next >= totalDuration) {
        setTime(totalDuration);
        onTimeChange(totalDuration);
        seekIframe(totalDuration);
        refreshSelectedRect(selectedSelector);
        setPlaying(false);
        return;
      }
      setTime(next);
      onTimeChange(next);
      seekIframe(next);
      refreshSelectedRect(selectedSelector);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loaded, totalDuration, seekIframe, refreshSelectedRect, selectedSelector, onTimeChange]);

  const seekTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(totalDuration || 0, next));
      setTime(clamped);
      onTimeChange(clamped);
      seekIframe(clamped);
      refreshSelectedRect(selectedSelector);
    },
    [totalDuration, onTimeChange, seekIframe, refreshSelectedRect, selectedSelector],
  );

  return {
    stageSize,
    compSize,
    time,
    timeRef,
    playing,
    setPlaying,
    totalDuration,
    fit,
    origMapsRef,
    toStageRect,
    onIframeLoad,
    seekTo,
  };
}
