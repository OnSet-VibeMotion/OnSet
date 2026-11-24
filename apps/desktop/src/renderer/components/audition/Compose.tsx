import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { AgentInfo, AgentsResponse } from '../../types';
import { Icon } from '../Icon';
import { ModelSelect } from '../ModelSelect';
import type { Pick } from './helpers';

/** 报名：选工具与模型，至少两位。 */
export function Compose({
  busy,
  onStart,
  onCancel,
}: {
  busy: string;
  onStart: (picks: Pick[], withMemory: boolean) => void;
  onCancel?: () => void;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [withMemory, setWithMemory] = useState(true);

  useEffect(() => {
    void api<AgentsResponse>('/api/agents').then(
      (r) => {
        const usable = r.agents.filter((a) => a.renderer && a.installed);
        setAgents(usable);
        // 缺省两位：设置里的渲染工具，加另一家装着的（只有一家时同一家换个模型来比）。
        const first = usable.find((a) => a.id === r.renderer) ?? usable[0];
        if (!first) return;
        const second = usable.find((a) => a.id !== first.id) ?? first;
        setPicks([
          { renderer: first.id, model: r.renderer === first.id ? (r.renderer_model ?? '') : '' },
          { renderer: second.id, model: '' },
        ]);
      },
      () => setAgents([]),
    );
  }, []);

  const set = (i: number, next: Partial<Pick>) =>
    setPicks((list) => list.map((p, j) => (j === i ? { ...p, ...next } : p)));
  const key = (p: Pick) => [p.renderer, p.model, p.designer?.renderer ?? '', p.designer?.model ?? ''].join('\0');
  const duplicate = picks.some((p, i) => picks.findIndex((q) => key(q) === key(p)) !== i);
  const labelOf = (id: string) => agents.find((a) => a.id === id)?.label ?? id;

  if (agents.length === 0) {
    return (
      <section className="audition-compose">
        <h3>没有能上场的渲染工具</h3>
        <p className="muted">这台电脑上还没装能渲染的工具（Claude Code、Codex、Qoder、CodeBuddy、OpenCode 任一家）。</p>
      </section>
    );
  }

  return (
    <section className="audition-compose">
      <h3>选手</h3>
      <ol className="audition-picks">
        {picks.map((p, i) => (
          <li key={i}>
            <span className="audition-ordinal">{i + 1}</span>
            <select
              value={p.renderer}
              aria-label={`第 ${i + 1} 位的渲染工具`}
              onChange={(e) => set(i, { renderer: e.currentTarget.value, model: '' })}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            <ModelSelect
              tool={p.renderer}
              value={p.model}
              defaultLabel={`${labelOf(p.renderer)} 自己的默认`}
              ariaLabel={`第 ${i + 1} 位的模型`}
              onChange={(model) => set(i, { model })}
            />
            {!p.designer && (
              <button
                className="ghost small"
                title="两段式：先由另一位写设计稿，这一位照着做"
                onClick={() => set(i, { designer: { renderer: agents[0].id, model: '' } })}
              >
                ＋设计稿
              </button>
            )}
            {picks.length > 2 && (
              <button
                className="icon"
                aria-label="去掉这一位"
                onClick={() => setPicks((list) => list.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={11} />
              </button>
            )}
            {p.designer && (
              <div className="audition-designer">
                <span className="muted">照着</span>
                <select
                  value={p.designer.renderer}
                  aria-label={`第 ${i + 1} 位的设计者`}
                  onChange={(e) => set(i, { designer: { renderer: e.currentTarget.value, model: '' } })}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
                <ModelSelect
                  tool={p.designer.renderer}
                  value={p.designer.model}
                  defaultLabel={`${labelOf(p.designer.renderer)} 自己的默认`}
                  ariaLabel={`第 ${i + 1} 位的设计者模型`}
                  onChange={(model) => set(i, { designer: { renderer: p.designer!.renderer, model } })}
                />
                <span className="muted">写的设计稿来做</span>
                <button className="icon" aria-label="不要设计稿" onClick={() => set(i, { designer: null })}>
                  <Icon name="close" size={11} />
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      {picks.length < 6 && (
        <button
          className="ghost audition-add"
          onClick={() => setPicks((list) => [...list, { renderer: agents[0].id, model: '' }])}
        >
          <Icon name="plus" size={11} /> 加一位
        </button>
      )}
      <label className="audition-check">
        <input type="checkbox" checked={withMemory} onChange={(e) => setWithMemory(e.currentTarget.checked)} />
        各自带上记忆
        <span className="muted">（真实情况下它会拿到的那几条；不勾就只比模型本身）</span>
      </label>
      <p className="audition-cost">
        每位选手是一次完整的渲染，{picks.length} 位就是 {picks.length}{' '}
        次（带设计稿的再加一次写稿），按各家的计费算。镜头本身不会被改动，选好之后才换进去。
      </p>
      {duplicate && <p className="error-line">有两位选手的工具和模型完全一样。</p>}
      <div className="audition-actions">
        <button
          className="primary"
          disabled={picks.length < 2 || duplicate || !!busy}
          title={busy || ''}
          onClick={() => onStart(picks, withMemory)}
        >
          开始试镜
        </button>
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
        )}
        {busy && <span className="muted small">项目正忙：{busy}</span>}
      </div>
    </section>
  );
}
