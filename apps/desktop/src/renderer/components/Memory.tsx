import { useRef } from 'react';
import '../memory.css';
import type { MemoryRow, Scene } from '../types';
import { ExamProgressPanel } from './ExamProgress';
import { ExamReview as ExamMatrix } from './ExamReview';
import { HumanAcceptance } from './HumanAcceptance';
import { ActivitySection } from './memory/ActivitySection';
import { AdvancedSection } from './memory/AdvancedSection';
import { label } from './memory/helpers';
import { MemoryCard } from './memory/MemoryCard';
import { RememberForm } from './memory/RememberForm';
import { useMemoryData } from './memory/useMemoryData';
import type { RunAction } from './Preview';

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
  const retiredRef = useRef<HTMLDetailsElement>(null);
  const { state, error, recall, recallFailed, recallStale, triggerRefresh } = useMemoryData(scene, version);

  if (error) return <div className="empty">{error}</div>;
  if (!state) return <div className="empty">正在读取记忆…</div>;

  const labels = state.labels;
  const pending = state.memories.filter((m) => m.status === 'trial' && (m.kind === 'preference' || !m.examinable));
  const preferences = state.memories.filter((m) => m.kind === 'preference' && m.status === 'active');
  const lessons = state.memories.filter(
    (m) => m.kind === 'lesson' && (m.status === 'active' || (m.status === 'trial' && m.examinable)),
  );
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
      seriesId={state.series_id}
      seriesName={state.series_name}
      onRefresh={triggerRefresh}
      run={run}
    />
  );

  const project = state.project ?? '';
  const pendingProblems = state.pending ?? [];
  const pendingTotal = state.status.pending_failures;
  const recalled = recall?.recall.items ?? [];
  const examRenderer = state.renderer || 'claude';
  const acceptedExam = [...state.exams].reverse().find((e) => !!e.human_acceptance);

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
            <strong>{scene ? (recall ? recalled.length : recallFailed ? '—' : '…') : '—'}</strong>
            <span>本镜头会带上</span>
            <small>
              {scene
                ? recall
                  ? `${scene.id} · ${recalled.length} 条${recallStale ? '（上次结果，暂未更新）' : ''}`
                  : `${scene.id} · ${recallFailed ? '暂时无法读取' : '正在读取'}`
                : '还没有镜头'}
            </small>
          </li>
        </ol>
      </header>

      {retired.some((m) => m.kind === 'lesson' && m.examinable) && (
        <section className="memory-retest-call" aria-label="重考入口">
          <p>已停用或未通过的经验也可以重新考试。</p>
          <button
            className="primary"
            onClick={() => {
              if (retiredRef.current) {
                retiredRef.current.open = true;
                retiredRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
              }
            }}
          >
            查看并重考
          </button>
        </section>
      )}

      <ExamProgressPanel state={state} />
      {acceptedExam && acceptedExam.id !== state.exams[state.exams.length - 1]?.id && (
        <HumanAcceptance exam={acceptedExam} />
      )}
      {state.exams.length > 0 && (
        <section className="memory-section" aria-label="最近考试结果">
          <h3>最近考试结果</h3>
          <ExamMatrix
            key={state.exams[state.exams.length - 1].id}
            exam={state.exams[state.exams.length - 1]}
            version={version}
            state={state}
          />
        </section>
      )}

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
          <p className="small muted">
            上次整理之后，渲染和检查里出过这些问题。成片确认可用后会整理，只出现过一次的不整理；不想等也可以现在就整理。
          </p>
          <ul className="memory-problems">
            {pendingProblems.map((g) => (
              <li key={g.check}>
                <span className="memory-problem">
                  {g.check === 'human' ? '你回退过、或说不满意' : label(labels?.checks, g.check)}
                </span>
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
                    <span
                      className="small muted"
                      title={[...new Set(g.scenes.filter((x) => x.project !== project).map((x) => x.project))].join(
                        '\n',
                      )}
                    >
                      {g.scenes.some((x) => x.project === project) ? '另有' : ''}其他项目{' '}
                      {g.scenes.filter((x) => x.project !== project).length} 个镜头
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
        <RememberForm seriesId={state.series_id} seriesName={state.series_name} onDone={triggerRefresh} />
      </section>

      <section className="memory-section">
        <h4>学到的经验 · {lessons.length}</h4>
        {lessons.length === 0 ? (
          <p className="small muted">
            {pendingTotal === 0
              ? '还没有。渲染或检查出了问题会先记下来，成片确认可用后整理成经验。'
              : '还没有。成片确认可用后，上面的问题会整理成经验。'}
          </p>
        ) : (
          <>
            {trialLessons.length > 0 ? (
              <div className="memory-exam-call">
                <p>
                  {trialLessons.length}{' '}
                  条新经验在试用，还没带进渲染。考试会拿已有镜头分别带上、不带它各渲染一遍做对照，比得出效果才生效——要花几次渲染的钱，所以不自动做。
                </p>
                <button
                  className="primary"
                  onClick={() => run('/api/memory/actions/exam', { renderers: [examRenderer] })}
                >
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
          <details className="memory-retired" ref={retiredRef}>
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
            <p className="small muted">
              另有 {recall.recall.omitted.length} 条相关但没带上（每个镜头最多 {recall.recall.max_lessons} 条经验）。
            </p>
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
