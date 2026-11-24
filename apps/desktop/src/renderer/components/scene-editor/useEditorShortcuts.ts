import { type MutableRefObject, useEffect } from 'react';
import { FPS } from './types';

interface EditorShortcutsOptions {
  hasSelected: boolean;
  exitConfirm: boolean;
  undoCount: number;
  timeRef: MutableRefObject<number>;
  undo: () => void;
  cancelExitConfirm: () => void;
  deselect: () => void;
  requestExit: () => void;
  setPlaying: (updater: boolean | ((prev: boolean) => boolean)) => void;
  seekTo: (next: number) => void;
  hideSelected: () => void;
}

/** 键盘快捷键：←/→ 逐帧，空格播放/暂停，Esc 逐层退出，Delete 隐藏选中元素，Cmd/Ctrl+Z 撤销。 */
export function useEditorShortcuts({
  hasSelected,
  exitConfirm,
  undoCount,
  timeRef,
  undo,
  cancelExitConfirm,
  deselect,
  requestExit,
  setPlaying,
  seekTo,
  hideSelected,
}: EditorShortcutsOptions): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const inInput = !!target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !inInput) {
        if (undoCount > 0) {
          e.preventDefault();
          undo();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (exitConfirm) cancelExitConfirm();
        else if (hasSelected) deselect();
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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelected) {
        e.preventDefault();
        hideSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    hasSelected,
    exitConfirm,
    undoCount,
    undo,
    cancelExitConfirm,
    deselect,
    requestExit,
    setPlaying,
    seekTo,
    hideSelected,
    timeRef,
  ]);
}
