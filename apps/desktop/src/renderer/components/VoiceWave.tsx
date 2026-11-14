import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { align, analyze, currentToken, tokenize, type Token, type Wave } from '../voiceTiming';

/**
 * 音色页的波形与跟读：一段参考音频画成波形，文字稿按估出的时间逐字点亮。
 * 一页共用一个隐藏的 <audio>（useVoicePlayer），同一时间只有一段在放，波形和文字都跟着它走；
 * 点波形或点某个字都从那里开始放。
 */

const waves = new Map<string, Promise<Wave>>();

function loadWave(url: string): Promise<Wave> {
  let job = waves.get(url);
  if (!job) {
    job = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`读取音频失败（${response.status}）`);
      const ctx = new OfflineAudioContext(1, 1, 24000);
      return analyze(await ctx.decodeAudioData(await response.arrayBuffer()));
    })();
    job.catch(() => waves.delete(url));
    waves.set(url, job);
    // 录音、试听草稿每段一个 blob 地址，只留最近的一些。
    if (waves.size > 40) waves.delete(waves.keys().next().value as string);
  }
  return job;
}

export function useWave(url: string | null): {
  wave: Wave | null;
  failed: boolean;
} {
  const [state, setState] = useState<{
    url: string | null;
    wave: Wave | null;
    failed: boolean;
  }>({ url: null, wave: null, failed: false });
  useEffect(() => {
    if (!url) return;
    let live = true;
    loadWave(url).then(
      (wave) => live && setState({ url, wave, failed: false }),
      () => live && setState({ url, wave: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state.url === url ? state : { wave: null, failed: false };
}

export interface VoicePlayer {
  audio: ReactNode;
  /** 正在放（或停在中途）的是哪一段。 */
  current: string;
  playing: boolean;
  time: number;
  toggle: (id: string, url: string) => void;
  seek: (id: string, url: string, time: number) => void;
  /** 停下并放下这一段（重录、删掉之前）。 */
  stop: () => void;
}

/** 一页共用的播放器：状态全由 <audio> 自己的事件定，别处把它暂停了按钮也跟着变。 */
export function useVoicePlayer(): VoicePlayer {
  const ref = useRef<HTMLAudioElement>(null);
  const [current, setCurrent] = useState('');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (ref.current) setTime(ref.current.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const start = (id: string, url: string, at: number) => {
    const el = ref.current;
    if (!el) return;
    el.src = url;
    el.currentTime = at;
    setCurrent(id);
    setTime(at);
    void el.play().catch(() => setPlaying(false));
  };

  const toggle = (id: string, url: string) => {
    const el = ref.current;
    if (!el) return;
    if (current !== id) return start(id, url, 0);
    if (!el.paused) return el.pause();
    if (el.ended) el.currentTime = 0;
    void el.play().catch(() => setPlaying(false));
  };

  const seek = (id: string, url: string, at: number) => {
    const el = ref.current;
    if (!el) return;
    if (current !== id) return start(id, url, at);
    el.currentTime = at;
    setTime(at);
    if (el.paused) void el.play().catch(() => setPlaying(false));
  };

  const stop = () => {
    ref.current?.pause();
    setCurrent('');
    setTime(0);
  };

  const audio = (
    <audio
      ref={ref}
      hidden
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={(e) => {
        setPlaying(false);
        setTime(e.currentTarget.duration);
      }}
      onSeeked={(e) => setTime(e.currentTarget.currentTime)}
    />
  );
  return { audio, current, playing, time, toggle, seek, stop };
}

function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

/** 把 240 个峰值并成 n 根柱子（每根取最大）。 */
function resample(peaks: Float32Array, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * peaks.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / n));
    let max = 0;
    for (let j = a; j < b; j++) max = Math.max(max, peaks[j]);
    out.push(max);
  }
  return out;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** 一排柱子：levels 是 0–1，played 之前的柱子用强调色。 */
export function Bars({ levels, played = -1, height }: { levels: number[] | null; played?: number; height: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const step = 4;
  const n = Math.max(1, Math.floor(width / step));
  const bars = levels ? (levels.length === n ? levels : resample(Float32Array.from(levels), n)) : null;
  return (
    <div ref={ref} className="voice-bars" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} aria-hidden>
          {Array.from({ length: n }, (_, i) => {
            const level = bars ? bars[i] : 0.08 + 0.06 * Math.abs(Math.sin(i * 0.7));
            const h = Math.max(2, Math.round(Math.pow(level, 0.7) * (height - 2)));
            return <rect key={i} className={!bars ? 'bar idle' : i < played * n ? 'bar played' : 'bar'} x={i * step} y={(height - h) / 2} width={step - 1.5} height={h} rx={1} />;
          })}
        </svg>
      )}
    </div>
  );
}

interface TrackProps {
  id: string;
  url: string;
  text: string;
  player: VoicePlayer;
  /** 波形高度。 */
  height?: number;
  /** 不显示文字，只要波形（文字另放在别处时）。 */
  textless?: boolean;
  className?: string;
}

/** 波形 + 跟读文字。 */
export function VoiceTrack({ id, url, text, player, height = 44, textless, className }: TrackProps) {
  const { wave, failed } = useWave(url);
  const tokens = useMemo(() => (wave ? align(text, wave) : tokenize(text)), [wave, text]);
  const active = player.current === id;
  const time = active ? player.time : 0;
  const duration = wave?.duration ?? 0;
  const progress = active && duration > 0 ? Math.min(1, time / duration) : -1;
  const seekTo = (t: number) => player.seek(id, url, Math.max(0, Math.min(duration - 0.05, t)));

  const onKey = (e: KeyboardEvent) => {
    if (!duration) return;
    if (e.key === 'ArrowRight') seekTo(time + 1);
    else if (e.key === 'ArrowLeft') seekTo(time - 1);
    else if (e.key === ' ' || e.key === 'Enter') player.toggle(id, url);
    else return;
    e.preventDefault();
  };

  return (
    <div className={['voice-track', active ? 'is-active' : '', active && player.playing ? 'is-playing' : '', className ?? ''].filter(Boolean).join(' ')}>
      <div className="voice-wave-row">
        <div
          className="voice-wave"
          role="slider"
          tabIndex={0}
          aria-label="播放位置"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 10) / 10}
          aria-valuenow={Math.round(time * 10) / 10}
          onKeyDown={onKey}
          onClick={(e) => {
            if (!duration) return;
            const box = e.currentTarget.getBoundingClientRect();
            seekTo(((e.clientX - box.left) / box.width) * duration);
          }}
        >
          <Bars levels={wave ? Array.from(wave.peaks) : null} played={progress} height={height} />
          {progress >= 0 && <span className="voice-head" style={{ left: `${progress * 100}%` }} />}
        </div>
        <span className="voice-clock">{failed ? '读不出波形' : duration ? (active ? `${clock(time)} / ${clock(duration)}` : clock(duration)) : '…'}</span>
      </div>
      {!textless && <ReadAlong tokens={tokens} time={active ? time : -1} onSeek={wave ? (t) => seekTo(t) : undefined} />}
    </div>
  );
}

