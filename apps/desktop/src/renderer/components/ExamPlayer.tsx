import { useRef, useState } from 'react';
import { rawURL } from '../api';
import type { ExamCell } from '../types';
import '../exam-comparison.css';

export function ExamPlayer({ control, trial, labels, version, descriptions = {} }: {
  control: ExamCell | null; trial: ExamCell | null; labels: Record<string, string>; version: number; descriptions?: Record<string, string>;
}) {
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const videos = () => [left.current, right.current].filter((v): v is HTMLVideoElement => v !== null);
  const updateDuration = () => setDuration(Math.max(0, ...videos().map((v) => Number.isFinite(v.duration) ? v.duration : 0)));
  const seek = (time: number) => {
    for (const v of videos()) {
      v.pause();
      if (Number.isFinite(v.duration)) v.currentTime = Math.min(time, v.duration);
    }
    setAt(time);
    setPlaying(false);
  };
  const toggle = async () => {
    if (videos().some((v) => !v.paused)) { videos().forEach((v) => v.pause()); setPlaying(false); return; }
    setError('');
    const usable = videos().filter((v) => !v.error);
    const time = usable.some((v) => v.ended) ? 0 : at;
    for (const v of usable) if (Number.isFinite(v.duration)) v.currentTime = Math.min(time, v.duration);
    const results = await Promise.allSettled(usable.map((v) => v.play()));
    setPlaying(results.some((r) => r.status === 'fulfilled'));
    if (results.length === 0 || results.every((r) => r.status === 'rejected')) setError('画面未能播放，请查看下方提示，或用单侧播放器打开。');
  };
  const side = (cell: ExamCell | null, arm: 'control' | 'trial', ref: React.RefObject<HTMLVideoElement | null>) => {
    const counts = new Map<string, number>();
    for (const check of cell?.checks ?? []) counts.set(check, (counts.get(check) ?? 0) + 1);
    return <figure className={'evidence-side ' + arm}>
      <figcaption>
        <span>{arm === 'control' ? '对照组 · 不带待考经验' : '试用组 · 带上待考经验'}</span>
        <strong className={cell?.passed ? 'ok' : 'bad'}>{!cell ? '缺少结果' : cell.invalid ? '本次执行无效' : cell.incomplete ? '检查依据不完整' : cell.passed ? '没有查出问题' : `查出 ${cell.problems} 处问题`}</strong>
      </figcaption>
      {cell?.output ? <>
        <video ref={ref} src={rawURL(cell.output, version)} preload="metadata" controls muted playsInline
          onLoadedMetadata={updateDuration} onDurationChange={updateDuration}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)} onPause={() => { if (videos().every((v) => v.paused)) setPlaying(false); }}
          onEnded={() => { if (videos().every((v) => v.paused)) setPlaying(false); }}
          onError={() => setFailed((old) => ({ ...old, [arm]: true }))} />
        {failed[arm] && <p className="exam-media-error" role="status">这段视频暂时无法解码或载入，检查结果仍列在下方。</p>}
        <button className="link small" onClick={() => { void ref.current?.requestFullscreen().catch(() => setError('无法进入全屏，可使用播放器的全屏按钮。')); }}>放大{arm === 'control' ? '对照' : '试用'}画面</button>
      </> : <div className="evidence-novideo">{cell ? '当前项目找不到这段视频。请打开做这场考试的项目查看。' : '没有这一组的结果'}</div>}
      {cell?.invalid && <p className="exam-media-error">{cell.error || '执行未完成，不参与效果判断。'}</p>}
      {!!counts.size && !cell?.incomplete && <ul>{[...counts].map(([id, count]) => <li key={id}>{labels[id] ?? id}{count > 1 ? ` · ${count} 处` : ''}</li>)}</ul>}
      {cell && <details>
        <summary>第 {cell.repeat} 次 · {cell.invalid ? '执行无效' : cell.incomplete ? '检查依据不完整' : cell.passed ? '检查通过' : '查看问题'}</summary>
        {(cell.problem_texts ?? []).map((text, i) => <p key={i}>{text}</p>)}
        <p>实际带入：{(cell.recalled ?? []).map((name) => descriptions[name] || name).join('、') || '无'}</p>
        <p className="small muted">{cell.model || '模型未记录'} · 用时 {Math.round(cell.seconds)} 秒</p>
      </details>}
    </figure>;
  };
  return <div className="exam-player evidence-player">
    {(control?.output || trial?.output) && <div className="evidence-controls">
      <button className="primary" onClick={() => void toggle()}>{playing ? '暂停' : '两边一起播放'}</button>
      <button onClick={() => seek(0)}>回到开头</button>
      <label className="exam-seek"><span>同一时间</span><input aria-label="对照视频时间" type="range" min={0} max={duration || 1} step="0.05" value={Math.min(at, duration || 1)} disabled={!duration} onChange={(e) => seek(Number(e.currentTarget.value))} /></label>
      <span className="small muted">{at.toFixed(1)} / {duration.toFixed(1)} 秒</span>
    </div>}
    {error && <p role="status">{error}</p>}
    <div className="evidence-sides">{side(control, 'control', left)}{side(trial, 'trial', right)}</div>
  </div>;
}
