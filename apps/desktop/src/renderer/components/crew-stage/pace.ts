import { useEffect, useRef, useState } from 'react';

export type StageKind = 'render' | 'media' | 'voice' | 'align' | 'carry';
export type StageState = 'ready' | 'missing' | 'waiting' | 'working' | 'failed' | 'paused';

/**
 * 赶路的速度。rate 是动画用的快慢（大约「每秒涨几个百分点」那一档：0.3 以下慢慢走，1.5 以上跑），
 * 没有样本时为 null；stalled 是好一会儿没有动静；bytesRate 是按字节量到的下载速度（字节/秒），
 * creep 为真时这一步没有百分比（只知道下了多少字节），人的位置不按速度往前推。
 */
export interface Pace {
  rate: number | null;
  stalled: boolean;
  bytesRate?: number | null;
  creep?: boolean;
}

/** 按字节的下载速度换成动画的快慢：0.2 MB/s 以下慢慢走，1–2 MB/s 快步，2 MB/s 以上跑。 */
function bytesToRate(perSecond: number): number {
  const mb = perSecond / 1_048_576;
  return mb < 0.2 ? mb * 1.5 : Math.min(3, 0.3 + mb * 0.6);
}

/**
 * 按进度（百分比或字节数）的变化算速度：只看最近 8 秒。quiet 是后端说的「多少秒没有动静」，
 * 有它时 15 秒没动静算停住；没有时（演示页）按本地看到的最后一次变化：百分比 4 秒、字节 15 秒。
 * active 为假时清空。
 */
export function usePace(value: number, active: boolean, unit: 'percent' | 'bytes' = 'percent', quiet?: number): Pace {
  const samples = useRef<{ at: number; v: number; unit: string }[]>([]);
  const [, setTick] = useState(0);
  // 停住要靠时间流逝才判断得出来：在路上时每秒看一次。
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active) {
    if (samples.current.length) samples.current = [];
    return { rate: null, stalled: false };
  }
  // 换了一种量法（上一步有百分比、这一步只有字节）就重新量。
  if (samples.current.length && samples.current[0].unit !== unit) samples.current = [];
  const list = samples.current;
  const t = performance.now();
  if (list.length === 0 || list[list.length - 1].v !== value) list.push({ at: t, v: value, unit });
  while (list.length > 2 && t - list[1].at > 8000) list.shift();
  const last = list[list.length - 1];
  const stalled = quiet !== undefined ? quiet >= 15 : t - last.at > (unit === 'bytes' ? 15000 : 4000);
  const creep = unit === 'bytes';
  if (list.length < 2) return { rate: null, stalled, creep, bytesRate: null };
  const first = list[0];
  const span = (last.at - first.at) / 1000;
  if (span <= 0) return { rate: null, stalled, creep, bytesRate: null };
  const perSecond = (last.v - first.v) / span;
  if (unit === 'bytes') return { rate: bytesToRate(perSecond), stalled, creep, bytesRate: perSecond };
  return { rate: perSecond, stalled, creep };
}

/** 给人看的速度：接在「在路上」后面。 */
export function paceWord(pace: Pace): string {
  if (pace.stalled) return '等网络';
  if (pace.rate === null) return '';
  if (pace.rate < 0.3) return '慢慢走';
  if (pace.rate < 1.5) return '快步赶路';
  return '一路小跑';
}

/** 组的 key 对应哪种小景；不认识的（插件登记的「以后可能用到」）都是搬运工。 */
export function stageKind(key: string): StageKind {
  return key === 'render' || key === 'media' || key === 'voice' || key === 'align' ? key : 'carry';
}
