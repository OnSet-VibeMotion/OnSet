import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorText } from '../../api';
import type { StationInfo, StationPageInfo, StationsResponse } from '../../types';
import type { RunAction } from '../Preview';
import {
  clickedInPluginPage,
  hostTheme,
  maxAskChars,
  type PageRequest,
  type PendingRun,
  paramText,
  projectSummary,
} from './frameBridge';
import { opNames, runAndWait, ScopeWarning } from './meta';

export interface FrameProps {
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
 * 页面要的东西都经这里：theme / info / project / read / list / run / call / ask / open。执行类先在上方请用户确认——
 * 页面里的按钮可以被脚本自己点，不算用户同意；只有 run 在用户刚亲手点了页面里的按钮时直接执行（clickedInPluginPage）。
 * call（片场自带的操作）与 send（替用户发话、会花钱）照旧确认。只认来自这个 iframe 的消息。
 */
export function StationFrame({
  station,
  page,
  context,
  version,
  run,
  onQuick,
  onOpen,
  projectName,
  height,
}: FrameProps) {
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
            for (const st of station.settings) {
              if (st.type !== 'secret' && st.value !== undefined) settings[st.key] = st.value;
            }
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
            reply(
              m.id,
              true,
              await api(
                `/api/stations/${encodeURIComponent(station.id)}/read?path=${encodeURIComponent(String(m.path ?? ''))}`,
              ),
            );
            return;
          case 'list': {
            // 列表操作只读插件自己的数据（清单 ops[].list），与设置里打开弹窗时自动跑的是同一条，不用用户确认。
            const op = station.ops.find((o) => o.name === m.op && o.list);
            if (!op) throw new Error(`没有列表操作 ${String(m.op)}（清单 ops[].list）`);
            // 先说收到了：跑操作要几秒，别让页面按「没回应」报错。
            frame.current?.contentWindow?.postMessage({ onset: 'host', id: m.id, ack: true }, '*');
            const id = encodeURIComponent(station.id);
            // 结果不进任务（任务会写进项目），从插件列表里这条操作的最近一次结果取。最近一次可能是同时跑的另一次
            // （设置弹窗也会自动跑列表）：那次成功的话它读的是同一份数据、不比这次旧，照用；失败了就再跑一次。
            for (let attempt = 0; ; attempt++) {
              const t = await runAndWait(`/api/stations/${id}/ops/${encodeURIComponent(op.name)}`, { params: {} });
              if (t.status !== 'succeeded') throw new Error(t.error || t.message || `${op.summary}没有成功`);
              const r = await api<StationsResponse>('/api/stations');
              const last = r.stations.find((x) => x.id === station.id)?.ops.find((o) => o.name === op.name)?.last_run;
              if (last?.ok) {
                reply(m.id, true, last.data ?? {});
                return;
              }
              if (attempt >= 2) throw new Error(`${op.summary}的结果被同时跑的另一次覆盖了，请重试`);
            }
          }
          case 'run': {
            const op = station.ops.find((o) => o.name === m.op);
            if (!op) throw new Error(`没有操作 ${String(m.op)}`);
            const req: PendingRun = {
              id: m.id,
              kind: 'run',
              op: op.name,
              label: op.summary,
              params: m.params && typeof m.params === 'object' ? m.params : {},
            };
            // 用户刚在插件页面里亲手点了按钮：那一下就是同意，不再弹确认条。脚本发起的、分不清是谁点的，照旧确认。
            if (clickedInPluginPage(frame.current)) executeRef.current(req);
            else ask(req);
            return;
          }
          case 'call': {
            const op = String(m.op ?? '');
            if (!station.permissions.uses.includes(op)) {
              throw new Error(`这个插件没有申请调用 ${op}（permissions.uses）`);
            }
            ask({
              id: m.id,
              kind: 'call',
              op,
              label: opNames[op] ?? op,
              params: m.params && typeof m.params === 'object' ? m.params : {},
            });
            return;
          }
          case 'ask': {
            const text = String(m.text ?? '')
              .slice(0, maxAskChars)
              .trim();
            if (text === '') throw new Error('没有要填的内容');
            onQuick(`（来自插件「${station.name}」的页面）\n${text}`, [], true);
            reply(m.id, true, { filled: true });
            return;
          }
          case 'send': {
            const text = String(m.text ?? '')
              .slice(0, maxAskChars)
              .trim();
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
  }, [station, page.id, projectName, JSON.stringify(context)]);

  // 项目有变化：告诉页面重读（不重载 iframe，页面里的状态不丢）。
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ onset: 'host', type: 'refresh' }, '*');
  }, [version]);

  // 执行一个请求（用户在确认条上点了「执行」，或在插件页面里亲手点了按钮）。
  const execute = (req: PendingRun) => {
    if (req.kind === 'send') {
      onQuick(`（来自插件「${station.name}」的页面）\n${req.label}`, [], false);
      reply(req.id, true, { sent: true });
      return;
    }
    const base = `/api/stations/${encodeURIComponent(station.id)}`;
    run(
      req.kind === 'run' ? `${base}/ops/${encodeURIComponent(req.op)}` : `${base}/call/${encodeURIComponent(req.op)}`,
      { params: req.params },
    );
    if (req.kind === 'run') setRan((r) => ({ ...r, [req.op]: new Date().toISOString() }));
    reply(req.id, true, { started: true });
  };

  const executeRef = useRef(execute);
  useLayoutEffect(() => {
    executeRef.current = execute;
  });

  const decide = (allow: boolean) => {
    const req = pendingRef.current;
    if (!req) return;
    if (allow) {
      execute(req);
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
          <ScopeWarning
            key={o.name}
            run={o.last_run}
            label={`「${station.name}」执行「${o.summary.replace(/（.*?）/g, '')}」`}
          />
        ))}
    </>
  );
}
