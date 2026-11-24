import type { RefObject } from 'react';
import type { ElementEdit } from '../../types';
import { Icon } from '../Icon';
import { PropsTab } from './PropsTab';
import type { SelectedInfo } from './types';

interface ElementPopoverProps {
  popoverRef: RefObject<HTMLDivElement | null>;
  style: { left: number; top: number; maxHeight: number };
  selected: SelectedInfo;
  currentEdit: ElementEdit | undefined;
  editTab: 'ai' | 'props';
  setEditTab: (tab: 'ai' | 'props') => void;
  aiText: string;
  setAiText: (text: string) => void;
  sendingAi: boolean;
  dirty: boolean;
  saving: boolean;
  busy: string;
  onHideSelected: () => void;
  onSelectParent: () => void;
  onSendAiEdit: () => void;
  onDeselect: () => void;
  onUpdateElement: (selector: string, patch: Partial<ElementEdit>, recordUndo?: boolean) => void;
  onResetElement: (selector: string) => void;
  onCancelProps: () => void;
  onApplyProps: () => void;
}

export function ElementPopover({
  popoverRef,
  style,
  selected,
  currentEdit,
  editTab,
  setEditTab,
  aiText,
  setAiText,
  sendingAi,
  dirty,
  saving,
  busy,
  onHideSelected,
  onSelectParent,
  onSendAiEdit,
  onDeselect,
  onUpdateElement,
  onResetElement,
  onCancelProps,
  onApplyProps,
}: ElementPopoverProps) {
  return (
    <div
      ref={popoverRef}
      className="se-popover"
      role="dialog"
      aria-label="元素编辑面板"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="se-pop-head">
        <div className="se-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={editTab === 'ai'}
            className={editTab === 'ai' ? 'on' : ''}
            onClick={() => setEditTab('ai')}
          >
            <Icon name="spark" size={12} /> AI 编辑
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={editTab === 'props'}
            className={editTab === 'props' ? 'on' : ''}
            onClick={() => setEditTab('props')}
          >
            <Icon name="sliders" size={12} /> 属性调整
            <span
              className="se-help-tip"
              title="直接调整元素位置、颜色、文字等外观，点「应用修改」后直接出片，不消耗 AI 额度"
            >
              ?
            </span>
          </button>
        </div>
        <button
          type="button"
          className="se-trash-btn"
          aria-label="删除元素"
          title="隐藏 / 删除这个元素"
          onClick={onHideSelected}
        >
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
              <button type="button" className="se-parent-btn" onClick={onSelectParent} title="选中它的外层容器">
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
                onSendAiEdit();
              }
            }}
          />
          <div className="se-pop-foot">
            <button type="button" className="se-cancel-btn" onClick={onDeselect}>
              取消
            </button>
            <button
              type="button"
              className="primary se-send-btn"
              aria-label="发送 AI 编辑"
              title="发给 AI 修改（⌘Enter）"
              disabled={!aiText.trim() || sendingAi || !!busy}
              onClick={onSendAiEdit}
            >
              <Icon name="up" size={14} />
            </button>
          </div>
        </>
      ) : (
        <PropsTab
          selected={selected}
          currentEdit={currentEdit}
          dirty={dirty}
          saving={saving}
          busy={busy}
          onUpdateElement={onUpdateElement}
          onResetElement={onResetElement}
          onCancel={onCancelProps}
          onApply={onApplyProps}
        />
      )}
    </div>
  );
}
