import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { ActivityStep, Scene, SceneActivity, ViewRequest } from '../types';
import { describeTool, formatElapsed } from './chat/model';
import {currentActivityStep, renderPhases, renderPresentation} from './render-progress';
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
  if (step.kind === 'thinking') return { verb: `思考 · ${thinkingSize(step)}`, target: step.text ?? '' };
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

/** 思考了多少字：几万字的思考要几分钟，说清楚比只写「思考」有用。 */
export function thinkingSize(step: ActivityStep): string {
  const n = step.chars ?? (step.text ?? '').length;
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}

/** 卡片上那一行「现在在做什么」。 */
function currentLine(steps: ActivityStep[], sceneDir: string): string {
  const last = currentActivityStep(steps);
  if (!last) return '正在启动渲染器…';
  const view = describeStep(last, sceneDir);
  if (last.kind === 'tool' && last.state === 'running') {
    // 完整命令留在展开的过程里；标题不要被运行时路径或 --json 之类的参数占满。
    const tool = describeTool(last.tool ?? '', last.input);
    if (tool.command) return '正在运行制作命令';
    const target = /^--?/.test(view.target) ? '' : view.target;
    return `正在${view.verb}${target ? '：' + firstLine(target) : ''}`;
  }
  if (last.kind === 'text') return firstLine(view.target);
  if (last.kind === 'thinking') return `想好了（${thinkingSize(last)}）：${firstLine(view.target)}`;
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
        const state = step.kind === 'error' ? 'failed' : step.kind === 'text' ? 'said' : step.kind === 'thinking' ? 'thought' : (step.state ?? 'done');
        const detail = step.kind === 'tool' && step.state === 'failed' ? step.output : '';
        return (
          <li key={offset + index} className={'ra-step ' + state + (view.toUser ? ' to-user' : '')}>
            <span className="ra-num mono">{offset + index + 1}</span>
            <span className={'ra-dot ' + state} aria-hidden="true" />
            {step.kind === 'text' ? (
              <p className="ra-said">{view.target}</p>
            ) : step.kind === 'thinking' ? (
              <details className="ra-thought">
                <summary>
                  <span className="ra-verb">{view.verb}</span>
                  <span className="ra-target">{firstLine(view.target)}</span>
                </summary>
                <p>{view.target}</p>
                {(step.chars ?? 0) > (step.text ?? '').length && <small className="ra-thought-more">只显示开头一段，全文在镜头目录的渲染日志里</small>}
              </details>
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
  const [activities, setActivities] = useState<Record<string, SceneActivity>>({});
  const [collapsed, setCollapsed] = useState(false);
  const report = useCallback((id: string, activity: SceneActivity) => setActivities((previous) => ({...previous, [id]: activity})), []);
  const rendering = scenes.filter((scene) => scene.rendering);
  if (rendering.length === 0) return null;
  const active = rendering.filter((scene) => activities[scene.id]?.rendering !== false);
  const waiting = active.filter((scene) => {
    const activity = activities[scene.id];
    return activity && renderPresentation(activity.steps, activity.renderer !== 'codex' || activity.tool_lifecycle === 'codex-mcp-v1').state === 'waiting';
  }).length;
  return (
    <section className={'render-watch' + (active.length === 0 ? ' is-finished' : '')} aria-label={`正在渲染的镜头 ${active.length} 个`}>
      <header className="render-watch-heading">
        <span className="render-watch-mark" aria-hidden="true">▥</span>
        <strong>镜头制作</strong><span className="render-watch-count">{active.length} 个进行中</span>
        {waiting > 0 && <span className="render-watch-waiting">{waiting} 个等待回复</span>}
        <button className="link small" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '展开列表' : '收起列表'}</button>
      </header>
      <div className={'render-watch-list' + (collapsed ? ' collapsed' : '')}>
      {rendering.map((scene) => (
        <WatchCard key={scene.id + (scene.rendering_since ?? '')} scene={scene} onView={onView} onActivity={report} />
      ))}
      </div>
    </section>
  );
}

function WatchCard({ scene, onView, onActivity }: { scene: Scene; onView: (view: ViewRequest) => void; onActivity: (id: string, activity: SceneActivity) => void }) {
  const activity = useSceneActivity(scene.id, true);
  const [open, setOpen] = useState(false);
  const now = useNow(true);
  useEffect(() => { if (activity) onActivity(scene.id, activity); }, [activity, scene.id, onActivity]);
  const steps = activity?.steps ?? [];
  // 已经结束、镜头列表还没刷新：先不显示。
  if (activity && !activity.rendering) return null;
  const elapsed = since(activity?.started_at, now);
  const quiet = since(activity?.updated_at, now);
  const progress = renderPresentation(steps, activity?.renderer !== 'codex' || activity?.tool_lifecycle === 'codex-mcp-v1');
  const phase = progress.phase === undefined ? steps.length > 0 ? '制作中' : '启动制作' : renderPhases[progress.phase];
  const number = /^scene-(\d+)$/.exec(scene.id)?.[1];
  const name = number ? `镜头 ${number.replace(/^0+(?=\d{2})/, '')}` : scene.id;
  const shown = steps.slice(-30);
  return (
    <div className={'render-card ' + progress.state + (open ? ' open' : '')} data-render-scene={scene.id}>
      <button className="ra-head" aria-expanded={open} aria-label={`${name}，${phase}，${progress.label}，${open ? '收起过程' : '展开过程'}`} onClick={() => setOpen(!open)}>
        <span className="ra-scene-number" aria-hidden="true">{number ? number.slice(-2) : '▥'}</span>
        <span className="ra-main">
          <span className="ra-main-heading"><span className="ra-title">{name}</span><span className="ra-phase">{phase}</span></span>
          <span className="ra-current ellipsis">{progress.detail}</span>
        </span>
        <span className="ra-timing">
          <span className={'ra-status ' + progress.state}><i aria-hidden="true" />{progress.label}</span>
          <span className={'ra-freshness' + (quiet > 90 ? ' is-quiet' : '')}>{activity?.updated_at ? quiet < 3 ? '刚刚更新' : `${formatElapsed(quiet)} 未更新` : '读取进展中'}</span>
        </span>
        <span className="ra-elapsed mono" title="本次渲染累计用时">{activity?.started_at ? <>累计 {formatElapsed(elapsed)}</> : '—'}</span>
        <span className={'ra-toggle' + (open ? ' expanded' : '')}><span className="ra-toggle-label">{open ? '收起' : '展开'}</span><span aria-hidden="true">⌄</span></span>
      </button>
      {quiet > 90 && open && (
        <p className="ra-quiet">
          {progress.state === 'waiting' ? '模型还在想下一步或在写回复。有的工具（例如 Qoder）要等这一段整个想完才写出来，所以这几分钟里没有新步骤；想完后会在过程里显示它想了什么。' : progress.state === 'busy' ? '工具尚未返回新结果，取帧和检查可能需要几分钟。' : '暂未收到新的进展，请展开过程查看最近记录。'}
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
