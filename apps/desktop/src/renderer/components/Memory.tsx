import { useEffect, useState } from 'react';
import { api, errorText, post, rawURL } from '../api';
import '../memory.css';
import type { ExamResult, MemoryEvent, MemoryRow, MemoryState, MemoryStatus, MemorySuspect, RecallResponse, RunStats, RunSummary, Scene } from '../types';
import type { RunAction } from './Preview';
import { ExamProgressPanel } from './ExamProgress';

type Labels = MemoryState['labels'];

const label = (table: Record<string, string> | undefined, id: string) => table?.[id] ?? id;
const checkText = (labels: Labels, ids: readonly string[] | null | undefined) => [...new Set(ids ?? [])].map((id) => label(labels?.checks, id)).join('、');

interface Props {
  scene: Scene | null;
  version: number;
  run: RunAction;
}

/**
 * 记忆面板。页头用三步讲清记忆在做什么：记下的问题 → 整理成的提醒 → 渲染时用上，各带现在的数字；
 * 下面依次是等你确认的、还没整理的问题（按问题归组，不是渲染日志）、你的要求、学到的经验、当前镜头会带上的几条。
 * 渲染记录、考试、批次对比、存档与回退是维护用的，收进「高级」。
 * 面板上不直接露出校验器 ID、事件类型和特征名，一律经 labels 换成大白话。改动一律经 onset memory 子命令。
 */
