import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react';
import type { SkinView } from '../../types';
import type { CrewSignal, PetCommand } from '../chat/crew';
import { Icon } from '../Icon';
import type { CrewInfo, Who } from './crewState';
import { CH, CW } from './iso';

export const sendPet = (command: PetCommand) => window.onset?.pet?.(command);

const moodTone: Record<string, 'good' | 'mid' | 'bad'> = {
  满意: 'good',
  舒心: 'good',
  悠闲: 'good',
  专注: 'mid',
  焦急: 'mid',
  无奈: 'bad',
  沮丧: 'bad',
  低落: 'bad',
};

/** 选中的人的状态面板：在做什么、心情、需求条、动作队列。 */
export function CrewPanel({ info, who, onClose }: { info: CrewInfo; who: Who; onClose: () => void }) {
  return (
    <aside
      className="pet-panel"
      data-who={who}
      aria-label={`${info.name}的状态`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <header>
        <strong>{info.name}</strong>
        <span className="pet-panel-role">{info.role}</span>
        <span className="pet-mood" data-tone={moodTone[info.mood] ?? 'mid'}>
          {info.mood}
        </span>
        <button className="pet-panel-close" aria-label="取消选中" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="pet-panel-doing">{info.doing}</p>
      <ul className="pet-needs">
        {info.needs.map((n) => (
          <li key={n.label}>
            <span>{n.label}</span>
            <i>
              <b
                style={{ width: `${Math.round(n.value * 100)}%` }}
                data-kind={n.kind ?? 'need'}
                data-low={!n.kind && n.value < 0.3 ? 'true' : 'false'}
              />
            </i>
            <em>{n.note}</em>
          </li>
        ))}
      </ul>
      {info.queue.length > 0 ? (
        <ol className="pet-queue" aria-label="接下来要做的">
          {info.queue.slice(0, 5).map((q, k) => (
            <li key={k} data-state={q.state}>
              {q.text}
            </li>
          ))}
          {info.queue.length > 5 ? <li data-state="more">还有 {info.queue.length - 5} 件</li> : null}
        </ol>
      ) : null}
    </aside>
  );
}

/**
 * 皮肤用插件页面整个换掉工作室：页面在沙箱 iframe 里（不给 allow-same-origin，后端另有 pageCSP 不许连网）。
 * 宿主把桌宠的全部状态（含等批准的调用、上一轮的选项）与皮肤的颜色 postMessage 过去；页面能做宿主桌宠能做的
 * 一切（答批准、发话、停下、切页、回到客户端、收起），动作原样交给主进程，形状由 main/pet.ts 的 petCommand 校验。
 * 不像插件页面那样要用户在宿主上再确认一次：用皮肤换桌宠就是把桌宠交给这个插件（用户的决定）。
 */
export function PetPage({ url, signal, skin }: { url: string; signal: CrewSignal; skin: SkinView }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const message = useMemo(
    () => ({ onset: 'pet', signal, skin: { scheme: skin.scheme, tokens: skin.tokens } }),
    [signal, skin],
  );
  const post = () => frame.current?.contentWindow?.postMessage(message, '*');
  useEffect(post, [message]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { onset?: unknown; phase?: unknown; command?: unknown } | null;
      // 宿主插进页面的拖动脚本（studio/stations.ts 的 petDragScript）：按住空白处挪动就拖窗口。
      if (data?.onset === 'pet-drag' && (data.phase === 'start' || data.phase === 'end')) {
        sendPet({ kind: 'drag', phase: data.phase });
        return;
      }
      if (!data || data.onset !== 'pet-command' || !data.command || typeof data.command !== 'object') return;
      sendPet(data.command as PetCommand);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      className="pet-frame"
      title="桌宠"
      src={url}
      sandbox="allow-scripts"
      width={CW}
      height={CH}
      onLoad={post}
    />
  );
}

/**
 * 盖在工作室下沿的一块小桌面：有批准请求时先答批准，上一轮回复带选项时列出选项，点了「说一句」时是输入框。
 * 三样都只是把动作交回主窗口（main/pet.ts 转交），桌宠自己不调接口。
 */
export function Desk(props: { signal: CrewSignal; composing: boolean; onCompose: (open: boolean) => void }) {
  const { signal, composing, onCompose } = props;
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // 打开输入框时先请主进程把桌宠设成键盘窗口，再把光标放进去。
  useEffect(() => {
    if (!composing) return;
    sendPet({ kind: 'type' });
    const timer = window.setTimeout(() => input.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [composing]);
  useEffect(() => {
    if (!sent) return;
    const timer = window.setTimeout(() => setSent(false), 1800);
    return () => window.clearTimeout(timer);
  }, [sent]);
  // 离开项目时收起输入框。
  useEffect(() => {
    if (!signal.project) onCompose(false);
  }, [signal.project, onCompose]);

  const ask = signal.asks[0];
  const say = () => {
    const text = draft.trim();
    if (!text || !signal.canSend) return;
    sendPet({ kind: 'say', text });
    setDraft('');
    setSent(true);
    onCompose(false);
  };

  let body: ReactElement | null = null;
  if (ask) {
    body = (
      <div className="pet-desk" data-desk="ask">
        <div className="pet-desk-head">
          <span>制作人想执行</span>
          {signal.asks.length > 1 ? <span className="pet-desk-more">还有 {signal.asks.length - 1} 件</span> : null}
        </div>
        <code className="pet-desk-cmd" title={ask.text}>
          {ask.text}
        </code>
        <div className="pet-desk-row">
          <button
            className="pet-btn primary"
            onClick={() => sendPet({ kind: 'answer', id: ask.id, decision: 'allow' })}
          >
            允许
          </button>
          {ask.always ? (
            <button className="pet-btn" onClick={() => sendPet({ kind: 'answer', id: ask.id, decision: 'always' })}>
              以后都允许
            </button>
          ) : null}
          <button className="pet-btn quiet" onClick={() => sendPet({ kind: 'answer', id: ask.id, decision: 'deny' })}>
            拒绝
          </button>
        </div>
      </div>
    );
  } else if (composing) {
    body = (
      <form
        className="pet-desk"
        data-desk="say"
        onSubmit={(event) => {
          event.preventDefault();
          say();
        }}
      >
        <div className="pet-desk-row">
          <input
            ref={input}
            className="pet-input"
            value={draft}
            placeholder={
              signal.canSend ? (signal.running ? '说一句，排到这一轮之后' : '对制作人说一句') : '项目正忙，稍后再说'
            }
            disabled={!signal.canSend}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCompose(false);
            }}
          />
          <button
            className="pet-btn primary icon"
            type="submit"
            disabled={!draft.trim() || !signal.canSend}
            aria-label="发送"
            title="发送"
          >
            <Icon name="send" size={11} />
          </button>
        </div>
      </form>
    );
  } else if (signal.choices.length > 0) {
    body = (
      <div className="pet-desk" data-desk="choices">
        {signal.question ? (
          <div className="pet-desk-head" title={signal.question}>
            <span className="pet-desk-q">{signal.question}</span>
          </div>
        ) : null}
        <div className="pet-desk-row wrap">
          {signal.choices.slice(0, 4).map((choice) => (
            <button
              key={choice}
              className="pet-btn choice"
              title={choice}
              onClick={() => sendPet({ kind: 'say', text: choice })}
            >
              {choice}
            </button>
          ))}
          {signal.choices.length > 4 ? (
            <button className="pet-btn quiet" onClick={() => sendPet({ kind: 'focus' })}>
              更多…
            </button>
          ) : null}
        </div>
      </div>
    );
  } else if (sent) {
    body = (
      <div className="pet-desk" data-desk="sent">
        <span className="pet-desk-note">已经交给制作人</span>
      </div>
    );
  }
  if (!body) return null;
  return (
    <div className="pet-desk-wrap" onDoubleClick={(event) => event.stopPropagation()}>
      {body}
    </div>
  );
}
