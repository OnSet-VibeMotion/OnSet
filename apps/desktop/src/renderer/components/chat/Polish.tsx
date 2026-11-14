import { Icon } from '../Icon';

/** /api/polish 的回答。 */
export interface PolishResult {
  decision: 'skip' | 'rewrite';
  text: string;
  notes: string[];
  tool: string;
  model?: string;
}

export interface PolishState {
  /** 交去润色的原文。 */
  from: string;
  status: 'working' | 'done' | 'failed';
  result?: PolishResult;
  error?: string;
}

/**
 * 输入框上方的润色卡片：上面是改写后的整句话，下面一行说改了什么。「用这版」只替换输入框，不发送；
 * 原文在用户点之前不动。润色期间用户接着打了字时照实提醒，免得「用这版」盖掉新写的。
 */
export function PolishCard({
  state,
  draft,
  onUse,
  onRetry,
  onClose,
}: {
  state: PolishState;
  draft: string;
  onUse: (text: string) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const edited = draft.trim() !== state.from.trim();
  return (
    <div className="polish-card" id="polish-card" role="region" aria-label="润色">
      <div className="polish-head">
        <span className="polish-badge">
          <Icon name="spark" size={12} />
          润色
        </span>
        {state.result && <span className="polish-by">{state.result.model ? `${state.result.tool} · ${state.result.model}` : state.result.tool}</span>}
        <span className="spacer" />
        <button className="icon-button" aria-label={state.status === 'working' ? '取消润色' : '关闭润色'} title={state.status === 'working' ? '取消' : '不用了'} onClick={onClose}>
          <Icon name="close" size={11} />
        </button>
      </div>
      {state.status === 'working' && (
        <p className="polish-working">
          <span className="orb tiny" aria-hidden="true" />
          <span className="shimmer">正在把这句话改得更清楚…</span>
        </p>
      )}
      {state.status === 'failed' && <p className="polish-error">{state.error}</p>}
      {state.status === 'done' && state.result?.decision === 'skip' && <p className="polish-skip">这句话已经够清楚了，不用改。</p>}
      {state.status === 'done' && state.result?.decision === 'rewrite' && (
        <>
          <p className="polish-text" id="polish-text">
            {state.result.text}
          </p>
          {state.result.notes.length > 0 && (
            <ul className="polish-notes">
              {state.result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {edited && <p className="polish-warn">润色期间输入框又改过了，「用这版」会换掉新写的内容。</p>}
        </>
      )}
      {state.status !== 'working' && (
        <div className="polish-actions">
          {state.status === 'done' && state.result?.decision === 'rewrite' && (
            <button className="primary pill" id="polish-use" onClick={() => onUse(state.result!.text)}>
              用这版
            </button>
          )}
          <button className="pill" id="polish-retry" onClick={onRetry}>
            {state.status === 'failed' ? '再试一次' : '再润色一次'}
          </button>
          <button className="pill ghost" onClick={onClose}>
            不用了
          </button>
        </div>
      )}
    </div>
  );
}
