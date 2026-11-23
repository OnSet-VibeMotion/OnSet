import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { cssSelector } from '../selector';
import type { Attachment, ElementEdit, Scene, SceneEdits, SceneEditsResponse } from '../types';
import { Icon } from './Icon';
import type { RunAction } from './Preview';
import '../scene-editor.css';

const FPS = 30;
const POPOVER_W = 344;
const POPOVER_H = 260;

type HandleKind = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SelectedInfo {
  selector: string;
  hasText: boolean;
  canSelectParent: boolean;
  computedColor: string;
  computedBg: string;
  computedFontSize: number;
  computedOpacity: number;
  origText: string;
}

interface HFWindow extends Window {
  __ONSET_EDITOR_ACTIVE__?: boolean;
  __hf?: { seek?: (t: number) => void };
  __player?: { seek?: (t: number) => void };
  __timelines?: Record<string, { seek?: (t: number, suppress?: boolean) => void; pause?: () => void }>;
  ONSET_SCENE?: { width_px?: number; height_px?: number; duration_seconds?: number; fps?: number };
}

function emptyEdits(): SceneEdits {
  return { schema: 1, elements: {} };
}

function cloneEdits(edits: SceneEdits): SceneEdits {
  const elements: Record<string, ElementEdit> = {};
  for (const [k, v] of Object.entries(edits.elements)) elements[k] = { ...v };
  return { schema: 1, elements };
}

function editsEqual(a: SceneEdits, b: SceneEdits): boolean {
  return JSON.stringify(a.elements) === JSON.stringify(b.elements);
}

function clock(seconds: number): string {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** 将 rgb()/rgba()/#hex 转为 input[type=color] 需要的 #rrggbb。 */
export function toHexColor(value: string): string {
  const v = value.trim();
  const hex3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
  if (hex3) return `#${hex3[1]}${hex3[1]}${hex3[2]}${hex3[2]}${hex3[3]}${hex3[3]}`.toLowerCase();
  const hex6 = /^#([0-9a-fA-F]{6})/.exec(v);
  if (hex6) return `#${hex6[1]}`.toLowerCase();
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(v);
  if (rgb) {
    const ch = (s: string) => Math.max(0, Math.min(255, Math.round(Number(s)))).toString(16).padStart(2, '0');
    return `#${ch(rgb[1])}${ch(rgb[2])}${ch(rgb[3])}`;
  }
  return '#ffffff';
}

function isTransparent(bg: string): boolean {
  const v = bg.trim().toLowerCase();
  return !v || v === 'transparent' || v === 'rgba(0, 0, 0, 0)' || v === 'rgba(0,0,0,0)';
}

function hasEditEffect(e: ElementEdit): boolean {
  return (
    (e.dx !== undefined && e.dx !== 0) ||
    (e.dy !== undefined && e.dy !== 0) ||
    (e.scaleX !== undefined && e.scaleX !== 1) ||
    (e.scaleY !== undefined && e.scaleY !== 1) ||
    (e.rotate !== undefined && e.rotate !== 0) ||
    e.opacity !== undefined ||
    e.color !== undefined ||
    e.backgroundColor !== undefined ||
    e.fontSize !== undefined ||
    e.text !== undefined ||
    e.hidden === true
  );
}

/** 构造注入到预览 iframe 的实时覆盖 CSS，与后端 buildEditsCSS 规则一致。 */
function buildPreviewCSS(edits: SceneEdits): string {
  const rules: string[] = [];
  for (const [selector, e] of Object.entries(edits.elements)) {
    const decls: string[] = [];
    if (e.hidden) {
      decls.push('display: none !important', 'visibility: hidden !important');
    } else {
      if (e.dx !== undefined || e.dy !== undefined) decls.push(`translate: ${e.dx ?? 0}px ${e.dy ?? 0}px !important`);
      if (e.scaleX !== undefined || e.scaleY !== undefined) decls.push(`scale: ${e.scaleX ?? 1} ${e.scaleY ?? 1} !important`);
      if (e.rotate !== undefined) decls.push(`rotate: ${e.rotate}deg !important`);
      if (e.color !== undefined) decls.push(`color: ${e.color} !important`);
      if (e.backgroundColor !== undefined) decls.push(`background-color: ${e.backgroundColor} !important`);
      if (e.fontSize !== undefined) decls.push(`font-size: ${e.fontSize}px !important`);
    }
    if (decls.length > 0) rules.push(`${selector} { ${decls.join('; ')}; }`);
  }
  return rules.join('\n');
}

function isRootOrNonVisual(el: Element, doc: Document): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body' || tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') return true;
  if (el.hasAttribute('data-composition-id')) return true;
  if (el.id === 'root' && el.parentElement === doc.body) return true;
  return false;
}

/** 尽量生成在当前文档内唯一命中 el 的 CSS 选择器。 */
function uniqueSelector(doc: Document, el: Element): string {
  const base = cssSelector(el);
  try {
    const matches = doc.querySelectorAll(base);
    if (matches.length === 1 && matches[0] === el) return base;
  } catch {
    // 退回到逐级路径。
  }
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
    if (node.id) {
      parts.unshift('#' + CSS.escape(node.id));
      const candidate = parts.join(' > ');
      try {
        if (doc.querySelectorAll(candidate).length === 1) return candidate;
      } catch {
        // 继续往上补父级。
      }
    } else {
      let part = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node!.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
    }
    if (node.tagName.toLowerCase() === 'body') break;
    node = node.parentElement;
  }
  return parts.join(' > ') || base;
}

