import type { MemoryEvent, MemoryState, MemoryStatus, RunStats } from '../../types';

export type Labels = MemoryState['labels'];

export const label = (table: Record<string, string> | undefined, id: string) => table?.[id] ?? id;

export const checkText = (labels: Labels, ids: readonly string[] | null | undefined) =>
  [...new Set(ids ?? [])].map((id) => label(labels?.checks, id)).join('、');

export function describe(event: MemoryEvent, labels: Labels): { text: string; tone: string } {
  const d = (event.detail ?? {}) as Record<string, any>;
  if (event.type === 'episode' && d.scene) {
    const recalled = Array.isArray(d.recalled) && d.recalled.length ? `，用上了 ${d.recalled.length} 条记忆` : '';
    if (d.outcome === 'succeeded') return { text: `${d.scene} 渲染通过${recalled}`, tone: 'ok' };
    const checks = checkText(labels, d.checks);
    const what = d.source === 'check' ? '检查发现' : d.source === 'exam' ? '考试中' : '渲染失败';
    return { text: `${d.scene} ${what}${checks ? '：' + checks : ''}${recalled}`, tone: 'bad' };
  }
  return { text: `${label(labels?.events, event.type)}：${event.summary}`, tone: '' };
}

export const when = (iso: string) => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getMonth() + 1}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
};

export const statusText: Record<MemoryStatus, string> = {
  active: '',
  trial: '试用中',
  rejected: '已拒绝',
  dormant: '已停用',
};

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const per = (total: number, s: RunStats) => (s.scenes ? total / s.scenes : 0);
export const secs = (s: RunStats) => `${Math.round(per(s.seconds, s))}s`;
export const tokens = (s: RunStats) =>
  s.input_tokens + s.output_tokens ? String(Math.round(per(s.input_tokens + s.output_tokens, s))) : '—';
export const brief = (s: RunStats) =>
  `${s.passed_first_try}/${s.scenes} 一次通过 · 重试 ${s.retries} · 问题 ${s.problems}`;
