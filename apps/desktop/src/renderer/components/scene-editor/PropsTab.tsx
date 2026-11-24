import type { ElementEdit } from '../../types';
import { Icon } from '../Icon';
import { isTransparent, toHexColor } from './dom';
import type { SelectedInfo } from './types';

interface PropsTabProps {
  selected: SelectedInfo;
  currentEdit: ElementEdit | undefined;
  dirty: boolean;
  saving: boolean;
  busy: string;
  onUpdateElement: (selector: string, patch: Partial<ElementEdit>, recordUndo?: boolean) => void;
  onResetElement: (selector: string) => void;
  onCancel: () => void;
  onApply: () => void;
}

export function PropsTab({
  selected,
  currentEdit,
  dirty,
  saving,
  busy,
  onUpdateElement,
  onResetElement,
  onCancel,
  onApply,
}: PropsTabProps) {
  const displayBg = currentEdit?.backgroundColor ?? selected.computedBg ?? 'rgba(0, 0, 0, 0)';
  const displayColor = currentEdit?.color ?? selected.computedColor ?? 'rgb(255, 255, 255)';
  const displayFontSize = currentEdit?.fontSize ?? selected.computedFontSize ?? 32;
  const displayOpacity = currentEdit?.opacity ?? 1;
  const displayText = currentEdit?.text ?? selected.origText ?? '';

  return (
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
              onChange={(e) => onUpdateElement(selected.selector, { text: e.currentTarget.value })}
            />
          </label>
        )}
        <label className="se-prop-row">
          <span>背景色</span>
          <span className="se-color-field">
            <span
              className="se-color-swatch"
              style={{ background: isTransparent(displayBg) ? 'transparent' : displayBg }}
            >
              <input
                type="color"
                aria-label="选择背景色"
                value={toHexColor(displayBg)}
                onChange={(e) => onUpdateElement(selected.selector, { backgroundColor: e.currentTarget.value }, true)}
              />
            </span>
            <input
              className="se-color-text"
              type="text"
              aria-label="背景色值"
              value={displayBg}
              onChange={(e) => onUpdateElement(selected.selector, { backgroundColor: e.currentTarget.value })}
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
                    onChange={(e) => onUpdateElement(selected.selector, { color: e.currentTarget.value }, true)}
                  />
                </span>
                <input
                  className="se-color-text"
                  type="text"
                  aria-label="文字色值"
                  value={displayColor}
                  onChange={(e) => onUpdateElement(selected.selector, { color: e.currentTarget.value })}
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
                    if (Number.isFinite(n) && n >= 4 && n <= 600) onUpdateElement(selected.selector, { fontSize: n });
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
                  if (Number.isFinite(n)) onUpdateElement(selected.selector, { dx: n });
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
                  if (Number.isFinite(n)) onUpdateElement(selected.selector, { dy: n });
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
                    onUpdateElement(selected.selector, { scaleX: s, scaleY: s });
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
                  if (Number.isFinite(n)) onUpdateElement(selected.selector, { rotate: n });
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
                onUpdateElement(selected.selector, { opacity: v >= 0.999 ? undefined : Math.round(v * 100) / 100 });
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
            <button type="button" className="se-reset-link" onClick={() => onResetElement(selected.selector)}>
              恢复默认
            </button>
          </div>
        )}
      </div>
      <div className="se-pop-foot">
        <button type="button" className="se-cancel-btn" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary se-apply-btn" disabled={!dirty || saving || !!busy} onClick={onApply}>
          <Icon name="check" size={12} /> {saving ? '应用中…' : '应用修改'}
        </button>
      </div>
    </>
  );
}
