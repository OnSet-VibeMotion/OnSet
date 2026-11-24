import { useEffect, useRef, useState } from 'react';
import { errorText } from '../../api';
import type { StationInfo, StationOp, StationParam, StationRun } from '../../types';
import type { RunAction } from '../Preview';
import { runAndWait, ScopeWarning } from './meta';

/** 列表操作结果里的一项（清单 ops[].list）：卡片上的头像、名字与按钮。只认 data:image 的图片。 */
interface ListItem {
  title: string;
  detail: string;
  image: string;
  actions: { label: string; op: string; params: Record<string, unknown>; confirm: string }[];
}

function listItems(run?: StationRun): ListItem[] | null {
  const raw = (run?.data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(raw)) return null;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return raw.slice(0, 50).flatMap((it): ListItem[] => {
    if (!it || typeof it !== 'object') return [];
    const o = it as Record<string, unknown>;
    const title = str(o.title, 80);
    if (!title) return [];
    const image =
      typeof o.image === 'string' && /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(o.image) ? o.image : '';
    const actions = (Array.isArray(o.actions) ? o.actions : []).slice(0, 4).flatMap((a) => {
      if (!a || typeof a !== 'object') return [];
      const x = a as Record<string, unknown>;
      const params =
        x.params && typeof x.params === 'object' && !Array.isArray(x.params)
          ? (x.params as Record<string, unknown>)
          : {};
      return str(x.label, 20) && str(x.op, 80)
        ? [{ label: str(x.label, 20), op: str(x.op, 80), params, confirm: str(x.confirm, 120) }]
        : [];
    });
    return [{ title, detail: str(o.detail, 160), image, actions }];
  });
}

/** 参数值的初始状态：用缺省值，没有就空。 */
function initialValue(p: StationParam): string | boolean {
  if (p.type === 'boolean') return p.default === true;
  if (p.default === undefined) return '';
  return Array.isArray(p.default) ? p.default.join('\n') : String(p.default);
}

function toParams(params: StationParam[], values: Record<string, string | boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of params) {
    const v = values[p.key];
    if (p.type === 'boolean') {
      out[p.key] = v === true;
      continue;
    }
    const text = typeof v === 'string' ? v.trim() : '';
    if (text === '') continue;
    if (p.type === 'integer' || p.type === 'number') out[p.key] = Number(text);
    else if (p.type === 'strings') {
      out[p.key] = text
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    } else out[p.key] = text;
  }
  return out;
}

function OpAction({
  station,
  op,
  run,
  disabled = false,
}: {
  station: StationInfo;
  op: StationOp;
  run: RunAction;
  disabled?: boolean;
}) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(op.params.map((p) => [p.key, initialValue(p)])),
  );
  const missing = op.params.some(
    (p) => p.required && p.type !== 'boolean' && String(values[p.key] ?? '').trim() === '',
  );
  const last = op.last_run;
  return (
    <div className="station-op" data-op={op.name}>
      <div className="station-op-head">
        <strong>{op.summary}</strong>
        {op.description && <span>{op.description}</span>}
      </div>
      {op.params.map((p) => (
        <label key={p.key} className="station-param">
          <span>
            {p.description}
            {p.required ? '' : '（可不填）'}
          </span>
          {p.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={values[p.key] === true}
              onChange={(e) => setValues({ ...values, [p.key]: e.target.checked })}
            />
          ) : p.type === 'strings' ? (
            <textarea
              rows={2}
              value={String(values[p.key] ?? '')}
              onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
            />
          ) : (
            <input
              aria-label={p.description}
              inputMode={p.type === 'string' ? undefined : 'decimal'}
              value={String(values[p.key] ?? '')}
              onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
            />
          )}
        </label>
      ))}
      <div className="station-op-foot">
        <button
          className="primary"
          disabled={missing || disabled}
          onClick={() =>
            run(`/api/stations/${encodeURIComponent(station.id)}/ops/${encodeURIComponent(op.name)}`, {
              params: toParams(op.params, values),
            })
          }
        >
          {op.summary.replace(/（.*?）/g, '')}
        </button>
        {last && (
          <span className={last.ok ? 'station-last ok' : 'station-last bad'}>
            {last.ok ? '上次执行成功' : '上次执行失败'}
          </span>
        )}
      </div>
      <ScopeWarning run={last} />
      {last && last.text.trim() !== '' && <pre className="station-output">{last.text.trim()}</pre>}
    </div>
  );
}

/**
 * 「详情与设置」里插件要你点的东西：列表操作（ops[].list，例如已登录的账号）画成卡片，打开弹窗与每次操作跑完后自动刷新；
 * 其余操作出按钮表单（ops[].form 为 false 的不出）。不需要项目的在这里跑完再刷新列表，要项目的交给客户端的写任务。
 */
