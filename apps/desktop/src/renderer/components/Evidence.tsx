import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, rawURL } from '../api';
import '../evidence.css';
import type { ExamCell, ExamResult, MemoryRow, MemoryState, RunStats, RunSummary } from '../types';
import type { RunAction, Tab } from './Preview';

interface Props {
  version: number;
  run: RunAction;
  onOpen: (tab: Tab) => void;
}

/**
 * 进化页：把「它学到了什么、学了之后好在哪、不好能不能退回」排成一页。
 * 从上到下是同一个镜头带与不带一条经验的两段画面、这条经验本身、两批渲染的对比、存档与回退。
 * 数据全部来自 /api/memory，这一页不另算任何数字；改动只有回退，经 am 的记忆操作。
 */
export function EvidenceTab({ version, run, onOpen }: Props) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<MemoryState>('/api/memory').then(
      (result) => {
        setState(result);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version]);

  if (error) return <div className="empty">{error}</div>;
  if (!state) return <div className="empty">正在读取…</div>;

  // 只看有结果的考试：无效的一场没有可比的两组。
  const exams = state.exams.filter((e) => !e.verdict.invalid && e.cells.length > 0);
  const tested = state.memories.filter((m) => m.kind === 'lesson' && m.status === 'active' && (m.verified_by?.length ?? 0) > 0);

  return (
    <div className="evidence">
      <header className="evidence-head">
        <span className="eyebrow">进化 · 每个数字都是机器查出来的</span>
        <h2>它学到了什么</h2>
        <p>
          渲染里出过的问题会被整理成经验。一条新经验不会直接生效：先拿出过问题的镜头，带上它、不带它各渲染一遍，
          带上之后问题确实少了才留下。每次变化都存一份，随时能退回上一版。
        </p>
      </header>

      {exams.length === 0 ? (
        <section className="evidence-empty">
          <h3>还没有考过试的经验</h3>
          <p>成片确认可用后会整理出新经验；在「记忆」页点「考试」，这里就会出现带与不带的两段画面。</p>
          <button onClick={() => onOpen('memory')}>去记忆页</button>
        </section>
      ) : (
        <Contrast exams={exams} memories={state.memories} labels={state.labels?.checks ?? {}} version={version} tested={tested.length} />
      )}

      <Runs runs={state.runs_all ?? state.runs} project={state.project ?? ''} />

      <Archive state={state} run={run} />
    </div>
  );
}

const armName = { control: '没带这条经验', trial: '带上之后' } as const;

/** 一场考试里一组的问题总数；通过的格子记 0。 */
function problemsOf(exam: ExamResult, arm: ExamCell['arm']): number {
  return exam.cells.filter((c) => c.arm === arm && !c.invalid).reduce((sum, c) => sum + (c.passed ? 0 : c.problems), 0);
}

