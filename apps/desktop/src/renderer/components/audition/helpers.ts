import type { Audition, AuditionContestant, Usage } from '../../types';

export interface Pick {
  renderer: string;
  model: string;
  /** 两段式：先由这一位写设计稿。 */
  designer?: { renderer: string; model: string } | null;
}

export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function examText(a: Audition): string {
  switch (a.exam?.applied) {
    case 'promoted':
      return '你选了带经验的那份：这些经验生效，学生以后渲染会带上。';
    case 'rejected':
      return '你选了不带经验的那份：这些经验不留。';
    case 'undecided':
      return '差不多或都不行：经验留在试用，可以换个镜头再考一场。';
  }
  return '';
}

export function verdictText(a: Audition): string {
  const v = a.verdict!;
  if (v.kind === 'tie') return '你判：差不多';
  if (v.kind === 'none') return '你判：都不行';
  const c = a.contestants.find((x) => x.slot === v.winner);
  return `你选了 ${v.winner}${c ? ' · ' + who(c) : ''}`;
}

export function who(c: AuditionContestant): string {
  const model = c.model || c.actual_model || '';
  const own = model ? `${c.renderer} · ${model}` : (c.renderer ?? '');
  if (!c.designer) return own;
  return `${own} ← ${c.designer_model ? `${c.designer} · ${c.designer_model}` : c.designer} 的设计稿`;
}

export const roleName: Record<string, string> = { reference: '参照 · 老师', trial: '带经验', control: '不带经验' };

export function tokens(u: Usage | null | undefined): string {
  if (!u) return '';
  const n = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  if (n === 0) return '';
  return (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k') + ' token' + (u.partial ? '+' : '');
}
