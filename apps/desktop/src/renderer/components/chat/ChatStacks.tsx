import type { CSSProperties } from 'react';
import type { BackgroundTask, PermissionAsk, PlanItem, Scene } from '../../types';
import { Icon } from '../Icon';
import { type QueuedMessage, splitAttachmentText } from './model';
import { StatusMark } from './TurnProcess';

export function BackgroundTaskStatus({ tasks }: { tasks: BackgroundTask[] }) {
  return (
    <section className="background-tasks" aria-label="正在执行的后台任务">
      <header role="status">
        <StatusMark state="running" />
        <span>{tasks.length} 个后台任务正在执行</span>
      </header>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <span className="ellipsis" title={task.description}>
              {task.description}
            </span>
            {task.activity && (
              <span className="background-task-activity ellipsis" title={task.activity}>
                {task.activity}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PlanPill({ plan, scenes }: { plan: PlanItem[]; scenes: Scene[] }) {
  const current = plan.findIndex((item) => item.status === 'in_progress');
  const done = plan.filter((item) => item.status === 'completed').length;
  const step = current >= 0 ? current + 1 : Math.min(done + 1, plan.length);
  const rendered = scenes.filter((scene) => scene.exists && !scene.stale).length;
  const rendering = scenes.filter((scene) => scene.rendering);
  return (
    <div className="plan-pill-wrap">
      <button className="float-pill plan-pill" aria-label={`进度：第 ${step}/${plan.length} 步`}>
        <span className="orb tiny" aria-hidden="true" />第 {step}/{plan.length} 步
        {current >= 0 && <span className="plan-current ellipsis">{plan[current].text}</span>}
      </button>
      <div className="popover plan-popover" role="tooltip">
        <ol>
          {plan.map((item, index) => (
            <li key={index} className={item.status}>
              <StatusMark state={item.status} />
              <span>{item.text}</span>
            </li>
          ))}
        </ol>
        {scenes.length > 0 && (
          <p className="plan-scenes">
            镜头已出片 {rendered}/{scenes.length}
            {rendering.length > 0 && ` · 渲染中：${rendering.map((scene) => scene.id).join('、')}`}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 编排工具在等你批准的调用。claude 在客户端里遇到白名单外的命令时会停在这里，直到你回答；
 * 「以后都允许」把命令前缀记进这个项目，之后同样的命令不再问；「以后都不用问」打开设置里的自动批准，什么命令都不再问。
 */
export function PermissionStack({
  asks,
  onAnswer,
}: {
  asks: PermissionAsk[];
  onAnswer: (ask: PermissionAsk, decision: 'allow' | 'always' | 'deny' | 'auto') => void;
}) {
  return (
    <section className="permission-stack" aria-label={`等你批准的操作 ${asks.length} 条`}>
      {asks.map((ask) => (
        <div key={ask.id} className="permission-card" data-permission={ask.id}>
          <div className="permission-head">
            <span className="permission-badge">要你批准</span>
            <span className="permission-what">
              {ask.description || (ask.command ? '运行一条命令' : `使用 ${ask.tool_name ?? '工具'}`)}
            </span>
          </div>
          {ask.command ? (
            <code className="permission-command">{ask.command}</code>
          ) : (
            <code className="permission-command">{JSON.stringify(ask.input ?? {}).slice(0, 400)}</code>
          )}
          <div className="permission-actions">
            <button className="primary" onClick={() => onAnswer(ask, 'allow')}>
              允许
            </button>
            {ask.suggestion && (
              <button onClick={() => onAnswer(ask, 'always')} title="记进这个项目，以后不再问">
                以后都允许 <code>{ask.suggestion}</code>
              </button>
            )}
            <button
              onClick={() => onAnswer(ask, 'auto')}
              title="打开设置里的「自动批准」：以后所有项目都不再问，直接允许；可以在设置里关掉"
            >
              以后都不用问
            </button>
            <button className="ghost" onClick={() => onAnswer(ask, 'deny')}>
              拒绝
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

export function QueuedStack({
  queue,
  onAction,
}: {
  queue: QueuedMessage[];
  onAction: (item: QueuedMessage, action: 'steer' | 'remove' | 'edit') => void;
}) {
  return (
    <section className="queue-stack" aria-label={`排队中的消息 ${queue.length} 条`}>
      {queue.map((item, index) => (
        <div
          key={item.id}
          className="queue-card"
          data-depth={Math.min(queue.length - 1 - index, 3)}
          style={{ '--depth': String(Math.min(queue.length - 1 - index, 3)) } as CSSProperties}
        >
          <span className="queue-badge">排队</span>
          <span className="queue-text ellipsis">{splitAttachmentText(item.text).body}</span>
          <button
            className="queue-action steer"
            onClick={() => onAction(item, 'steer')}
            title="停掉这一轮，马上发出排队的消息"
          >
            <Icon name="up" size={11} />
            引导对话
          </button>
          <button
            className="icon-button"
            onClick={() => onAction(item, 'edit')}
            aria-label="编辑"
            title="拿回输入框修改"
          >
            <Icon name="edit" size={12} />
          </button>
          <button className="icon-button" onClick={() => onAction(item, 'remove')} aria-label="移除" title="不发这条了">
            <Icon name="trash" size={12} />
          </button>
        </div>
      ))}
    </section>
  );
}