function Contrast({
  exams,
  memories,
  labels,
  version,
  tested,
}: {
  exams: ExamResult[];
  memories: MemoryRow[];
  labels: Record<string, string>;
  version: number;
  tested: number;
}) {
  const [examIndex, setExamIndex] = useState(exams.length - 1);
  const exam = exams[Math.min(examIndex, exams.length - 1)];
  const [questionID, setQuestionID] = useState(exam.questions[0]?.id ?? '');
  const question = exam.questions.find((q) => q.id === questionID) ?? exam.questions[0];
  const [renderer, setRenderer] = useState(exam.renderers[0] ?? '');
  const pick = (arm: ExamCell['arm']) => exam.cells.find((c) => c.question === question?.id && c.renderer === (renderer || exam.renderers[0]) && c.arm === arm) ?? null;
  const control = pick('control');
  const trial = pick('trial');
  const before = problemsOf(exam, 'control');
  const after = problemsOf(exam, 'trial');
  const repeats = Math.max(1, ...exam.cells.map((c) => c.repeat));
  const models = [...new Set(exam.cells.map((c) => c.model).filter(Boolean))];
  const lessons = exam.trials.map((name) => memories.find((m) => m.name === name)).filter((m): m is MemoryRow => !!m);
  const verdict = exam.verdict.needs_human ? '等你确认' : exam.verdict.pass ? '考试通过' : '没有通过';

  return (
    <>
      <ol className="evidence-figures" aria-label="这场考试的结果">
        <li>
          <strong>
            {before} <i>→</i> {after}
          </strong>
          <span>查出的问题</span>
          <small>同样的镜头，带上经验之前与之后</small>
        </li>
        <li className={exam.verdict.pass ? 'on' : ''}>
          <strong>{verdict}</strong>
          <span>
            {exam.questions.length} 个镜头 × 每组 {repeats} 次
          </span>
          <small>{exam.verdict.pass ? '问题少了，这条经验留下' : '没有变好的经验不会留下'}</small>
        </li>
        <li>
          <strong>{tested}</strong>
          <span>条经验考过试、正在用</span>
          <small>以后渲染相似的镜头会带上</small>
        </li>
      </ol>

      <section className="evidence-section">
        <div className="evidence-bar">
          <h3>同一个镜头，带与不带</h3>
          <span className="spacer" />
          {exam.renderers.length > 1 && (
            <select value={renderer} aria-label="渲染工具" onChange={(e) => setRenderer(e.currentTarget.value)}>
              {exam.renderers.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          {exams.length > 1 && (
            <select
              value={examIndex}
              aria-label="哪一场考试"
              onChange={(e) => {
                const next = Number(e.currentTarget.value);
                setExamIndex(next);
                setQuestionID(exams[next].questions[0]?.id ?? '');
                setRenderer(exams[next].renderers[0] ?? '');
              }}
            >
              {exams.map((x, i) => (
                <option key={x.id} value={i}>
                  第 {i + 1} 场 · {day(x.created_at)}
                </option>
              ))}
            </select>
          )}
        </div>
        {exam.questions.length > 1 && (
          <div className="evidence-questions" role="tablist" aria-label="考试用的镜头">
            {exam.questions.map((q) => (
              <button key={q.id} role="tab" aria-selected={q.id === question?.id} className={q.id === question?.id ? 'armed' : 'ghost'} onClick={() => setQuestionID(q.id)}>
                {q.scene_id}
                {q.holdout ? ' · 没见过的' : ''}
              </button>
            ))}
          </div>
        )}
        {question?.text && <p className="evidence-narration">「{question.text}」</p>}
        <SidePlayer key={exam.id + question?.id + renderer} control={control} trial={trial} labels={labels} version={version} />
        <p className="small muted evidence-note">
          {models.length > 0 ? `${models.join('、')} 渲染 · ` : ''}
          两组拿到的镜头说明逐字相同，只差这条经验。画面上每段文字的出现与停留时间由渲染方登记，机器按登记核对
          {exam.questions.some((q) => !q.holdout) ? '；考的是当初出过问题的镜头' : ''}。
        </p>
      </section>

      <section className="evidence-section">
        <h3>学到的是这一条</h3>
        {lessons.length === 0 && <p className="small muted">这场考试的经验已经不在记忆库里了。</p>}
        {lessons.map((m) => (
          <article key={m.name} className="evidence-lesson">
            <div className="evidence-lesson-head">
              <p>{m.description}</p>
              <span className={'evidence-chip' + (m.status === 'active' ? ' on' : '')}>{statusName[m.status] ?? m.status}</span>
            </div>
            <p className="small muted">
              从 {m.from_episodes?.length ?? 0} 次出过的问题里整理出来 · 管的是：{[...new Set(m.checked_by)].map((id) => labels[id] ?? id).join('、')}
            </p>
            <details>
              <summary>它对渲染方说了什么</summary>
              <pre>{m.body}</pre>
            </details>
          </article>
        ))}
      </section>
    </>
  );
}

const statusName: Record<string, string> = { active: '正在用', trial: '试用中', rejected: '没留下', dormant: '已停用' };

/** 两段画面并排、同一个播放键：评委要看的是同一时刻两边差在哪。 */
function SidePlayer({
  control,
  trial,
  labels,
  version,
}: {
  control: ExamCell | null;
  trial: ExamCell | null;
  labels: Record<string, string>;
  version: number;
}) {
  const left = useRef<HTMLVideoElement>(null);
  const right = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const both = () => [left.current, right.current].filter((v): v is HTMLVideoElement => v !== null);
  const toggle = () => {
    const videos = both();
    if (playing) {
      for (const v of videos) v.pause();
      setPlaying(false);
      return;
    }
    // 两边对到同一时刻再放：一边先结束时另一边还在走。
    const at = Math.min(...videos.map((v) => v.currentTime));
    for (const v of videos) {
      if (v.ended || Math.abs(v.currentTime - at) > 0.05) v.currentTime = v.ended ? 0 : at;
      void v.play().catch(() => undefined);
    }
    setPlaying(true);
  };
  const restart = () => {
    for (const v of both()) v.currentTime = 0;
  };
  const side = (cell: ExamCell | null, arm: ExamCell['arm'], ref: React.RefObject<HTMLVideoElement | null>) => (
    <figure className={'evidence-side ' + arm}>
      <figcaption>
        <span>{armName[arm]}</span>
        {cell && (
          <strong className={cell.invalid ? '' : cell.passed ? 'ok' : 'bad'}>
            {cell.invalid ? '这一次没跑成' : cell.passed ? '没有查出问题' : `查出 ${cell.problems} 处问题`}
          </strong>
        )}
      </figcaption>
      {cell?.output ? (
        <video ref={ref} src={rawURL(cell.output, version)} preload="metadata" muted playsInline onEnded={() => setPlaying(false)} />
      ) : (
        <div className="evidence-novideo">{cell ? '这段画面不在当前项目里，打开做考试的那个项目就能看到' : '没有这一组的结果'}</div>
      )}
      {cell && !cell.passed && !cell.invalid && (
        <>
          <ul>
            {grouped(cell.checks ?? []).map(([id, count]) => (
              <li key={id}>
                {labels[id] ?? id}
                {count > 1 ? ` · ${count} 处` : ''}
              </li>
            ))}
          </ul>
          {(cell.problem_texts?.length ?? 0) > 0 && (
            <details>
              <summary>机器查出的原话</summary>
              <pre>{cell.problem_texts!.join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </figure>
  );
  const playable = !!(control?.output || trial?.output);
  return (
    <div className="evidence-player">
      <div className="evidence-sides">
        {side(control, 'control', left)}
        {side(trial, 'trial', right)}
      </div>
      {playable && (
        <div className="evidence-controls">
          <button className="primary" onClick={toggle}>
            {playing ? '暂停' : '两边一起播放'}
          </button>
          <button className="ghost" onClick={restart}>
            回到开头
          </button>
        </div>
      )}
    </div>
  );
}

/** 按问题的种类归组并数出个数，出现多的在前。 */
function grouped(checks: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const id of checks) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const perScene = (total: number, s: RunStats) => (s.scenes ? total / s.scenes : 0);
const fixed = (v: number) => (Math.round(v * 10) / 10).toString();
const minutes = (s: RunStats) => `${fixed(perScene(s.seconds, s) / 60)} 分钟`;
const tokens = (s: RunStats) => {
  const each = perScene(s.input_tokens + s.output_tokens, s);
  return each ? `${fixed(each / 10000)} 万` : '—';
};
const day = (time: string) => {
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? time : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 两批渲染并排。主指标是每个镜头查出的问题数：一次就渲染成功的比例本来就接近满分，比不出差别。 */
function Runs({ runs, project }: { runs: RunSummary[]; project: string }) {
  const usable = useMemo(() => runs.filter((r) => r.scenes > 0), [runs]);
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  if (usable.length < 2) return null;
  // 缺省比最近两批像样的渲染：只重渲染一两个镜头的批次说明不了什么，有的话先跳过。
  const batches = usable.filter((r) => r.scenes >= 3);
  const recent = batches.length >= 2 ? batches : usable;
  const a = usable.find((r) => r.run === first) ?? recent[recent.length - 2];
  const b = usable.find((r) => r.run === second) ?? recent[recent.length - 1];
  const name = (r: RunSummary) => `${day(r.started_at)} · ${r.scenes} 个镜头${r.project && r.project !== project ? ` · ${r.project}` : ''}`;
  const picker = (value: RunSummary, set: (run: string) => void, label: string) => (
    <select value={value.run} aria-label={label} onChange={(e) => set(e.currentTarget.value)}>
      {usable.map((r) => (
        <option key={r.run} value={r.run}>
          {name(r)}
        </option>
      ))}
    </select>
  );
  const row = (label: string, from: string, to: string, change: number) => (
    <li className={change < 0 ? 'better' : change > 0 ? 'worse' : ''}>
      <span>{label}</span>
      <strong>
        {from} <i>→</i> {to}
      </strong>
    </li>
  );
  const problems = (s: RunStats) => perScene(s.problems, s);
  return (
    <section className="evidence-section">
      <div className="evidence-bar">
        <h3>两次渲染放在一起</h3>
        <span className="spacer" />
        {picker(a, setFirst, '第一次')}
        <span className="muted">对</span>
        {picker(b, setSecond, '第二次')}
      </div>
      <ul className="evidence-deltas">
        {row('每个镜头查出的问题', fixed(problems(a)), fixed(problems(b)), problems(b) - problems(a))}
        {row('重来的次数', String(a.retries), String(b.retries), b.retries - a.retries)}
        {row('每个镜头用时', minutes(a), minutes(b), perScene(b.seconds, b) - perScene(a.seconds, a))}
        {row('每个镜头的用量', tokens(a), tokens(b), 0)}
        {row('每个镜头带上的提醒', `${fixed(a.recalled)} 条`, `${fixed(b.recalled)} 条`, 0)}
      </ul>
      <p className="small muted evidence-note">每点一次渲染算一批。两批的镜头不一定相同，数字按每个镜头平均。</p>
    </section>
  );
}

/** 存档的说明里把记忆的内部名字换成它的一句话说明，去掉存档号与考试编号。 */
function plain(summary: string, memories: MemoryRow[]): string {
  let text = summary.replace(/^快照 #\d+：/, '').replace(/（exam-\d+ 通过）/, '（考试通过）');
  for (const m of memories) {
    if (!text.includes(m.name)) continue;
    // 「记住偏好 名字：说明」这类已经带说明的，只去掉名字。
    text = text.includes(m.name + '：') ? text.replace(m.name + '：', '') : text.replace(m.name, `「${m.description}」`);
  }
  return text;
}

/** 存档与回退：每一份存档写着它为什么产生，点两下退回去。 */
function Archive({ state, run }: { state: MemoryState; run: RunAction }) {
  const [armed, setArmed] = useState(0);
  const current = state.status.snapshot;
  const saves = state.timeline
    .filter((e) => e.type === 'snapshot' && (e.snapshot ?? 0) > 0)
    .sort((x, y) => (y.snapshot ?? 0) - (x.snapshot ?? 0))
    .slice(0, 8);
  if (saves.length === 0) return null;
  return (
    <section className="evidence-section">
      <h3>每一步都能退回</h3>
      <ol className="evidence-archive">
        {saves.map((e) => {
          const id = e.snapshot ?? 0;
          return (
            <li key={id} className={id === current ? 'now' : ''}>
              <span className="evidence-save">#{id}</span>
              <span className="evidence-why" title={e.summary}>
                {plain(e.summary, state.memories)}
              </span>
              <span className="muted small">{day(e.time)}</span>
              {id === current ? (
                <span className="evidence-chip on">现在用的</span>
              ) : (
                <button
                  className={armed === id ? 'armed' : 'ghost'}
                  onClick={() => {
                    if (armed !== id) return setArmed(id);
                    setArmed(0);
                    run('/api/memory/actions/rollback', { to: id });
                  }}
                >
                  {armed === id ? '再点一次确认' : '回到这一版'}
                </button>
              )}
            </li>
          );
        })}
      </ol>
      <p className="small muted evidence-note">退回不删任何东西：它把那一版的内容再存成新的一份，之后还能退回来。</p>
    </section>
  );
}