function hasDirectText(el: Element): boolean {
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim() !== '') return true;
  }
  return el.children.length === 0 && (el.textContent ?? '').trim() !== '';
}

function findElementAt(doc: Document, cx: number, cy: number, compW: number, compH: number): HTMLElement | null {
  if (typeof doc.elementsFromPoint !== 'function') return null;
  const list = doc.elementsFromPoint(cx, cy);
  for (const raw of list) {
    if (!(raw instanceof (doc.defaultView?.HTMLElement ?? HTMLElement)) && !(raw instanceof (doc.defaultView?.SVGElement ?? SVGElement))) continue;
    if (isRootOrNonVisual(raw, doc)) continue;
    const style = doc.defaultView?.getComputedStyle(raw);
    if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) <= 0.01)) continue;
    const rect = raw.getBoundingClientRect();
    if (rect.width < 1 && rect.height < 1) continue;
    // 跳过铺满整张画布的纯透明容器，但允许选中铺满画布的背景色块或叶子节点。
    if (rect.width >= compW * 0.96 && rect.height >= compH * 0.96 && raw.children.length > 0 && style && isTransparent(style.backgroundColor)) {
      continue;
    }
    return raw as HTMLElement;
  }
  return null;
}

export interface SceneEditorProps {
  scene: Scene;
  sceneRel: string;
  initialTime: number;
  duration: number;
  version: number;
  busy: string;
  onTimeChange: (seconds: number) => void;
  onExit: () => void;
  /** 向父级注册离开确认守卫：返回 true 表示允许直接离开，false 表示已弹出未保存确认。 */
  onRegisterExitGuard?: (guard: ((proceed: () => void) => boolean) | null) => void;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  run: RunAction;
}

