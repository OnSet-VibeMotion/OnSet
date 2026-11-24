import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Tab } from '../components/Preview';
import {
  minChat,
  minPanel,
  PANEL_OPEN_KEY,
  PANEL_WIDTH_KEY,
  type PanelKind,
  panelDefault,
  panelKind,
  readNumber,
  store,
} from './helpers';

export function usePanelLayout() {
  const [tab, setTab] = useState<Tab>('scene');
  // 对话是主栏；画面面板只在有东西要看时打开（步骤、studio_show、回复里的镜头与文件）。
  const [panelOpen, setPanelOpenState] = useState(() => {
    try {
      return localStorage.getItem(PANEL_OPEN_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setPanelOpen = useCallback((open: boolean | ((current: boolean) => boolean)) => {
    setPanelOpenState((current) => {
      const next = typeof open === 'function' ? open(current) : open;
      store(PANEL_OPEN_KEY, next ? '1' : '0');
      return next;
    });
  }, []);
  const sceneExitGuardRef = useRef<((proceed: () => void) => boolean) | null>(null);
  const guardSceneLeave = useCallback((proceed: () => void) => {
    if (sceneExitGuardRef.current && !sceneExitGuardRef.current(proceed)) return;
    proceed();
  }, []);
  const setTabGuarded = useCallback(
    (next: Tab) => {
      if (next === tab) return;
      guardSceneLeave(() => setTab(next));
    },
    [tab, guardSceneLeave],
  );
  /** 切到某一页并打开面板：用户或编排工具要看什么时都走这里；自动切页（稿件审核、卡点）只换页不开面板。 */
  const showTab = useCallback(
    (next: Tab) => {
      if (next !== tab) {
        guardSceneLeave(() => {
          setTab(next);
          setPanelOpen(true);
        });
        return;
      }
      setPanelOpen(true);
    },
    [tab, guardSceneLeave, setPanelOpen],
  );
  const kind = panelKind(tab);
  const [panelWidths, setPanelWidths] = useState<Record<PanelKind, number>>(() => ({
    media: readNumber(PANEL_WIDTH_KEY + 'media', panelDefault.media),
    doc: readNumber(PANEL_WIDTH_KEY + 'doc', panelDefault.doc),
  }));
  const workspace = useRef<HTMLDivElement>(null);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = workspace.current?.getBoundingClientRect();
    if (!box) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let latest = panelWidths[kind];
    const move = (e: PointerEvent) => {
      const width = Math.min(Math.max(box.right - e.clientX, minPanel), box.width - minChat);
      latest = Math.min(Math.max(width / box.width, 0.2), 0.8);
      setPanelWidths((current) => ({ ...current, [kind]: latest }));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      store(PANEL_WIDTH_KEY + kind, String(latest));
    };
    document.body.classList.add('resizing');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const resetWidth = () => {
    setPanelWidths((current) => ({ ...current, [kind]: panelDefault[kind] }));
    store(PANEL_WIDTH_KEY + kind, String(panelDefault[kind]));
  };

  // Esc 收起面板；圈选、菜单、弹窗开着时 Esc 归它们，输入框里的 Esc 也不管。
  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('.selection-bar, .scene-editor, [role="menu"], [role="dialog"], .modal-backdrop'))
        return;
      setPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen, setPanelOpen]);

  return {
    tab,
    setTab,
    panelOpen,
    setPanelOpen,
    sceneExitGuardRef,
    guardSceneLeave,
    setTabGuarded,
    showTab,
    kind,
    panelWidths,
    workspace,
    startResize,
    resetWidth,
  };
}