/** 跟读文字：念过的字压暗、正在念的字点亮；点某个字从那里开始放。time 为 -1 表示没在放这一段。 */
export function ReadAlong({ tokens, time, onSeek }: { tokens: Token[]; time: number; onSeek?: (time: number) => void }) {
  const now = time < 0 ? -1 : currentToken(tokens, time);
  return (
    <p className={time < 0 ? 'voice-read' : 'voice-read is-reading'}>
      {tokens.map((t, i) => {
        // 标点跟着前一个字：前一个字念完它就算读过。
        const state = time < 0 ? '' : i === now ? 'now' : time >= t.end && (t.weight > 0 || t.end > 0) ? 'said' : '';
        if (t.weight === 0)
          return (
            <span key={i} className={state ? `mark ${state}` : 'mark'}>
              {t.text}
            </span>
          );
        return (
          <span key={i} className={state ? `w ${state}` : 'w'} onClick={onSeek ? () => onSeek(t.start) : undefined}>
            {t.text}
          </span>
        );
      })}
    </p>
  );
}

/** 录音时的实时电平：从麦克风流里每 50 毫秒取一次响度，从右往左滚。 */
export function useLiveLevels(stream: MediaStream | null, count = 160): number[] {
  const [levels, setLevels] = useState<number[]>(() => new Array(count).fill(0));
  useEffect(() => {
    if (!stream) return;
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    setLevels(new Array(count).fill(0));
    const id = window.setInterval(() => {
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      // 说话的峰值多在 0.05–0.5，开方后拉开一点。
      const level = Math.min(1, Math.sqrt(peak * 2));
      setLevels((old) => [...old.slice(1), level]);
    }, 50);
    return () => {
      window.clearInterval(id);
      source.disconnect();
      void ctx.close();
    };
  }, [stream, count]);
  return levels;
}