export function SceneEditor(props: SceneEditorProps) {
  const { scene, sceneRel, duration } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 640, h: 360 });
  const [popoverHeight, setPopoverHeight] = useState(POPOVER_H);
  const [compSize, setCompSize] = useState({ w: 1920, h: 1080 });
  const [compDuration, setCompDuration] = useState(duration || scene.duration_seconds || 0);
  const [time, setTime] = useState(props.initialTime);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [savedEdits, setSavedEdits] = useState<SceneEdits>(emptyEdits);
  const [draftEdits, setDraftEdits] = useState<SceneEdits>(emptyEdits);
  const [undoStack, setUndoStack] = useState<SceneEdits[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [exitConfirm, setExitConfirm] = useState(false);
  const pendingExitRef = useRef<(() => void) | null>(null);

  const [hoverBox, setHoverBox] = useState<{ rect: StageRect; selector: string } | null>(null);
  const [selected, setSelected] = useState<SelectedInfo | null>(null);
  const [selectedRect, setSelectedRect] = useState<StageRect | null>(null);
  const [editTab, setEditTab] = useState<'ai' | 'props'>('ai');
  const [aiText, setAiText] = useState('');
  const [sendingAi, setSendingAi] = useState(false);
  /** 选中这个元素之前的状态：点「取消」时退回它。 */
  const beforeSelectRef = useRef<SceneEdits | null>(null);

  /** 记录原始文案、原始子节点（保护混合内容里的 span/样式与动画目标）与原始行内透明度，取消或恢复默认时完整还原。 */
  const origTextRef = useRef<Map<string, string>>(new Map());
  const origNodesRef = useRef<Map<string, Node[]>>(new Map());
  const origOpacityRef = useRef<Map<string, string>>(new Map());
  const timeRef = useRef(time);
  timeRef.current = time;
  const draftRef = useRef(draftEdits);
  draftRef.current = draftEdits;
  const draftRevRef = useRef(0);
  const savedWriteRef = useRef(0);
  const exitTokenRef = useRef(0);
  const loadedSceneRef = useRef('');

  const dirty = useMemo(() => !editsEqual(savedEdits, draftEdits), [savedEdits, draftEdits]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const hasAnyEdits = Object.keys(draftEdits.elements).length > 0;
  const totalDuration = compDuration || duration || scene.duration_seconds || 0;

  // 向父级导航（切换镜头 / 切换标签 / 收起面板）注册未保存离开守卫。
  useEffect(() => {
    const register = props.onRegisterExitGuard;
    if (!register) return;
    register((proceed: () => void) => {
      if (!dirtyRef.current) return true;
      pendingExitRef.current = proceed;
      setExitConfirm(true);
      return false;
    });
    return () => {
      register(null);
    };
  }, [props.onRegisterExitGuard]);

  // 等比缩放画布铺进舞台，居中对齐，与 <video object-fit: contain> 逐像素一致。
  const fit = useMemo(() => {
    const scale = Math.min(stageSize.w / compSize.w, stageSize.h / compSize.h) || 1;
    const width = compSize.w * scale;
    const height = compSize.h * scale;
    return { scale, offsetX: (stageSize.w - width) / 2, offsetY: (stageSize.h - height) / 2, width, height };
  }, [stageSize, compSize]);

  // 加载已保存的属性覆盖：区分初次加载/切镜与后台项目刷新（props.version 变化）。
  // 草稿已修改或首次 GET 返回前用户已经编辑时，只更新 savedEdits，保留未应用的草稿与撤销栈。
  useEffect(() => {
    let active = true;
    const sceneChanged = loadedSceneRef.current !== scene.id;
    loadedSceneRef.current = scene.id;
    if (sceneChanged) {
      setError('');
      setSelected(null);
      setSelectedRect(null);
      setHoverBox(null);
      setExitConfirm(false);
      pendingExitRef.current = null;
      setUndoStack([]);
    }
    const revAtStart = draftRevRef.current;
    const savedWriteAtStart = savedWriteRef.current;
    api<SceneEditsResponse>(`/api/scenes/${encodeURIComponent(scene.id)}/edits`).then(
      (res) => {
        if (!active) return;
        // 若 GET 在途期间发生了新的 PUT 保存，丢弃过期响应，不把 savedEdits / draftEdits 回退为旧值。
        if (savedWriteRef.current !== savedWriteAtStart) return;
        const next = res.edits && res.edits.elements ? cloneEdits(res.edits) : emptyEdits();
        setSavedEdits(next);
        const userEditedMeanwhile = draftRevRef.current !== revAtStart;
        if (sceneChanged) {
          if (!userEditedMeanwhile) setDraftEdits(cloneEdits(next));
        } else if (!dirtyRef.current && !userEditedMeanwhile) {
          setDraftEdits(cloneEdits(next));
        }
      },
      (err) => {
        if (active) setError(errorText(err));
      },
    );
    return () => {
      active = false;
    };
  }, [scene.id, props.version]);

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
  }, []);

  const toStageRect = useCallback(
    (domRect: DOMRect): StageRect => ({
      left: fit.offsetX + domRect.left * fit.scale,
      top: fit.offsetY + domRect.top * fit.scale,
      width: Math.max(2, domRect.width * fit.scale),
      height: Math.max(2, domRect.height * fit.scale),
    }),
    [fit],
  );

  /** 把草稿覆盖实时应用进 iframe DOM，不写磁盘。 */
  const applyLiveEdits = useCallback((doc: Document, edits: SceneEdits) => {
    const win = doc.defaultView as HFWindow | null;
    if (win) win.__ONSET_EDITOR_ACTIVE__ = true;
    // 禁用 index.html 里已落盘的旧覆盖样式，统一由实时样式接管，保证撤销/重置准确。
    const baked = doc.getElementById('onset-edits-css') as HTMLStyleElement | null;
    if (baked) baked.disabled = true;

    let styleEl = doc.getElementById('onset-edits-live') as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = doc.createElement('style');
      styleEl.id = 'onset-edits-live';
      (doc.head || doc.documentElement).appendChild(styleEl);
    }
    styleEl.textContent = buildPreviewCSS(edits);

    // 先把上次动态改过的文案和子节点复原（透明度已在 seekIframe 的 seek 之前清掉，这里不再用旧帧的 origOpacityRef 覆盖动画值）。
    for (const [sel, orig] of origTextRef.current.entries()) {
      const el = safeQuery(doc, sel);
      if (el && edits.elements[sel]?.text === undefined) {
        const savedNodes = origNodesRef.current.get(sel);
        if (savedNodes) {
          el.replaceChildren(...savedNodes);
          origNodesRef.current.delete(sel);
        } else {
          el.textContent = orig;
        }
        origTextRef.current.delete(sel);
      }
    }
    for (const sel of [...origOpacityRef.current.keys()]) {
      if (edits.elements[sel]?.opacity === undefined) origOpacityRef.current.delete(sel);
    }

    for (const [sel, edit] of Object.entries(edits.elements)) {
      if (edit.hidden) continue;
      const el = safeQuery(doc, sel) as HTMLElement | null;
      if (!el) continue;
      if (edit.text !== undefined) {
        if (!origTextRef.current.has(sel)) {
          origTextRef.current.set(sel, el.dataset.onsetOrigText ?? el.textContent ?? '');
          const bakedNodes = (el as HTMLElement & { __onsetOrigNodes?: Node[] }).__onsetOrigNodes;
          if (bakedNodes && bakedNodes.length > 0 && !origNodesRef.current.has(sel)) {
            origNodesRef.current.set(sel, bakedNodes);
          } else if (el.children.length > 0 && !origNodesRef.current.has(sel)) {
            const nodes: Node[] = [];
            while (el.firstChild) nodes.push(el.removeChild(el.firstChild));
            origNodesRef.current.set(sel, nodes);
          }
        }
        el.textContent = edit.text;
      }
      if (edit.opacity !== undefined) {
        if (!origOpacityRef.current.has(sel)) origOpacityRef.current.set(sel, el.dataset.onsetOrigOp ?? el.style.opacity ?? '');
        const raw = el.style.opacity;
        const base = raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : Number(win?.getComputedStyle(el).opacity ?? '1');
        const safeBase = Number.isFinite(base) ? base : 1;
        el.style.opacity = String(Math.max(0, Math.min(1, safeBase * edit.opacity)));
      }
    }
  }, []);

  /** 把 iframe 内的 HyperFrames / GSAP / CSS 动画精准 seek 到指定秒数，并叠加草稿编辑。 */
  const seekIframe = useCallback(
    (seconds: number, edits: SceneEdits = draftRef.current) => {
      const doc = iframeRef.current?.contentDocument;
      const win = iframeRef.current?.contentWindow as HFWindow | null;
      if (!doc || !win) return;
      win.__ONSET_EDITOR_ACTIVE__ = true;
      // seek 之前清掉编辑器临时覆写的行内透明度，让动画算出本帧的真实透明度。
      for (const [sel, orig] of origOpacityRef.current.entries()) {
        const el = safeQuery(doc, sel) as HTMLElement | null;
        if (el) {
          if (orig === '') el.style.removeProperty('opacity');
          else el.style.opacity = orig;
        }
      }
      try {
        if (typeof win.__hf?.seek === 'function') {
          win.__hf.seek(seconds);
        } else if (typeof win.__player?.seek === 'function') {
          win.__player.seek(seconds);
        }
        const tls = win.__timelines;
        if (tls && typeof tls === 'object') {
          for (const tl of Object.values(tls)) {
            tl?.pause?.();
            tl?.seek?.(seconds, false);
          }
        }
        if (typeof doc.getAnimations === 'function') {
          for (const anim of doc.getAnimations()) {
            anim.pause();
            anim.currentTime = seconds * 1000;
          }
        }
      } catch {
        // 某些自定义脚本在部分时间点可能抛错，不影响界面交互。
      }
      applyLiveEdits(doc, edits);
    },
    [applyLiveEdits],
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
    [toStageRect],
  );

  const onIframeLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    const win = iframeRef.current?.contentWindow as HFWindow | null;
    if (!doc || !win) return;
    origTextRef.current.clear();
    origNodesRef.current.clear();
    origOpacityRef.current.clear();
    const root = doc.querySelector<HTMLElement>('[data-composition-id]') ?? doc.getElementById('root');
    const w = Number(root?.getAttribute('data-width')) || win.ONSET_SCENE?.width_px || 1920;
    const h = Number(root?.getAttribute('data-height')) || win.ONSET_SCENE?.height_px || 1080;
    const dur = Number(root?.getAttribute('data-duration')) || win.ONSET_SCENE?.duration_seconds || duration || scene.duration_seconds || 0;
    setCompSize({ w, h });
    if (dur > 0) setCompDuration(dur);
    setLoaded(true);
    seekIframe(timeRef.current, draftRef.current);
  };

  // 草稿改动或加载完时同步刷新 iframe 与选中框。
  useEffect(() => {
    if (!loaded) return;
    seekIframe(timeRef.current, draftEdits);
    refreshSelectedRect(selected?.selector);
  }, [loaded, draftEdits, seekIframe, refreshSelectedRect, selected?.selector]);

  // 舞台尺寸变化时重算选中框位置。
  useEffect(() => {
    if (selected?.selector) refreshSelectedRect(selected.selector);
  }, [fit, selected?.selector, refreshSelectedRect]);

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
        props.onTimeChange(totalDuration);
        seekIframe(totalDuration);
        refreshSelectedRect(selected?.selector);
        setPlaying(false);
        return;
      }
      setTime(next);
      props.onTimeChange(next);
      seekIframe(next);
      refreshSelectedRect(selected?.selector);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, loaded, totalDuration, seekIframe, refreshSelectedRect, selected?.selector, props.onTimeChange]);

  const seekTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(totalDuration || 0, next));
      setTime(clamped);
      props.onTimeChange(clamped);
      seekIframe(clamped);
      refreshSelectedRect(selected?.selector);
    },
    [totalDuration, props.onTimeChange, seekIframe, refreshSelectedRect, selected?.selector],
  );

  const pushUndo = useCallback((snapshot: SceneEdits) => {
    setUndoStack((stack) => [...stack.slice(-29), cloneEdits(snapshot)]);
  }, []);

  const updateElement = useCallback(
    (selector: string, patch: Partial<ElementEdit>, recordUndo = false) => {
      draftRevRef.current += 1;
      setDraftEdits((prev) => {
        if (recordUndo) pushUndo(prev);
        const next = cloneEdits(prev);
        const merged: ElementEdit = { ...(next.elements[selector] ?? { selector }), ...patch, selector };
        // 清理还原到默认值的键，保持 JSON 干净。
        if (merged.dx === 0) delete merged.dx;
        if (merged.dy === 0) delete merged.dy;
        if (merged.scaleX === 1) delete merged.scaleX;
        if (merged.scaleY === 1) delete merged.scaleY;
        if (merged.rotate === 0) delete merged.rotate;
        if (merged.hidden === false) delete merged.hidden;
        if (hasEditEffect(merged)) next.elements[selector] = merged;
        else delete next.elements[selector];
        return next;
      });
    },
    [pushUndo],
  );

  const selectElement = useCallback(
    (el: Element) => {
      const doc = iframeRef.current?.contentDocument;
      const win = doc?.defaultView;
      if (!doc || !win) return;
      setPlaying(false);
      const selector = uniqueSelector(doc, el);
      const style = win.getComputedStyle(el);
      const parent = el.parentElement;
      const canSelectParent = !!parent && !isRootOrNonVisual(parent, doc);
      const textCapable = hasDirectText(el) || draftRef.current.elements[selector]?.text !== undefined;
      const origText = origTextRef.current.get(selector) ?? (el as HTMLElement).dataset?.onsetOrigText ?? el.textContent ?? '';
      beforeSelectRef.current = cloneEdits(draftRef.current);
      setSelected({
        selector,
        hasText: textCapable,
        canSelectParent,
        computedColor: style.color || 'rgb(255, 255, 255)',
        computedBg: style.backgroundColor || 'rgba(0, 0, 0, 0)',
        computedFontSize: Math.round(parseFloat(style.fontSize) || 32),
        computedOpacity: Number.isFinite(Number(style.opacity)) ? Number(style.opacity) : 1,
        origText,
      });
      setSelectedRect(toStageRect(el.getBoundingClientRect()));
      setHoverBox(null);
      setExitConfirm(false);
    },
    [toStageRect],
  );

  const deselect = useCallback(() => {
    setSelected(null);
    setSelectedRect(null);
    beforeSelectRef.current = null;
  }, []);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      draftRevRef.current += 1;
      const prev = stack[stack.length - 1];
      setDraftEdits(prev);
      return stack.slice(0, -1);
    });
  }, []);

  const hideSelected = useCallback(() => {
    if (!selected) return;
    updateElement(selected.selector, { hidden: true }, true);
    deselect();
  }, [selected, updateElement, deselect]);

  const requestExit = useCallback(() => {
    pendingExitRef.current = null;
    if (dirty) {
      setExitConfirm(true);
      return;
    }
    props.onExit();
  }, [dirty, props.onExit]);

  // 键盘快捷键：←/→ 逐帧，空格播放/暂停，Esc 逐层退出，Delete 隐藏选中元素，Cmd/Ctrl+Z 撤销。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const inInput = !!target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !inInput) {
        if (undoStack.length > 0) {
          e.preventDefault();
          undo();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (exitConfirm) {
          exitTokenRef.current += 1;
          pendingExitRef.current = null;
          setExitConfirm(false);
        } else if (selected) deselect();
        else requestExit();
        return;
      }
      if (inInput || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        const frames = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1);
        seekTo(timeRef.current + frames / FPS);
      } else if (e.key === ' ' && !target?.closest('button, summary, a')) {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        hideSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, exitConfirm, undoStack.length, undo, deselect, requestExit, seekTo, hideSelected]);

  // 画布鼠标悬停与点选。
  const canvasPoint = (e: ReactPointerEvent | PointerEvent) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return { cx: 0, cy: 0 };
    return {
      cx: (e.clientX - box.left - fit.offsetX) / fit.scale,
      cy: (e.clientY - box.top - fit.offsetY) / fit.scale,
    };
  };

  const onStageMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const { cx, cy } = canvasPoint(e);
    if (cx < 0 || cy < 0 || cx > compSize.w || cy > compSize.h) {
      setHoverBox(null);
      return;
    }
    const el = findElementAt(doc, cx, cy, compSize.w, compSize.h);
    if (!el) {
      setHoverBox(null);
      return;
    }
    const selector = uniqueSelector(doc, el);
    if (selector === selected?.selector) {
      setHoverBox(null);
      return;
    }
    setHoverBox({ rect: toStageRect(el.getBoundingClientRect()), selector });
  };

  const onStageClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const { cx, cy } = canvasPoint(e);
    const el = findElementAt(doc, cx, cy, compSize.w, compSize.h);
    if (!el) {
      deselect();
      return;
    }
    selectElement(el);
  };

  // 变换拖拽：移动、8 点缩放、旋转。
  const startTransform = (kind: HandleKind, e: ReactPointerEvent) => {
    if (e.button !== 0 || !selected || !selectedRect) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = selected.selector;
    const startX = e.clientX;
    const startY = e.clientY;
    const cur = draftRef.current.elements[sel] ?? { selector: sel };
    const startDx = cur.dx ?? 0;
    const startDy = cur.dy ?? 0;
    const startSx = cur.scaleX ?? 1;
    const startSy = cur.scaleY ?? 1;
    const startRot = cur.rotate ?? 0;
    const startW = Math.max(12, selectedRect.width);
    const startH = Math.max(12, selectedRect.height);
    const stageBox = stageRef.current?.getBoundingClientRect();
    const centerX = (stageBox?.left ?? 0) + selectedRect.left + selectedRect.width / 2;
    const centerY = (stageBox?.top ?? 0) + selectedRect.top + selectedRect.height / 2;
    const startAngle = Math.atan2(startY - centerY, startX - centerX);
    let pushed = false;

    const onMove = (ev: PointerEvent) => {
      const mx = ev.clientX - startX;
      const my = ev.clientY - startY;
      if (!pushed && Math.hypot(mx, my) >= 2) {
        pushed = true;
        pushUndo(draftRef.current);
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
  };

  /** 保存属性覆盖并触发零 Token 直接出片：只确认提交那一刻的草稿版本，编码受理回调时再次核对版本与离开意图。 */
  const applyAndEncode = async (exitAfter = false) => {
    setError('');
    setSaving(true);
    const submitted = cloneEdits(draftRef.current);
    const submittedRev = draftRevRef.current;
    const afterExit = pendingExitRef.current;
    const exitToken = exitTokenRef.current;
    try {
      const res = await api<{ edits: SceneEdits }>(`/api/scenes/${encodeURIComponent(scene.id)}/edits`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edits: submitted, encode: false }),
      });
      const saved = cloneEdits(res.edits);
      savedWriteRef.current += 1;
      setSavedEdits(saved);
      const stillMatchesSubmitted = draftRevRef.current === submittedRev;
      if (stillMatchesSubmitted) {
        dirtyRef.current = false;
        setDraftEdits(cloneEdits(saved));
        setUndoStack([]);
        setExitConfirm(false);
        pendingExitRef.current = null;
      }
      props.run(`/api/scenes/${encodeURIComponent(scene.id)}/encode`, {}, () => {
        if (exitAfter && draftRevRef.current === submittedRev && exitTokenRef.current === exitToken) {
          dirtyRef.current = false;
          if (afterExit) afterExit();
          else props.onExit();
        }
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  /** 发送 AI 编辑指令到左侧主对话，附带当前元素选择器、源文件与当前帧。 */
  const sendAiEdit = async () => {
    const text = aiText.trim();
    if (!selected || !text || sendingAi) return;
    setError('');
    setSendingAi(true);
    try {
      let framePath: string | undefined;
      if (scene.exists) {
        try {
          const shot = await api<Attachment>(`/api/scenes/${encodeURIComponent(scene.id)}/attachment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seconds: Number(timeRef.current.toFixed(3)) }),
          });
          framePath = shot.path;
        } catch {
          // 抽帧失败不阻断，仍带上选择器与时间点。
        }
      }
      const attachment: Attachment = {
        scene_id: scene.id,
        selector: selected.selector,
        source: `${sceneRel}/index.html`,
        seconds: Number(timeRef.current.toFixed(3)),
        ...(framePath ? { path: framePath } : {}),
      };
      props.onQuick(`修改镜头 ${scene.id} 里的元素 ${selected.selector}：${text}`, [attachment], false);
      setAiText('');
      deselect();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSendingAi(false);
    }
  };

  const selectParent = () => {
    if (!selected) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const el = safeQuery(doc, selected.selector);
    const parent = el?.parentElement;
    if (parent && !isRootOrNonVisual(parent, doc)) selectElement(parent);
  };

  const cancelCurrentProps = () => {
    if (beforeSelectRef.current) {
      draftRevRef.current += 1;
      setDraftEdits(cloneEdits(beforeSelectRef.current));
    }
    deselect();
  };

  const resetAll = () => {
    if (!hasAnyEdits) return;
    draftRevRef.current += 1;
    pushUndo(draftRef.current);
    setDraftEdits(emptyEdits());
    deselect();
  };

  // 测量悬浮卡片实际高度，用于窄舞台安全定位与防裁切。
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el || !selected) return;
    const measure = () => {
      if (el.offsetHeight > 0) setPopoverHeight(el.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [selected?.selector, editTab]);

  // 计算悬浮卡片在舞台内的安全定位：按舞台可用高度限制 maxHeight 并使用实际高度定位。
  const popoverStyle = useMemo(() => {
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

  const currentEdit = selected ? draftEdits.elements[selected.selector] : undefined;
  const thinVertical = !!selectedRect && selectedRect.width < 14 && selectedRect.height >= 24;
  const thinHorizontal = !!selectedRect && selectedRect.height < 14 && selectedRect.width >= 24;
  const handles: HandleKind[] = thinVertical
    ? ['n', 's']
    : thinHorizontal
      ? ['w', 'e']
      : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  const displayBg = currentEdit?.backgroundColor ?? selected?.computedBg ?? 'rgba(0, 0, 0, 0)';
  const displayColor = currentEdit?.color ?? selected?.computedColor ?? 'rgb(255, 255, 255)';
  const displayFontSize = currentEdit?.fontSize ?? selected?.computedFontSize ?? 32;
  const displayOpacity = currentEdit?.opacity ?? 1;
  const displayText = currentEdit?.text ?? selected?.origText ?? '';

  return (
    <div className="scene-editor">
      <div className="se-stage" ref={stageRef}>
        <div className="se-top-bar" role="toolbar" aria-label="画面编辑控制">
          {exitConfirm ? (
            <>
              <span className="se-dirty-tip">有未应用的修改</span>
              <button className="primary" disabled={saving || !!props.busy} onClick={() => void applyAndEncode(true)}>
                应用并出片
              </button>
              <button
                onClick={() => {
                  const after = pendingExitRef.current;
                  pendingExitRef.current = null;
                  dirtyRef.current = false;
                  setDraftEdits(cloneEdits(savedEdits));
                  setExitConfirm(false);
                  if (after) after();
                  else props.onExit();
                }}
              >
                放弃退出
              </button>
              <button
                className="ghost"
                onClick={() => {
                  exitTokenRef.current += 1;
                  pendingExitRef.current = null;
                  setExitConfirm(false);
                }}
              >
                继续编辑
              </button>
            </>
          ) : (
            <>
              <button className="se-exit-btn" id="exit-html-edit" onClick={requestExit}>
                退出编辑
              </button>
              {undoStack.length > 0 && (
                <button className="ghost" title="撤销上一步（⌘Z）" onClick={undo}>
                  <Icon name="undo" size={12} /> 撤销
                </button>
              )}
              {hasAnyEdits && (
                <button className="ghost" title="清除本镜头全部画面覆盖" onClick={resetAll}>
                  重置全部
                </button>
              )}
              {dirty && (
                <button className="primary" id="apply-html-edits" disabled={saving || !!props.busy} onClick={() => void applyAndEncode(false)}>
                  <Icon name="check" size={12} /> {saving ? '保存中…' : '应用修改'}
                </button>
              )}
            </>
          )}
        </div>

        <div
          className="se-canvas-wrap"
          style={{
            width: compSize.w,
            height: compSize.h,
            transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
          }}
        >
          <iframe
            ref={iframeRef}
            className="se-iframe"
            title="MG 画面编辑预览"
            width={compSize.w}
            height={compSize.h}
            src={`/preview/scenes/${encodeURIComponent(scene.id)}/?v=${props.version}`}
            onLoad={onIframeLoad}
          />
        </div>

        <div
          className="se-interact"
          aria-label="画面元素选择层"
          onPointerMove={onStageMove}
          onPointerLeave={() => setHoverBox(null)}
          onPointerDown={onStageClick}
        />

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
            onPointerDown={(e) => startTransform('move', e)}
          >
            {handles.map((h) => (
              <button
                key={h}
                type="button"
                className={`se-handle ${h}`}
                aria-label={`缩放控制点 ${h}`}
                onPointerDown={(e) => startTransform(h, e)}
              />
            ))}
            <button
              type="button"
              className="se-rotate-handle"
              aria-label="旋转元素"
              title="拖动旋转（按住 Shift 按 15° 吸附）"
              onPointerDown={(e) => startTransform('rotate', e)}
            >
              <Icon name="rotate" size={12} />
            </button>
          </div>
        )}

        {selected && popoverStyle && (
          <div ref={popoverRef} className="se-popover" role="dialog" aria-label="元素编辑面板" style={popoverStyle} onPointerDown={(e) => e.stopPropagation()}>
            <div className="se-pop-head">
              <div className="se-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={editTab === 'ai'} className={editTab === 'ai' ? 'on' : ''} onClick={() => setEditTab('ai')}>
                  <Icon name="spark" size={12} /> AI 编辑
                </button>
                <button type="button" role="tab" aria-selected={editTab === 'props'} className={editTab === 'props' ? 'on' : ''} onClick={() => setEditTab('props')}>
                  <Icon name="sliders" size={12} /> 属性调整
                  <span className="se-help-tip" title="直接调整元素位置、颜色、文字等外观，点「应用修改」后直接出片，不消耗 AI 额度">
                    ?
                  </span>
                </button>
              </div>
              <button type="button" className="se-trash-btn" aria-label="删除元素" title="隐藏 / 删除这个元素" onClick={hideSelected}>
                <Icon name="trash" size={14} />
              </button>
            </div>

            {editTab === 'ai' ? (
              <>
                <div className="se-selector-row">
                  <code className="se-selector-chip" title={selected.selector}>
                    {selected.selector}
                  </code>
                  {selected.canSelectParent && (
                    <button type="button" className="se-parent-btn" onClick={selectParent} title="选中它的外层容器">
                      ↑ 选父级
                    </button>
                  )}
                </div>
                <textarea
                  className="se-ai-input"
                  aria-label="AI 编辑说明"
                  placeholder="告诉我你希望这个画面如何变化，我会修改当前 MG 动画。"
                  value={aiText}
                  onChange={(e) => setAiText(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      void sendAiEdit();
                    }
                  }}
                />
                <div className="se-pop-foot">
                  <button type="button" className="se-cancel-btn" onClick={deselect}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary se-send-btn"
                    aria-label="发送 AI 编辑"
                    title="发给 AI 修改（⌘Enter）"
                    disabled={!aiText.trim() || sendingAi || !!props.busy}
                    onClick={() => void sendAiEdit()}
                  >
                    <Icon name="up" size={14} />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="se-props">
                  {selected.hasText && (
                    <label className="se-prop-row">
                      <span>文字</span>
                      <input
                        className="se-text-input"
                        type="text"
                        aria-label="文字内容"
                        value={displayText}
                        onChange={(e) => updateElement(selected.selector, { text: e.currentTarget.value })}
                      />
                    </label>
                  )}
                  <label className="se-prop-row">
                    <span>背景色</span>
                    <span className="se-color-field">
                      <span className="se-color-swatch" style={{ background: isTransparent(displayBg) ? 'transparent' : displayBg }}>
                        <input
                          type="color"
                          aria-label="选择背景色"
                          value={toHexColor(displayBg)}
                          onChange={(e) => updateElement(selected.selector, { backgroundColor: e.currentTarget.value }, true)}
                        />
                      </span>
                      <input
                        className="se-color-text"
                        type="text"
                        aria-label="背景色值"
                        value={displayBg}
                        onChange={(e) => updateElement(selected.selector, { backgroundColor: e.currentTarget.value })}
                      />
                    </span>
                  </label>
                  {selected.hasText && (
                    <>
                      <label className="se-prop-row">
                        <span>文字色</span>
                        <span className="se-color-field">
                          <span className="se-color-swatch" style={{ background: displayColor }}>
                            <input
                              type="color"
                              aria-label="选择文字色"
                              value={toHexColor(displayColor)}
                              onChange={(e) => updateElement(selected.selector, { color: e.currentTarget.value }, true)}
                            />
                          </span>
                          <input
                            className="se-color-text"
                            type="text"
                            aria-label="文字色值"
                            value={displayColor}
                            onChange={(e) => updateElement(selected.selector, { color: e.currentTarget.value })}
                          />
                        </span>
                      </label>
                      <label className="se-prop-row">
                        <span>字号</span>
                        <span className="se-num-chip">
                          <input
                            type="number"
                            aria-label="字号"
                            min={4}
                            max={600}
                            value={displayFontSize}
                            onChange={(e) => {
                              const n = Number(e.currentTarget.value);
                              if (Number.isFinite(n) && n >= 4 && n <= 600) updateElement(selected.selector, { fontSize: n });
                            }}
                          />
                          <span>px</span>
                        </span>
                      </label>
                    </>
                  )}
                  <div className="se-prop-row">
                    <span>偏移</span>
                    <div className="se-grid-2">
                      <label className="se-num-chip">
                        <span>X</span>
                        <input
                          type="number"
                          aria-label="X 偏移"
                          value={currentEdit?.dx ?? 0}
                          onChange={(e) => {
                            const n = Number(e.currentTarget.value);
                            if (Number.isFinite(n)) updateElement(selected.selector, { dx: n });
                          }}
                        />
                      </label>
                      <label className="se-num-chip">
                        <span>Y</span>
                        <input
                          type="number"
                          aria-label="Y 偏移"
                          value={currentEdit?.dy ?? 0}
                          onChange={(e) => {
                            const n = Number(e.currentTarget.value);
                            if (Number.isFinite(n)) updateElement(selected.selector, { dy: n });
                          }}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="se-prop-row">
                    <span>变换</span>
                    <div className="se-grid-2">
                      <label className="se-num-chip">
                        <span>缩放</span>
                        <input
                          type="number"
                          aria-label="缩放百分比"
                          min={10}
                          max={1000}
                          value={Math.round((currentEdit?.scaleX ?? 1) * 100)}
                          onChange={(e) => {
                            const n = Number(e.currentTarget.value);
                            if (Number.isFinite(n) && n >= 10 && n <= 1000) {
                              const s = Math.round(n) / 100;
                              updateElement(selected.selector, { scaleX: s, scaleY: s });
                            }
                          }}
                        />
                        <span>%</span>
                      </label>
                      <label className="se-num-chip">
                        <span>旋转</span>
                        <input
                          type="number"
                          aria-label="旋转角度"
                          value={currentEdit?.rotate ?? 0}
                          onChange={(e) => {
                            const n = Number(e.currentTarget.value);
                            if (Number.isFinite(n)) updateElement(selected.selector, { rotate: n });
                          }}
                        />
                        <span>°</span>
                      </label>
                    </div>
                  </div>
                  <label className="se-prop-row">
                    <span>透明度</span>
                    <span className="se-range-row">
                      <input
                        type="range"
                        aria-label="不透明度"
                        min={0}
                        max={100}
                        value={Math.round(displayOpacity * 100)}
                        onChange={(e) => {
                          const v = Number(e.currentTarget.value) / 100;
                          updateElement(selected.selector, { opacity: v >= 0.999 ? undefined : Math.round(v * 100) / 100 });
                        }}
                      />
                      <span className="mono">{Math.round(displayOpacity * 100)}%</span>
                    </span>
                  </label>
                  {currentEdit && (
                    <div className="se-selector-row">
                      <code className="se-selector-chip" title={selected.selector}>
                        {selected.selector}
                      </code>
                      <button
                        type="button"
                        className="se-reset-link"
                        onClick={() => {
                          draftRevRef.current += 1;
                          pushUndo(draftRef.current);
                          setDraftEdits((prev) => {
                            const next = cloneEdits(prev);
                            delete next.elements[selected.selector];
                            return next;
                          });
                        }}
                      >
                        恢复默认
                      </button>
                    </div>
                  )}
                </div>
                <div className="se-pop-foot">
                  <button type="button" className="se-cancel-btn" onClick={cancelCurrentProps}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary se-apply-btn"
                    disabled={!dirty || saving || !!props.busy}
                    onClick={() => void applyAndEncode(false)}
                  >
                    <Icon name="check" size={12} /> {saving ? '应用中…' : '应用修改'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="transport">
        <button className="step" onClick={() => (setPlaying(false), seekTo(time - 1 / FPS))} aria-label="后退一帧" title="后退一帧（←，Shift+← 10 帧）">
          <Icon name="prev" size={14} />
        </button>
        <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? '暂停' : '播放'} title="播放 / 暂停（空格）">
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <button className="step" onClick={() => (setPlaying(false), seekTo(time + 1 / FPS))} aria-label="前进一帧" title="前进一帧（→，Shift+→ 10 帧）">
          <Icon name="next" size={14} />
        </button>
        <span className="timecode">{clock(time)}</span>
        <span className="mono small muted">/ {clock(totalDuration)}</span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={totalDuration || 0}
          step={1 / FPS}
          value={time}
          aria-label="播放位置"
          onChange={(e) => {
            setPlaying(false);
            seekTo(Number(e.currentTarget.value));
          }}
        />
        <span className="mono small muted">
          帧 {Math.round(time * FPS)} / {Math.round(totalDuration * FPS)}
        </span>
      </div>

      <div className="se-hint-bar">
        <span>点击画面元素即可拖动、缩放、旋转，或切到 AI 编辑 / 属性调整</span>
        {error && <span className="error-line">{error}</span>}
      </div>
    </div>
  );
}

function safeQuery(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}
