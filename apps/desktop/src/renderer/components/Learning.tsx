import { useEffect, useState } from 'react';
import { api, errorText, post } from '../api';
import '../learning.css';
import type { LearningProposal, LearningRelation, LearningState, Scene } from '../types';
import type { RunAction } from './Preview';

interface Props {
  version: number;
  scenes: Scene[];
  sceneId: string;
  run: RunAction;
  onAudition: () => void;
}

/** 「渲染工具/模型」写成人读的样子：claude · opus。 */
export function keyLabel(key: string): string {
  const designed = key.split('<');
  const one = (k: string) => {
    const at = k.indexOf('/');
    return at < 0 ? k : `${k.slice(0, at)} · ${k.slice(at + 1)}`;
  };
  return designed.length > 1 ? `${one(designed[0])}（照 ${one(designed[1])} 的设计稿）` : one(key);
}

/**
 * 进化页的「谁向谁学」：评判累积出的提议、人确认的学习关系、每条关系的进度曲线、学来的经验，
 * 以及「向老师学」「人评考试」两个动作。老师不写死，全由你在试镜里的评判定。
 */
export function LearningSection({ version, scenes, sceneId, run, onAudition }: Props) {
  const [state, setState] = useState<LearningState | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api<LearningState>('/api/learning').then(
      (r) => {
        setState(r);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  }, [version, tick]);

  const refresh = () => setTick((n) => n + 1);
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (error && !state) return <section className="evidence-section learning"><h3>谁向谁学</h3><p className="muted">{error}</p></section>;
  if (!state) return null;
  const proposals = state.proposals ?? [];

  return (
    <section className="evidence-section learning">
      <div className="evidence-bar">
        <h3>谁向谁学</h3>
        <span className="spacer" />
        <span className="learning-sub">
          {state.verdicts} 场评判 · {state.exemplars} 份范例
        </span>
      </div>
      <p className="learning-lede">
        谁是老师不由我们定：你在试镜里的每一次选择都记下来，某一位在一类镜头上总是赢另一位时，这里会提议让输的那一位向它学。
        你点头之后，它会把老师赢下的那几场整理成学生的经验、带上老师的代码当范例，再用人评考试确认学得对不对。
      </p>

      {state.verdicts === 0 && (
        <div className="learning-empty">
          <p>还没有评判。到镜头页「⋯」→「试镜」，让几个模型各拍一遍、选出最好的一份。</p>
          <button onClick={onAudition}>去试镜</button>
        </div>
      )}

      {proposals.length > 0 && (
        <ul className="learning-proposals">
          {proposals.map((p) => (
            <Proposal key={p.student + p.teacher + p.features.join(',')} p={p} onConfirm={() => act(() => post('/api/learning/relations', { student: p.student, teacher: p.teacher, features: p.features }))} onDismiss={() => act(() => post('/api/learning/dismiss', { student: p.student, teacher: p.teacher, features: p.features }))} />
          ))}
        </ul>
      )}

      {state.relations.map((r) => (
        <RelationCard
          key={r.id}
          r={r}
          scenes={scenes}
          sceneId={sceneId}
          onLearn={() => run(`/api/learning/relations/${r.id}/learn`)}
          onExam={(scene) => run(`/api/learning/relations/${r.id}/exam`, { scene_id: scene })}
          onRemove={() => act(() => api(`/api/learning/relations/${r.id}`, { method: 'DELETE' }))}
        />
      ))}
      {error && <p className="error-line">{error}</p>}
    </section>
  );
}

function Proposal({ p, onConfirm, onDismiss }: { p: LearningProposal; onConfirm: () => void; onDismiss: () => void }) {
  return (
    <li className="learning-proposal">
      <div>
        <p>
          {p.features.length > 0 && <span className="learning-chip">{p.features.join('、')} 类镜头</span>}
          <strong>{keyLabel(p.student)}</strong> 在 {p.matches} 场里输给 <strong>{keyLabel(p.teacher)}</strong> {p.teacher_wins} 场
          {p.ties > 0 ? `、平 ${p.ties} 场` : ''}
          {!p.enough && <span className="learning-chip warn">样本少</span>}
        </p>
        <small className="muted">让 {keyLabel(p.student)} 向 {keyLabel(p.teacher)} 学？</small>
      </div>
      <div className="learning-actions">
        <button className={p.enough ? 'primary' : ''} onClick={onConfirm}>
          让它学
        </button>
        <button className="ghost" onClick={onDismiss}>
          不用
        </button>
      </div>
    </li>
  );
}

const statusName: Record<string, string> = { active: '正在用', trial: '待考试', rejected: '没留下', dormant: '已停用' };

