import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BeatPlanSegment } from '../../types';
import { barsOf, lowerBound } from './grid';

interface Palette {
  wave: string;
  waveDim: string;
  beat: string;
  down: string;
  text: string;
  head: string;
  seg: string[];
  segText: string;
  bad: string;
}

function palette(el: HTMLElement): Palette {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    wave: v('--text-3', '#a9a294'),
    waveDim: v('--line-strong', '#33302a'),
    beat: v('--faint', '#7a746a'),
    down: v('--accent', '#d9a35f'),
    text: v('--text-2', '#c2bbae'),
    head: v('--text', '#efe9dd'),
    seg: [v('--chip', '#1f1c18'), v('--raised', '#171512')],
    segText: v('--text-3', '#a9a294'),
    bad: v('--stale', '#e0c068'),
  };
}

const waveRate = 200;
const laneTop = 22;
const planLane = 22;

export function Lane(props: {
  duration: number;
  peaks: Float32Array | null;
  beats: number[];
  downbeats: number[];
  meter: number;
  plan: BeatPlanSegment[];
  now: () => number;
  playing: boolean;
  pausedAt: number;
  onSeek: (t: number) => void;
  onScene: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pps, setPps] = useState(80);
  const height = 168;
  const total = Math.max(1, props.duration * pps);
  const bars = useMemo(
    () => barsOf({ beats: props.beats, downbeats: props.downbeats, duration_seconds: props.duration }),
    [props.beats, props.downbeats, props.duration],
  );
  const hasPlan = props.plan.length > 0;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    if (!canvas || !scroller) return;
    const dpr = window.devicePixelRatio || 1;
    const w = scroller.clientWidth;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = height + 'px';
    }
    const g = canvas.getContext('2d');
    if (!g) return;
    const c = palette(canvas);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, height);
    const left = scroller.scrollLeft;
    const t0 = left / pps;
    const t1 = (left + w) / pps;
    const x = (t: number) => t * pps - left;
    const top = laneTop + (hasPlan ? planLane : 0);
    const mid = top + (height - top) / 2;
    const amp = (height - top) / 2 - 6;

    // 分镜计划：每个镜头占的小节。
    if (hasPlan) {
      props.plan.forEach((seg, i) => {
        if (seg.end_seconds < t0 || seg.start_seconds > t1) return;
        const a = x(seg.start_seconds);
        const b = x(seg.end_seconds);
        g.fillStyle = c.seg[i % 2];
        g.fillRect(a, laneTop, b - a - 1, planLane - 4);
        g.fillStyle = c.segText;
        g.font = '11px "SF Mono", ui-monospace, monospace';
        g.textBaseline = 'middle';
        g.save();
        g.beginPath();
        g.rect(a, laneTop, b - a - 1, planLane - 4);
        g.clip();
        g.fillText(`${seg.id} · ${seg.bars} 小节`, Math.max(a, 0) + 6, laneTop + (planLane - 4) / 2);
        g.restore();
      });
    }

    // 波形：已播过的亮、没播的暗，播放位置一眼可见。
    const playhead = props.playing ? props.now() : props.pausedAt;
    if (props.peaks) {
      const p = props.peaks;
      for (let px = 0; px < w; px++) {
        const ta = (left + px) / pps;
        const tb = (left + px + 1) / pps;
        let peak = 0;
        for (let i = Math.floor(ta * waveRate); i <= Math.min(p.length - 1, Math.floor(tb * waveRate)); i++)
          peak = Math.max(peak, p[i]);
        const h = Math.max(1, peak * amp);
        g.fillStyle = ta < playhead ? c.wave : c.waveDim;
        g.fillRect(px, mid - h, 1, h * 2);
      }
    }

    // 普通拍与重拍。
    const bi = lowerBound(props.beats, t0 - 1);
    g.lineWidth = 1;
    for (let i = bi; i < props.beats.length && props.beats[i] <= t1 + 1; i++) {
      const bx = Math.round(x(props.beats[i])) + 0.5;
      g.strokeStyle = c.beat;
      g.globalAlpha = 0.45;
      g.beginPath();
      g.moveTo(bx, top);
      g.lineTo(bx, height);
      g.stroke();
      // 上下各一小段实线刻度：波形很满时也看得见每一拍。
      g.globalAlpha = 1;
      g.strokeStyle = c.text;
      g.beginPath();
      g.moveTo(bx, top);
      g.lineTo(bx, top + 7);
      g.moveTo(bx, height - 7);
      g.lineTo(bx, height);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.font = '11px "SF Mono", ui-monospace, monospace';
    g.textBaseline = 'top';
    const di = Math.max(0, lowerBound(props.downbeats, t0 - 1));
    const labelEvery = pps < 14 ? 8 : pps < 28 ? 4 : pps < 50 ? 2 : 1;
    for (let i = di; i < bars.length && bars[i].start <= t1 + 1; i++) {
      const bar = bars[i];
      const bx = Math.round(x(bar.start)) + 0.5;
      g.strokeStyle = c.down;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(bx, top);
      g.lineTo(bx, height);
      g.stroke();
      g.lineWidth = 1;
      const odd = i < bars.length - 1 && bar.beats !== props.meter;
      if ((bar.number - 1) % labelEvery === 0 || odd) {
        g.fillStyle = odd ? c.bad : c.text;
        g.fillText(String(bar.number) + (odd ? ` · ${bar.beats}拍` : ''), bx + 4, 4);
      }
    }

    // 播放头。
    const hx = Math.round(x(playhead)) + 0.5;
    if (hx >= 0 && hx <= w) {
      g.strokeStyle = c.head;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(hx, 0);
      g.lineTo(hx, height);
      g.stroke();
    }
  }, [
    bars,
    hasPlan,
    pps,
    props.beats,
    props.downbeats,
    props.meter,
    props.now,
    props.pausedAt,
    props.peaks,
    props.plan,
    props.playing,
  ]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [draw]);

  // 播放中每帧重画，并让播放头留在视野里。
  useEffect(() => {
    draw();
    if (!props.playing) return;
    let raf = 0;
    const tick = () => {
      const scroller = scrollRef.current;
      if (scroller) {
        const hx = props.now() * pps - scroller.scrollLeft;
        if (hx > scroller.clientWidth * 0.8 || hx < 0)
          scroller.scrollLeft = Math.max(0, props.now() * pps - scroller.clientWidth * 0.2);
      }
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [draw, pps, props.now, props.playing]);

  const zoom = (factor: number) => {
    const scroller = scrollRef.current;
    const center = scroller ? (scroller.scrollLeft + scroller.clientWidth / 2) / pps : 0;
    const next = Math.min(600, Math.max(4, pps * factor));
    setPps(next);
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollLeft = Math.max(0, center * next - scroller.clientWidth / 2);
    });
  };
  const fit = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    setPps(Math.max(2, scroller.clientWidth / Math.max(1, props.duration)));
    scroller.scrollLeft = 0;
  };

  const pointToTime = (clientX: number) => {
    const scroller = scrollRef.current!;
    const rect = scroller.getBoundingClientRect();
    return (clientX - rect.left + scroller.scrollLeft) / pps;
  };

  return (
    <div className="beat-lane">
      <div
        className="beat-scroll"
        ref={scrollRef}
        onScroll={draw}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          zoom(e.deltaY < 0 ? 1.25 : 0.8);
        }}
        onClick={(e) => {
          const t = pointToTime(e.clientX);
          const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
          if (hasPlan && y >= laneTop && y < laneTop + planLane) {
            const seg = props.plan.find((s) => t >= s.start_seconds && t < s.end_seconds);
            if (seg && e.detail >= 2) {
              props.onScene(seg.id);
              return;
            }
          }
          props.onSeek(t);
        }}
        title="单击跳到这里；⌘ + 滚轮缩放；双击上方的镜头条打开镜头"
      >
        <div className="beat-track" style={{ width: total, height }}>
          <canvas ref={canvasRef} className="beat-canvas" />
        </div>
      </div>
      <div className="beat-zoom">
        <button className="icon-btn" onClick={() => zoom(0.7)} title="缩小" aria-label="缩小">
          −
        </button>
        <button className="icon-btn" onClick={() => zoom(1.4)} title="放大" aria-label="放大">
          +
        </button>
        <button className="link" onClick={fit}>
          整首
        </button>
      </div>
    </div>
  );
}
