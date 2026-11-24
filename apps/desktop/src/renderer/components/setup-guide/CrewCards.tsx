import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import type { PrereqStatus, SetupStatus } from '../../types';
import { CrewStage, paceWord, stageKind, usePace } from '../CrewStage';
import {
  type Crew,
  crewState,
  formatBytes,
  formatDuration,
  inTask,
  purposeOf,
  runningStep,
  stateLabel,
  technical,
  walkPercent,
} from './crews';

// ---- 图标：24 格线稿，描边随文字颜色 ----

function Icon(props: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

// 「以后可能用到」那排药丸的图标；风格库那一层在装的时候轻轻抬起。四个核心组画的是小景（CrewStage）。
export const laterIcons: Record<string, ReactNode> = {
  music: (
    <Icon>
      <path d="M9 18V6l10-2.5v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </Icon>
  ),
  design: (
    <Icon>
      <path d="M12 3v12M8 7v6M16 7v6M4 10v2M20 10v2" />
      <path d="M8.5 21h7M12 18v3" />
    </Icon>
  ),
  styles: (
    <Icon>
      <path className="ic-lift" d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </Icon>
  ),
};

function Check() {
  return (
    <span className="crew-check" aria-hidden="true">
      <svg viewBox="0 0 12 12">
        <path d="M3 6.2l2 2 4-4.4" />
      </svg>
    </span>
  );
}

export function CrewCard(props: { crew: Crew; task: SetupStatus['task']; index: number; onInstall: () => void }) {
  const { state, percent } = crewState(props.crew, props.task);
  const idle = props.task?.running && !inTask(props.crew, props.task);
  // 赶来的速度就是下载速度：量得出百分比的按百分比算，只知道字节数的按字节算，后端说好一会儿没动静就算停住。
  const step = runningStep(props.crew, props.task);
  const byBytes = step !== null && step.progress.percent === undefined;
  const pace = usePace(
    byBytes ? (step.progress.bytes ?? 0) : percent,
    state === 'working',
    byBytes ? 'bytes' : 'percent',
    step?.progress.quiet,
  );
  const word = paceWord(pace);
  let working = `${stateLabel.working} ${percent}%`;
  if (byBytes && step.progress.bytes) working = `${stateLabel.working} · 已下 ${formatBytes(step.progress.bytes)}`;
  else if (byBytes && props.crew.items.length > 1) {
    working = `${stateLabel.working} · 第 ${step.index + 1}/${props.crew.items.length} 步`;
  } else if (byBytes) working = stateLabel.working;
  return (
    <li
      className={'crew-card ' + state + (idle ? ' idle' : '')}
      title={technical(props.crew)}
      style={{ '--i': props.index } as CSSProperties}
    >
      <span className="crew-stage">
        <CrewStage
          kind={stageKind(props.crew.key)}
          state={state}
          percent={walkPercent(props.crew, props.task, percent)}
          pace={pace}
        />
        {state === 'ready' && <Check />}
      </span>
      <span className={'crew-meter ' + state} aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="crew-title">{props.crew.title}</span>
      <span className="crew-desc">{props.crew.desc}</span>
      <span className="crew-state">
        {state === 'working' ? `${working}${word ? ' · ' + word : ''}` : stateLabel[state]}
      </span>
      {state !== 'ready' && (
        <button className="setup-link crew-install" onClick={props.onInstall} disabled={!!props.task?.running}>
          {state === 'working'
            ? '正在准备…'
            : state === 'waiting'
              ? '等待安装'
              : state === 'failed'
                ? '重试安装'
                : `安装${props.crew.title}工具`}
        </button>
      )}
    </li>
  );
}

/** 数字平滑地走到目标值（进度每秒才更新一次，直接跳显得一顿一顿）。 */
function useTween(target: number, ms = 900): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const shown = useRef(target);
  useEffect(() => {
    from.current = shown.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      shown.current = from.current + (target - from.current) * eased;
      setValue(shown.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

/** 右上角的大百分比：平滑地数上去。 */
export function Percent(props: { value: number; className?: string }) {
  const shown = useTween(props.value);
  return (
    <span className={props.className ?? 'setup-percent'}>
      {Math.round(shown)}
      <small>%</small>
    </span>
  );
}

/**
 * 正在下载的那一项：单独一条亮出来——哪一组、具体是什么、走到哪一步、自己的进度，后面排着谁。
 * 换到下一项时整条重新入场（key 换了），看得出「轮到谁了」。
 */
export function NowPlaying(props: { crews: Crew[]; items: PrereqStatus[]; task: SetupStatus['task'] }) {
  const task = props.task;
  if (!task?.running) return null;
  const item = props.items.find((i) => task.items[i.id]?.state === 'running');
  const crew = item && props.crews.find((c) => c.items.includes(item));
  const queued = props.crews.filter((c) => c !== crew && crewState(c, task).state === 'waiting').map((c) => c.title);
  if (!item || !crew) return null;
  return <NowCard key={item.id} crew={crew} item={item} task={task} queued={queued} />;
}

/**
 * 「正在赶来」那一条：哪一组、第几步、用大白话说在干什么，量得出的给百分比，量不出的给下了多少、多快，
 * 再加用了多久与子进程最近的一行输出；好一会儿没有动静时照实说，并指向「网络」里的代理。
 */
function NowCard(props: { crew: Crew; item: PrereqStatus; task: NonNullable<SetupStatus['task']>; queued: string[] }) {
  const { crew, item, task, queued } = props;
  const progress = task.items[item.id];
  const measured = progress?.percent !== undefined;
  const percent = progress?.percent ?? 0;
  const crewPercent = crewState(crew, task).percent;
  const pace = usePace(
    measured ? crewPercent : (progress?.bytes ?? 0),
    true,
    measured ? 'percent' : 'bytes',
    progress?.quiet,
  );
  const word = paceWord(pace);
  const index = crew.items.indexOf(item);
  const elapsed = progress?.started_at ? (Date.now() - progress.started_at) / 1000 : 0;
  const quiet = progress?.quiet ?? 0;
  const facts: string[] = [];
  if (!measured && progress?.bytes) facts.push(`已下载 ${formatBytes(progress.bytes)}`);
  if (pace.bytesRate && pace.bytesRate > 0 && !pace.stalled) facts.push(`${formatBytes(pace.bytesRate)}/s`);
  if (elapsed >= 1) facts.push(`已用 ${formatDuration(elapsed)}`);
  return (
    <div className={'setup-now' + (quiet >= 60 ? ' quiet' : '')}>
      <span className="now-stage-art">
        <CrewStage
          kind={stageKind(crew.key)}
          state="working"
          percent={walkPercent(crew, task, crewPercent)}
          pace={pace}
        />
      </span>
      <div className="now-body">
        <span className="now-label">
          <i className="now-live" aria-hidden="true" />
          正在赶来{word ? ` · ${word}` : ''}
        </span>
        <span className="now-title">
          {crew.title}
          <span className="now-item">
            {crew.items.length > 1 ? `第 ${index + 1} 步，共 ${crew.items.length} 步：` : ''}
            {purposeOf(item)}
          </span>
        </span>
        <span className={'now-bar' + (measured ? '' : ' unknown')} aria-hidden="true">
          <span style={{ width: measured ? `${percent}%` : undefined }} />
        </span>
        <span className="now-stage">
          <span>{progress?.stage || '准备中'}</span>
          {facts.length > 0 && <span className="now-facts">{facts.join(' · ')}</span>}
          {queued.length > 0 && <span className="now-queue">接下来：{queued.join('、')}</span>}
        </span>
        {progress?.activity && (
          <span className="now-activity" title={progress.activity}>
            {progress.activity}
          </span>
        )}
        {quiet >= 60 && (
          <span className="now-warn">
            已经 {formatDuration(quiet)}
            没有新动静了，可能是网络不通。可以在下面「网络」里填一个代理，或者先暂停、过一会儿再继续——已经下好的不会丢。
          </span>
        )}
      </div>
      {measured && <Percent value={percent} className="now-percent" />}
    </div>
  );
}

/** 安装进行中顶上的放映机光束与走动的胶片：只是氛围，不承载信息。 */
export function Projector() {
  return (
    <span className="setup-projector" aria-hidden="true">
      <span className="setup-beam" />
      <span className="setup-reel" />
    </span>
  );
}