function RelationCard({
  r,
  scenes,
  sceneId,
  onLearn,
  onExam,
  onRemove,
}: {
  r: LearningRelation;
  scenes: Scene[];
  sceneId: string;
  onLearn: () => void;
  onExam: (scene: string) => void;
  onRemove: () => void;
}) {
  const [examScene, setExamScene] = useState(sceneId || scenes[0]?.id || '');
  const trial = r.lessons.filter((l) => l.status === 'trial');
  const active = r.lessons.filter((l) => l.status === 'active');
  const last = r.progress.points.at(-1);
  return (
    <article className="learning-relation">
      <header>
        <p className="learning-pair">
          <strong>{keyLabel(r.student)}</strong>
          <span className="learning-arrow">向</span>
          <strong>{keyLabel(r.teacher)}</strong>
          <span className="learning-arrow">学</span>
          {r.features.length > 0 && <span className="learning-chip">{r.features.join('、')} 类镜头</span>}
        </p>
        <button className="ghost small" onClick={onRemove}>
          去掉
        </button>
      </header>

      <Curve r={r} />
      <p className="learning-facts">
        {r.progress.points.length === 0
          ? '还没有正面比过'
          : `正面比了 ${r.progress.points.length} 场，最近 5 场学生的胜率 ${Math.round((last?.rate ?? 0) * 100)}%`}
        {r.progress.exams.length > 0 && ` · 人评考试 ${r.progress.exams.length} 场，${r.progress.exams.filter((e) => e.result === 'trial').length} 场选了带经验的`}
        {` · 老师的范例 ${r.exemplars} 份`}
      </p>

      {r.lessons.length > 0 && (
        <ul className="learning-lessons">
          {r.lessons.map((l) => (
            <li key={l.name}>
              <span className={'learning-chip' + (l.status === 'active' ? ' on' : '')}>{statusName[l.status] ?? l.status}</span>
              <span>{l.description}</span>
              <details>
                <summary>它对学生说了什么</summary>
                <pre>{l.body}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}

      <div className="learning-actions">
        <button onClick={onLearn} disabled={r.learnable === 0} title={r.learnable === 0 ? '老师赢过学生、还没学过的试镜一场都没有：先多比几场' : ''}>
          向老师学{r.learnable > 0 ? `（${r.learnable} 场可学）` : ''}
        </button>
        {trial.length > 0 && scenes.length > 0 && (
          <span className="learning-exam">
            <select value={examScene} aria-label="考试用的镜头" onChange={(e) => setExamScene(e.currentTarget.value)}>
              {scenes.map((s, i) => (
                <option key={s.id} value={s.id}>
                  镜头 {String(i + 1).padStart(2, '0')}
                </option>
              ))}
            </select>
            <button className="primary" onClick={() => onExam(examScene)}>
              人评考试（{trial.length} 条待考）
            </button>
          </span>
        )}
        {active.length > 0 && <span className="muted small">{active.length} 条已生效，学生渲染时会带上</span>}
      </div>
    </article>
  );
}

/** 学生对老师的胜率曲线（最近 5 场滚动），人评考试画成下面一排点：实心是选了带经验的。 */
function Curve({ r }: { r: LearningRelation }) {
  const pts = r.progress.points;
  if (pts.length === 0 && r.progress.exams.length === 0) return null;
  const w = 320;
  const h = 72;
  const pad = 6;
  const x = (i: number, n: number) => pad + (n <= 1 ? (w - pad * 2) / 2 : (i * (w - pad * 2)) / (n - 1));
  const y = (rate: number) => pad + (1 - rate) * (h - 24 - pad);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i, pts.length).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ');
  return (
    <svg className="learning-curve" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="学生对老师的胜率">
      <line x1={pad} x2={w - pad} y1={y(0.5)} y2={y(0.5)} className="mid" />
      {pts.length > 1 && <path d={line} className="rate" />}
      {pts.map((p, i) => (
        <circle key={p.audition} cx={x(i, pts.length)} cy={y(p.rate)} r={3} className={'pt ' + p.result}>
          <title>{p.result === 'win' ? '学生赢' : p.result === 'loss' ? '老师赢' : '差不多'}</title>
        </circle>
      ))}
      {r.progress.exams.map((e, i) => (
        <circle key={e.audition} cx={x(i, r.progress.exams.length)} cy={h - 8} r={4} className={'exam ' + e.result}>
          <title>{e.result === 'trial' ? '人评考试：选了带经验的' : e.result === 'control' ? '人评考试：选了不带经验的' : '人评考试：差不多'}</title>
        </circle>
      ))}
    </svg>
  );
}
