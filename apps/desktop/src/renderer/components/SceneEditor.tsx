import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useRef, useState } from 'react';
import { errorText } from '../api';
import type { SceneEdits } from '../types';
import { dispatchElementAiEdit } from './scene-editor/aiEdit';
import {
  cloneEdits,
  findElementAt,
  hasDirectText,
  isRootOrNonVisual,
  safeQuery,
  uniqueSelector,
} from './scene-editor/dom';
import { ElementOverlay } from './scene-editor/ElementOverlay';
import { ElementPopover } from './scene-editor/ElementPopover';
import { TopBar } from './scene-editor/TopBar';
import { TransportBar } from './scene-editor/TransportBar';
import { beginTransformDrag } from './scene-editor/transform';
import { FPS, type HandleKind, type SceneEditorProps, type SelectedInfo, type StageRect } from './scene-editor/types';
import { useEditorShortcuts } from './scene-editor/useEditorShortcuts';
import { usePopoverPosition } from './scene-editor/usePopoverPosition';
import { useSceneEdits } from './scene-editor/useSceneEdits';
import { useStageViewport } from './scene-editor/useStageViewport';
import '../scene-editor.css';

export { toHexColor } from './scene-editor/dom';
export type { SceneEditorProps } from './scene-editor/types';

export function SceneEditor(props: SceneEditorProps) {
  const { scene, sceneRel, duration } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const [hoverBox, setHoverBox] = useState<{ rect: StageRect; selector: string } | null>(null);
  const [selected, setSelected] = useState<SelectedInfo | null>(null);
  const [selectedRect, setSelectedRect] = useState<StageRect | null>(null);
  const [editTab, setEditTab] = useState<'ai' | 'props'>('ai');
  const [aiText, setAiText] = useState('');
  const [sendingAi, setSendingAi] = useState(false);
  /** 选中这个元素之前的状态：点「取消」时退回它。 */
  const beforeSelectRef = useRef<SceneEdits | null>(null);

  const edits = useSceneEdits({
    sceneId: scene.id,
    version: props.version,
    onExit: props.onExit,
    onRegisterExitGuard: props.onRegisterExitGuard,
    run: props.run,
    onSceneChanged: () => {
      setSelected(null);
      setSelectedRect(null);
      setHoverBox(null);
    },
  });

  const viewport = useStageViewport({
    stageRef,
    iframeRef,
    scene,
    duration,
    initialTime: props.initialTime,
    onTimeChange: props.onTimeChange,
    draftEdits: edits.draftEdits,
    draftRef: edits.draftRef,
    selectedSelector: selected?.selector,
    setSelectedRect,
  });

  const deselect = useCallback(() => {
    setSelected(null);
    setSelectedRect(null);
    beforeSelectRef.current = null;
  }, []);

  const selectElement = useCallback(
    (el: Element) => {
      const doc = iframeRef.current?.contentDocument;
      const win = doc?.defaultView;
      if (!doc || !win) return;
      viewport.setPlaying(false);
      const selector = uniqueSelector(doc, el);
      const style = win.getComputedStyle(el);
      const parent = el.parentElement;
      const canSelectParent = !!parent && !isRootOrNonVisual(parent, doc);
      const textCapable = hasDirectText(el) || edits.draftRef.current.elements[selector]?.text !== undefined;
      const origText =
        viewport.origMapsRef.current.text.get(selector) ??
        (el as HTMLElement).dataset?.onsetOrigText ??
        el.textContent ??
        '';
      beforeSelectRef.current = cloneEdits(edits.draftRef.current);
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
      setSelectedRect(viewport.toStageRect(el.getBoundingClientRect()));
      setHoverBox(null);
      edits.setExitConfirm(false);
    },
    [viewport.toStageRect, viewport.setPlaying, viewport.origMapsRef, edits.draftRef, edits.setExitConfirm],
  );

  const hideSelected = useCallback(() => {
    if (!selected) return;
    edits.updateElement(selected.selector, { hidden: true }, true);
    deselect();
  }, [selected, edits.updateElement, deselect]);

  useEditorShortcuts({
    hasSelected: !!selected,
    exitConfirm: edits.exitConfirm,
    undoCount: edits.undoStack.length,
    timeRef: viewport.timeRef,
    undo: edits.undo,
    cancelExitConfirm: edits.cancelExitConfirm,
    deselect,
    requestExit: edits.requestExit,
    setPlaying: viewport.setPlaying,
    seekTo: viewport.seekTo,
    hideSelected,
  });

  // 画布鼠标悬停与点选。
  const canvasPoint = (e: ReactPointerEvent | PointerEvent) => {
    const box = stageRef.current?.getBoundingClientRect();
    if (!box) return { cx: 0, cy: 0 };
    return {
      cx: (e.clientX - box.left - viewport.fit.offsetX) / viewport.fit.scale,
      cy: (e.clientY - box.top - viewport.fit.offsetY) / viewport.fit.scale,
    };
  };

  const onStageMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const { cx, cy } = canvasPoint(e);
    if (cx < 0 || cy < 0 || cx > viewport.compSize.w || cy > viewport.compSize.h) {
      setHoverBox(null);
      return;
    }
    const el = findElementAt(doc, cx, cy, viewport.compSize.w, viewport.compSize.h);
    if (!el) {
      setHoverBox(null);
      return;
    }
    const selector = uniqueSelector(doc, el);
    if (selector === selected?.selector) {
      setHoverBox(null);
      return;
    }
    setHoverBox({ rect: viewport.toStageRect(el.getBoundingClientRect()), selector });
  };

  const onStageClick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const { cx, cy } = canvasPoint(e);
    const el = findElementAt(doc, cx, cy, viewport.compSize.w, viewport.compSize.h);
    if (!el) {
      deselect();
      return;
    }
    selectElement(el);
  };

  const startTransform = (kind: HandleKind, e: ReactPointerEvent) => {
    if (!selected || !selectedRect) return;
    beginTransformDrag({
      kind,
      e,
      selected,
      selectedRect,
      stageEl: stageRef.current,
      fit: viewport.fit,
      getDraft: () => edits.draftRef.current,
      pushUndo: edits.pushUndo,
      updateElement: edits.updateElement,
    });
  };

  const sendAiEdit = async () => {
    const text = aiText.trim();
    if (!selected || !text || sendingAi) return;
    edits.setError('');
    setSendingAi(true);
    try {
      await dispatchElementAiEdit({
        scene,
        sceneRel,
        selector: selected.selector,
        seconds: viewport.timeRef.current,
        text,
        onQuick: props.onQuick,
      });
      setAiText('');
      deselect();
    } catch (err) {
      edits.setError(errorText(err));
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
    if (beforeSelectRef.current) edits.restoreDraft(beforeSelectRef.current);
    deselect();
  };

  const resetAll = () => {
    if (!edits.hasAnyEdits) return;
    edits.resetAllEdits();
    deselect();
  };

  const popoverStyle = usePopoverPosition(popoverRef, selected?.selector, editTab, selectedRect, viewport.stageSize);
  const currentEdit = selected ? edits.draftEdits.elements[selected.selector] : undefined;

  return (
    <div className="scene-editor">
      <div className="se-stage" ref={stageRef}>
        <TopBar
          exitConfirm={edits.exitConfirm}
          saving={edits.saving}
          busy={props.busy}
          undoCount={edits.undoStack.length}
          hasAnyEdits={edits.hasAnyEdits}
          dirty={edits.dirty}
          onApplyAndExit={() => void edits.applyAndEncode(true)}
          onDiscardAndExit={edits.discardAndExit}
          onContinueEditing={edits.cancelExitConfirm}
          onRequestExit={edits.requestExit}
          onUndo={edits.undo}
          onResetAll={resetAll}
          onApply={() => void edits.applyAndEncode(false)}
        />

        <div
          className="se-canvas-wrap"
          style={{
            width: viewport.compSize.w,
            height: viewport.compSize.h,
            transform: `translate(${viewport.fit.offsetX}px, ${viewport.fit.offsetY}px) scale(${viewport.fit.scale})`,
          }}
        >
          <iframe
            ref={iframeRef}
            className="se-iframe"
            title="MG 画面编辑预览"
            width={viewport.compSize.w}
            height={viewport.compSize.h}
            src={`/preview/scenes/${encodeURIComponent(scene.id)}/?v=${props.version}`}
            onLoad={viewport.onIframeLoad}
          />
        </div>

        <div
          className="se-interact"
          aria-label="画面元素选择层"
          onPointerMove={onStageMove}
          onPointerLeave={() => setHoverBox(null)}
          onPointerDown={onStageClick}
        />

        <ElementOverlay
          hoverBox={hoverBox}
          selected={selected}
          selectedRect={selectedRect}
          onStartTransform={startTransform}
        />

        {selected && popoverStyle && (
          <ElementPopover
            popoverRef={popoverRef}
            style={popoverStyle}
            selected={selected}
            currentEdit={currentEdit}
            editTab={editTab}
            setEditTab={setEditTab}
            aiText={aiText}
            setAiText={setAiText}
            sendingAi={sendingAi}
            dirty={edits.dirty}
            saving={edits.saving}
            busy={props.busy}
            onHideSelected={hideSelected}
            onSelectParent={selectParent}
            onSendAiEdit={() => void sendAiEdit()}
            onDeselect={deselect}
            onUpdateElement={edits.updateElement}
            onResetElement={edits.resetElement}
            onCancelProps={cancelCurrentProps}
            onApplyProps={() => void edits.applyAndEncode(false)}
          />
        )}
      </div>

      <TransportBar
        time={viewport.time}
        totalDuration={viewport.totalDuration}
        playing={viewport.playing}
        error={edits.error}
        onStep={(deltaFrames) => {
          viewport.setPlaying(false);
          viewport.seekTo(viewport.time + deltaFrames / FPS);
        }}
        onTogglePlay={() => viewport.setPlaying((p) => !p)}
        onScrub={(seconds) => {
          viewport.setPlaying(false);
          viewport.seekTo(seconds);
        }}
      />
    </div>
  );
}
