import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../../api';
import type { ElementEdit, SceneEdits, SceneEditsResponse } from '../../types';
import type { RunAction } from '../Preview';
import { cloneEdits, editsEqual, emptyEdits, hasEditEffect } from './dom';

interface UseSceneEditsOptions {
  sceneId: string;
  version: number;
  onExit: () => void;
  onRegisterExitGuard?: (guard: ((proceed: () => void) => boolean) | null) => void;
  run: RunAction;
  onSceneChanged: () => void;
}

export function useSceneEdits({
  sceneId,
  version,
  onExit,
  onRegisterExitGuard,
  run,
  onSceneChanged,
}: UseSceneEditsOptions) {
  const [savedEdits, setSavedEdits] = useState<SceneEdits>(emptyEdits);
  const [draftEdits, setDraftEdits] = useState<SceneEdits>(emptyEdits);
  const [undoStack, setUndoStack] = useState<SceneEdits[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [exitConfirm, setExitConfirm] = useState(false);

  const pendingExitRef = useRef<(() => void) | null>(null);
  const draftRef = useRef(draftEdits);
  draftRef.current = draftEdits;
  const draftRevRef = useRef(0);
  const savedWriteRef = useRef(0);
  const exitTokenRef = useRef(0);
  const loadedSceneRef = useRef('');
  const onSceneChangedRef = useRef(onSceneChanged);
  onSceneChangedRef.current = onSceneChanged;

  const dirty = useMemo(() => !editsEqual(savedEdits, draftEdits), [savedEdits, draftEdits]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const hasAnyEdits = Object.keys(draftEdits.elements).length > 0;

  // 向父级导航（切换镜头 / 切换标签 / 收起面板）注册未保存离开守卫。
  useEffect(() => {
    if (!onRegisterExitGuard) return;
    onRegisterExitGuard((proceed: () => void) => {
      if (!dirtyRef.current) return true;
      pendingExitRef.current = proceed;
      setExitConfirm(true);
      return false;
    });
    return () => {
      onRegisterExitGuard(null);
    };
  }, [onRegisterExitGuard]);

  // 加载已保存的属性覆盖：区分初次加载/切镜与后台项目刷新（props.version 变化）。
  // 草稿已修改或首次 GET 返回前用户已经编辑时，只更新 savedEdits，保留未应用的草稿与撤销栈。
  useEffect(() => {
    let active = true;
    const sceneChanged = loadedSceneRef.current !== sceneId;
    loadedSceneRef.current = sceneId;
    if (sceneChanged) {
      setError('');
      onSceneChangedRef.current();
      setExitConfirm(false);
      pendingExitRef.current = null;
      setUndoStack([]);
    }
    const revAtStart = draftRevRef.current;
    const savedWriteAtStart = savedWriteRef.current;
    void api<SceneEditsResponse>(`/api/scenes/${encodeURIComponent(sceneId)}/edits`).then(
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
  }, [sceneId, version]);

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

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      draftRevRef.current += 1;
      const prev = stack[stack.length - 1];
      setDraftEdits(prev);
      return stack.slice(0, -1);
    });
  }, []);

  const resetElement = useCallback(
    (selector: string) => {
      draftRevRef.current += 1;
      pushUndo(draftRef.current);
      setDraftEdits((prev) => {
        const next = cloneEdits(prev);
        delete next.elements[selector];
        return next;
      });
    },
    [pushUndo],
  );

  const resetAllEdits = useCallback(() => {
    if (!hasAnyEdits) return;
    draftRevRef.current += 1;
    pushUndo(draftRef.current);
    setDraftEdits(emptyEdits());
  }, [hasAnyEdits, pushUndo]);

  const restoreDraft = useCallback((snapshot: SceneEdits) => {
    draftRevRef.current += 1;
    setDraftEdits(cloneEdits(snapshot));
  }, []);

  const requestExit = useCallback(() => {
    pendingExitRef.current = null;
    if (dirty) {
      setExitConfirm(true);
      return;
    }
    onExit();
  }, [dirty, onExit]);

  const cancelExitConfirm = useCallback(() => {
    exitTokenRef.current += 1;
    pendingExitRef.current = null;
    setExitConfirm(false);
  }, []);

  const discardAndExit = useCallback(() => {
    const after = pendingExitRef.current;
    pendingExitRef.current = null;
    dirtyRef.current = false;
    setDraftEdits(cloneEdits(savedEdits));
    setExitConfirm(false);
    if (after) after();
    else onExit();
  }, [savedEdits, onExit]);

  /** 保存属性覆盖并触发零 Token 直接出片：只确认提交那一刻的草稿版本，编码受理回调时再次核对版本与离开意图。 */
  const applyAndEncode = async (exitAfter = false) => {
    setError('');
    setSaving(true);
    const submitted = cloneEdits(draftRef.current);
    const submittedRev = draftRevRef.current;
    const afterExit = pendingExitRef.current;
    const exitToken = exitTokenRef.current;
    try {
      const res = await api<{ edits: SceneEdits }>(`/api/scenes/${encodeURIComponent(sceneId)}/edits`, {
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
      run(`/api/scenes/${encodeURIComponent(sceneId)}/encode`, {}, () => {
        if (exitAfter && draftRevRef.current === submittedRev && exitTokenRef.current === exitToken) {
          dirtyRef.current = false;
          if (afterExit) afterExit();
          else onExit();
        }
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return {
    draftEdits,
    draftRef,
    undoStack,
    saving,
    error,
    setError,
    exitConfirm,
    setExitConfirm,
    dirty,
    hasAnyEdits,
    pushUndo,
    updateElement,
    undo,
    resetElement,
    resetAllEdits,
    restoreDraft,
    requestExit,
    cancelExitConfirm,
    discardAndExit,
    applyAndEncode,
  };
}
