import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Audition, AuditionActivity } from '../types';

const ended = new Set(['done', 'failed', 'interrupted']);

/** 每场一次请求，避免六位选手各开一条轮询。卸载、换场或揭晓后丢掉旧请求。 */
export function useAuditionActivity(a: Audition, version: number, busy: string) {
  const [activities, setActivities] = useState<AuditionActivity[]>([]);
  const [disconnected, setDisconnected] = useState(false);
  const statuses = a.contestants.map(c => `${c.slot}:${c.status}`).join(',');
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const load = async () => {
      let again = true;
      try {
        const response = await api<{ contestants: AuditionActivity[] }>(`/api/auditions/${encodeURIComponent(a.id)}/activity`);
        if (stopped) return;
        setActivities(response.contestants);
        setDisconnected(false);
        again = response.contestants.some(c => !ended.has(c.state));
      } catch {
        if (stopped) return;
        setDisconnected(true);
      }
      if (!stopped && again) timer = window.setTimeout(load, 2000);
    };
    void load();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [a.id, a.blind, statuses, version, busy]);
  return { activities, disconnected };
}

const stepStatus: Record<string, string> = { running: '进行中', done: '完成', failed: '出错', interrupted: '已结束' };

export function AuditionProgress({ activity, disconnected }: { activity: AuditionActivity; disconnected: boolean }) {
  const last = activity.steps.at(-1);
  return (
    <div className={'audition-progress ' + activity.state}>
      <div className="audition-current" role="status" aria-label={`选手 ${activity.slot} 的制作进度`}>
        <span className={'dot ' + (['starting', 'running', 'waiting'].includes(activity.state) ? 'busy' : '')} aria-hidden="true" />
        <strong>{activity.current}</strong>
        {activity.phase === 'design' && <span className="muted">设计阶段</span>}
      </div>
      {activity.hint && <p className="audition-progress-note">{activity.hint}</p>}
      {disconnected ? <p className="audition-progress-note">进度连接中断，正在重试；下方保留最近记录。</p>
        : activity.state === 'waiting' ? <p className="audition-progress-note">当前没有工具在执行，正在等模型给出下一步。</p>
        : activity.state === 'interrupted' ? <p className="audition-progress-note">制作进程已结束，保留下方过程供排查。</p>
        : activity.state === 'starting' ? <p className="audition-progress-note">正在准备输入，等待第一条制作日志。</p> : null}
      {last && <p className="audition-latest">最近：{last.label} · {stepStatus[last.state] ?? last.state}</p>}
      {activity.steps.length > 0 && (
        <details className="audition-process">
          <summary>查看过程 · {activity.step_count} 步</summary>
          <ol start={Math.max(1, activity.step_count - activity.steps.length + 1)}>
            {activity.steps.map((step, i) => (
              <li key={activity.step_count - activity.steps.length + i}>
                <div><span>{step.label}</span><small className={step.state}>{stepStatus[step.state] ?? step.state}</small></div>
                {step.detail && <pre>{step.detail}</pre>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
