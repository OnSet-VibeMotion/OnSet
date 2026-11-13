import { useEffect, useState } from 'preact/hooks';
import { api, errorText, post, rawURL } from '../api';
import '../memory.css';
import type { ExamResult, MemoryEvent, MemoryRow, MemoryState, MemoryStatus, MemorySuspect, RecallResponse, RunStats, RunSummary, Scene } from '../types';
import type { RunAction } from './Preview';

type Labels = MemoryState['labels'];

const label = (table: Record<string, string> | undefined, id: string) => table?.[id] ?? id;
const checkText = (labels: Labels, ids: readonly string[] | null | undefined) => (ids ?? []).map((id) => label(labels?.checks, id)).join('、');

interface Props {
  scene: Scene | null;
  version: number;
  run: RunAction;
}

/**
 * 记忆面板。先回答用户关心的三件事：记住了我什么、从失败里学到了什么、这个镜头会用上哪几条；
 * 再列本项目最近发生的事。考试、批次对比、存档与回退是维护用的，收进「高级」。
 * 面板上不直接露出校验器 ID、事件类型和特征名，一律经 labels 换成大白话。改动一律经 am memory 子命令。
 */
export function MemoryTab({ scene, version, run }: Props) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api<MemoryState>('/api/memory').then(
      (result) => {
        setState(result);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version, refresh]);

  if (error) return <div class="empty">{error}</div>;
  if (!state) return <div class="empty">正在读取记忆…</div>;

  const labels = state.labels;
  const pending = state.memories.filter((m) => m.status === 'trial' && (m.kind === 'preference' || !m.examinable));
  const preferences = state.memories.filter((m) => m.kind === 'preference' && m.status === 'active');
  const lessons = state.memories.filter((m) => m.kind === 'lesson' && (m.status === 'active' || (m.status === 'trial' && m.examinable)));
  const retired = state.memories.filter((m) => m.status === 'dormant' || m.status === 'rejected');
  const card = (m: MemoryRow) => (
    <MemoryCard
      key={m.name}
      memory={m}
      labels={labels}
      weak={state.status.weak.some((w) => w.name === m.name)}
      retest={state.status.retest.filter((r) => r.name === m.name)}
      suspect={(state.status.suspect ?? []).filter((x) => x.name === m.name)}
      run={run}
    />
  );

  return (
    <div class="memory-tab">
      <header class="memory-intro">
        <div>
          <span class="eyebrow">记忆 · {state.enabled ? '已打开' : '已关闭'} · 所有项目共用</span>
          <strong>am 记得什么</strong>
          <p class="small muted">
            {state.enabled
              ? '你说过的偏好，和从渲染失败里总结的经验。下次渲染类似的镜头时，相关的几条会自动交给渲染工具。'
              : '项目配置里 MEMORY=off，渲染时不会想起任何记忆，也不记录新的经历。'}
          </p>
        </div>
      </header>

      {pending.length > 0 && (
        <section class="memory-section memory-pending">
          <h4>等你确认 · {pending.length}</h4>
          <p class="small muted">这些是推测出来的，你认可之后才会生效。也可以直接在对话里回答。</p>
          {pending.map(card)}
        </section>
      )}

      <section class="memory-section">
        <h4>你的偏好 · {preferences.length}</h4>
        {preferences.length === 0 ? (
          <p class="small muted">还没有。在对话里说「以后都……」会自动记下，也可以在这里直接写。</p>
        ) : (
          preferences.map(card)
        )}
        <RememberForm onDone={() => setRefresh((n) => n + 1)} />
      </section>

      <section class="memory-section">
        <div class="toolbar">
          <h4>学到的经验 · {lessons.length}</h4>
          <span class="spacer" />
          {state.status.pending_failures > 0 && (
            <>
              <span class="small muted">有 {state.status.pending_failures} 次失败还没总结</span>
              <button onClick={() => run('/api/memory/actions/consolidate')}>总结成经验</button>
            </>
          )}
        </div>
        {lessons.length === 0 ? (
          <p class="small muted">
            还没有。渲染失败或检查查出问题时会记下来，攒够几次后点「总结成经验」，新经验先经过对照考试再生效。
          </p>
        ) : (
          lessons.map(card)
        )}
        {retired.length > 0 && (
          <details class="memory-retired">
            <summary class="small muted">已停用 · {retired.length}</summary>
            {retired.map(card)}
          </details>
        )}
      </section>

      <RecallSection scene={scene} version={version + refresh} labels={labels} />

      <ActivitySection state={state} />

      <details class="memory-advanced">
        <summary>高级：效果对比、考试、存档</summary>
        <AdvancedSection state={state} version={version} run={run} />
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
      <div class="toolbar">
        <input
          class="feedback-note memory-preference"
          value={text}
          placeholder="例如：节奏慢一点，每个画面多停一秒"
          aria-label="偏好内容"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) submit();
          }}
        />
        <label class="small">
          <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.currentTarget.checked)} /> 用于所有项目
        </label>
        <button disabled={!text.trim()} onClick={submit}>
          记住
        </button>
      </div>
      {notice && <p class="small muted">{notice}</p>}
    </>
  );
}

