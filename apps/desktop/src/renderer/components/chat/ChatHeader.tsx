import { useEffect, useRef, useState } from 'react';
import type { ProgressState, SessionMeta } from '../../types';
import type { Guide, GuideAction } from '../guide';
import { Icon } from '../Icon';
import { currentSummary } from '../Progress';

export interface ChatHeaderProps {
  sessions: SessionMeta[];
  sessionId: string;
  session?: SessionMeta;
  menu: '' | 'history' | 'plus';
  onMenu: (menu: '' | 'history' | 'plus') => void;
  onPickSession: (id: string) => void;
  onNewSession: () => void;
  onHandoff: () => void;
  onStartProduction: () => void;
  blocked: boolean;
  running: boolean;
  sending: boolean;
  drawing: { ok: boolean; reason: string };
  progress: ProgressState | null;
  onProgress: () => void;
  guide: Guide | null;
  onGuideAction: (action: GuideAction) => void;
}

export function ChatHeader(props: ChatHeaderProps) {
  const { session, menu, drawing } = props;
  return (
    <>
      <header className="chat-header">
        <div className="history">
          <button
            className="icon-button"
            id="history"
            aria-label="会话记录"
            title="会话记录"
            aria-expanded={menu === 'history'}
            onClick={() => props.onMenu(menu === 'history' ? '' : 'history')}
          >
            <Icon name="history" size={14} />
          </button>
          {menu === 'history' && (
            <HistoryMenu
              sessions={props.sessions}
              current={props.sessionId}
              onPick={props.onPickSession}
              onClose={() => props.onMenu('')}
            />
          )}
        </div>
        <span className="chat-title ellipsis" id="session-title" title={session?.title}>
          {session ? `${session.title}${session.kind === 'production' ? ' · 整片制作' : ''}` : '新对话'}
        </span>
        <span className="spacer" />
        {props.sessionId && (session?.turns?.length ?? 0) > 0 && !props.running && (
          <button
            className="icon-button"
            id="handoff-session"
            disabled={props.blocked}
            onClick={props.onHandoff}
            aria-label="新会话接力"
            title="新会话接力：清空旧上下文，保留项目进度继续（省 Token）"
          >
            <Icon name="handoff" size={13} />
          </button>
        )}
        {props.sessionId && (
          <button className="icon-button" onClick={props.onNewSession} aria-label="新对话" title="新对话">
            <Icon name="plus" size={13} />
          </button>
        )}
        <button
          id="start-production"
          className="primary pill"
          disabled={props.blocked || props.running || !drawing.ok}
          onClick={props.onStartProduction}
          title={drawing.ok ? '从头开始整片制作' : drawing.reason}
        >
          开始制作
        </button>
      </header>
      {!drawing.ok && (
        <div className="chat-renderer-missing" role="alert" id="renderer-missing">
          <Icon name="alert" size={13} />
          <span>{drawing.reason}：在输入框下方「渲染」里换一家，或去设置里改。</span>
        </div>
      )}
      <ProgressStrip progress={props.progress} onOpen={props.onProgress} />
      <NextStep
        guide={props.guide}
        disabled={props.blocked || props.running || props.sending}
        onAction={props.onGuideAction}
      />
    </>
  );
}

function HistoryMenu(props: {
  sessions: SessionMeta[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.parentElement?.contains(e.target as Node)) props.onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  const list = props.sessions.filter((s) => !query || s.title.includes(query));
  return (
    <div className="popover menu history-menu" ref={box} role="menu">
      <div className="history-search">
        <input
          autoFocus
          value={query}
          placeholder="搜索会话"
          aria-label="搜索会话"
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button className="icon-button" onClick={() => props.onPick('')} aria-label="新对话" title="新对话">
          <Icon name="plus" size={12} />
        </button>
      </div>
      {list.length === 0 && <p className="muted small empty">没有会话</p>}
      {list.map((s) => (
        <button
          key={s.session_id}
          role="menuitem"
          className={'history-row' + (s.session_id === props.current ? ' on' : '')}
          onClick={() => props.onPick(s.session_id)}
        >
          <span className="ellipsis">{s.title}</span>
          <span className="muted small">
            {s.kind === 'production' ? '整片制作 · ' : ''}
            {s.turns.length} 轮 · {new Date(s.updated_at).toLocaleString()}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * 「接下来」：在等你的时候，对话顶上那一行下面展开一张卡片，说清现在该做什么，带几个按钮。
 * AI 在做时不展开（那一行已经写着「AI 在做」）。点 × 收起这一次，换到下一站或下一种状态时再出现。
 */
function NextStep({
  guide,
  disabled,
  onAction,
}: {
  guide: Guide | null;
  disabled: boolean;
  onAction: (action: GuideAction) => void;
}) {
  const key = guide ? guide.title + '|' + guide.text : '';
  const [hidden, setHidden] = useState('');
  // 插件的操作对外、不能撤回：点了先在卡片上问一次，用户点「执行」才跑。
  const [confirming, setConfirming] = useState<Extract<GuideAction, { kind: 'op' }> | null>(null);
  if (!guide || !guide.waiting || hidden === key) return null;
  return (
    <section className="next-step" id="next-step" aria-label="接下来">
      <div className="ns-head">
        <span className="ns-kicker">接下来</span>
        <strong>{guide.title}</strong>
        <span className="spacer" />
        <button className="icon-button" aria-label="收起" title="收起" onClick={() => setHidden(key)}>
          <Icon name="close" size={10} />
        </button>
      </div>
      <p>{guide.text}</p>
      {confirming && (
        <div className="ns-confirm" role="alertdialog" aria-label="确认执行">
          <span>执行插件操作「{confirming.summary}」？</span>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => {
              onAction(confirming);
              setConfirming(null);
            }}
          >
            执行
          </button>
          <button onClick={() => setConfirming(null)}>取消</button>
        </div>
      )}
      {guide.actions.length > 0 && !confirming && (
        <div className="ns-actions">
          {guide.actions.map((action) => (
            <button
              key={action.label}
              // 推进制作的（确认、开工、发话）是主按钮；开页面、填输入框是次要的。
              className={action.kind === 'page' || action.kind === 'draft' ? '' : 'primary'}
              disabled={disabled && action.kind !== 'page' && action.kind !== 'draft'}
              onClick={() => (action.kind === 'op' ? setConfirming(action) : onAction(action))}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** 对话顶上的一行：现在在制作路线的哪一站、在等谁；点开制作路线。 */
function ProgressStrip({ progress, onOpen }: { progress: ProgressState | null; onOpen: () => void }) {
  const { station, text } = currentSummary(progress);
  if (!progress || !text) return null;
  const waiting = progress.waiting_on === 'user' || station?.status === 'changed';
  return (
    <button
      className={'progress-strip' + (waiting ? ' waiting' : '')}
      id="progress-strip"
      onClick={onOpen}
      title="打开制作路线"
    >
      {station && !waiting ? (
        <span className="orb tiny" aria-hidden="true" />
      ) : (
        <span className={'ps-dot' + (station ? '' : ' done')} aria-hidden="true" />
      )}
      {station ? (
        <>
          <span className="ps-label">现在 · {station.label}</span>
          <span className="ps-text">{text}</span>
        </>
      ) : (
        <span className="ps-label">{text}</span>
      )}
      <span className="spacer" />
      <span className="ps-open">制作路线</span>
      <Icon name="next" size={10} />
    </button>
  );
}
