import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ActivityStep, Scene, SceneActivity, ViewRequest } from '../types';
import { describeTool, formatElapsed } from './chat/model';
import {windowsRenderProgress} from './render-progress';
import '../render-activity.css';

/*
 * 渲染器此刻在做什么。
 *
 * 渲染器是另一个 CLI 进程，编排工具调了渲染之后只能等，对话里只剩一个在转的工具调用。
 * 后端把渲染器的输出流译成步骤（/api/scenes/{id}/activity，studio/activity.ts），这里画出来：
 * 对话里有镜头在渲染时，输入框上方挂一张卡片（RenderWatch）；镜头页里是完整过程（SceneActivityPanel）。
 */

/** 渲染器写给用户的话带这个前缀（tools.UserMessageMarker）。 */
const userMark = '[[USER_MESSAGE]]';

const outcomeText: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  verification_failed: '产物没通过校验',
  interrupted: '被中断',
};

/** 轮询一个镜头的渲染过程：渲染中每两秒一次，结束后停。 */
export function useSceneActivity(sceneId: string, rendering: boolean): SceneActivity | null {
  const [activity, setActivity] = useState<SceneActivity | null>(null);
  const live = useRef(rendering);
  live.current = rendering;
  useEffect(() => {
    setActivity(null);
    if (!sceneId) return;
    let stopped = false;
    let timer = 0;
    const load = async () => {
      let still = live.current;
      try {
        const next = await api<SceneActivity>(`/api/scenes/${encodeURIComponent(sceneId)}/activity`);
        if (stopped) return;
        setActivity(next);
        // 镜头列表八秒才刷新一次（不忙时不刷新），渲染刚开始或刚结束时以这边读到的为准。
        still = next.rendering;
      } catch {
        // 读失败不打扰用户，下一次再试。
      }
      if (!stopped && still) timer = window.setTimeout(load, 2000);
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [sceneId, rendering]);
  return activity;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

interface StepView {
  verb: string;
  target: string;
  /** 渲染器写给用户的话。 */
  toUser?: boolean;
}

/** 一步说成「动词 + 对象」：文件路径去掉镜头目录前缀。 */
export function describeStep(step: ActivityStep, sceneDir: string): StepView {
  if (step.kind === 'text') {
    const toUser = (step.text ?? '').includes(userMark);
    return { verb: toUser ? '对你说' : '说', target: (step.text ?? '').replaceAll(userMark, '').trim(), toUser };
  }
  if (step.kind === 'error') return { verb: '出错', target: step.text ?? '' };
  const info = describeTool(step.tool ?? '', step.input);
  let target = info.path || info.target;
  if (sceneDir && target.startsWith(sceneDir + '/')) target = target.slice(sceneDir.length + 1);
  target = target.replaceAll(sceneDir + '/', '');
  return { verb: info.verb, target };
}

/** 卡片上那一行「现在在做什么」。 */
function currentLine(steps: ActivityStep[], sceneDir: string): string {
  const last = steps[steps.length - 1];
  if (!last) return '正在启动渲染器…';
  const view = describeStep(last, sceneDir);
  if (last.kind === 'tool' && last.state === 'running') return `正在${view.verb}${view.target ? '：' + firstLine(view.target) : ''}`;
  if (last.kind === 'text') return firstLine(view.target);
  return `${view.verb}${view.target ? '：' + firstLine(view.target) : ''}`;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > 120 ? line.slice(0, 120) + '…' : line;
}

function since(iso: string | undefined, now: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0;
}

function PlanLine({ activity, reserve }: { activity: SceneActivity; reserve?: boolean }) {
  const plan = activity.plan ?? [];
  // reserve：镜头页渲染中始终占一行，计划出现时不把下面的列表往下推。
  if (plan.length === 0) return reserve ? <span className="ra-plan" aria-hidden="true" /> : null;
  const current = plan.findIndex((item) => item.status === 'in_progress');
  const done = plan.filter((item) => item.status === 'completed').length;
  const step = current >= 0 ? current + 1 : Math.min(done + 1, plan.length);
  return (
    <span className="ra-plan">
      计划第 {step}/{plan.length} 步{current >= 0 ? `：${plan[current].text}` : ''}
    </span>
  );
}

/** 步骤列表，最新的在最下面。 */
function StepList({ steps, sceneDir, offset }: { steps: ActivityStep[]; sceneDir: string; offset: number }) {
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [steps.length, steps[steps.length - 1]?.state]);
  return (
    <ol
      className="ra-steps"
      ref={list}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {steps.map((step, index) => {
        const view = describeStep(step, sceneDir);
        const state = step.kind === 'error' ? 'failed' : step.kind === 'text' ? 'said' : (step.state ?? 'done');
        const detail = step.kind === 'tool' && step.state === 'failed' ? step.output : '';
        return (
          <li key={offset + index} className={'ra-step ' + state + (view.toUser ? ' to-user' : '')}>
            <span className="ra-num mono">{offset + index + 1}</span>
            <span className={'ra-dot ' + state} aria-hidden="true" />
            {step.kind === 'text' ? (
              <p className="ra-said">{view.target}</p>
            ) : (
              <div className="ra-body">
                <span className="ra-verb">{view.verb}</span>
                {view.target && <span className="ra-target mono">{firstLine(view.target)}</span>}
                {detail && <pre className="ra-output">{detail}</pre>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 对话里：有镜头在渲染时挂在输入框上方，每个在渲染的镜头一张卡片。 */
export function RenderWatch({ scenes, onView }: { scenes: Scene[]; onView: (view: ViewRequest) => void }) {
  const rendering = scenes.filter((scene) => scene.rendering);
  if (rendering.length === 0) return null;
  return (
    <section className="render-watch" aria-label={`正在渲染的镜头 ${rendering.length} 个`}>
      {rendering.map((scene) => (
        <WatchCard key={scene.id} scene={scene} onView={onView} />
      ))}
    </section>
  );
}

function WatchCard({ scene, onView }: { scene: Scene; onView: (view: ViewRequest) => void }) {
  const activity = useSceneActivity(scene.id, true);
  const [open, setOpen] = useState(false);
  const now = useNow(true);
  const steps = activity?.steps ?? [];
  // 已经结束、镜头列表还没刷新：先不显示。
  if (activity && !activity.rendering) return null;
  const elapsed = since(activity?.started_at, now);
  const quiet = since(activity?.updated_at, now);
  const running = steps[steps.length - 1]?.state === 'running';
  const windows=window.onset?.platform==='win32'?windowsRenderProgress(steps,activity?.renderer!=='codex'||activity?.tool_lifecycle==='codex-mcp-v1'):null;
  const shown = steps.slice(-30);
  return (
    <div className={'render-card' + (open ? ' open' : '')} data-render-scene={scene.id}>
      <button className="ra-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="orb tiny" aria-hidden="true" />
        <span className="ra-title">{scene.id} {windows?.title??'渲染中'}</span>
        {activity?.started_at && <span className="ra-elapsed mono">{formatElapsed(elapsed)}</span>}
        <span className="ra-current ellipsis">{windows?.line??currentLine(steps, scene.directory)}</span>
        <span className="ra-toggle">{open ? '收起' : '看过程'}</span>
      </button>
      {quiet > 90 && (
        <p className="ra-quiet">
          已经 {formatElapsed(quiet)} 没有新动静
          {windows?'：'+windows.quiet:running ? '：这一步还在跑，渲染视频、截图检查本来就要几分钟' : ''}
        </p>
      )}
      {open && (
        <>
          <StepList steps={shown} sceneDir={scene.directory} offset={(activity?.step_count ?? 0) - shown.length} />
          <footer className="ra-foot">
            <span>
              共 {activity?.step_count ?? 0} 步{activity?.model ? ` · ${activity.model}` : ''}
            </span>
            {activity && <PlanLine activity={activity} />}
            <span className="spacer" />
            <button className="link small" onClick={() => onView({ page: 'scene', target: scene.id })}>
              打开镜头
            </button>
          </footer>
        </>
      )}
    </div>
  );
}

/** 镜头页里：渲染中实时显示过程；不在渲染时可展开看上一次的过程。 */
export function SceneActivityPanel({ scene }: { scene: Scene }) {
  const rendering = !!scene.rendering;
  const activity = useSceneActivity(scene.id, rendering);
  // 读到过就以它为准：镜头列表可能还停在「渲染中」。
  const live = activity ? activity.rendering : rendering;
  const now = useNow(live);
  if (!activity || (activity.steps.length === 0 && !live)) return null;
  const steps = activity.steps;
  const offset = activity.step_count - steps.length;
  const summary = live ? (
    <>
      <span className="orb tiny" aria-hidden="true" />
      <span className="ra-title">渲染过程</span>
      {activity.started_at && <span className="ra-elapsed mono">{formatElapsed(since(activity.started_at, now))}</span>}
      <span className="ra-current ellipsis">{currentLine(steps, scene.directory)}</span>
    </>
  ) : (
    <>
      <span className="ra-title">上次渲染的过程</span>
      <span className={'ra-outcome ' + (activity.outcome ?? '')}>{outcomeText[activity.outcome ?? ''] ?? ''}</span>
      <span className="ra-current">{activity.step_count} 步</span>
    </>
  );
  return (
    <details className={'scene-activity' + (live ? ' live' : '')} open={live || undefined}>
      <summary>{summary}</summary>
      {live && <PlanLine activity={activity} reserve />}
      {!live && activity.error && <p className="ra-error">{activity.error}</p>}
      <StepList steps={steps} sceneDir={scene.directory} offset={offset} />
    </details>
  );
}
