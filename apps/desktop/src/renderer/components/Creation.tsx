import '../creation.css';
import { Slate, TimelineRig, TitleDraft } from './creation/CreationVisuals';
import { type CreationJob, firstLine, timecode } from './creation/helpers';
import { useCreationRunner } from './creation/useCreationRunner';

export { type CreationJob, datedName } from './creation/helpers';

/**
 * 新建项目的「开机」画面。起片名、建项目、放素材、装技能、请编排工具开工，几步摆成剪辑
 * 时间线上的四段片段，播放头按真实进度走；场记板写着片名、画幅与制作方式，监视器按
 * 选定的画幅放倒计时片头，全部就绪时打板、闪白、推进到项目里。
 *
 * 顺序刻意先装技能再开工：编排工具一开工就该有 hyperframes 技能可用。装技能要联网、
 * 一分钟上下，所以随时可以「不等了」——技能转到后台，顶栏继续显示进度。
 */

export function Creation(props: {
  job: CreationJob;
  onDone: (projectId: string, sessionId: string) => void;
  onClose: (error: string) => void;
}) {
  const { job } = props;
  const {
    states,
    fractions,
    caption,
    error,
    skillsError,
    styleError,
    indeterminate,
    finale,
    title,
    naming,
    renamed,
    started,
    now,
    overall,
    skipNaming,
    skipSkills,
    retrySkills,
    skipStyle,
    retryStyle,
  } = useCreationRunner(job, props.onDone);

  const elapsed = (now - started) / 1000;
  const countdown = 3 - (Math.floor(elapsed) % 3);
  const sweep = (elapsed % 1) * 360;
  const ratio = job.canvasInfo ? job.canvasInfo.width / job.canvasInfo.height : 3 / 4;
  const today = new Date(started);
  const running = states.skills === 'running';
  const namingStep = states.name === 'running';

  return (
    <div
      className={'creation' + (finale ? ' ' + finale : '')}
      role="dialog"
      aria-modal="true"
      aria-label="正在新建项目"
    >
      <div className="creation-grain" aria-hidden="true" />
      <div className="creation-stage">
        <Slate
          title={title}
          naming={naming}
          canvas={job.canvasInfo ? `${job.canvasInfo.width}×${job.canvasInfo.height}` : job.canvas}
          mode={job.modeLabel}
          date={`${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`}
          tool={job.toolLabel}
          clapped={finale !== ''}
        />

        <div className="monitor" style={{ aspectRatio: String(ratio) }}>
          {naming && !finale ? (
            <TitleDraft
              draft={job.name}
              title={title}
              phase={naming}
              renamed={renamed}
              reading={job.materials.length > 0 ? '正在读你的话和素材' : '正在读你的话'}
            />
          ) : finale ? (
            <div className="monitor-title">
              <span className="monitor-kicker">TAKE 1</span>
              <strong>{title}</strong>
            </div>
          ) : (
            <div className="leader" aria-hidden="true">
              <div
                className="leader-sweep"
                style={{ background: `conic-gradient(rgba(255,255,255,.16) ${sweep}deg, transparent ${sweep}deg)` }}
              />
              <div className="leader-cross" />
              <div className="leader-ring" />
              <div className="leader-ring inner" />
              <span className="leader-number">{countdown}</span>
            </div>
          )}
          <span className="monitor-rec">
            <i />
            REC
          </span>
          <span className="monitor-tc mono">{timecode(elapsed)}</span>
          <span className="monitor-safe" aria-hidden="true" />
        </div>

        <TimelineRig
          elapsed={elapsed}
          overall={overall}
          states={states}
          fractions={fractions}
          indeterminate={indeterminate}
        />

        <div className="creation-caption" aria-live="polite">
          <span className="caption-percent mono">{Math.round(overall)}%</span>
          <span className="caption-text">{error || caption}</span>
        </div>

        <div className="creation-actions">
          {error ? (
            <button className="pill" onClick={() => props.onClose(error)}>
              回到首页
            </button>
          ) : styleError ? (
            <>
              <span className="creation-error" title={styleError}>
                {firstLine(styleError)}
              </span>
              <button className="pill" onClick={() => retryStyle.current()}>
                重试
              </button>
              <button className="pill primary-pill" onClick={() => skipStyle.current()}>
                跳过，先开始制作
              </button>
            </>
          ) : skillsError ? (
            <>
              <span className="creation-error" title={skillsError}>
                {firstLine(skillsError)}
              </span>
              <button className="pill" onClick={() => retrySkills.current()}>
                重试
              </button>
              <button className="pill primary-pill" onClick={() => skipSkills.current()}>
                跳过，先开始制作
              </button>
            </>
          ) : namingStep ? (
            <button
              className="pill ghost-pill"
              onClick={() => skipNaming.current()}
              title={`不等 AI 起名，片名用「${job.name}」`}
            >
              不等了，用我的第一句话
            </button>
          ) : (
            running && (
              <button
                className="pill ghost-pill"
                onClick={() => skipSkills.current()}
                title="技能转到后台继续装，AI 先从写稿、配音开始"
              >
                不等了，先开始制作
              </button>
            )
          )}
        </div>
      </div>
      {finale === 'clap' && <div className="creation-flash" aria-hidden="true" />}
    </div>
  );
}
