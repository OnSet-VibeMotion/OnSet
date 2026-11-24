import { useState } from 'react';
import { ApiError, errorText, post } from '../../api';
import { DiffDialog } from '../DiffDialog';
import { Icon } from '../Icon';
import { formatElapsed, splitAttachmentText, type TurnBlock } from './model';

export function clockOf(time?: string): string {
  if (!time) return '';
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

const changeLabels = { added: '新增', modified: '修改', deleted: '删除' } as const;

export interface TurnEndProps {
  turn: TurnBlock;
  latest: boolean;
  elapsed: number;
  stations?: Record<string, string[]>;
  onRetry: (text: string) => void;
  onOpenFile: (path: string) => void;
  onReverted: () => void;
}

export function TurnEnd(props: TurnEndProps) {
  const { turn } = props;
  const end = turn.end!;
  const changes = end.changes ?? [];
  const [expanded, setExpanded] = useState(false);
  const [diffPath, setDiffPath] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const tokens = turn.usage ? (turn.usage.input_tokens ?? 0) + (turn.usage.output_tokens ?? 0) : 0;
  const revert = async () => {
    setWorking(true);
    setError('');
    try {
      await post(`/api/turns/${end.turn_id}/revert`);
      props.onReverted();
    } catch (err) {
      const paths =
        err instanceof ApiError && Array.isArray(err.body.paths) ? `：${(err.body.paths as string[]).join('、')}` : '';
      setError(errorText(err) + paths);
    } finally {
      setWorking(false);
    }
  };
  const shown = expanded ? changes : changes.slice(0, 4);
  const retryText = turn.user ? splitAttachmentText(turn.user.text ?? '').body : '';
  return (
    <div className="turn-end">
      {(turn.state === 'failed' || turn.state === 'interrupted') && (
        <section className="error-card" role="alert">
          <h4>
            <Icon name="alert" size={14} />
            {turn.state === 'failed' ? '运行失败' : '这一轮被中断了'}
          </h4>
          {end.text && <p>{end.text}</p>}
          {turn.state === 'interrupted' && !end.text && <p>Studio 重启时这一轮还在进行，AI 的进程已经不在了。</p>}
          {retryText && (
            <div className="actions">
              <button className="pill primary-pill" onClick={() => props.onRetry(retryText)}>
                重试
              </button>
            </div>
          )}
        </section>
      )}
      {turn.state === 'stopped' && (
        <p className="pause-line">
          <Icon name="pause" size={12} />
          已停止这一轮
        </p>
      )}
      {changes.length > 0 && (
        <section className={'files-card turn-card' + (turn.reverted ? ' reverted' : '')} id={'turn-' + end.turn_id}>
          <header>
            <Icon name="file" size={12} />
            <span className="files-label">{turn.reverted ? '已回退这一轮' : '本轮改动'}</span>
            <span className="count">{changes.length}</span>
            <span className="files-summary ellipsis">{changes.map((c) => c.path.split('/').pop()).join('、')}</span>
            {!turn.reverted && (
              <button className="pill revert" id="revert-turn" disabled={working} onClick={revert}>
                回退本轮
              </button>
            )}
          </header>
          <ul>
            {shown.map((change) => (
              <li key={change.path}>
                <span className={'change ' + change.change}>{changeLabels[change.change]}</span>
                <button
                  className="link mono ellipsis"
                  onClick={() => (change.revertable ? setDiffPath(change.path) : props.onOpenFile(change.path))}
                  title={change.revertable ? '查看改动' : '媒体或大文件：只列出，不回退'}
                >
                  {change.path}
                </button>
                {!change.revertable && <span className="muted small">不回退</span>}
              </li>
            ))}
          </ul>
          {changes.length > 4 && (
            <button className="link small more" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : `还有 ${changes.length - 4} 个文件`}
            </button>
          )}
          {error && <p className="error-line">{error}</p>}
          {diffPath && <DiffDialog turnId={end.turn_id ?? ''} path={diffPath} onClose={() => setDiffPath('')} />}
        </section>
      )}
      {turn.state === 'done' && (
        <footer className={'done-line' + (props.latest ? ' latest' : '')}>
          <span>✓ 已完成</span>
          <span>{formatElapsed(props.elapsed)}</span>
          {tokens > 0 && <span className="mono">{tokens.toLocaleString()} tokens</span>}
          {changes.length === 0 && <span>没有改动项目文件</span>}
          {(props.stations?.[end.turn_id ?? ''] ?? []).length > 0 && (
            <span className="turn-stations" title="这一轮推进到的制作环节">
              → {props.stations![end.turn_id ?? ''].join(' · ')}
            </span>
          )}
          <span>{clockOf(end.time)}</span>
        </footer>
      )}
    </div>
  );
}
