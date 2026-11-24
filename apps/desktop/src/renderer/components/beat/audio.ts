import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { claimAudioPlayback, releaseAudioPlayback } from '../../media';
import type { BeatState } from '../../types';
import { lowerBound, match } from './grid';

/** 解码整首音乐，算出每 1/200 秒的峰值，供画波形。 */
export function useMusic(url: string | null) {
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setBuffer(null);
    setPeaks(null);
    setError('');
    if (!url) return;
    let cancelled = false;
    void (async () => {
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
export function usePlayer(buffer: AudioBuffer | null, beats: number[], downbeats: number[], clicks: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const clickNodesRef = useRef(new Set<OscillatorNode>());
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
    // Windows 切到其他试听时，连同提前排好的节拍声一起停掉。
    if (window.onset?.platform === 'win32') {
      for (const click of clickNodesRef.current) click.stop();
      clickNodesRef.current.clear();
    }
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
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
    if (window.onset?.platform === 'win32') {
      clickNodesRef.current.add(osc);
      osc.onended = () => clickNodesRef.current.delete(osc);
    }
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
      claimAudioPlayback(ctx, () => {
        const t = ctx.currentTime - startRef.current.ctxTime + startRef.current.offset;
        stopSource();
        setPausedAt(Math.max(0, t));
        setPlaying(false);
      });
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
        releaseAudioPlayback(ctx);
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
          blip(
            ctx,
            startRef.current.ctxTime + (b - startRef.current.offset),
            di < ds.length && Math.abs(ds[di] - b) <= match,
          );
        }
      }, 25);
      setPlaying(true);
    },
    [buffer],
  );

  const pause = useCallback(() => {
    const t = now();
    if (ctxRef.current) releaseAudioPlayback(ctxRef.current);
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
      if (ctxRef.current) releaseAudioPlayback(ctxRef.current);
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

/** 读 /api/beat（卡点插件登记的接口）；version 变了重读。读不到（项目没开卡点、接口不在）时为 null。 */
export function useBeatState(version: number): BeatState | null {
  const [beat, setBeat] = useState<BeatState | null>(null);
  useEffect(() => {
    let live = true;
    api<BeatState>('/api/beat')
      .then((b) => live && setBeat(b))
      .catch(() => live && setBeat(null));
    return () => {
      live = false;
    };
  }, [version]);
  return beat;
}
