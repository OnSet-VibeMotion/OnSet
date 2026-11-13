import { useEffect, useState } from 'preact/hooks';
import { api, errorText, post, rawURL } from '../api';
import type { ExamResult, MemoryRow, MemoryState, MemoryStatus, MemorySuspect, RecallResponse, RunStats, RunSummary, Scene } from '../types';
import type { RunAction } from './Preview';

const statusLabel: Record<MemoryStatus, string> = { active: '生效', trial: '试用', rejected: '被拒', dormant: '沉睡' };
const statusOrder: MemoryStatus[] = ['active', 'trial', 'dormant', 'rejected'];

interface Props {
  scene: Scene | null;
  version: number;
  run: RunAction;
}

/** 记忆面板：本镜头想起了什么、记忆库、考试矩阵、时间线。改动一律经 am memory 子命令。 */
export function MemoryTab({ scene, version, run }: Props) {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState('');
  const [renderers, setRenderers] = useState('claude,codex');
  const [examIndex, setExamIndex] = useState(-1);
  const [rollbackTo, setRollbackTo] = useState(0);
  const [preference, setPreference] = useState('');
  const [globalPreference, setGlobalPreference] = useState(false);
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    api<MemoryState>('/api/memory').then(
      (result) => {
        setState(result);
        setError('');
        setExamIndex(result.exams.length - 1);
      },
      (err) => setError(errorText(err)),
    );
  }, [version, refresh]);

  const remember = async () => {
    setNotice('');
    try {
      const result = await post<{ message: string }>('/api/memory/actions/remember', { note: preference.trim(), global: globalPreference });
      setNotice(result.message);
      setPreference('');
      setRefresh((n) => n + 1);
    } catch (err) {
      setNotice(errorText(err));
    }
  };

  if (error) return <div class="empty">{error}</div>;
  if (!state) return <div class="empty">正在读取记忆库…</div>;

  const exam = state.exams[examIndex] ?? null;
  const pendingPreferences = state.memories.filter((m) => m.kind === 'preference' && m.status === 'trial');
  const pendingLessons = state.memories.filter((m) => m.kind === 'lesson' && m.status === 'trial' && !m.examinable);
  const previous = state.snapshots.filter((id) => id !== state.status.snapshot);
  return (
    <div class="memory-tab">
      <div class="toolbar">
        <span class={state.enabled ? 'status-ok' : 'status-todo'}>{state.enabled ? '记忆已打开' : '记忆已关闭（MEMORY=off）'}</span>
        <span class="chip mono">快照 #{state.status.snapshot || '—'}</span>
        {state.pinned > 0 && <span class="chip mono">钉住 #{state.pinned}</span>}
        <span class="small muted">
          经历 {state.status.episodes} 段 · 待整理失败 {state.status.pending_failures} 段 · 召回预算 {state.budget} 字
        </span>
        <span class="spacer" />
        <button onClick={() => run('/api/memory/actions/consolidate')}>整理</button>
        <input
          class="memory-input mono"
          value={renderers}
          aria-label="参加考试的渲染工具"
          onInput={(e) => setRenderers(e.currentTarget.value)}
        />
        <button
          class="primary"
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
      </div>

      {(pendingPreferences.length > 0 || pendingLessons.length > 0) && (
        <div class="banner">
          有 {pendingPreferences.length + pendingLessons.length} 条记忆等你确认：
          {[...pendingPreferences, ...pendingLessons].map((m) => m.description).join('；')}。在下方记忆库里确认或拒绝，或者直接在对话里回答。
        </div>
      )}

      <RunsSection runs={state.runs} />

      <section class="memory-section">
        <h4>记住一条偏好</h4>
        <p class="small muted">用户亲口说的取向当场生效：编排工具每次开工前会读到它，渲染时也会召回。对话里说「以后都…」时编排工具会自己记。</p>
        <div class="toolbar">
          <input
            class="feedback-note memory-preference"
            value={preference}
            placeholder="例如：节奏慢一点，每个画面多停一秒"
            aria-label="偏好内容"
            onInput={(e) => setPreference(e.currentTarget.value)}
          />
          <label class="small">
            <input type="checkbox" checked={globalPreference} onChange={(e) => setGlobalPreference(e.currentTarget.checked)} /> 所有项目
          </label>
          <button disabled={!preference.trim()} onClick={remember}>
            记住
          </button>
        </div>
        {notice && <p class="small muted">{notice}</p>}
      </section>

      <RecallSection scene={scene} version={version + refresh} />

      <section class="memory-section">
        <h4>记忆库</h4>
        {state.memories.length === 0 && <p class="small muted">还没有记忆。渲染失败的经历攒够后点「整理」。</p>}
        {statusOrder.map((status) => {
          const rows = state.memories.filter((m) => m.status === status);
          if (!rows.length) return null;
          return (
            <div key={status} class="memory-group">
              <div class="memory-group-title">
                {statusLabel[status]} · {rows.length}
              </div>
              {rows.map((m) => (
                <MemoryCard
                  key={m.name}
                  memory={m}
                  weak={state.status.weak.some((w) => w.name === m.name)}
                  retest={state.status.retest.filter((r) => r.name === m.name)}
                  suspect={(state.status.suspect ?? []).filter((x) => x.name === m.name)}
                  run={run}
                />
              ))}
            </div>
          );
        })}
      </section>

      <section class="memory-section">
        <div class="toolbar">
          <h4>考试矩阵</h4>
          <span class="spacer" />
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
          <h4>时间线</h4>
          <span class="spacer" />
          {previous.length > 0 && (
            <>
              <select value={rollbackTo} aria-label="回退目标快照" onChange={(e) => setRollbackTo(Number(e.currentTarget.value))}>
                <option value={0}>回退到…</option>
                {previous.map((id) => (
                  <option key={id} value={id}>
                    快照 #{id}
                  </option>
                ))}
              </select>
              <button disabled={!rollbackTo} onClick={() => run('/api/memory/actions/rollback', { to: rollbackTo })}>
                回退
              </button>
            </>
          )}
        </div>
        <ol class="memory-timeline">
          {state.timeline.map((event, index) => (
            <li key={index} class={'event-' + event.type}>
              <span class="mono small muted">{event.time.replace('T', ' ').replace('Z', '')}</span>
              <span class="chip mono">{event.type}</span>
              <span>{event.summary}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function RecallSection({ scene, version }: { scene: Scene | null; version: number }) {
  const [recall, setRecall] = useState<RecallResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setRecall(null);
    setError('');
    if (!scene) return;
    api<RecallResponse>(`/api/memory/recall?scene=${encodeURIComponent(scene.id)}`).then(setRecall, (err) => setError(errorText(err)));
  }, [scene?.id, version]);
  return (
    <section class="memory-section">
      <h4>本镜头想起了什么{scene ? `：${scene.id}` : ''}</h4>
      {recall && (
        <p class="small muted">
          渲染工具 {recall.recall.renderer} · 模型 {recall.recall.model || '未知（限定了模型的经验不召回）'}
        </p>
      )}
      {!scene && <p class="small muted">还没有镜头：分镜完成后，这里会显示每个镜头渲染前想起了哪些记忆。</p>}
      {error && <p class="error-line">{error}</p>}
      {recall && (
        <>
          <div class="memory-features">
            {recall.recall.features.map((f) => (
              <span key={f} class="chip mono">
                {f}
              </span>
            ))}
          </div>
          {recall.recall.items.length === 0 ? (
            <p class="small muted">没有召回任何记忆。</p>
          ) : (
            <ul class="memory-recall">
              {recall.recall.items.map((item, index) => (
                <li key={item.name}>
                  <strong class="mono">{item.name}</strong>
                  {item.kind === 'preference' && <span class="memory-unverified">偏好 · 未经机器验证</span>}
                  <span>{item.description}</span>
                  <span class="small muted">
                    {recall.reasons[index]} · 得分 {item.score.toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p class="small muted">
            用去 {recall.recall.used} / {recall.recall.budget} 字
            {recall.recall.omitted?.length ? `，${recall.recall.omitted.length} 条超出预算或条数上限（${recall.recall.max_lessons} 条经验）未注入` : ''}
          </p>
        </>
      )}
    </section>
  );
}

function MemoryCard({
  memory,
  weak,
  retest,
  suspect,
  run,
}: {
  memory: MemoryRow;
  weak: boolean;
  retest: MemoryState['status']['retest'];
  suspect: MemorySuspect[];
  run: RunAction;
}) {
  const [open, setOpen] = useState(false);
  const stats = Object.entries(memory.stats ?? {});
  return (
    <div class="memory-card">
      <div class="toolbar">
        <button class="link mono" onClick={() => setOpen(!open)} aria-expanded={open}>
          {memory.name}
        </button>
        {memory.kind === 'preference' && <span class="memory-unverified">偏好 · 未经机器验证</span>}
        {weak && <span class="status-stale">待沉睡</span>}
        {suspect.length > 0 && (
          <span
            class="status-stale"
            title={suspect.map((x) => `${x.renderer}：召回 ${x.recalled} 次，其中 ${x.harmful} 次它要防的 ${x.checks.join('、')} 照样失败`).join('\n')}
          >
            可疑
          </span>
        )}
        <span class="spacer" />
        {memory.status === 'trial' && memory.kind === 'lesson' && !memory.examinable && <span class="memory-unverified">整片检查判定 · 考不了，需人工确认</span>}
        {memory.status === 'trial' && (
          <>
            {(memory.kind === 'preference' || !memory.examinable) && (
              <button onClick={() => run('/api/memory/actions/promote', { name: memory.name })}>确认生效</button>
            )}
            <button onClick={() => run('/api/memory/actions/reject', { name: memory.name })}>拒绝</button>
          </>
        )}
        {memory.status === 'active' && weak && <button onClick={() => run('/api/memory/actions/retire', { name: memory.name })}>沉睡</button>}
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
            模型已换，重考（{r.renderer}）
          </button>
        ))}
      </div>
      <p>{memory.description}</p>
      <p class="small muted">
        {memory.checked_by.join('、')}
        {memory.applies_when.features?.length ? ` · 特征 ${memory.applies_when.features.join('、')}` : ''}
        {memory.applies_when.renderers?.length || memory.applies_when.models?.length
          ? ` · 专为 ${[...(memory.applies_when.renderers ?? []), ...(memory.applies_when.models ?? [])].join('、')}`
          : ''}
        {memory.scope ? ` · 限项目 ${memory.scope}` : memory.kind === 'preference' ? ' · 所有项目' : ''}
        {memory.from_episodes?.length ? ` · 来自 ${memory.from_episodes.length} 段经历` : ''}
        {memory.verified_by?.length ? ` · 经 ${memory.verified_by.join('、')} 验证` : ''}
        {memory.revises ? ` · 修订 ${memory.revises}` : ''}
      </p>
      {stats.length > 0 && (
        <p class="small mono">
          {stats.map(([renderer, s]) => `${renderer} ${s.passed_first_try}/${s.recalled}`).join('  ·  ')}
        </p>
      )}
      {memory.rejected_reason && <p class="error-line">{memory.rejected_reason}</p>}
      {open && <pre class="memory-body">{memory.body}</pre>}
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
        <span class="legend control" /> 对照 <span class="legend trial" /> 试用
      </figcaption>
    </figure>
  );
}

/** 按渲染批次对比：评审要看「第二次比第一次好」，这里是机器量出来的那张表。 */
function RunsSection({ runs }: { runs: RunSummary[] }) {
  if (!runs.length) {
    return (
      <section class="memory-section">
        <h4>运行对比</h4>
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
      <h4>运行对比</h4>
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