export function PluginActions({ station, run, onDone }: { station: StationInfo; run?: RunAction; onDone: () => void }) {
  const user = station.ops.filter((o) => o.trigger === 'user');
  const lists = user.filter((o) => o.list);
  const forms = user.filter((o) => !o.list && o.form);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState('');
  // 同一时间只跑一个：按钮在 React 重画前还能再点一次，靠这个同步的标记挡住第二次提交。
  const inflight = useRef(false);
  const base = `/api/stations/${encodeURIComponent(station.id)}/ops/`;
  const refresh = async () => {
    for (const l of lists) await runAndWait(base + encodeURIComponent(l.name), { params: {} }).catch(() => undefined);
    setLoaded(true);
    onDone();
  };
  useEffect(() => {
    if (lists.length > 0) void refresh();
    // 只在打开弹窗（换插件）时刷新。
  }, [station.id]);
  const start = (op: StationOp, params: Record<string, unknown>) => {
    if (op.project) {
      if (!run) {
        return setMessage({
          ok: false,
          text: `「${op.summary.replace(/（.*?）/g, '')}」要在项目里执行，先打开一个项目`,
        });
      }
      return run(base + encodeURIComponent(op.name), { params });
    }
    if (inflight.current) return;
    inflight.current = true;
    const label = op.summary.replace(/（.*?）/g, '');
    setBusy(label);
    setMessage(null);
    void (async () => {
      try {
        const t = await runAndWait(base + encodeURIComponent(op.name), { params });
        const done = (t.result as { message?: unknown } | undefined)?.message;
        setMessage(
          t.status === 'succeeded'
            ? { ok: true, text: typeof done === 'string' && done ? done : `${label}：好了` }
            : { ok: false, text: `${label}没有成功：${t.error || t.message}` },
        );
      } catch (err) {
        setMessage({ ok: false, text: `${label}没有成功：${errorText(err)}` });
      }
      inflight.current = false;
      setBusy('');
      await refresh();
    })();
  };
  if (user.length === 0) return null;
  const projectForms = forms.filter((o) => o.project);
  return (
    <div className="station-actions-group plugin-actions">
      {busy && (
        <div className="stations-busy" role="status">
          {busy}…
        </div>
      )}
      {!busy && message && (
        <div className={message.ok ? 'stations-result' : 'stations-result bad'} role="status">
          {message.text}
        </div>
      )}
      {lists.map((l) => {
        const items = listItems(l.last_run);
        return (
          <section key={l.name} className="plugin-list" data-op={l.name} aria-label={l.summary}>
            <div className="plugin-list-head">
              <div className="station-prompt-label">{l.summary.replace(/（.*?）/g, '')}</div>
              <button className="link" disabled={busy !== ''} onClick={() => void refresh()}>
                刷新
              </button>
            </div>
            {!loaded && !items && <span className="station-perms-note">正在读取…</span>}
            {l.last_run && !l.last_run.ok && (
              <span className="station-last bad">{l.last_run.text.trim().split('\n').pop()}</span>
            )}
            {items && items.length === 0 && <span className="station-perms-note">还没有。</span>}
            {items && items.length > 0 && (
              <ul className="plugin-items">
                {items.map((it, i) => (
                  <li key={it.title + i} className="plugin-item">
                    {it.image ? (
                      <img src={it.image} alt="" />
                    ) : (
                      <span className="plugin-item-blank">{[...it.title][0]}</span>
                    )}
                    <div className="plugin-item-text">
                      <strong>{it.title}</strong>
                      {it.detail && <span>{it.detail}</span>}
                    </div>
                    {it.actions.map((a) => {
                      const op = user.find((o) => o.name === a.op);
                      if (!op) return null;
                      // 确认状态认的是这一项本身（名字与按钮参数），不是它在列表里的位置：列表刷新后挪了位，不能确认到别的账号上。
                      const key = `${it.title}\n${a.label}\n${JSON.stringify(a.params)}`;
                      return asking === key ? (
                        <span key={key} className="plugin-item-confirm">
                          <span>{a.confirm}</span>
                          <button
                            className="danger"
                            disabled={busy !== ''}
                            onClick={() => {
                              setAsking('');
                              start(op, a.params);
                            }}
                          >
                            {a.label}
                          </button>
                          <button onClick={() => setAsking('')}>取消</button>
                        </span>
                      ) : (
                        <button
                          key={key}
                          disabled={busy !== ''}
                          onClick={() => (a.confirm ? setAsking(key) : start(op, a.params))}
                        >
                          {a.label}
                        </button>
                      );
                    })}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {forms.length > 0 && <div className="station-prompt-label">要你点的操作</div>}
      {forms
        .filter((o) => !o.project)
        .map((o) => (
          <OpAction
            key={o.name}
            station={station}
            op={o}
            disabled={busy !== ''}
            run={(_path, payload) => start(o, (payload?.params as Record<string, unknown>) ?? {})}
          />
        ))}
      {projectForms.length > 0 &&
        (run ? (
          projectForms.map((o) => <OpAction key={o.name} station={station} op={o} run={run} />)
        ) : (
          <span className="station-perms-note">
            {projectForms.map((o) => `「${o.summary.replace(/（.*?）/g, '')}」`).join('')}
            针对项目执行，打开一个项目后在这里点。
          </span>
        ))}
    </div>
  );
}