function RecallSection({ scene, version, labels }: { scene: Scene | null; version: number; labels: Labels }) {
  const [recall, setRecall] = useState<RecallResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setRecall(null);
    setError('');
    if (!scene) return;
    api<RecallResponse>(`/api/memory/recall?scene=${encodeURIComponent(scene.id)}`).then(setRecall, (err) => setError(errorText(err)));
  }, [scene?.id, version]);
  const items = recall?.recall.items ?? [];
  return (
    <section class="memory-section">
      <h4>{scene ? `渲染 ${scene.id} 时会用上` : '渲染时会用上'}</h4>
      {!scene && <p class="small muted">还没有镜头。分镜完成后，这里显示每个镜头渲染前会想起哪几条。</p>}
      {error && <p class="error-line">{error}</p>}
      {recall &&
        (items.length === 0 ? (
          <p class="small muted">没有相关的记忆，这个镜头会按默认做法渲染。</p>
        ) : (
          <ul class="memory-recall">
            {items.map((item) => (
              <li key={item.name}>
                <span class="memory-kind">{item.kind === 'preference' ? '偏好' : '经验'}</span>
                <span>{item.description}</span>
              </li>
            ))}
          </ul>
        ))}
      {recall && recall.recall.features.length > 0 && (
        <p class="small muted">
          这个镜头：{recall.recall.features.map((f) => label(labels?.features, f)).join('、')}
          {recall.recall.omitted?.length ? `。另有 ${recall.recall.omitted.length} 条相关但没放进去（每个镜头最多 ${recall.recall.max_lessons} 条经验）` : ''}
        </p>
      )}
    </section>
  );
}

