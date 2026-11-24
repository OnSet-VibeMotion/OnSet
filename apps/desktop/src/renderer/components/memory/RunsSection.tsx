import type { ExamResult, RunSummary } from '../../types';
import { brief, pct, per, secs, tokens } from './helpers';

/** 每场考试的对照分与试用分，按时间排开。 */
export function ScoreCurve({ exams }: { exams: ExamResult[] }) {
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
export function RunsSection({ runs }: { runs: RunSummary[] }) {
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
          <Delta
            label="一次通过率"
            from={pct(a.pass_rate)}
            to={pct(b.pass_rate)}
            better={b.pass_rate > a.pass_rate}
            worse={b.pass_rate < a.pass_rate}
          />
          <Delta
            label="重试"
            from={String(a.retries)}
            to={String(b.retries)}
            better={b.retries < a.retries}
            worse={b.retries > a.retries}
          />
          <Delta
            label="问题数"
            from={String(a.problems)}
            to={String(b.problems)}
            better={b.problems < a.problems}
            worse={b.problems > a.problems}
          />
          <Delta
            label="平均耗时"
            from={secs(a)}
            to={secs(b)}
            better={per(b.seconds, b) < per(a.seconds, a)}
            worse={per(b.seconds, b) > per(a.seconds, a)}
          />
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

function Delta({
  label,
  from,
  to,
  better,
  worse,
}: {
  label: string;
  from: string;
  to: string;
  better: boolean;
  worse: boolean;
}) {
  return (
    <div className={'run-delta' + (better ? ' better' : worse ? ' worse' : '')}>
      <span className="small muted">{label}</span>
      <strong>
        {from} → {to}
      </strong>
    </div>
  );
}
