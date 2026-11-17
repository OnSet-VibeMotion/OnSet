import { useEffect, useRef, useState } from 'react';
import { rawURL } from '../api';
import type { AuditionContestant } from '../types';
import { Icon } from './Icon';

interface Props {
  contestants: AuditionContestant[];
  version: number;
  labelFor: (c: AuditionContestant) => string;
  onPick?: (slot: string) => void;
}

/** 所有已有画面默认同屏，时间轴统一；制作过程在画面之外，不挤占比较空间。 */
export function AuditionCompare({ contestants, version, labelFor, onPick }: Props) {
  const root = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const available = contestants.filter(c => c.output);
  const position = useRef(0);
  useEffect(() => {
    if (expanded) root.current?.querySelector<HTMLButtonElement>('[data-expand]')?.focus();
  }, [expanded]);
  if (!available.length) return null;
  return <section ref={root} className={'audition-compare' + (expanded ? ' expanded' : '')}
    role={expanded ? 'dialog' : 'region'} aria-modal={expanded || undefined} aria-label="画面对比"
    onKeyDownCapture={e => {
      if (!expanded) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setExpanded(false); }
      if (e.key === 'Tab') {
        const controls = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input:not(:disabled)') ?? [])].filter(el => el.getClientRects().length);
        const first = controls[0], last = controls[controls.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    <ComparisonPlayer key={JSON.stringify([version, available.map(c => c.output)])} available={available}
      initialTime={position.current} onTime={t => { position.current = t; }}
      version={version} labelFor={labelFor} onPick={onPick} expanded={expanded} onExpand={() => setExpanded(value => !value)} />
  </section>;
}

function ComparisonPlayer({ available, initialTime, onTime, version, labelFor, onPick, expanded, onExpand }: {
  available: AuditionContestant[];
  initialTime: number;
  onTime: (time: number) => void;
  expanded: boolean;
  onExpand: () => void;
} & Pick<Props, 'version' | 'labelFor' | 'onPick'>) {
  const videos = useRef(new Map<number, HTMLVideoElement>());
  const pending = useRef(0);
  const master = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const [time, setTime] = useState(initialTime);
  const [duration, setDuration] = useState(0);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  const [ready, setReady] = useState<number[]>([]);
  const [failed, setFailed] = useState<number[]>([]);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const all = () => [...videos.current.values()];
  const playable = () => [...videos.current.entries()].filter(([side]) => !failed.includes(side)).map(([, video]) => video);
  useEffect(() => {
    const elements = videos.current;
    return () => {
      pending.current++;
      for (const video of elements.values()) if (!video.paused) video.pause();
    };
  }, []);
  const pause = () => {
    pending.current++;
    for (const video of all()) if (!video.paused) video.pause();
    setPlaying(false);
    setStarting(false);
  };
  const remember = (t: number) => { setTime(t); onTime(t); };
  const seek = (t: number) => {
    pause();
    for (const video of all()) if (Number.isFinite(video.duration)) video.currentTime = Math.min(t, video.duration);
    remember(t);
  };
  const toggle = async () => {
    if (playing || starting) { pause(); return; }
    const elements = playable();
    if (!elements.length) return;
    const request = ++pending.current;
    setStarting(true);
    setError('');
    const at = time >= duration - 0.01 ? 0 : time;
    // 较长的一份提供时钟；较短的一份停在末帧，不能提前把整个对比停掉。
    master.current = elements.reduce((longest, v) => v.duration > longest.duration ? v : longest);
    for (const video of elements) {
      video.currentTime = Math.min(at, video.duration);
      video.playbackRate = speed;
    }
    const results = await Promise.allSettled(elements.map(v => at < v.duration ? v.play() : Promise.resolve()));
    // 旧 play() 的结果可能晚于暂停或下一次播放；不能把新一轮播放也停掉。
    if (request !== pending.current) return;
    setStarting(false);
    if (results.some(r => r.status === 'rejected')) {
      pause();
      setError('有画面无法播放，已暂停播放。请检查视频文件后重试。');
    } else setPlaying(true);
  };
  const update = (video: HTMLVideoElement) => {
    if (master.current !== video || video.paused) return;
    remember(video.currentTime);
    for (const other of playable()) if (other !== video && !other.ended && Math.abs(other.currentTime - video.currentTime) > 0.1) {
      other.currentTime = Math.min(video.currentTime, other.duration);
    }
  };
  const metadata = (video: HTMLVideoElement) => {
    if (Number.isFinite(video.duration)) video.currentTime = Math.min(initialTime, video.duration);
    const max = Math.max(0, ...all().map(v => Number.isFinite(v.duration) ? v.duration : 0));
    setDuration(max);
    const ratios = all().filter(v => v.videoWidth && v.videoHeight).map(v => v.videoWidth / v.videoHeight);
    if (ratios.length) setAspectRatio(Math.max(...ratios));
  };
  const loaded = available.every((_, i) => ready.includes(i) || failed.includes(i)) && failed.length < available.length;

  return <>
    <header className="audition-compare-head">
      <div><h3>画面对比 <span className="audition-count">{available.length} 份</span></h3><p>全部画面同步播放，暂停比较同一瞬间</p></div>
      <div className="audition-actions">
        {focus !== null && <button onClick={() => setFocus(null)}>返回全部画面</button>}
        <button className="ghost" data-expand onClick={onExpand}>{expanded ? '收起对比' : '铺满窗口'}</button>
      </div>
    </header>
    <div className={'audition-screens count-' + available.length + (focus !== null || available.length === 1 ? ' single' : '')}>
      {available.map((c, side) => <figure key={c.slot} className="audition-screen" data-slot={c.slot} hidden={focus !== null && focus !== side}>
        <figcaption>
          <strong className="audition-screen-label" title={labelFor(c)}>{labelFor(c)}</strong>
          <button className="ghost small" onClick={() => setFocus(focus === side ? null : side)}>{focus === side ? '缩回对比' : `放大 ${c.slot}`}</button>
          {onPick && c.role !== 'reference' && <button className="ghost small audition-pick" aria-label={`选 ${c.slot} 为最佳`} onClick={() => onPick(c.slot)}>选它</button>}
        </figcaption>
        <div className="audition-screen-media" style={{ aspectRatio }}>
          <video aria-label={`选手 ${c.slot} 的画面`} ref={el => { if (el) videos.current.set(side, el); else videos.current.delete(side); }}
            src={rawURL(c.output!, version)} preload="auto" muted playsInline
            onLoadedMetadata={e => metadata(e.currentTarget)}
            onLoadedData={() => setReady(old => old.includes(side) ? old : [...old, side])}
            onTimeUpdate={e => update(e.currentTarget)}
            onEnded={e => { if (e.currentTarget === master.current) { remember(e.currentTarget.duration); pause(); } }}
            onError={() => { pause(); setFailed(old => old.includes(side) ? old : [...old, side]); }} />
          {failed.includes(side) && <p className="audition-media-error" role="alert">{c.slot} 的视频无法载入，请检查文件是否仍在或更换一份画面。</p>}
        </div>
        {c.outcome !== 'succeeded' && <span className="muted small">尚未通过验收</span>}
      </figure>)}
    </div>
    <div className="audition-transport">
      <button className="primary" disabled={!loaded} onClick={() => void toggle()} aria-label={playing || starting ? '暂停' : available.length > 1 ? '一起播放' : '播放'}>
        <Icon name={playing || starting ? 'pause' : 'play'} size={14} /> {playing || starting ? '暂停' : available.length > 1 ? '一起播放' : '播放'}
      </button>
      <button className="ghost" disabled={!loaded} onClick={() => seek(0)}>回到开头</button>
      <input className="scrub" type="range" min={0} max={duration || 1} step="0.01" value={Math.min(time, duration || 1)}
        disabled={!loaded} aria-label="对比播放位置" onChange={e => seek(Number(e.currentTarget.value))} />
      <span className="mono small muted">{Math.min(time, duration).toFixed(2)} / {duration.toFixed(2)} 秒</span>
      <select aria-label="对比播放速度" value={speed} onChange={e => {
        const next = Number(e.currentTarget.value); setSpeed(next); for (const v of all()) v.playbackRate = next;
      }}><option value={0.5}>0.5× 慢放</option><option value={1}>1× 正常</option><option value={2}>2× 快放</option></select>
    </div>
    {available.length === 1 && <p className="audition-progress-note">还需要另一份画面才能对比。</p>}
    {error && <p className="error-line" role="alert">{error}</p>}
  </>;
}