/** 本项目最近的事，写成一句话。 */
function ActivitySection({ state }: { state: MemoryState }) {
  const [more, setMore] = useState(false);
  const events = state.timeline.filter((e) => (e.type === 'episode' ? e.project === state.project : !e.project || e.project === state.project));
  const shown = more ? events : events.slice(0, 8);
  return (
    <section class="memory-section">
      <h4>最近</h4>
      {events.length === 0 ? (
        <p class="small muted">这个项目还没有和记忆有关的事。渲染、检查、总结和记下的偏好会出现在这里。</p>
      ) : (
        <ol class="memory-activity">
          {shown.map((event, index) => {
            const { text, tone } = describe(event, state.labels);
            return (
              <li key={index} class={tone}>
                <span class="memory-time">{when(event.time)}</span>
                <span>{text}</span>
              </li>
            );
          })}
        </ol>
      )}
      {events.length > 8 && (
        <button class="link small" onClick={() => setMore(!more)}>
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
  const exam = state.exams[examIndex] ?? null;
  const previous = state.snapshots.filter((id) => id !== state.status.snapshot);
  const others = state.timeline.filter((e) => e.type === 'episode' && e.project !== state.project);
  return (
    <div class="memory-advanced-body">
      <p class="small muted">
        记忆库 {state.dir} · 当前存档 #{state.status.snapshot || '—'}
        {state.pinned > 0 ? `（项目钉在 #${state.pinned}）` : ''} · 共 {state.status.episodes} 段经历 · 每个镜头最多注入 {state.budget} 字
      </p>

      <RunsSection runs={state.runs} />

      <section class="memory-section">
        <div class="toolbar">
          <h4>考试</h4>
          <span class="small muted">新经验先用这些渲染工具做对照考试，通过了才生效</span>
          <span class="spacer" />
          <input class="memory-input mono" value={renderers} aria-label="参加考试的渲染工具" onInput={(e) => setRenderers(e.currentTarget.value)} />
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
        {exam ? <ExamMatrix exam={exam} version={version} /> : <p class="small muted">还没有考试。</p>}
        {state.exams.length > 0 && <ScoreCurve exams={state.exams} />}
      </section>

      <section class="memory-section">
        <div class="toolbar">
          <h4>存档与回退</h4>
          <span class="small muted">记忆每次变化都存一份，可以整体退回到之前的某一份</span>
          <span class="spacer" />
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
            <span class="small muted">还没有可回退的存档</span>
          )}
        </div>
      </section>

      {others.length > 0 && (
        <section class="memory-section">
          <label class="small">
            <input type="checkbox" checked={allProjects} onChange={(e) => setAllProjects(e.currentTarget.checked)} /> 显示其他项目最近的 {others.length} 次渲染
          </label>
          {allProjects && (
            <ol class="memory-activity">
              {others.map((event, index) => {
                const { text, tone } = describe(event, state.labels);
                return (
                  <li key={index} class={tone}>
                    <span class="memory-time">{when(event.time)}</span>
                    <span class="muted">{event.project || '（未记项目）'}</span>
                    <span>{text}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}

const statusText: Record<MemoryStatus, string> = { active: '', trial: '试用中', rejected: '已拒绝', dormant: '已停用' };

function MemoryCard({
  memory,
  labels,
  weak,
  retest,
  suspect,
  run,
}: {
  memory: MemoryRow;
  labels: Labels;
  weak: boolean;
  retest: MemoryState['status']['retest'];
  suspect: MemorySuspect[];
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
    <div class="memory-card">
      <div class="memory-card-head">
        <p class="memory-desc">{memory.description}</p>
        <div class="memory-card-actions">
          {statusText[memory.status] && <span class="memory-badge">{statusText[memory.status]}</span>}
          {weak && <span class="memory-badge warn" title="最近用上它的镜头通过率不比没用时高">效果不明显</span>}
          {suspect.length > 0 && (
            <span
              class="memory-badge warn"
              title={suspect.map((x) => `${x.renderer}：用了 ${x.recalled} 次，其中 ${x.harmful} 次它要防的问题照样出现`).join('\n')}
            >
              可能没用
            </span>
          )}
          {memory.status === 'trial' && (
            <>
              {(memory.kind === 'preference' || !memory.examinable) && (
                <button class="primary" onClick={() => run('/api/memory/actions/promote', { name: memory.name })}>
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
      {facts.length > 0 && <p class="small muted">{facts.join(' · ')}</p>}
      {memory.status === 'trial' && memory.kind === 'lesson' && !memory.examinable && (
        <p class="small muted">这条要看整片才能判断有没有用，没法自动考试，需要你确认。</p>
      )}
      {memory.rejected_reason && <p class="error-line">{memory.rejected_reason}</p>}
      <button class="link small" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? '收起全文' : '查看全文'}
      </button>
      {open && (
        <>
          <pre class="memory-body">{memory.body}</pre>
          <p class="small muted mono">
            {memory.name}
            {memory.revises ? ` · 修订自 ${memory.revises}` : ''}
            {memory.verified_by?.length ? ` · 考试 ${memory.verified_by.join('、')}` : ''}
          </p>
        </>
      )}
    </div>
  );
}

function ExamMatrix({ exam, version }: { exam: ExamResult; version: number }) {
  const verdict = exam.verdict;
  const state = verdict.invalid ? '无效' : verdict.needs_human ? '待人工确认' : verdict.pass ? '通过' : '未通过';
  return (
    <div class="exam">
      <p>
        <strong>{exam.id}</strong> · {state} · 试用 {exam.trials.join('、')} · 对照 {verdict.control_score.toFixed(1)} 分 → 试用{' '}
        {verdict.trial_score.toFixed(1)} 分
      </p>
      {verdict.reasons.length > 0 && (
        <ul class="issues">
          {verdict.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div class="exam-scroll">
        <table class="exam-table">
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
                  {q.id} <span class="small muted">{q.scene_id}{q.holdout ? ' · 留出' : ''}</span>
                </th>
                {exam.renderers.map((r) =>
                  (['control', 'trial'] as const).map((arm) => {
                    const cells = exam.cells.filter((c) => c.question === q.id && c.renderer === r && c.arm === arm);
                    return (
                      <td key={r + arm}>
                        {cells.map((c, i) => (
                          <div
                            key={i}
                            class={'exam-cell ' + (c.invalid ? 'invalid' : c.passed ? 'pass' : 'fail')}
                            title={[c.model, c.error || (c.checks ?? []).join('\n')].filter(Boolean).join('\n')}
                          >
                            {c.output && <video src={rawURL(c.output, version) + '#t=0.5'} preload="metadata" muted />}
                            <span>{c.invalid ? '⚠' : c.passed ? '✅' : `❌ ${c.problems}`}</span>
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
    <figure class="score-curve">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每场考试的对照分与试用分">
        <line x1={pad} x2={width - pad} y1={y(0)} y2={y(0)} class="axis" />
        <polyline points={line((e) => e.verdict.control_score)} class="control" />
        <polyline points={line((e) => e.verdict.trial_score)} class="trial" />
        {exams.map((e, i) => (
          <g key={e.id}>
            <circle cx={x(i)} cy={y(e.verdict.control_score)} r={3} class="control" />
            <circle cx={x(i)} cy={y(e.verdict.trial_score)} r={3} class="trial" />
            <text x={x(i)} y={height - 6} text-anchor="middle">
              {e.id.replace('exam-', '#')}
            </text>
          </g>
        ))}
      </svg>
      <figcaption class="small muted">
        <span class="curve-key control" /> 对照 <span class="curve-key trial" /> 试用
      </figcaption>
    </figure>
  );
}

/** 按渲染批次对比：评审要看「第二次比第一次好」，这里是机器量出来的那张表。 */
function RunsSection({ runs }: { runs: RunSummary[] }) {
  if (!runs.length) {
    return (
      <section class="memory-section">
        <h4>效果对比</h4>
        <p class="small muted">还没有渲染批次。每次 am scene run / run-all 是一批。</p>
      </section>
    );
  }
  const [a, b] = runs.length >= 2 ? runs.slice(-2) : [null, runs[0]];
  const models = b ? Object.keys(b.by_model).sort() : [];
  const width = 480;
  const height = 120;
  const bar = Math.min(48, (width - 24) / runs.length - 8);
  return (
    <section class="memory-section">
      <h4>效果对比</h4>
      {a && b && (
        <div class="run-compare">
          <Delta label="一次通过率" from={pct(a.pass_rate)} to={pct(b.pass_rate)} better={b.pass_rate > a.pass_rate} worse={b.pass_rate < a.pass_rate} />
          <Delta label="重试" from={String(a.retries)} to={String(b.retries)} better={b.retries < a.retries} worse={b.retries > a.retries} />
          <Delta label="问题数" from={String(a.problems)} to={String(b.problems)} better={b.problems < a.problems} worse={b.problems > a.problems} />
          <Delta label="平均耗时" from={secs(a)} to={secs(b)} better={per(b.seconds, b) < per(a.seconds, a)} worse={per(b.seconds, b) > per(a.seconds, a)} />
          <Delta label="平均 token" from={tokens(a)} to={tokens(b)} better={false} worse={false} />
        </div>
      )}
      <figure class="score-curve">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每批的一次通过率">
          <line x1={12} x2={width - 12} y1={height - 24} y2={height - 24} class="axis" />
          {runs.map((r, i) => {
            const x = 12 + i * ((width - 24) / runs.length) + 4;
            const h = (height - 40) * r.pass_rate;
            return (
              <g key={r.run}>
                <rect x={x} y={height - 24 - h} width={bar} height={Math.max(h, 1)} class="run-bar" />
                <text x={x + bar / 2} y={height - 28 - h} text-anchor="middle">
                  {pct(r.pass_rate)}
                </text>
                <text x={x + bar / 2} y={height - 8} text-anchor="middle">
                  {r.run.slice(-6)}
                </text>
              </g>
            );
          })}
        </svg>
        <figcaption class="small muted">每批首次尝试就通过的镜头比例（事后检查查出问题的不算）</figcaption>
      </figure>
      {models.length > 0 && (
        <div class="exam-scroll">
          <table class="exam-table">
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
                  <th class="mono">{key}</th>
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
    <div class={'run-delta' + (better ? ' better' : worse ? ' worse' : '')}>
      <span class="small muted">{label}</span>
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
