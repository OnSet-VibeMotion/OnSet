import { useEffect, useRef, useState } from 'react';
import { rawURL } from '../api';
import type { ExamCell } from '../types';
import '../exam-comparison.css';

export function ExamPlayer({ control, trial, labels, version, descriptions = {} }: {
  control: ExamCell | null; trial: ExamCell | null; labels: Record<string, string>; version: number; descriptions?: Record<string, string>;
}) {
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const master = useRef<HTMLVideoElement | null>(null);
  const paired = useRef(false);
  const audioURL = useRef('');
  const pendingAudioTime = useRef(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const videoURL = (cell: ExamCell | null) => cell?.preview_video ? `${cell.preview_video.url}&v=${version}` : cell?.output ? rawURL(cell.output, version) : '';
  const hasVideo = !!(videoURL(control) || videoURL(trial));
  const videos = () => [left.current, right.current].filter((v): v is HTMLVideoElement => v !== null);
  useEffect(() => {
    const player = audio.current;
    return () => { player?.pause(); };
  }, []);
  const pause = () => {
    paired.current = false;
    audio.current?.pause();
    videos().forEach((v) => { if (!v.paused) v.pause(); });
    setPlaying(false);
  };
  const syncAudio = (video: HTMLVideoElement, play: boolean, force = false) => {
    const player = audio.current;
    const reference = (video === left.current ? control : trial)?.preview_audio;
    if (!player || !reference || !reference.path && !reference.url) { player?.pause(); return; }
    const url = reference.url ? `${reference.url}&v=${version}` : rawURL(reference.path!, version);
    const changed = audioURL.current !== url;
    pendingAudioTime.current = reference.start_seconds + video.currentTime;
    if (changed) { player.pause(); player.src = url; audioURL.current = url; }
    if (Number.isFinite(player.duration) && pendingAudioTime.current >= player.duration) { player.pause(); return; }
    if (force || changed || Math.abs(player.currentTime - pendingAudioTime.current) > 0.2) player.currentTime = pendingAudioTime.current;
    player.playbackRate = video.playbackRate;
    if (play && player.paused) void player.play().catch((err) => {
      if (err?.name !== 'AbortError') setError('口播暂时无法播放，请检查配音文件后重试。');
    });
    if (!play) player.pause();
  };
  const startSide = (video: HTMLVideoElement) => {
    // play 与 pause 都异步派发；切换单侧时忽略已暂停一侧迟到的 play 事件。
    if (video.paused) return;
    if (!paired.current) {
      master.current = video;
      for (const other of videos()) if (other !== video) other.pause();
    }
    if (master.current === video) syncAudio(video, true, true);
    setPlaying(true);
  };
  const stopSide = (video: HTMLVideoElement) => {
    if (!video.paused) return;
    // 新一侧的 play() 已开始，但它的 play 事件可能还排在旧一侧的 pause 后面。
    // 单侧模式下以实际播放状态接棒，不能让旧主播放器的迟到事件停掉新的一侧。
    const next = !paired.current && videos().find(v => v !== video && !v.paused);
    if (next) { master.current = next; syncAudio(next, true, true); setPlaying(true); return; }
    if (master.current === video || paired.current && !video.ended) pause();
  };
  const updateTime = (video: HTMLVideoElement) => {
    if (master.current && master.current !== video) return;
    setAt(video.currentTime);
    if (!video.paused) syncAudio(video, true);
  };
  const seeking = (video: HTMLVideoElement) => {
    if (master.current !== video) return;
    if (paired.current) for (const other of videos()) {
      if (other !== video && Number.isFinite(other.duration) && Math.abs(other.currentTime - video.currentTime) > 0.15) other.currentTime = Math.min(video.currentTime, other.duration);
    }
    syncAudio(video, !video.paused, true);
    setAt(video.currentTime);
  };
  const updateDuration = () => setDuration(Math.max(0, ...videos().map((v) => Number.isFinite(v.duration) ? v.duration : 0)));
  const seek = (time: number) => {
    pause();
    for (const v of videos()) {
      v.pause();
      if (Number.isFinite(v.duration)) v.currentTime = Math.min(time, v.duration);
    }
    setAt(time);
    if (master.current) syncAudio(master.current, false, true);
  };
  const toggle = async () => {
    if (videos().some((v) => !v.paused)) { pause(); return; }
    setError('');
    const usable = videos().filter((v) => !v.error);
    paired.current = true;
    master.current = usable.find((v) => (v === left.current ? control : trial)?.preview_audio) ?? usable[0] ?? null;
    const time = usable.some((v) => v.ended) ? 0 : at;
    for (const v of usable) if (Number.isFinite(v.duration)) v.currentTime = Math.min(time, v.duration);
    const results = await Promise.allSettled(usable.map((v) => v.play()));
    const active = master.current && !master.current.paused ? master.current : usable.find((v) => !v.paused);
    if (active) { master.current = active; syncAudio(active, true, true); }
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
      {cell && videoURL(cell) ? <>
        <video ref={ref} src={videoURL(cell)} preload="metadata" controls muted playsInline
          onLoadedMetadata={updateDuration} onDurationChange={updateDuration}
          onTimeUpdate={(e) => updateTime(e.currentTarget)}
          onPlay={(e) => startSide(e.currentTarget)}
          onPlaying={(e) => { if (master.current === e.currentTarget) syncAudio(e.currentTarget, true, true); }}
          onSeeking={(e) => seeking(e.currentTarget)}
          onWaiting={(e) => { if (master.current === e.currentTarget) audio.current?.pause(); }}
          onRateChange={(e) => { if (master.current === e.currentTarget && audio.current) audio.current.playbackRate = e.currentTarget.playbackRate; }}
          onPause={(e) => stopSide(e.currentTarget)}
          onEnded={(e) => { if (e.currentTarget.ended && master.current === e.currentTarget) { pause(); paired.current = false; } }}
          onError={() => setFailed((old) => ({ ...old, [arm]: true }))} />
        {failed[arm] && <p className="exam-media-error" role="status">这段视频暂时无法解码或载入，检查结果仍列在下方。</p>}
        {!cell.preview_audio && cell.audio_unavailable && <p className="small muted">{cell.audio_unavailable}</p>}
        <button className="link small" onClick={() => { void ref.current?.requestFullscreen().catch(() => setError('无法进入全屏，可使用播放器的全屏按钮。')); }}>放大{arm === 'control' ? '对照' : '试用'}画面</button>
      </> : <div className="evidence-novideo">{cell ? '这段考试视频暂时不可用，请检查来源项目和视频文件是否仍在。' : '没有这一组的结果'}</div>}
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
    <audio ref={audio} preload="auto" muted={muted}
      onLoadedMetadata={() => { if (audio.current) audio.current.currentTime = pendingAudioTime.current; }}
      onError={() => setError('口播文件无法载入，画面仍可继续预览。')} />
    {hasVideo && <div className="evidence-controls">
      <button className="primary" onClick={() => void toggle()}>{playing ? '暂停' : '两边一起播放'}</button>
      <button onClick={() => seek(0)}>回到开头</button>
      <label className="exam-seek"><span>同一时间</span><input aria-label="对照视频时间" type="range" min={0} max={duration || 1} step="0.05" value={Math.min(at, duration || 1)} disabled={!duration} onChange={(e) => seek(Number(e.currentTarget.value))} /></label>
      <span className="small muted">{at.toFixed(1)} / {duration.toFixed(1)} 秒</span>
    </div>}
    {(control?.preview_audio || trial?.preview_audio) ? <div className="exam-audio-controls">
      <button aria-pressed={!muted} onClick={() => setMuted(!muted)}>{muted ? '配音已静音' : '配音已开启'}</button>
      <label>音量 <input aria-label="配音音量" type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => { const value = Number(e.currentTarget.value); setVolume(value); if (audio.current) audio.current.volume = value; }} /></label>
      <span className="small muted">{(control?.preview_audio || trial?.preview_audio)?.source_project ? `配音：${(control?.preview_audio || trial?.preview_audio)?.source_project}` : '叠加项目口播预览'} · 两边同时播放只放一份声音</span>
    </div> : hasVideo && <p className="small muted" role="status">{control?.audio_unavailable || trial?.audio_unavailable || '此题尚未提供可匹配的口播，当前仅有画面预览。'}</p>}
    {error && <p role="status">{error}</p>}
    <div className="evidence-sides">{side(control, 'control', left)}{side(trial, 'trial', right)}</div>
  </div>;
}
