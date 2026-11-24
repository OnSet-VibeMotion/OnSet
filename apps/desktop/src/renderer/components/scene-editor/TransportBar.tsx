import { Icon } from '../Icon';
import { clock } from './dom';
import { FPS } from './types';

interface TransportBarProps {
  time: number;
  totalDuration: number;
  playing: boolean;
  error: string;
  onStep: (deltaFrames: number) => void;
  onTogglePlay: () => void;
  onScrub: (seconds: number) => void;
}

export function TransportBar({
  time,
  totalDuration,
  playing,
  error,
  onStep,
  onTogglePlay,
  onScrub,
}: TransportBarProps) {
  return (
    <>
      <div className="transport">
        <button className="step" onClick={() => onStep(-1)} aria-label="后退一帧" title="后退一帧（←，Shift+← 10 帧）">
          <Icon name="prev" size={14} />
        </button>
        <button
          className="play"
          onClick={onTogglePlay}
          aria-label={playing ? '暂停' : '播放'}
          title="播放 / 暂停（空格）"
        >
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <button className="step" onClick={() => onStep(1)} aria-label="前进一帧" title="前进一帧（→，Shift+→ 10 帧）">
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
          onChange={(e) => onScrub(Number(e.currentTarget.value))}
        />
        <span className="mono small muted">
          帧 {Math.round(time * FPS)} / {Math.round(totalDuration * FPS)}
        </span>
      </div>

      <div className="se-hint-bar">
        <span>点击画面元素即可拖动、缩放、旋转，或切到 AI 编辑 / 属性调整</span>
        {error && <span className="error-line">{error}</span>}
      </div>
    </>
  );
}
