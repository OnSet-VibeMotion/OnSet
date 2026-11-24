import { useEffect, useState } from 'react';
import { lowerBound, match } from './grid';

/** 大字数拍：当前是第几小节、第几拍，重拍那一格最大。眼睛跟着数，比只听咔嗒容易判断「1」是不是落在音乐的重音上。 */
export function Counter({
  beats,
  downbeats,
  now,
  playing,
  pausedAt,
  meter,
}: {
  beats: number[];
  downbeats: number[];
  now: () => number;
  playing: boolean;
  pausedAt: number;
  meter: number;
}) {
  const [state, setState] = useState({ bar: 0, beat: -1, flash: 0 });
  useEffect(() => {
    const compute = () => {
      const t = playing ? now() : pausedAt;
      const bi = lowerBound(beats, t + 0.001) - 1;
      const di = lowerBound(downbeats, t + 0.001) - 1;
      let beatInBar = -1;
      if (bi >= 0 && di >= 0) beatInBar = bi - lowerBound(beats, downbeats[di] - match);
      else if (bi >= 0) beatInBar = bi - lowerBound(beats, 0);
      const flash = bi >= 0 ? Math.max(0, 1 - (t - beats[bi]) / 0.18) : 0;
      setState((prev) =>
        prev.bar === di + 1 && prev.beat === beatInBar && Math.abs(prev.flash - flash) < 0.08
          ? prev
          : { bar: di + 1, beat: beatInBar, flash },
      );
    };
    compute();
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      compute();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [beats, downbeats, now, pausedAt, playing]);
  const cells = Math.max(meter, state.beat + 1);
  return (
    <div className="beat-counter" aria-live="off">
      <div className="beat-counter-bar">
        <span className="label">小节</span>
        <strong>{state.bar > 0 ? state.bar : '弱起'}</strong>
      </div>
      <div className="beat-cells">
        {Array.from({ length: cells }, (_, i) => (
          <span
            key={i}
            className={
              'beat-cell' + (i === 0 ? ' down' : '') + (i === state.beat ? ' on' : '') + (i >= meter ? ' extra' : '')
            }
            style={i === state.beat ? { opacity: 0.55 + 0.45 * state.flash } : undefined}
          >
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}