export function MemoryTab({ scene, version, run }: Props) {
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

  // 当前镜头渲染时会带上哪几条：页头的第三步与「会带上」一节共用。
  const [recall, setRecall] = useState<RecallResponse | null>(null);
  useEffect(() => {
    setRecall(null);
    if (!scene) return;
    api<RecallResponse>(`/api/memory/recall?scene=${encodeURIComponent(scene.id)}`).then(setRecall, () => setRecall(null));
  }, [scene?.id, version, refresh]);

  if (error) return <div className="empty">{error}</div>;
  if (!state) return <div className="empty">正在读取记忆…</div>;

  const labels = state.labels;
  const pending = state.memories.filter((m) => m.status === 'trial' && (m.kind === 'preference' || !m.examinable));
  const preferences = state.memories.filter((m) => m.kind === 'preference' && m.status === 'active');
  const lessons = state.memories.filter((m) => m.kind === 'lesson' && (m.status === 'active' || (m.status === 'trial' && m.examinable)));
  const activeLessons = lessons.filter((m) => m.status === 'active');
  const trialLessons = lessons.filter((m) => m.status === 'trial');
  const retired = state.memories.filter((m) => m.status === 'dormant' || m.status === 'rejected');
  const card = (m: MemoryRow) => (
    <MemoryCard
      key={m.name}
      memory={m}
      labels={labels}
      weak={state.status.weak.some((w) => w.name === m.name)}
      retest={state.status.retest.filter((r) => r.name === m.name)}
      suspect={(state.status.suspect ?? []).filter((x) => x.name === m.name)}
      renderer={state.renderer || 'claude'}
      run={run}
    />
  );

  const project = state.project ?? '';
  const pendingProblems = state.pending ?? [];
  const pendingTotal = state.status.pending_failures;
  const recalled = recall?.recall.items ?? [];
  const examRenderer = state.renderer || 'claude';

  if (!state.enabled) {
    return (
      <div className="memory-tab">
        <header className="memory-head">
          <span className="eyebrow">记忆 · 已关闭</span>
          <h2>记忆</h2>
          <p>项目配置里写着 MEMORY=off：渲染时不会带上任何提醒，也不再记下新的问题。改回 on 就会继续。</p>
        </header>
      </div>
    );
  }

  return (
    <div className="memory-tab">
      <header className="memory-head">
        <span className="eyebrow">记忆 · 所有项目共用</span>
        <h2>记忆</h2>
        <p>
          渲染和检查里出过的问题会先记下来。
          你在成片页确认「这一版可用」（或在对话里这样说）之后，会把这次制作里的问题整理成经验；
          新经验先试用，你点「考试」、它考过了，以后渲染相似的镜头才会带上。你说过的要求不用整理，记下就生效。
        </p>
        <ol className="memory-flow" aria-label="记忆怎么起作用">
          <li className={pendingTotal > 0 ? 'on' : ''}>
            <strong>{pendingTotal}</strong>
            <span>记下的问题</span>
            <small>{pendingTotal === 0 ? '暂时没有新的' : '成片确认可用后整理'}</small>
          </li>
          <li>
            <strong>{preferences.length + lessons.length}</strong>
            <span>整理成的提醒</span>
            <small>
              你的要求 {preferences.length} · 经验 {activeLessons.length}
              {trialLessons.length > 0 ? ` · 待考试 ${trialLessons.length}` : ''}
            </small>
          </li>
          <li>
            <strong>{scene ? recalled.length : '—'}</strong>
            <span>渲染时用上</span>
            <small>{scene ? `${scene.id} 会带上 ${recalled.length} 条` : '还没有镜头'}</small>
          </li>
        </ol>
      </header>

      <ExamProgressPanel state={state} />
      {state.exams.length > 0 && <section className="memory-section" aria-label="最近考试结果">
        <h3>最近考试结果</h3>
        <ExamMatrix exam={state.exams[state.exams.length - 1]} version={version} state={state} />
      </section>}

      {pending.length > 0 && (
        <section className="memory-section memory-pending">
          <h4>等你确认 · {pending.length}</h4>
          <p className="small muted">这些是推测出来的，你认可之后才会用上。也可以直接在对话里回答。</p>
          {pending.map(card)}
        </section>
      )}

      {pendingProblems.length > 0 && (
        <section className="memory-section">
          <h4>记下的问题</h4>
          <p className="small muted">上次整理之后，渲染和检查里出过这些问题。成片确认可用后会整理，只出现过一次的不整理；不想等也可以现在就整理。</p>
          <ul className="memory-problems">
            {pendingProblems.map((g) => (
              <li key={g.check}>
                <span className="memory-problem">{g.check === 'human' ? '你回退过、或说不满意' : label(labels?.checks, g.check)}</span>
                <span className="memory-count">{g.count} 次</span>
                <span className="memory-scenes">
                  {g.scenes
                    .filter((x) => x.project === project)
                    .map((x) => (
                      <span key={x.scene} className="memory-scene">
                        {x.scene}
                      </span>
                    ))}
                  {g.scenes.some((x) => x.project !== project) && (
                    <span className="small muted" title={[...new Set(g.scenes.filter((x) => x.project !== project).map((x) => x.project))].join('\n')}>
                      {g.scenes.some((x) => x.project === project) ? '另有' : ''}其他项目 {g.scenes.filter((x) => x.project !== project).length} 个镜头
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <div className="memory-consolidate">
            <button onClick={() => run('/api/memory/actions/consolidate')}>现在就整理</button>
            <span className="small muted">会调用一次 AI 读这些问题，写成几条试用经验。</span>
          </div>
        </section>
      )}

      <section className="memory-section">
        <h4>你的要求 · {preferences.length}</h4>
        <p className="small muted">每次渲染、每轮对话都会照着做。在对话里说「以后都……」会自动记下，也可以在这里写。</p>
        {preferences.map(card)}
        <RememberForm onDone={() => setRefresh((n) => n + 1)} />
      </section>

      <section className="memory-section">
        <h4>学到的经验 · {lessons.length}</h4>
        {lessons.length === 0 ? (
          <p className="small muted">
            {pendingTotal === 0 ? '还没有。渲染或检查出了问题会先记下来，成片确认可用后整理成经验。' : '还没有。成片确认可用后，上面的问题会整理成经验。'}
          </p>
        ) : (
          <>
            {trialLessons.length > 0 ? (
              <div className="memory-exam-call">
                <p>
                  {trialLessons.length} 条新经验在试用，还没带进渲染。考试会拿已有镜头分别带上、不带它各渲染一遍做对照，比得出效果才生效——要花几次渲染的钱，所以不自动做。
                </p>
                <button className="primary" onClick={() => run('/api/memory/actions/exam', { renderers: [examRenderer] })}>
                  考试（用 {examRenderer}）
                </button>
              </div>
            ) : (
              <p className="small muted">只在相似的镜头上用。</p>
            )}
            {lessons.map(card)}
          </>
        )}
        {retired.length > 0 && (
          <details className="memory-retired">
            <summary className="small muted">已停用 · {retired.length}</summary>
            {retired.map(card)}
          </details>
        )}
      </section>

      {scene && recalled.length > 0 && (
        <section className="memory-section">
          <h4>渲染 {scene.id} 时会带上</h4>
          <ul className="memory-recall">
            {recalled.map((item) => (
              <li key={item.name}>
                <span className="memory-kind">{item.kind === 'preference' ? '要求' : '经验'}</span>
                <span>{item.description}</span>
              </li>
            ))}
          </ul>
          {recall?.recall.omitted?.length ? (
            <p className="small muted">另有 {recall.recall.omitted.length} 条相关但没带上（每个镜头最多 {recall.recall.max_lessons} 条经验）。</p>
          ) : null}
        </section>
      )}

      <details className="memory-advanced">
        <summary>高级：渲染记录、效果对比、考试、存档</summary>
        <div className="memory-advanced-body">
          <ActivitySection state={state} />
          <AdvancedSection state={state} version={version} run={run} />
        </div>
      </details>
    </div>
  );
}

function RememberForm({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [global, setGlobal] = useState(false);
  const [notice, setNotice] = useState('');
  const submit = async () => {
    setNotice('');
    try {
      const result = await post<{ message: string }>('/api/memory/actions/remember', { note: text.trim(), global });
      setNotice(result.message);
      setText('');
      onDone();
    } catch (err) {
      setNotice(errorText(err));
    }
  };
  return (
    <>
      <div className="toolbar">
        <input
          className="feedback-note memory-preference"
          value={text}
          placeholder="例如：节奏慢一点，每个画面多停一秒"
          aria-label="偏好内容"
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) submit();
          }}
        />
        <label className="small">
          <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.currentTarget.checked)} /> 用于所有项目
        </label>
        <button disabled={!text.trim()} onClick={submit}>
          记住
        </button>
      </div>
      {notice && <p className="small muted">{notice}</p>}
    </>
  );
}

/** 本项目最近的事，写成一句话。 */
function ActivitySection({ state }: { state: MemoryState }) {
  const [more, setMore] = useState(false);
  const events = state.timeline.filter((e) => (e.type === 'episode' ? e.project === state.project : !e.project || e.project === state.project));
  const shown = more ? events : events.slice(0, 8);
  return (
    <section className="memory-section">
      <h4>渲染记录</h4>
      {events.length === 0 ? (
        <p className="small muted">这个项目还没有渲染记录。</p>
      ) : (
        <ol className="memory-activity">
          {shown.map((event, index) => {
            const { text, tone } = describe(event, state.labels);
            return (
              <li key={index} className={tone}>
                <span className="memory-time">{when(event.time)}</span>
                <span>{text}</span>
              </li>
            );
          })}
        </ol>
      )}
      {events.length > 8 && (
        <button className="link small" onClick={() => setMore(!more)}>
          {more ? '收起' : `显示全部 ${events.length} 条`}
        </button>
      )}
    </section>
  );
}

function describe(event: MemoryEvent, labels: Labels): { text: string; tone: string } {
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

const when = (iso: string) => {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getMonth() + 1}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
};

function AdvancedSection({ state, version, run }: { state: MemoryState; version: number; run: RunAction }) {
  const [renderers, setRenderers] = useState('claude,codex');
  const [examIndex, setExamIndex] = useState(state.exams.length - 1);
  const [rollbackTo, setRollbackTo] = useState(0);
  const [allProjects, setAllProjects] = useState(false);
  const exam = state.exams[examIndex < 0 ? state.exams.length - 1 : Math.min(examIndex, state.exams.length - 1)] ?? null;
  const previous = state.snapshots.filter((id) => id !== state.status.snapshot);
  const others = state.timeline.filter((e) => e.type === 'episode' && e.project !== state.project);
  return (
    <>
      <p className="small muted">
        记忆库 {state.dir} · 当前存档 #{state.status.snapshot || '—'}
        {state.pinned > 0 ? `（项目钉在 #${state.pinned}）` : ''} · 共 {state.status.episodes} 段经历 · 每个镜头最多注入 {state.budget} 字
      </p>

      <RunsSection runs={state.runs} />

      <section className="memory-section">
        <div className="toolbar">
          <h4>考试</h4>
          <span className="small muted">新经验先用这些渲染工具做对照考试，通过了才生效</span>
          <span className="spacer" />
          <input className="memory-input mono" value={renderers} aria-label="参加考试的渲染工具" onChange={(e) => setRenderers(e.currentTarget.value)} />
          <button
            onClick={() =>
              run('/api/memory/actions/exam', {
                renderers: renderers
                  .split(',')
                  .map((r) => r.trim())
                  .filter(Boolean),
              })
            }
          >
            考试
          </button>
          {state.exams.length > 1 && (
            <select value={examIndex} aria-label="选择考试" onChange={(e) => setExamIndex(Number(e.currentTarget.value))}>
              {state.exams.map((x, i) => (
                <option key={x.id} value={i}>
                  {x.id}
                </option>
              ))}
            </select>
          )}
        </div>
        {exam ? <ExamMatrix exam={exam} version={version} state={state} /> : <p className="small muted">还没有考试。</p>}
        {state.exams.length > 0 && <ScoreCurve exams={state.exams} />}
      </section>

      <section className="memory-section">
        <div className="toolbar">
          <h4>存档与回退</h4>
          <span className="small muted">记忆每次变化都存一份，可以整体退回到之前的某一份</span>
          <span className="spacer" />
          {previous.length > 0 ? (
            <>
              <select value={rollbackTo} aria-label="回退目标快照" onChange={(e) => setRollbackTo(Number(e.currentTarget.value))}>
                <option value={0}>回退到…</option>
                {previous.map((id) => (
                  <option key={id} value={id}>
                    存档 #{id}
                  </option>
                ))}
              </select>
              <button disabled={!rollbackTo} onClick={() => run('/api/memory/actions/rollback', { to: rollbackTo })}>
                回退
              </button>
            </>
          ) : (
            <span className="small muted">还没有可回退的存档</span>
          )}
        </div>
      </section>

      {others.length > 0 && (
        <section className="memory-section">
          <label className="small">
            <input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.currentTarget.checked)} /> 显示其他项目最近的 {others.length} 次渲染
          </label>
          {allProjects && (
            <ol className="memory-activity">
              {others.map((event, index) => {
                const { text, tone } = describe(event, state.labels);
                return (
                  <li key={index} className={tone}>
                    <span className="memory-time">{when(event.time)}</span>
                    <span className="muted">{event.project || '（未记项目）'}</span>
                    <span>{text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
    </>
  );
}

const statusText: Record<MemoryStatus, string> = { active: '', trial: '试用中', rejected: '已拒绝', dormant: '已停用' };

function MemoryCard({
  memory,
  labels,
  weak,
  retest,
  suspect,
  renderer,
  run,
}: {
  memory: MemoryRow;
  labels: Labels;
  weak: boolean;
  retest: MemoryState['status']['retest'];
  suspect: MemorySuspect[];
  renderer: string;
  run: RunAction;
}) {
  const [open, setOpen] = useState(false);
  const stats = Object.entries(memory.stats ?? {});
  const recalled = stats.reduce((n, [, s]) => n + s.recalled, 0);
  const passed = stats.reduce((n, [, s]) => n + s.passed_first_try, 0);
  const guards = memory.kind === 'lesson' ? checkText(labels, memory.checked_by) : '';
  const facts = [
    guards && `防止：${guards}`,
    memory.applies_when.features?.length && `适用：${memory.applies_when.features.map((f) => label(labels?.features, f)).join('、')}`,
    (memory.applies_when.renderers?.length || memory.applies_when.models?.length) &&
      `只给 ${[...(memory.applies_when.renderers ?? []), ...(memory.applies_when.models ?? [])].join('、')}`,
    memory.kind === 'preference' && (memory.scope ? '只用于本项目' : '用于所有项目'),
    memory.from_episodes?.length && `来自 ${memory.from_episodes.length} 次失败`,
    recalled > 0 && `用过 ${recalled} 次，${passed} 次一次通过`,
  ].filter(Boolean);
  return (
    <div className="memory-card">
      <div className="memory-card-head">
        <p className="memory-desc">{memory.description}</p>
        <div className="memory-card-actions">
          {statusText[memory.status] && <span className="memory-badge">{statusText[memory.status]}</span>}
          {weak && <span className="memory-badge warn" title="最近用上它的镜头通过率不比没用时高">效果不明显</span>}
          {suspect.length > 0 && (
            <span
              className="memory-badge warn"
              title={suspect.map((x) => `${x.renderer}：用了 ${x.recalled} 次，其中 ${x.harmful} 次它要防的问题照样出现`).join('\n')}
            >
              可能没用
            </span>
          )}
          {memory.status === 'trial' && (
            <>
              {memory.kind === 'lesson' && memory.examinable && (
                <button className="primary" onClick={() => run('/api/memory/actions/exam', { renderers: [renderer], trial: memory.name })}>
                  只考这条
                </button>
              )}
              {(memory.kind === 'preference' || !memory.examinable) && (
                <button className="primary" onClick={() => run('/api/memory/actions/promote', { name: memory.name })}>
                  确认
                </button>
              )}
              <button onClick={() => run('/api/memory/actions/reject', { name: memory.name })}>不要</button>
            </>
          )}
          {memory.status === 'active' && weak && <button onClick={() => run('/api/memory/actions/retire', { name: memory.name })}>停用</button>}
          {memory.status === 'active' &&
            suspect
              .filter((x) => !retest.some((r) => x.renderer.split('/')[0] === r.renderer))
              .map((x) => (
                <button key={'s' + x.renderer} onClick={() => run('/api/memory/actions/exam', { renderers: [x.renderer.split('/')[0]], name: memory.name })}>
                  重考（{x.renderer.split('/')[0]}）
                </button>
              ))}
          {retest.map((r) => (
            <button
              key={r.renderer}
              title={`当初在 ${r.renderer} 上用 ${r.examined_models.join('、')} 考过，现在是 ${r.current_model}`}
              onClick={() => run('/api/memory/actions/exam', { renderers: [r.renderer], name: memory.name })}
            >
              换了模型，重考（{r.renderer}）
            </button>
          ))}
        </div>
      </div>
      {facts.length > 0 && <p className="small muted">{facts.join(' · ')}</p>}
      {memory.status === 'trial' && memory.kind === 'lesson' && !memory.examinable && (
        <p className="small muted">这条要看相邻镜头的衔接才能判断有没有用，没法自动考试，需要你确认。</p>
      )}
      {memory.rejected_reason && <p className="error-line">{memory.rejected_reason}</p>}
      <button className="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起全文' : '查看全文'}
      </button>
      {open && (
        <>
          <pre className="memory-body">{memory.body}</pre>
          <p className="small muted mono">
            {memory.name}
            {memory.revises ? ` · 修订自 ${memory.revises}` : ''}
            {memory.verified_by?.length ? ` · 考试 ${memory.verified_by.join('、')}` : ''}
          </p>
        </>
      )}
    </div>
  );
}

function ExamMatrix({ exam, version, state: memoryState }: { exam: ExamResult; version: number; state: MemoryState }) {
  const verdict = exam.verdict;
  const state = verdict.invalid ? '无效' : verdict.needs_human ? '待人工确认' : verdict.pass ? '通过' : '未通过';
  return (
    <div className="exam">
      <p>
        <strong>{exam.id}</strong> · {state} · 试用 {exam.trials.map((name) => memoryState.memories.find((m) => m.name === name)?.description || name).join('、')} · 对照 {verdict.control_score.toFixed(1)} 分 → 试用{' '}
        {verdict.trial_score.toFixed(1)} 分
      </p>
      {verdict.reasons.length > 0 && (
        <ul className="issues">
          {verdict.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="exam-scroll">
        <table className="exam-table">
          <thead>
            <tr>
              <th>考题</th>
              {exam.renderers.map((r) => [
                <th key={r + 'c'}>{r} · 对照</th>,
                <th key={r + 't'}>{r} · 试用</th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {exam.questions.map((q) => (
              <tr key={q.id}>
                <th>
                  {q.id} <span className="small muted">{q.scene_id}{q.holdout ? ' · 留出' : ''}</span>
                  {q.text && <p className="small">{q.text}</p>}
                </th>
                {exam.renderers.map((r) =>
                  (['control', 'trial'] as const).map((arm) => {
                    const cells = exam.cells.filter((c) => c.question === q.id && c.renderer === r && c.arm === arm);
                    return (
                      <td key={r + arm}>
                        {cells.map((c, i) => (
                          <div
                            key={i}
                            className={'exam-cell ' + (c.invalid ? 'invalid' : c.passed ? 'pass' : 'fail')}
                            title={[c.model, c.error || (c.checks ?? []).join('\n')].filter(Boolean).join('\n')}
                          >
                            {c.output && <video src={rawURL(c.output, version)} preload="none" controls muted />}
                            <span>{c.invalid ? '⚠' : c.passed ? '✅' : `❌ ${c.problems}`}</span>
                            <details>
                              <summary>第 {c.repeat} 次 · {c.invalid ? '执行无效' : c.passed ? '检查通过' : '查看问题'}</summary>
                              <p>{c.model || '模型未记录'} · {Math.round(c.seconds)} 秒</p>
                              {c.error && <p>{c.error}</p>}
                              {(c.problem_texts?.length ?? 0) > 0 ? <ul>{c.problem_texts!.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p>{checkText(memoryState.labels, c.checks)}</p>}
                              <p>实际带入：{(c.recalled ?? []).map((name) => memoryState.memories.find((m) => m.name === name)?.description || name).join('、') || '无'}</p>
                            </details>
                          </div>
                        ))}
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** 每场考试的对照分与试用分，按时间排开。 */
function ScoreCurve({ exams }: { exams: ExamResult[] }) {
  const width = 480;
  const height = 120;
  const pad = 24;
  const values = exams.flatMap((e) => [e.verdict.control_score, e.verdict.trial_score]);
  const lo = Math.min(0, ...values);
  const hi = Math.max(10, ...values);
  const x = (i: number) => (exams.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (exams.length - 1));
  const y = (v: number) => height - pad - ((v - lo) * (height - 2 * pad)) / (hi - lo || 1);
  const line = (pick: (e: ExamResult) => number) => exams.map((e, i) => `${x(i)},${y(pick(e))}`).join(' ');
  return (
    <figure className="score-curve">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每场考试的对照分与试用分">
        <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} className="axis" />
        <polyline points={line((e) => e.verdict.control_score)} className="control" />
        <polyline points={line((e) => e.verdict.trial_score)} className="trial" />
        {exams.map((e, i) => (
          <g key={e.id}>
            <circle cx={x(i)} cy={y(e.verdict.control_score)} r={3} className="control" />
            <circle cx={x(i)} cy={y(e.verdict.trial_score)} r={3} className="trial" />
            <text x={x(i)} y={height - 6} textAnchor="middle">
              {e.id.replace('exam-', '#')}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="small muted">
        <span className="curve-key control" /> 对照 <span className="curve-key trial" /> 试用
      </figcaption>
    </figure>
  );
}

/** 按渲染批次对比：评审要看「第二次比第一次好」，这里是机器量出来的那张表。 */
function RunsSection({ runs }: { runs: RunSummary[] }) {
  if (!runs.length) {
    return (
      <section className="memory-section">
        <h4>效果对比</h4>
        <p className="small muted">还没有渲染批次。每次 onset scene run / run-all 是一批。</p>
      </section>
    );
  }
  const [a, b] = runs.length >= 2 ? runs.slice(-2) : [null, runs[0]];
  const models = b ? Object.keys(b.by_model).sort() : [];
  const width = 480;
  const height = 120;
  const bar = Math.min(48, (width - 24) / runs.length - 8);
  return (
    <section className="memory-section">
      <h4>效果对比</h4>
      {a && b && (
        <div className="run-compare">
          <Delta label="一次通过率" from={pct(a.pass_rate)} to={pct(b.pass_rate)} better={b.pass_rate > a.pass_rate} worse={b.pass_rate < a.pass_rate} />
          <Delta label="重试" from={String(a.retries)} to={String(b.retries)} better={b.retries < a.retries} worse={b.retries > a.retries} />
          <Delta label="问题数" from={String(a.problems)} to={String(b.problems)} better={b.problems < a.problems} worse={b.problems > a.problems} />
          <Delta label="平均耗时" from={secs(a)} to={secs(b)} better={per(b.seconds, b) < per(a.seconds, a)} worse={per(b.seconds, b) > per(a.seconds, a)} />
          <Delta label="平均 token" from={tokens(a)} to={tokens(b)} better={false} worse={false} />
        </div>
      )}
      <figure className="score-curve">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每批的一次通过率">
          <line x1={12} x2={width - 12} y1={height - 24} y2={height - 24} className="axis" />
          {runs.map((r, i) => {
            const x = 12 + i * ((width - 24) / runs.length) + 4;
            const h = (height - 40) * r.pass_rate;
            return (
              <g key={r.run}>
                <rect x={x} y={height - 24 - h} width={bar} height={Math.max(h, 1)} className="run-bar" />
                <text x={x + bar / 2} y={height - 28 - h} textAnchor="middle">
                  {pct(r.pass_rate)}
                </text>
                <text x={x + bar / 2} y={height - 8} textAnchor="middle">
                  {r.run.slice(-6)}
                </text>
              </g>
            );
          })}
        </svg>
        <figcaption className="small muted">每批首次尝试就通过的镜头比例（事后检查查出问题的不算）</figcaption>
      </figure>
      {models.length > 0 && (
        <div className="exam-scroll">
          <table className="exam-table">
            <thead>
              <tr>
                <th>渲染工具/模型</th>
                {a && <th>上一批</th>}
                <th>最近一批</th>
              </tr>
            </thead>
            <tbody>
              {models.map((key) => (
                <tr key={key}>
                  <th className="mono">{key}</th>
                  {a && <td>{a.by_model[key] ? brief(a.by_model[key]) : '—'}</td>}
                  <td>{brief(b!.by_model[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Delta({ label, from, to, better, worse }: { label: string; from: string; to: string; better: boolean; worse: boolean }) {
  return (
    <div className={'run-delta' + (better ? ' better' : worse ? ' worse' : '')}>
      <span className="small muted">{label}</span>
      <strong>
        {from} → {to}
      </strong>
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const per = (total: number, s: RunStats) => (s.scenes ? total / s.scenes : 0);
const secs = (s: RunStats) => `${Math.round(per(s.seconds, s))}s`;
const tokens = (s: RunStats) => (s.input_tokens + s.output_tokens ? String(Math.round(per(s.input_tokens + s.output_tokens, s))) : '—');
const brief = (s: RunStats) => `${s.passed_first_try}/${s.scenes} 一次通过 · 重试 ${s.retries} · 问题 ${s.problems}`;
