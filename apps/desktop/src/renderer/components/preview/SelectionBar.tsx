import { useEffect } from 'react';
import { Icon } from '../Icon';

/** 选区旁的小工具条：贴在选区下沿，放不下就放到上沿，左右不出画面。 */
export function SelectionBar(props: {
  drag: { x0: number; y0: number; x1: number; y1: number };
  frame: HTMLDivElement | null;
  onFix: () => void;
  onAttach: () => void;
  onClear: () => void;
}) {
  const { drag, frame } = props;
  const width = frame?.clientWidth ?? 0;
  const height = frame?.clientHeight ?? 0;
  const barW = 236;
  const barH = 36;
  const left = Math.max(8, Math.min(Math.min(drag.x0, drag.x1), width - barW - 8));
  const bottom = Math.max(drag.y0, drag.y1);
  const top = bottom + 8 + barH <= height - 8 ? bottom + 8 : Math.max(8, Math.min(drag.y0, drag.y1) - barH - 8);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClear]);

  return (
    <div className="selection-bar" style={{ left, top }}>
      <button
        id="fix-region"
        className="primary"
        onClick={props.onFix}
        title="带上这一帧和圈出的区域，在对话里说哪里不对"
      >
        说说这里…
      </button>
      <button id="attach-region" onClick={props.onAttach} title="把这一帧和圈出的区域附到对话">
        附到对话
      </button>
      <button className="icon" onClick={props.onClear} aria-label="取消圈选" title="取消圈选（Esc）">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
