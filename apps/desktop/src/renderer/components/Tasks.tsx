import { useState } from 'react';
import { forUser } from '../api';
import { Icon } from './Icon';
import type { Task } from '../types';

const statusLabels: Record<Task['status'], string> = {
  queued: '排队',
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
};

export function Tasks({ tasks, onCancel }: { tasks: Task[]; onCancel: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const active = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
  return (
    <div className="tasks">
      {/* 只在有任务在跑或排队时挂数字：做完的任务数不是要你注意的事。 */}
      <button className="ghost icon tasks-toggle" id="tasks-toggle" aria-expanded={open} aria-label="任务" title={active ? `任务：${active} 个在进行` : '任务'} onClick={() => setOpen(!open)}>
        <Icon name="list" size={14} />
        {active > 0 && <span className="count on">{active}</span>}
      </button>
      {open && (
        <div className="popover" id="tasks">
          {tasks.length === 0 && <p className="muted pad">还没有任务。</p>}
          {tasks.slice(0, 20).map((task) => (
            <div key={task.task_id} className={'task ' + task.status}>
              <div className="task-head">
                <strong>{forUser(task.message.split('\n')[0] ?? '')}</strong>
                <span className="muted small">{statusLabels[task.status]}</span>
              </div>
              {task.status === 'running' && (
                <div className="meter">
                  <i style={{ width: `${Math.round(task.progress * 100)}%` }} />
                </div>
              )}
              {task.error && <pre className="task-error">{forUser(task.error)}</pre>}
              {task.warning && <p className="task-warning">{task.warning}</p>}
              {(task.status === 'running' || task.status === 'queued') && (
                <button className="ghost" onClick={() => onCancel(task.task_id)}>
                  取消
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
