import { INK_STEP, type StepID, type StepState, steps, timecode } from './helpers';

function Ink(props: { text: string; delay?: number }) {
  return (
    <span className="ink" aria-label={props.text}>
      {Array.from(props.text).map((ch, i) => (
        <span
          key={i}
          className="ink-char"
          aria-hidden="true"
          style={{ animationDelay: `${(props.delay ?? 0) + i * INK_STEP}ms` }}
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

/**
 * 监视器上的「拟片名」：拟定中放用户的原话当暂定片名，一道扫描线来回读；定名时（AI 起了新名字）
 * 划掉原话，逐字写出片名。没起出名字时不划线，直接把原话写成片名。
 */
export function TitleDraft(props: {
  draft: string;
  title: string;
  phase: 'drafting' | 'reveal';
  renamed: boolean;
  reading: string;
}) {
  const reveal = props.phase === 'reveal';
  return (
    <div className={'title-draft ' + props.phase + (props.renamed ? ' renamed' : '')}>
      <span className="monitor-kicker">{reveal ? 'TITLE' : 'WORKING TITLE'}</span>
      {(!reveal || props.renamed) && (
        <span className="draft-words">
          {props.draft}
          {!reveal && <i className="draft-scan" aria-hidden="true" />}
        </span>
      )}
      {reveal ? (
        <strong className="draft-title">
          {/* 监视器上只写片名，日期后缀留在场记板上。 */}
          <Ink text={props.title.replace(/-\d{4}$/, '')} delay={props.renamed ? 380 : 0} />
        </strong>
      ) : (
        <span className="draft-reading">
          {props.reading}
          <i className="draft-dots" aria-hidden="true">
            <b />
            <b />
            <b />
          </i>
        </span>
      )}
    </div>
  );
}

export function Slate(props: {
  title: string;
  naming: '' | 'drafting' | 'reveal';
  canvas: string;
  mode: string;
  date: string;
  tool: string;
  clapped: boolean;
}) {
  return (
    <div className={'slate' + (props.clapped ? ' clapped' : '')}>
      <div className="slate-arm" aria-hidden="true">
        <span />
      </div>
      <div className="slate-top" aria-hidden="true">
        <span />
      </div>
      <div className="slate-body">
        <div className="slate-row wide">
          <label>片名</label>
          {props.naming === 'drafting' || !props.title ? (
            <strong className="pending">
              <i className="chalk-caret" aria-hidden="true" />
            </strong>
          ) : props.naming === 'reveal' ? (
            <strong>
              <Ink text={props.title} delay={380} />
            </strong>
          ) : (
            <strong>{props.title}</strong>
          )}
        </div>
        <div className="slate-row">
          <label>画幅</label>
          <span className="mono">{props.canvas}</span>
        </div>
        <div className="slate-row">
          <label>形式</label>
          <span>{props.mode}</span>
        </div>
        <div className="slate-row">
          <label>场 / 镜</label>
          <span className="mono">01 / 001</span>
        </div>
        <div className="slate-row">
          <label>日期</label>
          <span className="mono">{props.date}</span>
        </div>
        <div className="slate-row wide">
          <label>编排</label>
          <span>{props.tool}</span>
        </div>
      </div>
    </div>
  );
}

export function TimelineRig(props: {
  elapsed: number;
  overall: number;
  states: Record<StepID, StepState>;
  fractions: Record<StepID, number>;
  indeterminate: boolean;
}) {
  const { elapsed, overall, states, fractions, indeterminate } = props;
  return (
    <div className="timeline-rig">
      <div className="rig-ruler mono" aria-hidden="true">
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i}>{timecode((i * Math.max(elapsed, 10)) / 10).slice(3, 8)}</span>
        ))}
      </div>
      <div className="rig-track video">
        <span className="track-label mono">V1</span>
        <div className="track-lane">
          {steps.map((step) => {
            const state = states[step.id];
            const fill = state === 'done' || state === 'skipped' ? 1 : state === 'running' ? fractions[step.id] : 0;
            return (
              <div
                key={step.id}
                className={
                  'clip ' +
                  state +
                  ((step.id === 'skills' && indeterminate) ||
                  (step.id === 'name' && state === 'running') ||
                  (step.id === 'style' && state === 'running')
                    ? ' indeterminate'
                    : '')
                }
                style={{ flexGrow: step.weight }}
              >
                <span className="clip-fill" style={{ width: `${fill * 100}%` }} />
                <span className="clip-label">
                  {step.label}
                  {state === 'skipped' && step.id === 'skills' && <em> · 后台</em>}
                  {state === 'skipped' && step.id === 'name' && <em> · 用原话</em>}
                  {state === 'skipped' && step.id === 'style' && <em> · 不用</em>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="rig-track audio">
        <span className="track-label mono">A1</span>
        <div className="track-lane wave" aria-hidden="true">
          {Array.from({ length: 64 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(i * 97) % 1100}ms`, height: `${30 + ((i * 37) % 60)}%` }} />
          ))}
        </div>
      </div>
      <div className="playhead" style={{ left: `calc(48px + (100% - 60px) * ${overall / 100})` }} aria-hidden="true">
        <span className="playhead-cap" />
      </div>
    </div>
  );
}
