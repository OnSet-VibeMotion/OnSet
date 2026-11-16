import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon';
import { NativeDirectoryPicker } from './NativeDirectoryPicker';
import { api, errorText, post } from '../api';
import type { BuiltinContents, ProgressState, ProjectState, Scene, StationInfo, StationOp, StationPageInfo, StationParam, StationPreview, StationRun, StationSetting, StationsResponse, Task } from '../types';
import { setPluginCommands } from './chat/complete';
import { pluginVerb } from './chat/model';
import type { RunAction } from './Preview';
import '../stations.css';

/**
 * 插件。
 * - 设置页：内置功能与「我的插件」——这台电脑上装的第三方插件，对所有项目生效：它会做什么、要了哪些权限、
 *   它的设置（含密钥）、要你点的操作与它的页面入口，添加、更新与去掉。没有打开项目也能管（PluginSettings），
 *   操作与页面要先打开项目；发布页这类制作页面里不放插件的配置；
 * - 插件自己的页面（StationPage）与嵌进自带页面的小窗（StationSlots），都经 StationFrame 的沙箱桥接。
 * 装、去掉、更新是后台任务（/api/stations），执行操作是项目的写任务；客户端自己不写项目文件。
 */

const stepNames: Record<string, string> = { beat: '节拍', script: '口播稿', storyboard: '分镜', scene: '镜头', final: '成片', publish: '发布' };
/** 站点 id 的说法（认得的步骤名，否则原样）。 */
const stepLabel = (id: string) => stepNames[id] ?? id;
const eventNames: Record<string, string> = {
  'turn.finished': '每轮对话结束后',
  'task.finished': '每个任务跑完后',
  'gate.confirmed': '你确认一个审核关卡后',
  'film.approved': '你确认成片可用后',
};
const opNames: Record<string, string> = {
  scene_run: '渲染一个镜头',
  scene_run_all: '渲染全部镜头',
  scene_frames: '给镜头抽帧',
  concat: '拼接母版',
  review: '整片复查',
  validate_video: '成片校验',
  film_style_use: '换整片风格',
  voice_save: '存一个音色',
};

function useStations(version: number): [StationsResponse | null, string, () => void] {
  const [data, setData] = useState<StationsResponse | null>(null);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    api<StationsResponse>('/api/stations').then(
      (value) => {
        setData(value);
        setError('');
        // 设置改过、站加减过：全局的插件表（顶栏、嵌入位、斜杠命令）跟着换，不等下一次读项目。
        setStationPages(value.stations);
      },
      (err) => setError(errorText(err)),
    );
  }, [version, nonce]);
  return [data, error, () => setNonce((n) => n + 1)];
}

/** 插件图标：一块拼图，表示「接进来的一站」。 */
function PluginGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M9 3.5a2 2 0 0 1 4 0V5h3.5A1.5 1.5 0 0 1 18 6.5V10h1.5a2 2 0 0 1 0 4H18v3.5a1.5 1.5 0 0 1-1.5 1.5H13v-1.5a2 2 0 0 0-4 0V19H5.5A1.5 1.5 0 0 1 4 17.5V14h1.5a2 2 0 0 0 0-4H4V6.5A1.5 1.5 0 0 1 5.5 5H9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 这一站放在制作路线的哪里，用用户的话说。 */
function placement(s: StationInfo): string {
  const steps = [...new Set(s.nodes.map((n) => stepNames[n.step] ?? n.step))];
  const where = steps.length > 0 ? `在「${steps.join('、')}」这一步` : '不在制作路线上显示';
  return s.replaces ? `${where}，替换自带的这一站` : where;
}

/**
 * 插件的操作是电脑上的普通程序，清单管不住它：添加前、详情里都照实说（与 station_add 的输出同一句话，
 * 引擎里是 flow.OpsTrustNotice）。页面的权限另列，不混成一张表，免得让人以为操作也受限。
 */
const opsTrust =
  '它的操作是在你电脑上运行的程序，能读写你的文件、能联网；片场只限制它拿不到项目 .env 与片场的凭据，并在它写了声明范围之外的项目文件时告诉你。';

