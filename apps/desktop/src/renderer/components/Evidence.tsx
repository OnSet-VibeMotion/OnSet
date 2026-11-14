import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from '../api';
import '../evidence.css';
import type { ExamCell, ExamResult, MemoryRow, MemoryState, RunStats, RunSummary, Scene } from '../types';
import { LearningSection } from './Learning';
import type { RunAction, Tab } from './Preview';
import { ExamProgressPanel } from './ExamProgress';
import { ExamPlayer as SidePlayer } from './ExamPlayer';
import { MemoryApplications } from './MemoryApplications';
import '../memory.css';

interface Props {
  version: number;
  run: RunAction;
  onOpen: (tab: Tab) => void;
  scenes?: Scene[];
  sceneId?: string;
}

/**
 * 进化页：把「它学到了什么、学了之后好在哪、不好能不能退回」排成一页。
 * 从上到下是同一个镜头带与不带一条经验的两段画面、这条经验本身、两批渲染的对比、存档与回退。
 * 数据全部来自 /api/memory，这一页不另算任何数字；改动只有回退，经 onset 的记忆操作。
 */
export function EvidenceTab({ version, run, onOpen, scenes = [], sceneId = '' }: Props) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setRefresh((n) => n + 1), 2000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let current = true;
    api<MemoryState>('/api/memory').then(
      (result) => {
        if (!current) return;
        setState(result);
        setError('');
      },
      (err) => { if (current) setError(errorText(err)); },
    );
    return () => { current = false; };
  }, [version, refresh]);

  if (error) return <div className="empty">{error}</div>;
  if (!state) return <div className="empty">正在读取…</div>;

  // 只看有结果的考试：无效的一场没有可比的两组。
  const exams = state.exams.filter((e) => !e.verdict.invalid && e.cells.length > 0);
  const tested = state.memories.filter((m) => m.kind === 'lesson' && m.status === 'active' && (m.verified_by?.length ?? 0) > 0);

  return (
    <div className="evidence">
      <header className="evidence-head">
        <span className="eyebrow">进化 · 看对照，也看依据</span>
        <h2>它学到了什么</h2>
        <p>
          渲染里出过的问题会被整理成试用经验。技术问题用带与不带经验的两组渲染检查，构图、节奏等观看体验由你看过对照后判断。
          每次变化都存一份，随时能退回上一版。
        </p>
      </header>

      <ExamProgressPanel state={state} />
      {state.exams.filter((e) => e.verdict.invalid).map((e) => <section className="evidence-section" key={e.id}>
        <h3>{e.id} · 考试无效</h3>
        <p>未改变记忆状态。{e.verdict.reasons.join('；')}</p>
        {e.cells.filter((c) => c.invalid).map((c) => <p key={`${c.question}-${c.renderer}-${c.arm}-${c.repeat}`}>{c.question} · {c.renderer} · {c.arm === 'control' ? '对照组' : '试用组'}：{c.error || '执行失败'}</p>)}
      </section>)}
      {exams.length === 0 ? (
        <section className="evidence-empty">
          <h3>还没有考过试的经验</h3>
          <p>成片确认可用后会整理出新经验；在「记忆」页点「考试」，这里就会出现带与不带的两段画面。</p>
          <button onClick={() => onOpen('memory')}>去记忆页</button>
        </section>
      ) : (
        <Contrast exams={exams} memories={state.memories} labels={state.labels?.checks ?? {}} featureLabels={state.labels?.features ?? {}} renderer={state.renderer || 'claude'} run={run} version={version} tested={tested.length} />
      )}

      <LearningSection version={version} scenes={scenes} sceneId={sceneId} run={run} onAudition={() => onOpen('audition')} />

      <Runs runs={state.runs_all ?? state.runs} project={state.project ?? ''} />

      <Archive state={state} run={run} />
    </div>
  );
}

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
  run,
  renderer: currentRenderer,
  featureLabels,
}: {
  exams: ExamResult[];
  memories: MemoryRow[];
  labels: Record<string, string>;
  version: number;
  tested: number;
  run: RunAction;
  renderer: string;
  featureLabels: Record<string, string>;
}) {
  const lessonsRef = useRef<HTMLElement>(null);
  const [examIndex, setExamIndex] = useState(exams.length - 1);
  const exam = exams[Math.min(examIndex, exams.length - 1)];
  const [questionID, setQuestionID] = useState(exam.questions[0]?.id ?? '');
  const question = exam.questions.find((q) => q.id === questionID) ?? exam.questions[0];
  const [renderer, setRenderer] = useState(exam.renderers[0] ?? '');
  const [repeat, setRepeat] = useState(1);
  const repeatsForPair = [...new Set(exam.cells.filter((c) => c.question === question?.id && c.renderer === renderer).map((c) => c.repeat))].sort((a, b) => a - b);
  const selectedRepeat = repeatsForPair.includes(repeat) ? repeat : repeatsForPair[0];
  const pick = (arm: ExamCell['arm']) => exam.cells.find((c) => c.question === question?.id && c.renderer === renderer && c.arm === arm && c.repeat === selectedRepeat) ?? null;
  const control = pick('control');
  const trial = pick('trial');
  const before = problemsOf(exam, 'control');
  const after = problemsOf(exam, 'trial');
  const incomplete = exam.cells.some((c) => c.incomplete);
  const repeats = Math.max(1, ...exam.cells.map((c) => c.repeat));
  const models = [...new Set(exam.cells.map((c) => c.model).filter(Boolean))];
  const lessons = exam.trials.map((name) => memories.find((m) => m.name === name)).filter((m): m is MemoryRow => !!m);
  const bothPassed = !exam.verdict.needs_human && !exam.verdict.pass && exam.cells.length > 0 && exam.cells.every((c) => c.passed && !c.invalid);
  const verdict = exam.cells.some((c) => c.incomplete) ? '检查依据不完整' : exam.verdict.needs_human ? '等你确认' : exam.verdict.pass ? '考试通过' : bothPassed ? '未发现额外改善' : '没有通过';
  const examinable = lessons.filter((m) => m.kind === 'lesson' && m.examinable);

  return (
    <>
      <ol className="evidence-figures" aria-label="这场考试的结果">
        <li>
          <strong>
            {incomplete ? '暂不能比较' : <>{before} <i>→</i> {after}</>}
          </strong>
          <span>{incomplete ? '检查依据不完整' : '查出的问题'}</span>
          <small>同样的镜头，带上经验之前与之后</small>
        </li>
        <li className={exam.verdict.pass ? 'on' : ''}>
          <strong>{verdict}</strong>
          <span>
            {exam.questions.length} 个镜头 × 每组 {repeats} 次
          </span>
          <small>{exam.verdict.needs_human ? '有待核实的条件，本场未改变记忆状态' : exam.applied === 'promoted' ? '待考经验已生效' : exam.applied === 'rejected' ? '待考经验未留下' : '本场未改变记忆状态'}</small>
        </li>
        <li>
          <strong>{tested}</strong>
          <span>条经验考过试、正在用</span>
          <small>以后渲染相似的镜头会带上</small>
        </li>
      </ol>

      {examinable.length > 0 && <section className="evidence-retest-call" aria-label="重考入口">
        <p>本场有 {examinable.length} 条经验可以重新考试。停用或未通过的经验，重考通过后才会恢复生效。</p>
        <button className="primary" onClick={() => lessonsRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>查看并重考</button>
      </section>}

      <section className="evidence-section">
        <div className="evidence-bar">
          <h3>同一个镜头，带与不带</h3>
          <span className="spacer" />
          {repeatsForPair.length > 1 && <select aria-label="第几次重复" value={selectedRepeat} onChange={(e) => setRepeat(Number(e.currentTarget.value))}>
            {repeatsForPair.map((n) => <option key={n} value={n}>第 {n} 次</option>)}
          </select>}
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
                {q.id} · {q.scene_id}
                {q.holdout ? ' · 留出镜头' : ''}
              </button>
            ))}
          </div>
        )}
        {question?.text && <p className="evidence-narration">「{question.text}」</p>}
        <SidePlayer key={exam.id + question?.id + renderer + selectedRepeat} control={control} trial={trial} labels={labels} version={version} />
        <p className="small muted">对照 {exam.verdict.control_score} 分 → 试用 {exam.verdict.trial_score} 分。{exam.verdict.reasons.join('；')}</p>
        {exam.evaluation_note && <p role="status">{exam.evaluation_note}</p>}
        {bothPassed && <p>两组都通过了本场检查，尚未证明经验带来额外改善。先核对检查是否覆盖原问题，再加入相关新镜头或做观看对照；重复相同满分题不能增加改善证据。</p>}
        <p className="small muted evidence-note">
          {models.length > 0 ? `${models.join('、')} 渲染 · ` : ''}
          两组使用相同镜头输入，试用组按召回条件加入待考经验。多条合考的结果属于整组，不能证明每条经验单独有效。画面上每段文字的出现与停留时间由渲染方登记，机器按登记核对
          {exam.questions.some((q) => !q.holdout) ? '；考的是当初出过问题的镜头' : ''}。
        </p>
        <p className="small muted evidence-scope">
          {exam.questions.some((q) => q.holdout)
            ? '本场包含留出镜头，可检查新镜头是否退步；能否迁移到其他项目还要继续观察。'
            : '本场没有留出镜头，只能说明这些旧题上的表现，还没有新镜头的迁移证据。'}
          机器检查通过说明对应问题未被查出；画面是否更好，要看人的对照评价。
        </p>
      </section>

      <section className="evidence-section" ref={lessonsRef} aria-label="本场经验与重考">
        <h3>本场经验与重考 · {exam.trials.length} 条</h3>
        {lessons.length === 0 && <p className="small muted">这场考试的经验已经不在记忆库里了。</p>}
        {lessons.map((m) => (
          <article key={m.name} className="evidence-lesson">
            <div className="evidence-lesson-head">
              <p>{m.description}</p>
              <div className="evidence-lesson-actions">
                <span className={'evidence-chip' + (m.status === 'active' ? ' on' : '')}>{statusName[m.status] ?? m.status}</span>
                {m.kind === 'lesson' && m.examinable && <button className="primary" onClick={() => {
                  const renderer = m.applies_when.renderers?.includes(currentRenderer) ? currentRenderer : m.applies_when.renderers?.[0] || currentRenderer;
                  void run('/api/memory/actions/exam', { renderers: [renderer], ...(m.status === 'trial' ? { trial: m.name } : { name: m.name }) });
                }}>{m.status === 'trial' ? '只考这条' : '重新考试'}</button>}
              </div>
            </div>
            <p className="small muted">
              从 {m.from_episodes?.length ?? 0} 次出过的问题里整理出来 · 管的是：{[...new Set(m.checked_by)].map((id) => labels[id] ?? id).join('、')}
            </p>
            <details>
              <summary>它对渲染方说了什么</summary>
              <pre>{m.body}</pre>
            </details>
            {m.kind === 'lesson' && <MemoryApplications memory={m} featureLabels={featureLabels} run={run} />}
          </article>
        ))}
      </section>
    </>
  );
}

const statusName: Record<string, string> = { active: '正在用', trial: '试用中', rejected: '没留下', dormant: '已停用' };

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
