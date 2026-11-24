import { useState } from 'react';
import { errorText, post } from '../../api';
import type { Audition, AuditionActivity, AuditionContestant } from '../../types';
import { AuditionProgress, useAuditionActivity } from '../AuditionActivity';
import { AuditionCompare } from '../AuditionCompare';
import { keyLabel } from '../Learning';
import type { RunAction } from '../Preview';
import { examText, roleName, tokens, verdictText, who } from './helpers';

/** 一场试镜：并排同步播放、评判、揭晓与采用。 */
export function Stage({
  audition: a,
  version,
  busy,
  run,
  onChange,
}: {
  audition: Audition;
  version: number;
  busy: string;
  run: RunAction;
  onChange: () => void;
}) {
  const { activities, disconnected } = useAuditionActivity(a, version, busy);
  const retryBusy =
    busy ||
    (activities.some((c) => ['pending', 'starting', 'running', 'waiting'].includes(c.state)) ? '其余选手仍在试镜' : '');
  const [note, setNote] = useState(a.verdict?.note ?? '');
  const [revoting, setRevoting] = useState(false);
  const [error, setError] = useState('');

  const done = a.contestants.every((c) => c.status === 'done');
  const judging = done && !busy && (a.blind || revoting);

  const vote = async (kind: 'winner' | 'tie' | 'none', winner = '') => {
    setError('');
    try {
      const r = await post<Audition>(`/api/auditions/${a.id}/vote`, { kind, winner, note: note.trim() });
      if (r.warning) setError(r.warning);
      setRevoting(false);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="audition-stage">
      {a.exam && (
        <div className="audition-exam">
          <strong>人评考试</strong>
          <span>
            {keyLabel(a.exam.student)} 向 {keyLabel(a.exam.teacher)} 学的 {a.exam.lessons.length} 条经验：A、B 都是{' '}
            {keyLabel(a.exam.student)}，一份带上这些经验、一份不带；R 是老师，作参照。
            {a.blind ? ' 从 A、B 里选更好的（更接近老师的）一份。' : ''}
          </span>
        </div>
      )}
      {!done && (
        <p className="audition-status">
          {!retryBusy && activities.some((c) => c.state === 'interrupted')
            ? '试镜已中断，可以重试未完成的选手。'
            : `正在拍：${a.contestants.filter((c) => c.status === 'done').length} / ${a.contestants.length} 位拍完。可以离开这一页，拍完会出现在这里。`}
        </p>
      )}
      <AuditionCompare
        contestants={a.contestants}
        version={version}
        labelFor={(c) => `选手 ${c.slot}${!a.blind || c.role === 'reference' ? ` · ${who(c)}` : ''}`}
        onPick={
          judging
            ? (slot) => {
                void vote('winner', slot);
              }
            : undefined
        }
      />
      {judging && (
        <div className="audition-judge">
          <p>
            <strong>
              {a.blind ? (a.exam ? '看完了？A、B 哪份更好？' : '看完了？选出你觉得最好的一份。') : '改判'}
            </strong>
            <span className="muted"> 用画面旁的「选它」选出最佳，也可以：</span>
          </p>
          <input
            value={note}
            placeholder="一句话说说为什么（可选，会一起记下）"
            aria-label="评判说明"
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <div className="audition-actions">
            <button onClick={() => void vote('tie')}>差不多</button>
            <button onClick={() => void vote('none')}>都不行</button>
            {revoting && (
              <button className="ghost" onClick={() => setRevoting(false)}>
                取消
              </button>
            )}
          </div>
        </div>
      )}

      {!a.blind && !revoting && a.verdict && (
        <div className="audition-verdict">
          <p>
            <strong>{verdictText(a)}</strong>
            {a.verdict.note && <span className="muted">「{a.verdict.note}」</span>}
            {a.exam && <span className="audition-exam-result">{examText(a)}</span>}
          </p>
          {!(a.exam && (a.exam.applied === 'promoted' || a.exam.applied === 'rejected')) && (
            <button className="ghost" onClick={() => setRevoting(true)}>
              改判
            </button>
          )}
        </div>
      )}
      {error && <p className="error-line">{error}</p>}
      <div className="audition-roster-head">
        <h3>选手与制作过程</h3>
        <span className="muted small">
          {a.blind ? '盲评只显示制作动作，评判后揭晓具体过程' : '查看进展、失败原因与重试'}
        </span>
      </div>
      <div className={'audition-grid n' + a.contestants.length}>
        {a.contestants.map((c) => (
          <Card
            key={c.slot}
            c={c}
            activity={activities.find((activity) => activity.slot === c.slot)}
            disconnected={disconnected}
            a={a}
            judging={judging}
            onPick={() => void vote('winner', c.slot)}
            onAdopt={() => run(`/api/auditions/${a.id}/adopt`, { slot: c.slot })}
            onRetry={() => run(`/api/auditions/${a.id}/retry`, { slot: c.slot })}
            retryBusy={retryBusy}
            busy={busy}
          />
        ))}
      </div>
    </section>
  );
}

function Card({
  c,
  activity,
  disconnected,
  a,
  judging,
  busy,
  onPick,
  onAdopt,
  onRetry,
  retryBusy,
}: {
  c: AuditionContestant;
  activity?: AuditionActivity;
  disconnected: boolean;
  a: Audition;
  judging: boolean;
  busy: string;
  onPick: () => void;
  onAdopt: () => void;
  onRetry: () => void;
  retryBusy: string;
}) {
  const won = a.verdict?.kind === 'winner' && a.verdict.winner === c.slot;
  const adopted = a.adopted?.slot === c.slot;
  const ok = c.outcome === 'succeeded';
  const reference = c.role === 'reference';
  const retryable = !a.verdict && !a.adopted && !ok && (c.status === 'done' || activity?.state === 'interrupted');
  return (
    <figure
      className={'audition-card' + (won && !a.blind ? ' won' : '') + (reference ? ' reference' : '')}
      data-slot={c.slot}
    >
      <figcaption>
        <span className="audition-slot">{c.slot}</span>
        {c.role && (!a.blind || reference) && <span className="audition-chip">{roleName[c.role]}</span>}
        {(!a.blind || reference) && <span className="audition-who">{who(c)}</span>}
        {won && !a.blind && <span className="audition-chip on">你选的</span>}
        {adopted && <span className="audition-chip">已换进镜头</span>}
      </figcaption>
      {activity && <AuditionProgress activity={activity} disconnected={disconnected} />}
      {disconnected && !activity && (
        <p className="audition-progress-note" role="status">
          暂时无法读取制作过程，正在重试。
        </p>
      )}
      {!activity && (
        <p className="audition-facts">
          {c.output
            ? '画面已就绪，可在上方选择比较'
            : c.status === 'done'
              ? '尚无可比较的画面'
              : c.status === 'running'
                ? '正在制作画面'
                : '等待上场'}
        </p>
      )}
      {!a.blind && c.status === 'done' && (
        <p className="audition-facts">
          {ok ? '没有查出问题' : (c.problems?.length ?? 0) > 0 ? `查出 ${c.problems!.length} 处问题` : '没跑成'}
          {c.seconds ? ` · ${Math.round(c.seconds)} 秒` : ''}
          {tokens(c.usage) ? ` · ${tokens(c.usage)}` : ''}
        </p>
      )}
      {!a.blind && !ok && (c.problems?.length || c.error) && (
        <details className="audition-why">
          <summary>为什么</summary>
          <ul>
            {(c.problems ?? []).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
            {c.error && <li>{c.error}</li>}
          </ul>
        </details>
      )}
      <div className="audition-card-actions">
        {retryable && (
          <button
            className="ghost"
            aria-label={`重试 ${c.slot}`}
            disabled={!!retryBusy}
            title={retryBusy || '沿用这位选手的配置与试镜输入重新制作'}
            onClick={onRetry}
          >
            重试
          </button>
        )}
        {judging && c.output && !reference && <button onClick={onPick}>选它</button>}
        {!a.blind && ok && !adopted && !c.role && (
          <button
            className={won ? 'primary' : 'ghost'}
            disabled={!!busy}
            title={busy || '把这一份换进镜头，原来的画面归档'}
            onClick={onAdopt}
          >
            换进镜头
          </button>
        )}
      </div>
      {retryable && (
        <p className="audition-progress-note">
          {retryBusy ? `任务结束后可重试：${retryBusy}` : '沿用原配置和试镜输入；先验收已有视频，需要时再调用模型。'}
        </p>
      )}
    </figure>
  );
}
