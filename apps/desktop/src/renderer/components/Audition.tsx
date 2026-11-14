import { useEffect, useRef, useState } from 'react';
import { api, errorText, post, rawURL } from '../api';
import '../audition.css';
import type { AgentInfo, AgentsResponse, Audition, AuditionContestant, AuditionRecommendation, Scene, Usage } from '../types';
import { Icon } from './Icon';
import { keyLabel } from './Learning';
import { ModelSelect } from './ModelSelect';
import type { RunAction } from './Preview';

interface Props {
  scene: Scene | null;
  scenes: Scene[];
  version: number;
  busy: string;
  run: RunAction;
}

interface Pick {
  renderer: string;
  model: string;
  /** 两段式：先由这一位写设计稿。 */
  designer?: { renderer: string; model: string } | null;
}

/**
 * 试镜页：同一个镜头交给几位选手（渲染工具 + 模型）各渲染一遍，并排同步播放，盲评之后才揭晓是谁，再决定采用哪一份。
 * 选手是谁由后端藏着（评判之前接口里就没有），这一页不需要自己守秘密。
 */
export function AuditionTab({ scene, scenes, version, busy, run }: Props) {
  const [list, setList] = useState<Audition[] | null>(null);
  const [current, setCurrent] = useState('');
  const [error, setError] = useState('');
  const [composing, setComposing] = useState(false);

  const load = () => {
    if (!scene) return;
    api<{ auditions: Audition[] | null }>(`/api/auditions?scene=${encodeURIComponent(scene.id)}`).then(
      (r) => {
        setList(r.auditions ?? []);
        setError('');
      },
      (err) => setError(errorText(err)),
    );
  };

  const [recommend, setRecommend] = useState<AuditionRecommendation[]>([]);
  useEffect(() => {
    setList(null);
    setCurrent('');
    setComposing(false);
    setRecommend([]);
    if (!scene) return;
    api<{ recommendations: AuditionRecommendation[] | null }>(`/api/auditions/recommend?scene=${encodeURIComponent(scene.id)}`).then(
      (r) => setRecommend(r.recommendations ?? []),
      () => setRecommend([]),
    );
  }, [scene?.id]);
  useEffect(load, [scene?.id, version]);

  const running = (list ?? []).some((a) => a.contestants.some((c) => c.status !== 'done'));
  // 渲染中每 3 秒看一次进度；刚点开始、试镜记录还没写出来时也看（busy 是项目正忙的说明）。
  useEffect(() => {
    if (!running && !busy) return;
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [running, busy, scene?.id]);

  if (!scene) return <div className="empty">{scenes.length === 0 ? '还没有镜头。' : '先在镜头页选一个镜头。'}</div>;
  if (error) return <div className="empty">{error}</div>;
  if (!list) return <div className="empty">正在读取…</div>;

  const shown = list.find((a) => a.id === current) ?? list[0] ?? null;
  const index = scenes.findIndex((s) => s.id === scene.id);
  const label = `镜头 ${String(index + 1).padStart(2, '0')}`;

  return (
    <div className="audition">
      <header className="audition-head">
        <span className="eyebrow">试镜 · {label}</span>
        <h2>同一个镜头，谁拍得最好</h2>
        <p>
          同一份镜头说明交给几位选手各拍一遍。看的时候只有 A、B、C，选完才揭晓是谁；选中的那一份可以直接换进镜头。
          你的每一次选择都会记下来，以后用来判断哪个模型该向哪个学。
        </p>
        {recommend.length > 0 && (
          <p className="audition-recommend">
            按你以往的评判，这类镜头
            {recommend.map((r, i) => (
              <span key={r.key}>
                {i > 0 ? '，其次' : ''} <strong>{keyLabel(r.key)}</strong> 赢了 {r.wins}/{r.appearances} 场
              </span>
            ))}
            。
          </p>
        )}
      </header>

      {(composing || !shown) && (
        <Compose
          busy={busy}
          onCancel={shown ? () => setComposing(false) : undefined}
          onStart={(picks, withMemory) => {
            run('/api/auditions', { scene_id: scene.id, contestants: picks, with_memory: withMemory });
            setComposing(false);
            window.setTimeout(load, 800);
          }}
        />
      )}

      {shown && !composing && (
        <>
          <div className="audition-bar">
            {list.length > 1 && (
              <select value={shown.id} aria-label="哪一场试镜" onChange={(e) => setCurrent(e.currentTarget.value)}>
                {list.map((a, i) => (
                  <option key={a.id} value={a.id}>
                    第 {list.length - i} 场 · {when(a.created_at)}
                  </option>
                ))}
              </select>
            )}
            <span className="audition-sub">
              {shown.contestants.length} 位选手 · {shown.with_memory ? '各自带上记忆' : '都不带记忆'}
            </span>
            <span className="spacer" />
            <button className="ghost" disabled={!!busy} onClick={() => setComposing(true)}>
              <Icon name="plus" size={11} /> 再开一场
            </button>
          </div>
          <Stage key={shown.id} audition={shown} version={version} busy={busy} run={run} onChange={load} />
        </>
      )}
    </div>
  );
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 报名：选工具与模型，至少两位。 */
function Compose({ busy, onStart, onCancel }: { busy: string; onStart: (picks: Pick[], withMemory: boolean) => void; onCancel?: () => void }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [withMemory, setWithMemory] = useState(true);

  useEffect(() => {
    api<AgentsResponse>('/api/agents').then(
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

  const set = (i: number, next: Partial<Pick>) => setPicks((list) => list.map((p, j) => (j === i ? { ...p, ...next } : p)));
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
              <button className="ghost small" title="两段式：先由另一位写设计稿，这一位照着做" onClick={() => set(i, { designer: { renderer: agents[0].id, model: '' } })}>
                ＋设计稿
              </button>
            )}
            {picks.length > 2 && (
              <button className="icon" aria-label="去掉这一位" onClick={() => setPicks((list) => list.filter((_, j) => j !== i))}>
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
        <button className="ghost audition-add" onClick={() => setPicks((list) => [...list, { renderer: agents[0].id, model: '' }])}>
          <Icon name="plus" size={11} /> 加一位
        </button>
      )}
      <label className="audition-check">
        <input type="checkbox" checked={withMemory} onChange={(e) => setWithMemory(e.currentTarget.checked)} />
        各自带上记忆
        <span className="muted">（真实情况下它会拿到的那几条；不勾就只比模型本身）</span>
      </label>
      <p className="audition-cost">
        每位选手是一次完整的渲染，{picks.length} 位就是 {picks.length} 次（带设计稿的再加一次写稿），按各家的计费算。镜头本身不会被改动，选好之后才换进去。
      </p>
      {duplicate && <p className="error-line">有两位选手的工具和模型完全一样。</p>}
      <div className="audition-actions">
        <button className="primary" disabled={picks.length < 2 || duplicate || !!busy} title={busy || ''} onClick={() => onStart(picks, withMemory)}>
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

/** 一场试镜：并排同步播放、评判、揭晓与采用。 */
function Stage({ audition: a, version, busy, run, onChange }: { audition: Audition; version: number; busy: string; run: RunAction; onChange: () => void }) {
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [note, setNote] = useState(a.verdict?.note ?? '');
  const [revoting, setRevoting] = useState(false);
  const [error, setError] = useState('');

  const all = () => [...videos.current.values()];
  const toggle = () => {
    const list = all();
    if (playing) {
      for (const v of list) v.pause();
      setPlaying(false);
      return;
    }
    // 先对到同一时刻再一起放：一边先放完时另一边还在走。
    const at = Math.min(...list.map((v) => (v.ended ? 0 : v.currentTime)));
    for (const v of list) {
      v.currentTime = at;
      void v.play().catch(() => undefined);
    }
    setPlaying(true);
  };
  const seek = (t: number) => {
    for (const v of all()) v.currentTime = Math.min(t, v.duration || t);
    setTime(t);
  };

  const done = a.contestants.every((c) => c.status === 'done');
  const judging = done && (a.blind || revoting);

  const vote = async (kind: 'winner' | 'tie' | 'none', winner = '') => {
    setError('');
    try {
      const r = await post<Audition>(`/api/auditions/${a.id}/vote`, { kind, winner, note: note.trim() });
      if (r.warning) setError(r.warning);
      setRevoting(false);
      onChange();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="audition-stage">
      {a.exam && (
        <div className="audition-exam">
          <strong>人评考试</strong>
          <span>
            {keyLabel(a.exam.student)} 向 {keyLabel(a.exam.teacher)} 学的 {a.exam.lessons.length} 条经验：A、B 都是 {keyLabel(a.exam.student)}，一份带上这些经验、一份不带；R 是老师，作参照。
            {a.blind ? ' 从 A、B 里选更好的（更接近老师的）一份。' : ''}
          </span>
        </div>
      )}
      {!done && <p className="audition-status">正在拍：{a.contestants.filter((c) => c.status === 'done').length} / {a.contestants.length} 位拍完。可以离开这一页，拍完会出现在这里。</p>
      }
      <div className={'audition-grid n' + a.contestants.length}>
        {a.contestants.map((c) => (
          <Card
            key={c.slot}
            c={c}
            a={a}
            version={version}
            judging={judging}
            register={(el) => {
              if (el) videos.current.set(c.slot, el);
              else videos.current.delete(c.slot);
            }}
            onTime={(t, d) => {
              setTime(t);
              if (d) setDuration(d);
            }}
            onEnded={() => setPlaying(false)}
            onPick={() => vote('winner', c.slot)}
            onAdopt={() => run(`/api/auditions/${a.id}/adopt`, { slot: c.slot })}
            busy={busy}
          />
        ))}
      </div>

      {a.contestants.some((c) => c.output) && (
        <div className="audition-transport">
          <button className="play" onClick={toggle} aria-label={playing ? '暂停' : '一起播放'}>
            <Icon name={playing ? 'pause' : 'play'} size={14} />
          </button>
          <input
            className="scrub"
            type="range"
            min={0}
            max={duration || 0}
            step={1 / 30}
            value={time}
            aria-label="播放位置"
            onChange={(e) => seek(Number(e.currentTarget.value))}
          />
          <span className="mono small muted">
            {time.toFixed(1)} / {duration.toFixed(1)} 秒
          </span>
        </div>
      )}

      {judging && (
        <div className="audition-judge">
          <p>
            <strong>{a.blind ? (a.exam ? '看完了？A、B 哪份更好？' : '看完了？选出你觉得最好的一份。') : '改判'}</strong>
            <span className="muted"> 点画面下面的「选它」，或者：</span>
          </p>
          <input value={note} placeholder="一句话说说为什么（可选，会一起记下）" aria-label="评判说明" onChange={(e) => setNote(e.currentTarget.value)} />
          <div className="audition-actions">
            <button onClick={() => vote('tie')}>差不多</button>
            <button onClick={() => vote('none')}>都不行</button>
            {revoting && (
              <button className="ghost" onClick={() => setRevoting(false)}>
                取消
              </button>
            )}
          </div>
        </div>
      )}

      {!a.blind && !revoting && a.verdict && (
        <div className="audition-verdict">
          <p>
            <strong>{verdictText(a)}</strong>
            {a.verdict.note && <span className="muted">「{a.verdict.note}」</span>}
            {a.exam && <span className="audition-exam-result">{examText(a)}</span>}
          </p>
          {!(a.exam && (a.exam.applied === 'promoted' || a.exam.applied === 'rejected')) && (
            <button className="ghost" onClick={() => setRevoting(true)}>
              改判
            </button>
          )}
        </div>
      )}
      {error && <p className="error-line">{error}</p>}
    </section>
  );
}

function examText(a: Audition): string {
  switch (a.exam?.applied) {
    case 'promoted':
      return '你选了带经验的那份：这些经验生效，学生以后渲染会带上。';
    case 'rejected':
      return '你选了不带经验的那份：这些经验不留。';
    case 'undecided':
      return '差不多或都不行：经验留在试用，可以换个镜头再考一场。';
  }
  return '';
}

function verdictText(a: Audition): string {
  const v = a.verdict!;
  if (v.kind === 'tie') return '你判：差不多';
  if (v.kind === 'none') return '你判：都不行';
  const c = a.contestants.find((x) => x.slot === v.winner);
  return `你选了 ${v.winner}${c ? ' · ' + who(c) : ''}`;
}

function who(c: AuditionContestant): string {
  const model = c.model || c.actual_model || '';
  const own = model ? `${c.renderer} · ${model}` : c.renderer ?? '';
  if (!c.designer) return own;
  return `${own} ← ${c.designer_model ? `${c.designer} · ${c.designer_model}` : c.designer} 的设计稿`;
}

const roleName: Record<string, string> = { reference: '参照 · 老师', trial: '带经验', control: '不带经验' };

function tokens(u: Usage | null | undefined): string {
  if (!u) return '';
  const n = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  if (n === 0) return '';
  return (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k') + ' token' + (u.partial ? '+' : '');
}

function Card({
  c,
  a,
  version,
  judging,
  busy,
  register,
  onTime,
  onEnded,
  onPick,
  onAdopt,
}: {
  c: AuditionContestant;
  a: Audition;
  version: number;
  judging: boolean;
  busy: string;
  register: (el: HTMLVideoElement | null) => void;
  onTime: (t: number, duration: number) => void;
  onEnded: () => void;
  onPick: () => void;
  onAdopt: () => void;
}) {
  const won = a.verdict?.kind === 'winner' && a.verdict.winner === c.slot;
  const adopted = a.adopted?.slot === c.slot;
  const ok = c.outcome === 'succeeded';
  const reference = c.role === 'reference';
  return (
    <figure className={'audition-card' + (won && !a.blind ? ' won' : '') + (reference ? ' reference' : '')} data-slot={c.slot}>
      <figcaption>
        <span className="audition-slot">{c.slot}</span>
        {c.role && (!a.blind || reference) && <span className="audition-chip">{roleName[c.role]}</span>}
        {(!a.blind || reference) && <span className="audition-who">{who(c)}</span>}
        {won && !a.blind && <span className="audition-chip on">你选的</span>}
        {adopted && <span className="audition-chip">已换进镜头</span>}
      </figcaption>
      {c.output ? (
        <video
          ref={register}
          src={rawURL(c.output, version)}
          preload="metadata"
          muted
          playsInline
          onTimeUpdate={(e) => onTime(e.currentTarget.currentTime, e.currentTarget.duration)}
          onLoadedMetadata={(e) => onTime(e.currentTarget.currentTime, e.currentTarget.duration)}
          onEnded={onEnded}
        />
      ) : (
        <div className="audition-empty">
          {c.status === 'pending' && '等着上场'}
          {c.status === 'running' && (
            <>
              <span className="dot busy" /> 正在拍
            </>
          )}
          {c.status === 'done' && '没拍出合格的画面'}
        </div>
      )}
      {!a.blind && c.status === 'done' && (
        <p className="audition-facts">
          {ok ? '没有查出问题' : (c.problems?.length ?? 0) > 0 ? `查出 ${c.problems!.length} 处问题` : '没跑成'}
          {c.seconds ? ` · ${Math.round(c.seconds)} 秒` : ''}
          {tokens(c.usage) ? ` · ${tokens(c.usage)}` : ''}
        </p>
      )}
      {!a.blind && !ok && (c.problems?.length || c.error) && (
        <details className="audition-why">
          <summary>为什么</summary>
          <ul>
            {(c.problems ?? []).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
            {c.error && <li>{c.error}</li>}
          </ul>
        </details>
      )}
      <div className="audition-card-actions">
        {judging && c.output && !reference && <button onClick={onPick}>选它</button>}
        {!a.blind && ok && !adopted && !c.role && (
          <button className={won ? 'primary' : 'ghost'} disabled={!!busy} title={busy || '把这一份换进镜头，原来的画面归档'} onClick={onAdopt}>
            换进镜头
          </button>
        )}
      </div>
    </figure>
  );
}
