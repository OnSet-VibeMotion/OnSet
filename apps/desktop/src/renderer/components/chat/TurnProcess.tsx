import { useState } from 'react';
import type { SessionEvent } from '../../types';
import { Icon } from '../Icon';
import { Markdown } from './Markdown';
import { describeTool, formatElapsed, type ProcessItem, seconds, type TurnBlock } from './model';

const stateLabels: Record<TurnBlock['state'], string> = {
  running: '进行中',
  thinking: '思考中',
  done: '已完成',
  failed: '运行失败',
  stopped: '已停止',
  interrupted: '被中断',
};

export function ExecutionShell(props: {
  turn: TurnBlock;
  live: boolean;
  elapsed: number;
  projectPath: string;
  onOpenFile: (path: string) => void;
}) {
  const { turn, live } = props;
  // 跟随这一轮的状态（进行中展开、结束收起），直到用户自己点过。
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const lifecycleOpen = live || turn.state === 'stopped';
  const open = userOpen ?? lifecycleOpen;
  const label = stateLabels[turn.state];
  return (
    <details
      className={'shell ' + turn.state}
      open={open}
      onToggle={(e) => {
        const next = (e.currentTarget as HTMLDetailsElement).open;
        if (next !== open) {
          setUserOpen(next);
        }
      }}
    >
      <summary>
        {live && <span className="orb" aria-hidden="true" />}
        <span className={live ? 'shimmer' : 'shell-label'}>{label}</span>
        {turn.state === 'thinking' && (
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {!live && <span className="shell-meta">· {formatElapsed(props.elapsed)}</span>}
        <span className="spacer" />
        {live && <span className="shell-time">{formatElapsed(props.elapsed)}</span>}
        <Icon name="chevron" size={11} />
      </summary>
      <div className="shell-body">
        {live && turn.process.length === 0 && turn.prose.length === 0 && (
          <p className="muted small">{turn.backgroundTasks.length > 0 ? '后台任务正在执行…' : '等待 AI 首次响应…'}</p>
        )}
        {turn.process.map((item, index) => (
          <ProcessRow key={index} item={item} projectPath={props.projectPath} onOpenFile={props.onOpenFile} />
        ))}
      </div>
    </details>
  );
}

function ProcessRow({
  item,
  projectPath,
  onOpenFile,
}: {
  item: ProcessItem;
  projectPath: string;
  onOpenFile: (path: string) => void;
}) {
  switch (item.type) {
    case 'step':
      return (
        <div className="step-row">
          <span className="step-index">
            {item.index}/{item.total}
          </span>
          {item.text}
        </div>
      );
    case 'thinking':
      return (
        <ThinkingRow text={item.event.text ?? ''} live={!item.until} duration={seconds(item.event.time, item.until)} />
      );
    case 'text':
      return (
        <div className="process-text">
          <Markdown text={item.event.text ?? ''} />
        </div>
      );
    case 'note':
      return <div className={'chat-note' + (item.event.kind === 'error' ? ' error' : '')}>{item.event.text}</div>;
    case 'tool':
      return <ToolRow call={item.call} result={item.result} projectPath={projectPath} onOpenFile={onOpenFile} />;
  }
}

function ThinkingRow({ text, live, duration }: { text: string; live: boolean; duration: number }) {
  return (
    <details className="tool thinking-row" open={live}>
      <summary>
        {live ? <span className="orb small" aria-hidden="true" /> : <Icon name="brain" size={14} />}
        <span className={live ? 'shimmer' : ''}>{live ? '思考中…' : '思考过程'}</span>
        <span className="spacer" />
        {!live && <span className="tool-meta">{formatElapsed(duration)}</span>}
      </summary>
      <div className="thinking-body">
        <Markdown text={text} />
      </div>
    </details>
  );
}

function ToolRow(props: {
  call: SessionEvent;
  result?: SessionEvent;
  projectPath: string;
  onOpenFile: (path: string) => void;
}) {
  const { call, result } = props;
  const state = !result ? 'running' : result.is_error ? 'failed' : 'done';
  const info = describeTool(call.tool ?? '', call.input ?? result?.input);
  const path = info.path ? relativePath(info.path, props.projectPath) : '';
  const output = result?.text ?? '';
  const foldable = info.command || output !== '';
  const head = (
    <>
      <StatusMark state={state} />
      <span className="tool-verb">{info.verb}</span>
      {path && !path.startsWith('/') ? (
        <button
          className="tool-target link mono ellipsis"
          onClick={(e) => {
            e.preventDefault();
            props.onOpenFile(path);
          }}
        >
          {path}
        </button>
      ) : (
        <span className="tool-target mono ellipsis">{path || info.target}</span>
      )}
      <span className="spacer" />
      {state === 'failed' && <span className="tool-failed">失败</span>}
      {result && <span className="tool-meta">{formatElapsed(seconds(call.time, result.time))}</span>}
    </>
  );
  if (!foldable) return <div className={'tool ' + state}>{head}</div>;
  return (
    <details className={'tool ' + state} open={state === 'failed'}>
      <summary>{head}</summary>
      <pre className="terminal">
        {info.command && <span className="prompt-sign">$ </span>}
        {info.command && (info.full ?? info.target) + (output ? '\n' : '')}
        {output}
      </pre>
    </details>
  );
}

function relativePath(path: string, project: string): string {
  if (project && path.startsWith(project + '/')) return path.slice(project.length + 1);
  return path;
}

export function StatusMark({
  state,
}: {
  state: 'running' | 'done' | 'failed' | 'pending' | 'in_progress' | 'completed';
}) {
  if (state === 'running' || state === 'in_progress') return <span className="mark running" aria-label="进行中" />;
  if (state === 'failed') {
    return (
      <span className="mark fail" aria-label="失败">
        ×
      </span>
    );
  }
  if (state === 'done' || state === 'completed') {
    return (
      <span className="mark ok" aria-label="完成">
        ✓
      </span>
    );
  }
  return <span className="mark pending" aria-label="未开始" />;
}
