import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rawURL } from '../api';
import type { Attachment, BeatGrid, BeatPlanSegment, BeatState } from '../types';
import type { RunAction } from './Preview';
import '../beat.css';

/**
 * 「节拍」页：卡点模式下代替口播稿页排在第一步。
 *
 * 以前只能听 grid-click.wav（每拍一声、重拍更高）再在终端里看 am beat bars 的表。这里把同一份网格画出来：
 * 波形上的每一拍、每个重拍和小节号，播放时大字数拍；重拍错位或拍号判错时，在页面上换拍号、换起始拍
 * 立刻就能听到（咔嗒由 WebAudio 按预览的网格现合成，不用等 ffmpeg 重做试听轨），听对了再写回草稿、确认。
 * 写文件只经 am beat regrid / am beat confirm 两个写任务，客户端自己不改网格。
 */

interface Props {
  beat: BeatState | null;
  version: number;
  busy: string;
  run: RunAction;
  onQuick: (text: string, attachments: Attachment[], draftOnly?: boolean) => void;
  onScene: (id: string) => void;
}

/** 与 beat/grid.ts 的 downbeatMatch 相同：重拍对齐到普通拍的容差。 */
const match = 0.002;
const meterChoices = [2, 3, 4, 6, 8];

function clock(seconds: number, digits = 1): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(digits).padStart(digits > 0 ? 3 + digits : 2, '0')}`;
}

/** 第一个不小于 x 的下标。 */
function lowerBound(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Bar {
  number: number;
  start: number;
  end: number;
  beats: number;
}

function barsOf(grid: { beats: number[]; downbeats: number[]; duration_seconds: number }): Bar[] {
  return grid.downbeats.map((start, i) => {
    const end = i + 1 < grid.downbeats.length ? grid.downbeats[i + 1] : grid.duration_seconds;
    const count = lowerBound(grid.beats, end - match) - lowerBound(grid.beats, start - match);
    return { number: i + 1, start, end, beats: count };
  });
}

/** 最常见的每小节拍数（最后一小节常被结尾截断，不算）与第一个重拍在普通拍里的位置。 */
function detectMeter(grid: BeatGrid): { meter: number; anchor: number } {
  const bars = barsOf(grid);
  const counts = new Map<number, number>();
  bars.slice(0, -1).forEach((b) => counts.set(b.beats, (counts.get(b.beats) ?? 0) + 1));
  let meter = 4;
  let best = 0;
  for (const [m, n] of counts) {
    if (m >= 1 && m <= 16 && n > best) {
      meter = m;
      best = n;
    }
  }
  const first = grid.downbeats.length > 0 ? lowerBound(grid.beats, grid.downbeats[0] - match) : 0;
  return { meter, anchor: Math.min(first % meter, Math.max(0, grid.beats.length - 1)) };
}

/** 与 beat.regrid 相同：从第 anchor 拍（从 0 数）起每 meter 拍一个重拍。 */
function regridDownbeats(beats: number[], meter: number, anchor: number): number[] {
  const out: number[] = [];
  for (let i = anchor; i < beats.length; i += meter) out.push(beats[i]);
  return out;
}

function sameTimes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= match);
}

function bpmOf(beats: number[]): number {
  if (beats.length < 2) return 0;
  const intervals: number[] = [];
  for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
  intervals.sort((a, b) => a - b);
  return 60 / intervals[Math.floor(intervals.length / 2)];
}

/** 解码整首音乐，算出每 1/200 秒的峰值，供画波形。 */
function useMusic(url: string | null) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setBuffer(null);
    setPeaks(null);
    setError('');
    if (!url) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`读取音乐失败（${response.status}）`);
        const data = await response.arrayBuffer();
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const decoded = await ctx.decodeAudioData(data);
        if (cancelled) return;
        const rate = 200;
        const bucket = Math.max(1, Math.floor(decoded.sampleRate / rate));
        const n = Math.ceil(decoded.length / bucket);
        const out = new Float32Array(n);
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
        let max = 0;
        for (let i = 0; i < n; i++) {
          let peak = 0;
          const end = Math.min(decoded.length, (i + 1) * bucket);
          for (const ch of channels) for (let j = i * bucket; j < end; j += 4) peak = Math.max(peak, Math.abs(ch[j]));
          out[i] = peak;
          max = Math.max(max, peak);
        }
        if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
        setBuffer(decoded);
        setPeaks(out);
      } catch (err) {
        if (!cancelled) setError((err as Error).message || '无法解码音乐');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  return { buffer, peaks, error };
}

/**
 * 播放器：音乐走 AudioBufferSourceNode，咔嗒按预览网格提前 0.15 秒排进同一个 AudioContext，
 * 两者共用一个时钟，不会像 <audio> 加 setTimeout 那样慢慢错开。
 */
function usePlayer(buffer: AudioBuffer | null, beats: number[], downbeats: number[], clicks: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startRef = useRef({ ctxTime: 0, offset: 0 });
  const [playing, setPlaying] = useState(false);
  const [pausedAt, setPausedAt] = useState(0);
  const timerRef = useRef<number | null>(null);
  const nextRef = useRef(0);
  const gridRef = useRef({ beats, downbeats, clicks });
  gridRef.current = { beats, downbeats, clicks };

  const now = useCallback((): number => {
    const ctx = ctxRef.current;
    if (!ctx || !sourceRef.current) return pausedAt;
    return ctx.currentTime - startRef.current.ctxTime + startRef.current.offset;
  }, [pausedAt]);

  const stopSource = () => {
    if (timerRef.current != null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    const src = sourceRef.current;
    sourceRef.current = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // 已经停了。
      }
    }
  };

  const blip = (ctx: AudioContext, at: number, down: boolean) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = down ? 1760 : 1100;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(down ? 0.55 : 0.3, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.07);
  };

  const play = useCallback(
    (from: number) => {
      if (!buffer) return;
      stopSource();
      const ctx = ctxRef.current ?? new AudioContext();
      ctxRef.current = ctx;
      void ctx.resume();
      const offset = Math.min(Math.max(0, from), buffer.duration - 0.01);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 0.8;
      src.connect(gain).connect(ctx.destination);
      const ctxTime = ctx.currentTime + 0.05;
      src.start(ctxTime, offset);
      sourceRef.current = src;
      startRef.current = { ctxTime, offset };
      nextRef.current = lowerBound(gridRef.current.beats, offset);
      src.onended = () => {
        if (sourceRef.current !== src) return;
        stopSource();
        setPausedAt(0);
        setPlaying(false);
      };
      timerRef.current = window.setInterval(() => {
        const { beats: bs, downbeats: ds, clicks: on } = gridRef.current;
        const t = ctx.currentTime - startRef.current.ctxTime + startRef.current.offset;
        while (nextRef.current < bs.length && bs[nextRef.current] < t + 0.15) {
          const b = bs[nextRef.current++];
          if (!on || b < t - 0.02) continue;
          const di = lowerBound(ds, b - match);
          blip(ctx, startRef.current.ctxTime + (b - startRef.current.offset), di < ds.length && Math.abs(ds[di] - b) <= match);
        }
      }, 25);
      setPlaying(true);
    },
    [buffer],
  );

  const pause = useCallback(() => {
    const t = now();
    stopSource();
    setPausedAt(t);
    setPlaying(false);
  }, [now]);

  const seek = useCallback(
    (t: number) => {
      if (playing) play(t);
      else setPausedAt(Math.max(0, t));
    },
    [play, playing],
  );

  useEffect(
    () => () => {
      stopSource();
      void ctxRef.current?.close();
    },
    [],
  );
  // 换了预览网格，咔嗒从当前位置重新排。
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx || !sourceRef.current) return;
    nextRef.current = lowerBound(beats, ctx.currentTime - startRef.current.ctxTime + startRef.current.offset + 0.15);
  }, [beats, downbeats]);

  return { playing, now, play, pause, seek, pausedAt };
}

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

function Lane(props: {
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
  const bars = useMemo(() => barsOf({ beats: props.beats, downbeats: props.downbeats, duration_seconds: props.duration }), [props.beats, props.downbeats, props.duration]);
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
        for (let i = Math.floor(ta * waveRate); i <= Math.min(p.length - 1, Math.floor(tb * waveRate)); i++) peak = Math.max(peak, p[i]);
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
  }, [bars, hasPlan, pps, props.beats, props.downbeats, props.meter, props.now, props.pausedAt, props.peaks, props.plan, props.playing]);

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
        if (hx > scroller.clientWidth * 0.8 || hx < 0) scroller.scrollLeft = Math.max(0, props.now() * pps - scroller.clientWidth * 0.2);
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

/** 大字数拍：当前是第几小节、第几拍，重拍那一格最大。眼睛跟着数，比只听咔嗒容易判断「1」是不是落在音乐的重音上。 */
function Counter({ beats, downbeats, now, playing, pausedAt, meter }: { beats: number[]; downbeats: number[]; now: () => number; playing: boolean; pausedAt: number; meter: number }) {
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
      setState((prev) => (prev.bar === di + 1 && prev.beat === beatInBar && Math.abs(prev.flash - flash) < 0.08 ? prev : { bar: di + 1, beat: beatInBar, flash }));
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
            className={'beat-cell' + (i === 0 ? ' down' : '') + (i === state.beat ? ' on' : '') + (i >= meter ? ' extra' : '')}
            style={i === state.beat ? { opacity: 0.55 + 0.45 * state.flash } : undefined}
          >
            {i + 1}
          </span>
        ))}
      </div>
    </div>
  );
}

const steps = ['导入音乐', '分析节拍', '试听确认', '分镜计划', '写入镜头'];

export function BeatTab(props: Props) {
  const b = props.beat;
  const grid = b?.grid ?? null;
  const music = b?.music_path ? rawURL(b.music_path) : null;
  const { buffer, peaks, error: musicError } = useMusic(music);
  const detected = useMemo(() => (grid ? detectMeter(grid) : { meter: 4, anchor: 0 }), [grid]);
  const [meter, setMeter] = useState(detected.meter);
  const [anchor, setAnchor] = useState(detected.anchor);
  const [clicks, setClicks] = useState(true);
  const [adjusting, setAdjusting] = useState(false);
  /** 只有动过拍号或起始拍才按预览算重拍；没动时照原网格显示（手改、拼接过的网格不一定是规整的 N 拍一小节）。 */
  const [touched, setTouched] = useState(false);
  const gridKey = grid ? `${grid.kind}:${grid.beats.length}:${grid.downbeats.join(',')}` : '';
  useEffect(() => {
    setMeter(detected.meter);
    setAnchor(detected.anchor);
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridKey]);

  const beats = grid?.beats ?? [];
  const saved = grid?.downbeats ?? [];
  const preview = useMemo(() => (beats.length > 0 ? regridDownbeats(beats, meter, Math.min(anchor, meter - 1)) : saved), [anchor, beats, meter, saved]);
  const changed = touched && grid !== null && !sameTimes(preview, saved);
  const downbeats = changed ? preview : saved;
  const duration = grid?.duration_seconds ?? b?.track?.duration_seconds ?? buffer?.duration ?? 0;
  const player = usePlayer(buffer, beats, downbeats, clicks);
  const bars = useMemo(() => barsOf({ beats, downbeats, duration_seconds: duration }), [beats, downbeats, duration]);
  const bpm = useMemo(() => bpmOf(beats), [beats]);
  const odd = bars.slice(0, -1).filter((bar) => bar.beats !== meter);
  const problems = changed ? [] : (b?.problems ?? []);
  const confirmed = grid?.kind === 'confirmed';
  const plan = confirmed && !changed ? (b?.plan ?? []) : [];
  const busy = props.busy !== '';

  // 空格播放 / 暂停；播放中按 T 表示「这一拍是重拍」，起始拍随之改。
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (player.playing) player.pause();
      else player.play(player.pausedAt);
    } else if (e.key === 't' || e.key === 'T') {
      tapDownbeat();
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const tapDownbeat = () => {
    if (beats.length === 0) return;
    const t = player.playing ? player.now() : player.pausedAt;
    // 人反应慢半拍：取离按下时刻最近的一拍，偏后 80 毫秒算作上一拍。
    const at = t - 0.08;
    let i = lowerBound(beats, at);
    if (i >= beats.length || (i > 0 && at - beats[i - 1] < beats[i] - at)) i -= 1;
    setAnchor(((Math.max(0, i) % meter) + meter) % meter);
    setTouched(true);
    setAdjusting(true);
  };

  const togglePlay = () => (player.playing ? player.pause() : player.play(player.pausedAt));

  const stage = !b?.track ? 0 : !grid ? 1 : grid.kind === 'draft' ? 2 : !b.plan ? 3 : 4;

  if (!b?.enabled) return <div className="beat-tab"><p className="beat-note">这个项目没有启用卡点模式。</p></div>;

  return (
    <div className="beat-tab">
      <header className="beat-head">
        <div className="beat-title-row">
          <h1 className="beat-title">节拍</h1>
          {grid && <span className={'beat-status ' + (confirmed && !changed ? 'ok' : 'pending')}>{changed ? '预览中，未写回' : confirmed ? '已确认' : '草稿，待确认'}</span>}
        </div>
        <ol className="beat-steps">
          {steps.map((label, i) => (
            <li key={label} className={i < stage ? 'done' : i === stage ? 'now' : ''}>
              <span>{String(i + 1).padStart(2, '0')}</span>
              {label}
            </li>
          ))}
        </ol>
        {b.track && (
          <div className="beat-stats">
            <span title="导入的音乐">{b.track.source}</span>
            <span>{clock(duration)}</span>
            {grid && (
              <>
                <span>{bars.length} 小节</span>
                <span>约 {bpm.toFixed(1)} BPM</span>
                <span>每小节 {meter} 拍</span>
                {downbeats.length > 0 && downbeats[0] > 0.05 && <span title="第一个重拍之前的部分，并进第一个镜头">弱起 {downbeats[0].toFixed(2)} 秒</span>}
                <span className="faint" title="分析模型">{grid.source}</span>
              </>
            )}
          </div>
        )}
      </header>

      {!b.track && (
        <section className="beat-empty">
          <p>还没有音乐。把音乐文件拖进对话框，或者直接说要用哪首。</p>
          <button className="primary" onClick={() => props.onQuick('导入这首音乐并分析节拍：', [], true)}>
            在对话里导入音乐
          </button>
        </section>
      )}
      {b.track && !grid && (
        <section className="beat-empty">
          <p>音乐已导入，还没有分析节拍。{b.grid_error && <span className="bad">{b.grid_error}</span>}</p>
          <button className="primary" disabled={busy} onClick={() => props.onQuick('分析这首音乐的节拍（am beat analyze），分析完带我去节拍页试听。', [])}>
            让它分析节拍
          </button>
        </section>
      )}
      {musicError && <p className="beat-note bad">波形读不出来：{musicError}</p>}

      {grid && (
        <>
          <section className="beat-player">
            <div className="beat-transport">
              <button className="primary play" onClick={togglePlay} disabled={!buffer} aria-label={player.playing ? '暂停' : '播放'} title="空格">
                {player.playing ? '❚❚' : '▶'}
              </button>
              <button className="link" onClick={() => player.seek(0)}>
                从头
              </button>
              <label className="beat-toggle">
                <input type="checkbox" checked={clicks} onChange={(e) => setClicks(e.target.checked)} />
                咔嗒声
              </label>
              <span className="beat-hint">{buffer ? '每拍一声，重拍更高。听「1」是不是落在音乐的重音上。' : '正在读取音乐…'}</span>
            </div>
            <Counter beats={beats} downbeats={downbeats} now={player.now} playing={player.playing} pausedAt={player.pausedAt} meter={meter} />
          </section>

          <Lane
            duration={duration}
            peaks={peaks}
            beats={beats}
            downbeats={downbeats}
            meter={meter}
            plan={plan}
            now={player.now}
            playing={player.playing}
            pausedAt={player.pausedAt}
            onSeek={player.seek}
            onScene={props.onScene}
          />

          {problems.length > 0 && (
            <ul className="beat-problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          {(!confirmed || changed || adjusting) ? (
            <section className="beat-fix">
              <div className="beat-fix-row">
                <span className="label">每小节</span>
                <div className="seg">
                  {meterChoices.map((m) => (
                    <button key={m} className={m === meter ? 'on' : ''} onClick={() => { setMeter(m); setAnchor((a) => Math.min(a, m - 1)); setTouched(true); }}>
                      {m} 拍
                    </button>
                  ))}
                </div>
              </div>
              <div className="beat-fix-row">
                <span className="label">重拍是</span>
                <div className="seg">
                  {Array.from({ length: meter }, (_, i) => (
                    <button key={i} className={i === anchor ? 'on' : ''} onClick={() => { setAnchor(i); setTouched(true); }}>
                      第 {i + 1} 拍
                    </button>
                  ))}
                </div>
                <button onClick={tapDownbeat} disabled={!player.playing} title="播放中，在你听到的重拍上按一下（或按 T 键）">
                  在重拍上敲一下 · T
                </button>
              </div>
              <p className="beat-note">
                {changed
                  ? `预览：${meter} 拍一小节，从第 ${anchor + 1} 拍起算重拍，共 ${preview.length} 小节。听对了再写回草稿。`
                  : odd.length > 0
                    ? `有 ${odd.length} 个小节不是 ${meter} 拍（波形上用黄色标出），多半是模型在那里漏了或多了重拍；整体错位时换「重拍是第几拍」，零星几处可以在对话里说是第几小节。`
                    : confirmed
                      ? '改网格会让已写好的镜头时长全部失效，要重跑 am beat cues 并重渲染。'
                      : '整体错位（「1」总落在第 2、3 拍上）就换「重拍是第几拍」；拍子数不对就换每小节几拍。'}
              </p>
              <div className="beat-actions">
                {changed ? (
                  <>
                    <button className="primary" disabled={busy} onClick={() => props.run('/api/commands/beat.regrid', { meter, anchor })}>
                      写回草稿
                    </button>
                    <button onClick={() => { setMeter(detected.meter); setAnchor(detected.anchor); setTouched(false); }}>还原</button>
                  </>
                ) : (
                  !confirmed && (
                    <button className="primary" disabled={busy || (b.problems ?? []).length > 0} onClick={() => props.run('/api/commands/beat.confirm')}>
                      听过了，确认网格
                    </button>
                  )
                )}
                <button onClick={() => props.onQuick(`节拍网格有问题：${player.pausedAt > 0 || player.playing ? `大约在 ${clock(player.playing ? player.now() : player.pausedAt)}（第 ${lowerBound(downbeats, (player.playing ? player.now() : player.pausedAt) + 0.001)} 小节）附近，` : ''}`, [], true)}>
                  在对话里说哪里不对
                </button>
                {confirmed && !changed && (
                  <button className="link" onClick={() => setAdjusting(false)}>
                    收起
                  </button>
                )}
              </div>
            </section>
          ) : (
            <section className="beat-fix compact">
              <p className="beat-note">
                网格已确认。{b.plan ? `分镜计划 ${b.plan.length} 个镜头，切点全部在重拍上。` : b.plan_error ? '' : '下一步按小节写分镜计划。'}
              </p>
              {b.plan_error && <p className="beat-note bad">分镜计划：{b.plan_error}</p>}
              <div className="beat-actions">
                {!b.plan && (
                  <button className="primary" disabled={busy} onClick={() => props.onQuick('节拍网格确认了，按小节写分镜计划（production/beat/plan.json），写好带我回节拍页看切点。', [])}>
                    按小节写分镜计划
                  </button>
                )}
                <button className="link" onClick={() => setAdjusting(true)}>
                  重新调整重拍
                </button>
              </div>
            </section>
          )}

          <section className="beat-bars" data-ctx-source={confirmed ? 'production/beat/grid.json' : 'production/beat/grid-draft.json'} data-ctx-label="节拍网格">
            {bars.map((bar, i) => {
              const seg = plan.find((s) => bar.number >= s.first_bar && bar.number < s.first_bar + s.bars);
              const segStart = seg && seg.first_bar === bar.number;
              const irregular = i < bars.length - 1 && bar.beats !== meter;
              return (
                <button
                  key={bar.number}
                  className={'beat-bar' + (irregular ? ' odd' : '') + (segStart ? ' cut' : '')}
                  onClick={() => player.seek(bar.start)}
                  title={`第 ${bar.number} 小节 ${clock(bar.start, 2)} – ${clock(bar.end, 2)}，${bar.beats} 拍${seg ? `，镜头 ${seg.id}` : ''}`}
                >
                  <span className="no">{bar.number}</span>
                  <span className="t">{clock(bar.start)}</span>
                  {irregular && <span className="n">{bar.beats}拍</span>}
                  {segStart && <span className="scene">{seg!.id}</span>}
                </button>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
