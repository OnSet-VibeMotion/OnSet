import type { TurnActivity } from './activity';
import { formatElapsed, seconds, type TurnBlock } from './model';

export function ActivityStatus({ activity, turn, now, projectPath, reconnecting }: {
  activity: TurnActivity;
  turn: TurnBlock;
  now: number;
  projectPath: string;
  reconnecting: boolean;
}) {
  const { phase, quiet, completed, failed, active } = activity;
  const detail = activity.detail.replaceAll(projectPath + '/', '').replaceAll(projectPath + '\\', '');
  const step = turn.plan?.find(item => item.status === 'in_progress');
  const waiting = phase === 'waiting' || phase === 'starting';
  return (
    <section className={'chat-activity' + (quiet ? ' is-quiet' : '')} role="region" aria-label="当前 AI 进度">
      <div className="chat-activity-head">
        <span className="orb" aria-hidden="true" />
        <strong role="status">{reconnecting ? '进度连接中断，正在重连' : activity.label}</strong>
        <span className="chat-activity-time">本轮 {formatElapsed(seconds(turn.start, now))}</span>
      </div>
      <div className="chat-activity-detail" title={detail}>{detail}</div>
      {step && <div className="chat-activity-detail" title={step.text}>当前计划：{step.text}</div>}
      <div className="chat-activity-meta">
        {active > 0 && <span>{active} 项操作执行中</span>}
        {phase === 'tool' && !reconnecting && <span>已执行 {formatElapsed(seconds(activity.since, now))}</span>}
        {phase === 'compacting' && !reconnecting && <span>已整理 {formatElapsed(seconds(activity.since, now))}</span>}
        {completed > 0 && <span>已完成 {completed} 项操作</span>}
        {failed > 0 && <span>{failed} 项操作失败</span>}
        {waiting && !reconnecting && <span>等待 {formatElapsed(seconds(activity.since, now))}</span>}
        {quiet && <span>{formatElapsed(seconds(activity.lastUpdate, now))} 无新消息</span>}
      </div>
      {reconnecting ? <p>连接恢复后会同步进度；当前任务的状态尚未确认。</p> : quiet && waiting && <p>尚未收到新的模型输出，你可以继续等待，或点击输入框右下角停止。</p>}
      {!reconnecting && quiet && phase === 'compacting' && <p>压缩尚未返回结果；收到后会自动更新进度。</p>}
    </section>
  );
}
