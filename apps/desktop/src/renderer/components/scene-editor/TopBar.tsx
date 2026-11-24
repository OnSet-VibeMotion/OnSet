import { Icon } from '../Icon';

interface TopBarProps {
  exitConfirm: boolean;
  saving: boolean;
  busy: string;
  undoCount: number;
  hasAnyEdits: boolean;
  dirty: boolean;
  onApplyAndExit: () => void;
  onDiscardAndExit: () => void;
  onContinueEditing: () => void;
  onRequestExit: () => void;
  onUndo: () => void;
  onResetAll: () => void;
  onApply: () => void;
}

export function TopBar({
  exitConfirm,
  saving,
  busy,
  undoCount,
  hasAnyEdits,
  dirty,
  onApplyAndExit,
  onDiscardAndExit,
  onContinueEditing,
  onRequestExit,
  onUndo,
  onResetAll,
  onApply,
}: TopBarProps) {
  return (
    <div className="se-top-bar" role="toolbar" aria-label="画面编辑控制">
      {exitConfirm ? (
        <>
          <span className="se-dirty-tip">有未应用的修改</span>
          <button className="primary" disabled={saving || !!busy} onClick={onApplyAndExit}>
            应用并出片
          </button>
          <button onClick={onDiscardAndExit}>放弃退出</button>
          <button className="ghost" onClick={onContinueEditing}>
            继续编辑
          </button>
        </>
      ) : (
        <>
          <button className="se-exit-btn" id="exit-html-edit" onClick={onRequestExit}>
            退出编辑
          </button>
          {undoCount > 0 && (
            <button className="ghost" title="撤销上一步（⌘Z）" onClick={onUndo}>
              <Icon name="undo" size={12} /> 撤销
            </button>
          )}
          {hasAnyEdits && (
            <button className="ghost" title="清除本镜头全部画面覆盖" onClick={onResetAll}>
              重置全部
            </button>
          )}
          {dirty && (
            <button className="primary" id="apply-html-edits" disabled={saving || !!busy} onClick={onApply}>
              <Icon name="check" size={12} /> {saving ? '保存中…' : '应用修改'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