/** 页面申请的权限：页面在沙箱里，只能做这些。已装的插件与取回待装的（reads 另给）用同一种说法。 */
function pagePermissionLines(s: { browser?: StationInfo['browser']; permissions: StationInfo['permissions']; pages?: StationInfo['pages']; reads?: string[] }): [string, string][] {
  const out: [string, string][] = [];
  const reads = s.reads ?? [...new Set((s.pages ?? []).flatMap((p) => p.reads))];
  if (s.browser) out.push(['客户端内网页', s.browser.origins.join('、') + '（账号登录独立保存）']);
  if (s.permissions.project) out.push(['看项目', '镜头、制作进度、发布信息的概况']);
  if (reads.length > 0) out.push(['读文件', reads.join('、')]);
  if (s.permissions.network.length > 0) out.push(['联网', s.permissions.network.map((o) => o.replace(/^https?:\/\//, '')).join('、')]);
  if (s.permissions.uses.length > 0) out.push(['请你确认后执行', s.permissions.uses.map((u) => opNames[u] ?? pluginVerb(u) ?? u).join('、')]);
  return out;
}

/** 插件接进来的地方（自动执行、提供配音、给渲染器的技能……），用用户的话列出来。 */
function permissionLines(s: StationInfo): [string, string][] {
  const out: [string, string][] = [];
  for (const h of s.hooks) {
    const op = s.ops.find((o) => o.name === h.op);
    out.push(['自动执行', `${eventNames[h.on] ?? h.on}：${op?.summary ?? h.op}`]);
  }
  if (s.provides?.tts) out.push(['提供配音', `${s.provides.tts}（在设置的「配音」里选它）`]);
  if (s.provides?.align) out.push(['提供字幕对齐', `${s.provides.align}（在设置的「字幕对齐」里选它）`]);
  for (const rs of s.renderer_skills ?? []) {
    out.push(['给渲染器的技能', `${rs.name}：${rs.summary}（${rs.scenes === 'all' ? '每个镜头都用，装上后所有项目里已渲染的镜头都要重渲染' : 'AI 点名的镜头才用'}）`]);
  }
  if (s.film_styles) out.push(['整片风格库', `${s.film_styles}（新建项目和「风格」里都能选到）`]);
  if ((s.skins ?? []).length > 0) out.push(['界面皮肤', `${s.skins.join('、')}（在设置的「外观」里选）`]);
  if (s.flow) out.push(['新的做法', `${s.flow.name}（新建项目时在「做法」里选）`]);
  if ((s.inserts ?? []).length > 0) out.push(['补充制作说明', `往这几个阶段里加了说明：${s.inserts.join('、')}`]);
  for (const sc of s.schedules ?? []) {
    const op = s.ops.find((o) => o.name === sc.op);
    const every = sc.every_minutes % 60 === 0 ? `${sc.every_minutes / 60} 小时` : `${sc.every_minutes} 分钟`;
    out.push(['定时执行', `客户端开着时每 ${every}：${op?.summary ?? sc.op}`]);
  }
  return out;
}

/** 内置功能带了什么：它在片场里登记的站点、工具、渲染技能、页面与流程，用用户的话列出。 */
function BuiltinDetail({ contents }: { contents: BuiltinContents }) {
  const rows: [string, string][] = [];
  if (contents.flows.length > 0) rows.push(['做法', contents.flows.join('、')]);
  if (contents.nodes.length > 0) rows.push(['制作路线', contents.nodes.join('、')]);
  if (contents.ops.length > 0) rows.push(['AI 能用的', contents.ops.map((o) => o.verb || o.summary).join('；')]);
  if (contents.skills.length > 0) rows.push(['给渲染器的技能', contents.skills.join('、')]);
  if (contents.blocks.length > 0) rows.push(['镜头里的设定', contents.blocks.join('、')]);
  if (contents.pages.length > 0) rows.push(['页面', contents.pages.join('、')]);
  if (contents.film_styles.length > 0) rows.push(['整片风格库', contents.film_styles.join('、')]);
  if ((contents.skins ?? []).length > 0) rows.push(['界面皮肤', contents.skins.join('、')]);
  if (rows.length === 0) return null;
  return (
    <div className="station-detail builtin-detail">
      <dl className="station-perms">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 插件的设置：按清单出表单。密钥只写不读，界面上只显示「已填写」。 */
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
    const image = typeof o.image === 'string' && /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(o.image) ? o.image : '';
    const actions = (Array.isArray(o.actions) ? o.actions : []).slice(0, 4).flatMap((a) => {
      if (!a || typeof a !== 'object') return [];
      const x = a as Record<string, unknown>;
      const params = x.params && typeof x.params === 'object' && !Array.isArray(x.params) ? (x.params as Record<string, unknown>) : {};
      return str(x.label, 20) && str(x.op, 80) ? [{ label: str(x.label, 20), op: str(x.op, 80), params, confirm: str(x.confirm, 120) }] : [];
    });
    return [{ title, detail: str(o.detail, 160), image, actions }];
  });
}

/** 发起一条插件操作并等它跑完（不需要项目的操作是用户级任务，设置里没打开项目也能跑）。 */
async function runAndWait(path: string, payload: Record<string, unknown>): Promise<Task> {
  const { task_id } = await post<{ task_id: string }>(path, payload);
  for (;;) {
    await new Promise((r) => window.setTimeout(r, 400));
    const t = await api<Task>(`/api/tasks/${encodeURIComponent(task_id)}`);
    if (t.status === 'succeeded' || t.status === 'failed' || t.status === 'cancelled') return t;
  }
}

/**
 * 「详情与设置」里插件要你点的东西：列表操作（ops[].list，例如已登录的账号）画成卡片，打开弹窗与每次操作跑完后自动刷新；
 * 其余操作出按钮表单（ops[].form 为 false 的不出）。不需要项目的在这里跑完再刷新列表，要项目的交给客户端的写任务。
 */
function PluginActions({ station, run, onDone }: { station: StationInfo; run?: RunAction; onDone: () => void }) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id]);
  const start = (op: StationOp, params: Record<string, unknown>) => {
    if (op.project) {
      if (!run) return setMessage({ ok: false, text: `「${op.summary.replace(/（.*?）/g, '')}」要在项目里执行，先打开一个项目` });
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
        setMessage(t.status === 'succeeded' ? { ok: true, text: typeof done === 'string' && done ? done : `${label}：好了` } : { ok: false, text: `${label}没有成功：${t.error || t.message}` });
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
      {busy && <div className="stations-busy" role="status">{busy}…</div>}
      {!busy && message && <div className={message.ok ? 'stations-result' : 'stations-result bad'} role="status">{message.text}</div>}
      {lists.map((l) => {
        const items = listItems(l.last_run);
        return (
          <section key={l.name} className="plugin-list" data-op={l.name} aria-label={l.summary}>
            <div className="plugin-list-head">
              <div className="station-prompt-label">{l.summary.replace(/（.*?）/g, '')}</div>
              <button className="link" disabled={busy !== ''} onClick={() => void refresh()}>刷新</button>
            </div>
            {!loaded && !items && <span className="station-perms-note">正在读取…</span>}
            {l.last_run && !l.last_run.ok && <span className="station-last bad">{l.last_run.text.trim().split('\n').pop()}</span>}
            {items && items.length === 0 && <span className="station-perms-note">还没有。</span>}
            {items && items.length > 0 && (
              <ul className="plugin-items">
                {items.map((it, i) => (
                  <li key={it.title + i} className="plugin-item">
                    {it.image ? <img src={it.image} alt="" /> : <span className="plugin-item-blank">{[...it.title][0]}</span>}
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
                          <button className="danger" disabled={busy !== ''} onClick={() => { setAsking(''); start(op, a.params); }}>{a.label}</button>
                          <button onClick={() => setAsking('')}>取消</button>
                        </span>
                      ) : (
                        <button key={key} disabled={busy !== ''} onClick={() => (a.confirm ? setAsking(key) : start(op, a.params))}>
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
      {forms.filter((o) => !o.project).map((o) => (
        <OpAction key={o.name} station={station} op={o} disabled={busy !== ''} run={(_path, payload) => start(o, (payload?.params as Record<string, unknown>) ?? {})} />
      ))}
      {projectForms.length > 0 &&
        (run ? (
          projectForms.map((o) => <OpAction key={o.name} station={station} op={o} run={run} />)
        ) : (
          <span className="station-perms-note">
            {projectForms.map((o) => `「${o.summary.replace(/（.*?）/g, '')}」`).join('')}针对项目执行，打开一个项目后在这里点。
          </span>
        ))}
    </div>
  );
}

/**
 * 一个第三方插件的「详情与设置」：盖在设置窗口上的弹窗（挂到 body 上，不受设置窗口的滚动与裁切）。
 * Esc、点背景、「关闭」都只关这一层，设置窗口留着。
 */
function PluginDialog({ station, onClose, children }: { station: StationInfo; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop plugin-dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="modal plugin-dialog" role="dialog" aria-modal="true" aria-label={`${station.name} 详情与设置`} data-station={station.id}>
        <header className="modal-head">
          <span className="station-icon">
            <PluginGlyph />
          </span>
          <div className="plugin-dialog-title">
            <h2>{station.name}</h2>
            <span>
              {placement(station)} · {station.version}
            </span>
          </div>
          <span className="station-badge">第三方</span>
          <span className="spacer" />
          <button className="ghost icon" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="stations plugin-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function StationSettingsForm({ station, onSaved }: { station: StationInfo; onSaved: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const save = async (setting: StationSetting, value: unknown) => {
    try {
      await post(`/api/stations/${encodeURIComponent(station.id)}/settings`, { key: setting.key, value });
      setDrafts((d) => ({ ...d, [setting.key]: '' }));
      setError('');
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  if (station.settings.length === 0) return null;
  return (
    <div className="station-settings">
      <div className="station-prompt-label">它的设置</div>
      {station.settings.map((st) => (
        <div className="station-setting" key={st.key} data-setting={st.key}>
          <div className="station-setting-label">
            <strong>{st.label}</strong>
            {st.description && <span>{st.description}</span>}
          </div>
          {st.type === 'boolean' ? (
            <input type="checkbox" aria-label={st.label} checked={st.value === true} onChange={(e) => void save(st, e.target.checked)} />
          ) : st.type === 'select' ? (
            <select aria-label={st.label} value={String(st.value ?? '')} onChange={(e) => void save(st, e.target.value)}>
              {st.default === undefined && <option value="">未选择</option>}
              {st.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : st.type === 'secret' ? (
            <div className="station-secret">
              <span className={st.set ? 'ok' : 'muted'}>{st.set ? '已填写' : '未填写'}</span>
              <input
                type="password"
                aria-label={st.label}
                placeholder={st.set ? '填新的会替换' : '粘贴到这里'}
                value={drafts[st.key] ?? ''}
                onChange={(e) => setDrafts((d) => ({ ...d, [st.key]: e.target.value }))}
              />
              <button disabled={(drafts[st.key] ?? '').trim() === ''} onClick={() => void save(st, (drafts[st.key] ?? '').trim())}>
                保存
              </button>
              {st.set && (
                <button className="link danger" onClick={() => void save(st, '')}>
                  清除
                </button>
              )}
            </div>
          ) : (
            <input
              aria-label={st.label}
              inputMode={st.type === 'number' ? 'decimal' : undefined}
              defaultValue={st.value === undefined ? '' : String(st.value)}
              placeholder={st.default === undefined ? '' : `缺省：${String(st.default)}`}
              onBlur={(e) => {
                if (e.target.value !== (st.value === undefined ? '' : String(st.value))) void save(st, e.target.value);
              }}
            />
          )}
        </div>
      ))}
      {error && <div className="settings-error">{error}</div>}
    </div>
  );
}

/**
 * 装、去掉、更新插件：起一个后台任务（不要打开项目），在这里等它跑完、报结果。
 * 跑完后重读插件列表，onChanged 让外面（顶栏的插件页面、首页的做法）跟着换。
 */
type StartTask = (path: string, label: string, payload?: Record<string, unknown>, onResult?: (result: unknown) => void) => void;

function usePluginTask(onDone: () => void): { busy: string; message: string; start: StartTask } {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const start: StartTask = (path, label, payload = {}, onResult) => {
    setBusy(label);
    setMessage('');
    void (async () => {
      try {
        const { task_id } = await post<{ task_id: string }>(path, payload);
        for (;;) {
          await new Promise((r) => window.setTimeout(r, 500));
          const t = await api<Task>(`/api/tasks/${encodeURIComponent(task_id)}`);
          if (t.status === 'succeeded') {
            // 取回给你看的任务没有「好了」可说：结果交给 onResult（弹出确认）。
            if (onResult) onResult(t.result);
            else setMessage(`${label}：好了`);
            break;
          }
          if (t.status === 'failed' || t.status === 'cancelled') {
            setMessage(`${label}没有成功：${t.error || t.message}`);
            break;
          }
        }
      } catch (err) {
        setMessage(`${label}没有成功：${errorText(err)}`);
      }
      setBusy('');
      onDone();
    })();
  };
  return { busy, message, start };
}

/** 取回的插件、还没装上：/api/stations 任务的 result（studio/stations.ts，flow.StationPreview）。 */
interface StagedPlugin {
  staged: string;
  preview: StationPreview;
}

/** 装上之前给你看这个插件的实情：它的操作、页面能做的、接进来的地方、还在试验的能力。点「装上」才对所有项目生效。 */
function StagedConfirm({ staged, onInstall, onCancel }: { staged: StagedPlugin; onInstall: () => void; onCancel: () => void }) {
  const p = staged.preview;
  const u = p.update;
  const tools = p.ops.filter((o) => o.trigger === 'agent');
  const buttons = p.ops.filter((o) => o.trigger === 'user');
  const pagePerms = pagePermissionLines({ browser: p.browser, permissions: p.permissions, reads: p.reads });
  const rows: [string, string][] = [];
  if (p.replaces) rows.push(['制作路线', `顶替自带的「${p.replaces}」：${p.nodes.join('、')}`]);
  else if (p.nodes.length > 0) rows.push(['制作路线', `${p.after ? `接在「${stepLabel(p.after)}」后面` : p.flow ? '只在它带来的做法里' : '每个项目的最后'}：${p.nodes.join('、')}`]);
  if (p.flow) rows.push(['新的做法', `${p.flow}（新建项目时在「做法」里选）`]);
  if (p.film_styles) rows.push(['整片风格库', p.film_styles]);
  if ((p.skins ?? []).length > 0) {
    // 皮肤可以用插件自己的页面换掉桌宠，那个页面能替你答批准、发话、停下（不再另外确认）。
    const petNote = p.pages.length > 0 ? '；带页面的皮肤会用它换掉桌宠，选了之后它能替你答批准、发话和停下' : '';
    rows.push(['界面皮肤', `${p.skins.length} 套（装上后在设置的「外观」里选${petNote}）`]);
  }
  if (p.provides.tts) rows.push(['提供配音', p.provides.tts]);
  if (p.provides.align) rows.push(['提供字幕对齐', p.provides.align]);
  for (const h of p.hooks) rows.push(['自动执行', `${h.label}：${h.summary}`]);
  for (const sc of p.schedules) rows.push(['定时执行', `客户端开着时每 ${sc.every_minutes % 60 === 0 ? `${sc.every_minutes / 60} 小时` : `${sc.every_minutes} 分钟`}：${sc.summary}`]);
  for (const rs of p.renderer_skills) rows.push(['给渲染器的技能', `${rs.name}：${rs.summary}（${rs.scenes === 'all' ? '每个镜头都用' : 'AI 点名的镜头才用'}）`]);
  if (p.inserts.length > 0) rows.push(['补充制作说明', `往这几个阶段里加了说明：${p.inserts.join('、')}`]);
  return (
    <div className="stations-confirm staged-confirm" role="alertdialog" aria-label="确认添加插件" data-staged={p.id}>
      <div className="staged-head">
        <strong>{p.name}</strong>
        <span className="mono">
          {p.id} · {p.version}
          {p.commit ? ` · ${p.commit.slice(0, 12)}` : p.linked ? ' · 本机目录' : ''}
        </span>
        {p.description && <span>{p.description}</span>}
      </div>
      {p.linked && (
        <p className="staged-local">直接加载本地文件夹：{p.source.replace(/^link:/, '')}。改动立即生效，请保留这个文件夹；移动或删除后插件将无法使用。</p>
      )}
      {u && (
        <p className="staged-update">
          {u.changed ? `新版本：${u.old_version || '（本机已没有原来那一版）'} → ${u.new_version}` : `已是来源上的最新版本（${u.new_version}）`}
          {u.new_permissions.length > 0 && <> · 新申请：{u.new_permissions.join('、')}</>}
          {u.new_experimental.length > 0 && <> · 新用到的实验性能力：{u.new_experimental.join('、')}</>}
        </p>
      )}
      <dl className="station-perms">
        {tools.length > 0 && (
          <div>
            <dt>AI 能用的</dt>
            <dd>{tools.map((o) => o.summary).join('；')}</dd>
          </div>
        )}
        {buttons.length > 0 && (
          <div>
            <dt>要你点的</dt>
            <dd>{buttons.map((o) => o.summary).join('；')}</dd>
          </div>
        )}
      </dl>
      {p.ops_trust && <p className="station-trust">{p.ops_trust}</p>}
      {pagePerms.length > 0 && (
        <>
          <div className="station-prompt-label">它的页面能做的（在沙箱里，只能做这些）</div>
          <dl className="station-perms staged-page-perms">
            {pagePerms.map(([k, v]) => (
              <div key={k + v}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {rows.length > 0 && (
        <>
          <div className="station-prompt-label">它接进来的地方</div>
          <dl className="station-perms">
            {rows.map(([k, v]) => (
              <div key={k + v}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {p.experimental.length > 0 && <p className="station-experimental">用到了实验性能力：{p.experimental.join('、')}，以后的版本可能调整</p>}
      <p>
        装上后对这台电脑上的所有项目生效。
        {p.rerender_all && <strong className="staged-rerender">它给每个镜头都带上渲染技能：所有项目里已经渲染好的镜头都会标成要重新渲染。</strong>}
      </p>
      <div>
        <button className="primary" onClick={onInstall}>
          {u ? '换上' : '装上'}
        </button>
        <button onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/** 设置页：内置功能与「我的插件」。插件装在这台电脑上，对所有项目生效；没有打开项目也能管。 */
/**
 * run 与 onOpenPage 只在打开了项目时给：要你点的操作是项目的写任务，插件的页面在项目的画面面板里打开。
 */
export function PluginSettings({ version, onChanged, run, onOpenPage }: { version: number; onChanged?: () => void; run?: RunAction; onOpenPage?: (tab: string) => void }) {
  const [data, error, reload] = useStations(version);
  const [source, setSource] = useState('');
  const [open, setOpen] = useState<string>('');
  // 先取回、看清，再装：取回的插件放在暂存处，用户看过它自己的实情点「装上」才对所有项目生效。
  const [pending, setPending] = useState<StagedPlugin | null>(null);
  const task = usePluginTask(() => {
    reload();
    onChanged?.();
  });
  const show = (result: unknown) => setPending(result as StagedPlugin);
  const fetchPlugin = () => {
    const value = source.trim();
    if (value === '' || pending !== null || task.busy !== '') return;
    task.start('/api/stations', '取回插件', { source: value }, show);
  };
  const install = () => {
    if (!pending) return;
    task.start(`/api/stations/staged/${encodeURIComponent(pending.staged)}/install`, pending.preview.update ? '换上新版本' : '装上插件');
    setPending(null);
    setSource('');
  };
  const cancel = () => {
    if (pending) void post(`/api/stations/staged/${encodeURIComponent(pending.staged)}/discard`).catch(() => {});
    setPending(null);
  };
  const builtins = (data?.stations ?? []).filter((s) => s.builtin);
  const thirdParty = (data?.stations ?? []).filter((s) => !s.builtin);
  return (
    <>
    {builtins.length > 0 && (
      <section className="stations builtin-stations" aria-label="内置功能">
        <div className="stations-head">
          <strong>内置功能</strong>
          <span>片场自带的功能，每个项目都有。用不用得上由片子的做法决定，点「详情」看它带了什么。</span>
        </div>
        <ul className="stations-list">
          {builtins.map((s) => (
            <li key={s.id} className="station-card" data-builtin={s.id}>
              <div className="station-row">
                <span className="station-icon">
                  <PluginGlyph />
                </span>
                <div className="station-title">
                  <strong>{s.name}</strong>
                  <span>{s.description}</span>
                </div>
                {s.contents && (
                  <button className="link" onClick={() => setOpen(open === s.id ? '' : s.id)}>
                    {open === s.id ? '收起' : '详情'}
                  </button>
                )}
              </div>
              {open === s.id && s.contents && <BuiltinDetail contents={s.contents} />}
            </li>
          ))}
        </ul>
      </section>
    )}
    <section className="stations" aria-label="我的插件">
      <div className="stations-head">
        <strong>我的插件</strong>
        <span>装上别人写的制作步骤，例如自动发布、新的做法或风格。装一次，这台电脑上的所有项目都能用。插件不是片场自带的，由它的作者维护；装之前请确认来源可信，装完看一眼它要了哪些权限。</span>
      </div>
      {error && <div className="settings-error">{error}</div>}
      {task.busy && <div className="stations-busy" role="status">{task.busy}…</div>}
      {!task.busy && task.message && (
        <div className="stations-result" role="status">
          {task.message}
        </div>
      )}
      {data?.problems.map((p) => (
        <div className="stations-problem" key={p.id + p.message} data-problem={p.id}>
          <span>{p.message}</span>
          {p.id !== '' && (
            <span className="stations-problem-actions">
              {!p.linked && (
                <button className="link" disabled={task.busy !== ''} onClick={() => task.start(`/api/stations/${encodeURIComponent(p.id)}/update`, '取回新版本', {}, show)}>
                  更新
                </button>
              )}
              <button className="link danger" disabled={task.busy !== ''} onClick={() => task.start(`/api/stations/${encodeURIComponent(p.id)}/remove`, '去掉插件')}>
                去掉
              </button>
            </span>
          )}
        </div>
      ))}
      {data && thirdParty.length > 0 && (
        <ul className="stations-list">
          {thirdParty.map((s) => {
            const perms = permissionLines(s);
            const pagePerms = pagePermissionLines(s);
            const needsSetup = s.settings.some((st) => st.type === 'secret' && !st.set);
            return (
              <li key={s.id} className="station-card" data-station={s.id}>
                <div className="station-row">
                  <span className="station-icon">
                    <PluginGlyph />
                  </span>
                  <div className="station-title">
                    <strong>{s.name}</strong>
                    <span>
                      {placement(s)} · {s.version}
                      {needsSetup && <em className="station-needs"> · 还有设置没填</em>}
                    </span>
                  </div>
                  <span className="station-badge">第三方</span>
                  <button
                    className="link"
                    aria-haspopup="dialog"
                    onClick={() => setOpen(s.id)}
                  >
                    详情与设置
                  </button>
                  {!s.linked && (
                    <button className="link" disabled={task.busy !== ''} onClick={() => task.start(`/api/stations/${encodeURIComponent(s.id)}/update`, '取回新版本', {}, show)}>
                      更新
                    </button>
                  )}
                  <button className="link danger" disabled={task.busy !== ''} onClick={() => task.start(`/api/stations/${encodeURIComponent(s.id)}/remove`, '去掉插件')}>
                    去掉
                  </button>
                </div>
                {open === s.id && (
                  <PluginDialog station={s} onClose={() => setOpen('')}>
                      <div className="station-detail">
                        <StationSettingsForm station={s} onSaved={reload} />
                        {s.pages.length > 0 && (
                          <div className="station-page-links">
                            <div className="station-prompt-label">它的页面</div>
                            {onOpenPage ? (
                              <div className="station-page-buttons">
                                {s.pages.map((p) => (
                                  <button key={p.tab} onClick={() => onOpenPage(p.tab)}>
                                    打开「{p.label}」
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span className="station-perms-note">打开一个项目后，可以在这里打开它的页面。</span>
                            )}
                          </div>
                        )}
                        <PluginActions station={s} run={run} onDone={reload} />
                        <dl>
                          <dt>来源</dt>
                          <dd className="mono">
                            {s.source}
                            {s.commit ? ` · ${s.commit.slice(0, 12)}` : s.linked ? ' · 本机目录，改动立即生效' : ''}
                          </dd>
                          {s.experimental.length > 0 && (
                            <>
                              <dt>实验性</dt>
                              <dd className="station-experimental">用到了实验性能力：{s.experimental.join('、')}，以后的版本可能调整</dd>
                            </>
                          )}
                          {s.ops.some((o) => o.trigger === 'agent') && (
                            <>
                              <dt>AI 能用的</dt>
                              <dd>{s.ops.filter((o) => o.trigger === 'agent').map((o) => o.summary).join('；')}</dd>
                            </>
                          )}
                          {s.ops.some((o) => o.trigger === 'user') && (
                            <>
                              <dt>要你点的</dt>
                              <dd>{s.ops.filter((o) => o.trigger === 'user').map((o) => o.summary).join('；')}</dd>
                            </>
                          )}
                          {s.pages.length > 0 && (
                            <>
                              <dt>页面</dt>
                              <dd>{s.pages.map((p) => p.label).join('、')}</dd>
                            </>
                          )}
                        </dl>
                        {s.ops.length > 0 && (
                          <>
                            <div className="station-prompt-label">它的操作</div>
                            <p className="station-trust">{opsTrust}</p>
                          </>
                        )}
                        {pagePerms.length > 0 && (
                          <>
                            <div className="station-prompt-label">它的页面能做的</div>
                            <dl className="station-perms station-page-perms">
                              {pagePerms.map(([k, v]) => (
                                <div key={k + v}>
                                  <dt>{k}</dt>
                                  <dd>{v}</dd>
                                </div>
                              ))}
                            </dl>
                            <span className="station-perms-note">页面在沙箱里运行，只能做上面这些；读文件、执行操作都要经过片场。</span>
                          </>
                        )}
                        {perms.length > 0 && (
                          <>
                            <div className="station-prompt-label">它接进来的地方</div>
                            <dl className="station-perms">
                              {perms.map(([k, v]) => (
                                <div key={k + v}>
                                  <dt>{k}</dt>
                                  <dd>{v}</dd>
                                </div>
                              ))}
                            </dl>
                          </>
                        )}
                        {s.prompt && (
                          <>
                            <div className="station-prompt-label">它交给 AI 的说明</div>
                            <pre className="station-prompt">{s.prompt}</pre>
                          </>
                        )}
                      </div>
                  </PluginDialog>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="stations-add">
        {window.onset?.selectDirectory && (
          <NativeDirectoryPicker
            id="station-local-directory"
            value={source.replace(/^link:/, '')}
            label="选择本地文件夹"
            disabled={pending !== null || task.busy !== ''}
            onChange={(directory) => setSource(`link:${directory}`)}
          />
        )}
        <input
          aria-label="插件来源"
          placeholder="github:作者/仓库#版本，或本机目录的绝对路径"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') fetchPlugin();
          }}
        />
        <button className="primary" disabled={source.trim() === '' || pending !== null || task.busy !== ''} onClick={fetchPlugin}>
          添加
        </button>
      </div>
      <p className="stations-source-help">支持 Git 地址或本地文件夹。本地文件夹需包含 onset-station.json，无需 Git；选好后点「添加」查看插件详情。</p>
      {pending && <StagedConfirm staged={pending} onInstall={install} onCancel={cancel} />}
    </section>
    </>
  );
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
    else if (p.type === 'strings') out[p.key] = text.split('\n').map((x) => x.trim()).filter(Boolean);
    else out[p.key] = text;
  }
  return out;
}

function OpAction({ station, op, run, disabled = false }: { station: StationInfo; op: StationOp; run: RunAction; disabled?: boolean }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(op.params.map((p) => [p.key, initialValue(p)])));
  const missing = op.params.some((p) => p.required && p.type !== 'boolean' && String(values[p.key] ?? '').trim() === '');
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
            <input type="checkbox" checked={values[p.key] === true} onChange={(e) => setValues({ ...values, [p.key]: e.target.checked })} />
          ) : p.type === 'strings' ? (
            <textarea rows={2} value={String(values[p.key] ?? '')} onChange={(e) => setValues({ ...values, [p.key]: e.target.value })} />
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
        <button className="primary" disabled={missing || disabled} onClick={() => run(`/api/stations/${encodeURIComponent(station.id)}/ops/${encodeURIComponent(op.name)}`, { params: toParams(op.params, values) })}>
          {op.summary.replace(/（.*?）/g, '')}
        </button>
        {last && <span className={last.ok ? 'station-last ok' : 'station-last bad'}>{last.ok ? '上次执行成功' : '上次执行失败'}</span>}
      </div>
      <ScopeWarning run={last} />
      {last && last.text.trim() !== '' && <pre className="station-output">{last.text.trim()}</pre>}
    </div>
  );
}

/** 插件写了它没声明会写的项目文件：照实列出来。文件已经写了，客户端撤销不了，只能告诉用户怎么恢复。 */
function ScopeWarning({ run, label }: { run?: StationRun; label?: string }) {
  const files = run?.out_of_scope ?? [];
  if (files.length === 0) return null;
  const more = run?.out_of_scope_more ?? 0;
  const reserved = new Set(run?.reserved ?? []);
  return (
    <div className="station-scope" role="alert">
      <strong>
        {label ? `${label}：` : ''}
        {reserved.size > 0 ? '它写了片场自己的文件，这次按失败处理' : `它改了 ${files.length + more} 个没声明会写的文件`}
      </strong>
      <ul>
        {files.map((f) => (
          <li key={f} className={reserved.has(f) ? 'reserved' : undefined}>
            {f}
          </li>
        ))}
        {more > 0 && <li className="more">……另有 {more} 个</li>}
      </ul>
      <span>文件已经写了。不该改的话，可以回退那一轮对话，或者用 git 恢复。</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 插件自己的页面与嵌入小窗

/** 已加载的插件（顶栏、嵌入位、对话里的「↗ 页面」与斜杠命令都要它）；app 读到 /api/stations 时更新。 */
const pageRegistry = new Map<string, { page: StationPageInfo; station: StationInfo }>();
let loadedStations: StationInfo[] = [];

export function setStationPages(stations: StationInfo[]): void {
  loadedStations = stations;
  pageRegistry.clear();
  for (const station of stations) for (const page of station.pages) pageRegistry.set(page.tab, { page, station });
  setPluginCommands(stations.flatMap((s) => s.commands));
}

export function stationPageLabel(tab: string): string | undefined {
  return pageRegistry.get(tab)?.page.label;
}

export function isStationTab(tab: string): boolean {
  return tab.startsWith('x:');
}

/** 交给插件页面的配色变量（宿主 :root 的同名变量），页面照着用就与客户端一致。 */
const themeVars = [
  '--bg', '--panel', '--raised', '--well', '--chip', '--hover', '--line', '--line-strong',
  '--text', '--text-2', '--text-3', '--muted', '--faint',
  '--accent', '--accent-hover', '--accent-ink', '--accent-soft', '--accent-line', '--accent-text',
  '--ok', '--stale', '--bad', '--radius', '--sans', '--serif', '--mono',
];

/** 插件页面的基础样式：与客户端同一套按钮、输入框、标题，页面不写样式也像是客户端的一部分。 */
const themeCSS = `
:root { color-scheme: dark; }
body { margin: 0; padding: 16px; background: var(--panel); color: var(--text); font: 13px/1.6 var(--sans); }
h1, h2, h3 { font-family: var(--serif); font-weight: 600; margin: 0 0 10px; }
h1 { font-size: 20px; } h2 { font-size: 16px; } h3 { font-size: 14px; }
a { color: var(--accent-text); }
small, .muted { color: var(--muted); }
button { font: 13px var(--sans); color: var(--text); background: transparent; border: 1px solid var(--line-strong); border-radius: 999px; padding: 6px 14px; cursor: pointer; }
button:hover { background: var(--hover); }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
input, select, textarea { font: 13px var(--sans); color: var(--text); background: var(--well); border: 1px solid var(--line-strong); border-radius: 8px; padding: 6px 10px; }
.card { background: var(--raised); border: 1px solid var(--line-strong); border-radius: var(--radius); padding: 14px; }
.ok { color: var(--ok); } .bad { color: var(--bad); } .warn { color: var(--stale); }
`;

function hostTheme(): { vars: Record<string, string>; css: string } {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const name of themeVars) {
    const v = style.getPropertyValue(name).trim();
    if (v) vars[name] = v;
  }
  return { vars, css: themeCSS };
}

/** 项目概况：给申请了 permissions.project 的插件页面。只有摘要，不给文件内容。 */
async function projectSummary(): Promise<Record<string, unknown>> {
  const [state, scenes, progress, publish] = await Promise.all([
    api<ProjectState>('/api/state'),
    api<{ scenes: Scene[] }>('/api/scenes'),
    api<ProgressState>('/api/progress').catch(() => null),
    api<{ available: boolean; data?: Record<string, unknown> }>('/api/publish').catch(() => null),
  ]);
  const root = state.project.path;
  return {
    name: state.project.name,
    step: state.step ?? '',
    film_style: state.metadata?.film_style ?? '',
    scenes: (scenes.scenes ?? []).map((sc) => {
      const dir = sc.directory.startsWith(root + '/') ? sc.directory.slice(root.length + 1) : sc.directory;
      return {
        id: sc.id,
        duration_seconds: sc.duration_seconds,
        rendered: sc.exists,
        stale: sc.stale,
        rendering: sc.rendering === true,
        output: sc.output ? `${dir}/${sc.output}` : '',
      };
    }),
    progress: progress
      ? { current: progress.current, waiting_on: progress.waiting_on, stations: progress.stations.map((s) => ({ id: s.id, label: s.label, status: s.status, detail: s.detail ?? '' })) }
      : null,
    publish: publish?.available ? (publish.data ?? null) : null,
  };
}

/** 页面经 postMessage 发来的请求（协议同 /station-ui/_sdk.js）。 */
interface PageRequest {
  onset: 'station';
  id: number;
  type: 'theme' | 'info' | 'project' | 'read' | 'run' | 'call' | 'ask' | 'send' | 'open';
  path?: string;
  op?: string;
  page?: string;
  params?: Record<string, unknown>;
  text?: string;
}

/** 等用户确认的执行请求：本站的操作（run）或 onset 自带的操作（call）。 */
interface PendingRun {
  id: number;
  kind: 'run' | 'call' | 'send';
  op: string;
  label: string;
  params: Record<string, unknown>;
}

const maxAskChars = 4000;

function paramText(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('，');
}

interface FrameProps {
  station: StationInfo;
  page: StationPageInfo;
  /** 嵌在哪、对着什么（嵌进镜头页时有镜头编号）。 */
  context: Record<string, unknown>;
  version: number;
  run: RunAction;
  onQuick: (text: string, attachments: [], draftOnly?: boolean) => void;
  onOpen?: (tab: string) => void;
  projectName: string;
  height?: number;
}

/**
 * 沙箱 iframe（只给 allow-scripts，不透明源，CSP 只许它碰本站目录与申请过的地址）加宿主一侧的桥。
 * 页面要的东西都经这里：theme / info / project / read / run / call / ask / open。执行类（run、call）
 * 一律先在上方请用户确认——页面里的按钮可以被脚本自己点，不算用户同意。只认来自这个 iframe 的消息。
 */
function StationFrame({ station, page, context, version, run, onQuick, onOpen, projectName, height }: FrameProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [pending, setPending] = useState<PendingRun | null>(null);
  // 这个页面经 onset.run() 请用户确认后执行过的操作（操作名 → 点「执行」的时间）：之后的执行结果越界了，回执处要标出来。
  const [ran, setRan] = useState<Record<string, string>>({});
  const pendingRef = useRef<PendingRun | null>(null);

  const reply = (id: number, ok: boolean, result?: unknown, error?: string) => {
    frame.current?.contentWindow?.postMessage({ onset: 'host', id, ok, result, error }, '*');
  };
  const ask = (req: PendingRun) => {
    if (pendingRef.current) throw new Error('上一个请求还在等用户确认');
    pendingRef.current = req;
    setPending(req);
    // 收到了、在等用户：页面的 SDK 据此停掉「宿主没回应」的计时，用户想多久都行。
    frame.current?.contentWindow?.postMessage({ onset: 'host', id: req.id, ack: true }, '*');
  };

  // 监听在布局阶段挂上：iframe 元素与监听在同一次提交里出现，页面脚本最早也要等这次提交之后才跑，
  // 所以页面一加载就发的请求不会落空。换站、换上下文时卸旧挂新也在同一个任务里，中间收不到消息。
  useLayoutEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const m = event.data as PageRequest;
      if (!m || m.onset !== 'station' || typeof m.id !== 'number') return;
      try {
        switch (m.type) {
          case 'theme':
            reply(m.id, true, hostTheme());
            return;
          case 'info': {
            const settings: Record<string, unknown> = {};
            for (const st of station.settings) if (st.type !== 'secret' && st.value !== undefined) settings[st.key] = st.value;
            reply(m.id, true, {
              project: projectName,
              station: { id: station.id, name: station.name, version: station.version },
              page: page.id,
              context,
              settings,
              permissions: station.permissions,
              ops: station.ops.map((o) => ({ name: o.name, summary: o.summary, trigger: o.trigger, params: o.params })),
              pages: station.pages.map((p) => ({ id: p.id, label: p.label })),
            });
            return;
          }
          case 'project':
            if (!station.permissions.project) throw new Error('这个插件没有申请看项目（permissions.project）');
            reply(m.id, true, await projectSummary());
            return;
          case 'read':
            reply(m.id, true, await api(`/api/stations/${encodeURIComponent(station.id)}/read?path=${encodeURIComponent(String(m.path ?? ''))}`));
            return;
          case 'run': {
            const op = station.ops.find((o) => o.name === m.op);
            if (!op) throw new Error(`没有操作 ${String(m.op)}`);
            ask({ id: m.id, kind: 'run', op: op.name, label: op.summary, params: m.params && typeof m.params === 'object' ? m.params : {} });
            return;
          }
          case 'call': {
            const op = String(m.op ?? '');
            if (!station.permissions.uses.includes(op)) throw new Error(`这个插件没有申请调用 ${op}（permissions.uses）`);
            ask({ id: m.id, kind: 'call', op, label: opNames[op] ?? op, params: m.params && typeof m.params === 'object' ? m.params : {} });
            return;
          }
          case 'ask': {
            const text = String(m.text ?? '').slice(0, maxAskChars).trim();
            if (text === '') throw new Error('没有要填的内容');
            onQuick(`（来自插件「${station.name}」的页面）\n${text}`, [], true);
            reply(m.id, true, { filled: true });
            return;
          }
          case 'send': {
            const text = String(m.text ?? '').slice(0, maxAskChars).trim();
            if (text === '') throw new Error('没有要发的内容');
            ask({ id: m.id, kind: 'send', op: '', label: text, params: {} });
            return;
          }
          case 'open': {
            const target = station.pages.find((p) => p.id === m.page);
            if (!target || !onOpen) throw new Error(`没有页面 ${String(m.page)}`);
            onOpen(target.tab);
            reply(m.id, true, { opened: true });
            return;
          }
          default:
            throw new Error(`不认识的请求 ${String((m as { type?: unknown }).type)}`);
        }
      } catch (err) {
        reply(m.id, false, undefined, errorText(err));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // reply / onQuick 每次渲染都是新函数，按站、页面与上下文重新挂监听即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station, page.id, projectName, JSON.stringify(context)]);

  // 项目有变化：告诉页面重读（不重载 iframe，页面里的状态不丢）。
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ onset: 'host', type: 'refresh' }, '*');
  }, [version]);

  const decide = (allow: boolean) => {
    const req = pendingRef.current;
    if (!req) return;
    if (allow && req.kind === 'send') {
      onQuick(`（来自插件「${station.name}」的页面）\n${req.label}`, [], false);
      reply(req.id, true, { sent: true });
    } else if (allow) {
      const base = `/api/stations/${encodeURIComponent(station.id)}`;
      run(req.kind === 'run' ? `${base}/ops/${encodeURIComponent(req.op)}` : `${base}/call/${encodeURIComponent(req.op)}`, { params: req.params });
      if (req.kind === 'run') setRan((r) => ({ ...r, [req.op]: new Date().toISOString() }));
      reply(req.id, true, { started: true });
    } else {
      reply(req.id, false, undefined, '用户没有同意');
    }
    pendingRef.current = null;
    setPending(null);
  };

  return (
    <>
      <div className="station-frame-wrap" style={height ? { height, minHeight: height, flex: 'none' } : undefined}>
        {/* 确认条盖在页面上方，不挤动 iframe：页面一挪位置，紧跟着的点击会按旧位置命中，落不进页面（e2e 实测）。 */}
        {pending && (
          <div className="station-confirm" role="alertdialog" aria-label="插件请求执行">
            <div>
              <strong>
                {pending.kind === 'send'
                  ? `「${station.name}」想替你发一条消息给 AI`
                  : `「${station.name}」请求${pending.kind === 'call' ? '调用片场的' : '执行'}：${pending.label}`}
              </strong>
              {pending.kind === 'send' && <span className="station-confirm-text">{pending.label}</span>}
              {paramText(pending.params) && <span>参数：{paramText(pending.params)}</span>}
            </div>
            <button className="primary" onClick={() => decide(true)}>
              执行
            </button>
            <button onClick={() => decide(false)}>不执行</button>
          </div>
        )}
        <iframe ref={frame} className="station-frame" title={page.label} sandbox="allow-scripts" src={page.url} />
      </div>
      {/* 越界提醒排在页面下面，理由同确认条：不能把页面往下推。 */}
      {station.ops
        .filter((o) => ran[o.name] && o.last_run && o.last_run.at >= ran[o.name])
        .map((o) => (
          <ScopeWarning key={o.name} run={o.last_run} label={`「${station.name}」执行「${o.summary.replace(/（.*?）/g, '')}」`} />
        ))}
    </>
  );
}

interface PageProps {
  tab: string;
  version: number;
  run: RunAction;
  onQuick: (text: string, attachments: [], draftOnly?: boolean) => void;
  onOpen?: (tab: string) => void;
  projectName: string;
}

/** 插件自己的整页（画面面板里的一页）。 */
export function StationPage({ tab, ...rest }: PageProps) {
  const entry = pageRegistry.get(tab);
  if (!entry) return <div className="empty">这个插件页面已经不在了（插件可能被去掉了）。</div>;
  const { station, page } = entry;
  return (
    <div className="station-page" data-station={station.id}>
      <div className="station-page-bar">
        <span className="station-icon">
          <PluginGlyph />
        </span>
        <strong>{page.label}</strong>
        <span className="station-badge">第三方插件 · {station.name}</span>
        <span className="spacer" />
        <span className="small muted">页面在沙箱里运行，读文件、执行操作都要经过这里</span>
      </div>
      <StationFrame station={station} page={page} context={{ slot: '' }} {...rest} />
    </div>
  );
}

/**
 * 嵌进自带页面的插件小窗（清单 slots）：at 是哪一页，context 是那一页正对着的东西（镜头编号等）。
 * 没有插件嵌在这里时什么都不画。
 */
export function StationSlots({ at, context = {}, ...rest }: Omit<PageProps, 'tab'> & { at: string; context?: Record<string, unknown> }) {
  const slots = loadedStations.flatMap((station) =>
    station.slots.filter((sl) => sl.at === at).map((sl) => ({ station, slot: sl, page: station.pages.find((p) => p.id === sl.page)! })),
  );
  if (slots.length === 0) return null;
  return (
    <div className="station-slots" data-slot={at}>
      {slots.map(({ station, slot, page }) => (
        <section key={station.id + slot.page} className="station-slot station-page" data-station={station.id}>
          <div className="station-page-bar">
            <span className="station-icon">
              <PluginGlyph />
            </span>
            <strong>{page.label}</strong>
            <span className="station-badge">第三方插件 · {station.name}</span>
            <span className="spacer" />
            {rest.onOpen && (
              <button className="link" onClick={() => rest.onOpen!(page.tab)}>
                单独打开
              </button>
            )}
          </div>
          <StationFrame station={station} page={page} context={{ slot: at, ...context }} height={slot.height} {...rest} />
        </section>
      ))}
    </div>
  );
}

/** 顶栏「页面」菜单里自带页面的图标。 */
const builtinPageIcons: Record<string, IconName> = {
  compose: 'layers',
  style: 'brush',
  voice: 'mic',
  review: 'check',
  memory: 'brain',
  file: 'folder',
};

/**
 * 顶栏的「页面」菜单：五个制作步骤之外的页面（合成、风格、音色、复查、记忆，内置插件登记的页面）与第三方插件的页面
 * 不一个个摆在顶栏上（几个页面一摆，顶栏就乱、插件一多还会溢出），收进一个菜单，插件页面另起一组。
 * 当前开着的是菜单里的页面时，按钮显示那一页的名字。
 */
export function PageMenu({ pages, tabs, current, onPick }: { pages: [string, string][]; tabs: [string, string][]; current: string; onPick: (tab: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (pages.length === 0 && tabs.length === 0) return null;
  const active = [...pages, ...tabs].find(([id]) => id === current);
  const item = (id: string, label: string, icon: ReactNode, owner?: string) => (
    <button
      key={id}
      role="menuitem"
      data-tab={id}
      className={id === current ? 'on' : ''}
      aria-current={id === current ? 'page' : undefined}
      onClick={() => {
        setOpen(false);
        onPick(id);
      }}
    >
      {icon}
      {label}
      {owner && <span className="page-menu-owner">{owner}</span>}
    </button>
  );
  return (
    <div className="page-menu" ref={root}>
      <button className={'page-menu-trigger' + (active ? ' on' : '')} id="page-menu-trigger" aria-expanded={open} aria-haspopup="menu" title="其他页面" onClick={() => setOpen(!open)}>
        <Icon name="pages" size={13} />
        <span>{active ? active[1] : '页面'}</span>
        <Icon name="chevron" size={10} />
      </button>
      {open && (
        <div className="page-menu-list" role="menu">
          {pages.map(([id, label]) =>
            item(
              id,
              label,
              <span className="page-icon">
                <Icon name={builtinPageIcons[id] ?? 'file'} size={13} />
              </span>,
            ),
          )}
          {tabs.length > 0 && pages.length > 0 && <div className="page-menu-sep" role="separator" />}
          {tabs.map(([id, label]) =>
            item(
              id,
              label,
              <span className="station-icon">
                <PluginGlyph />
              </span>,
              pageRegistry.get(id)?.station.name ?? '',
            ),
          )}
        </div>
      )}
    </div>
  );
}
