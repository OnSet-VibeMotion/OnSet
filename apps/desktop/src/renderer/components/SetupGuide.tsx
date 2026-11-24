import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import { api, errorText, forUser, post } from '../api';
import '../setup.css';
import type { SetupStatus } from '../types';
import { CrewCard, laterIcons, NowPlaying, Percent, Projector } from './setup-guide/CrewCards';
import { coreCrews, crewState, inTask, laterCrews, shortPath, technical } from './setup-guide/crews';
import { RenderCheck } from './setup-guide/RenderCheck';

export { formatBytes } from './setup-guide/crews';

/**
 * 开拍前的准备：前置资源的安装页。
 *
 * 给用户看的是「摄制组」——画面、剪辑、配音、字幕四个组各自就位——而不是工具名：几项技术上的前置资源
 * 合成一个组（HyperFrames 技能 + CLI + 浏览器 = 画面组），工具名、版本、安装位置只在悬停提示与「高级」里。
 * 背后跑的是与 onset setup 同一份清单（/api/setup/run），断了重来会接着下。首页与顶栏的弹窗共用这一个组件。
 */

export interface SetupHandle {
  status: SetupStatus | null;
  checking: boolean;
  recheck: () => Promise<void>;
  /** 开始安装：only 为空时装全部必需项与配音、对齐工具。 */
  start: (only?: string[]) => Promise<void>;
  cancel: () => Promise<void>;
  /** 开始安装时被拒的原因（例如代理写错）。 */
  startError: string;
  proxy: string;
  setProxy: (value: string) => void;
}

const proxyKey = 'onset.setup.proxy';

function loadProxy(): string {
  try {
    return window.localStorage.getItem(proxyKey) ?? '';
  } catch {
    return '';
  }
}

/** 读前置资源状态：安装中每秒取一次进度；有缺项时每 10 秒再看一次（节拍页、风格页也可能在后台装）。 */
export function useSetup(): SetupHandle {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [startError, setStartError] = useState('');
  const [proxy, setProxyState] = useState(loadProxy);
  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await api<SetupStatus>('/api/setup'));
    } catch {
      // 读不到就保持上一次的状态。
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    void recheck();
  }, [recheck]);
  const running = status?.task?.running ?? false;
  const missing = status?.items.some((item) => !item.ready) ?? false;
  useEffect(() => {
    if (!missing && !running) return;
    const timer = window.setInterval(() => void recheck(), running ? 1000 : 10000);
    return () => window.clearInterval(timer);
  }, [missing, running, recheck]);
  const start = useCallback(
    async (only?: string[]) => {
      setStartError('');
      try {
        await post('/api/setup/run', { only: only ?? [], proxy: proxy.trim() });
      } catch (err) {
        setStartError(errorText(err));
      }
      await recheck();
    },
    [proxy, recheck],
  );
  const cancel = useCallback(async () => {
    try {
      await post('/api/setup/cancel');
    } finally {
      await recheck();
    }
  }, [recheck]);
  const setProxy = useCallback((value: string) => {
    setProxyState(value);
    try {
      window.localStorage.setItem(proxyKey, value);
    } catch {
      // 存不下就只在这次会话里用。
    }
  }, []);
  return { status, checking, recheck, start, cancel, startError, proxy, setProxy };
}

export function SetupGuide(props: { setup: SetupHandle; compact?: boolean }) {
  const { setup } = props;
  const status = setup.status;
  const [drawer, setDrawer] = useState<'' | 'network' | 'advanced'>('');
  if (!status) return null;
  const task = status.task;
  const running = task?.running ?? false;
  const core = coreCrews(status.items);
  const later = laterCrews(status.items);
  const states = core.map((c) => crewState(c, task));
  const readyCount = states.filter((s) => s.state === 'ready').length;
  const coreMissing = core.length - readyCount;
  const stoppedTask = task && !task.running && task.error ? task : null;
  const paused =
    stoppedTask !== null && Object.values(stoppedTask.items).some((p) => p.state === 'failed' && p.error === '已取消');
  const failed = paused ? null : stoppedTask;
  const allReady = coreMissing === 0 && later.every((c) => c.items.every((i) => i.ready));
  const toggle = (which: 'network' | 'advanced') => setDrawer(drawer === which ? '' : which);

  if (allReady && !running) {
    return (
      <div className={'setup-guide ok' + (props.compact ? ' compact' : '')}>
        <div className="setup-ok-row">
          <p className="setup-title">摄制组已全部就位</p>
          <RenderCheck />
        </div>
      </div>
    );
  }

  // 安装进行中按这次真正在装的组算（只装一个风格库时不该一开始就显示 100%）；否则按四个核心组。
  const counted = running ? [...core, ...later].filter((c) => inTask(c, task)) : core;
  const overall =
    counted.length === 0
      ? 100
      : Math.round(counted.reduce((sum, c) => sum + crewState(c, task).percent, 0) / counted.length);
  const showCrew = coreMissing > 0 || running;

  let eyebrow = '开拍之前';
  let title = '召集你的摄制组';
  let lead = '第一次使用需要把几样工具请到位，只下载这一次，之后每个项目都能用。';
  if (running) {
    eyebrow = '正在就位';
    title = '摄制组正在赶来';
    lead = '可以先在下面写想做的片子。中途关掉也没关系，下次会接着刚才的进度。';
  } else if (paused) {
    eyebrow = '已暂停';
    title = '摄制组暂停待命';
    lead = '已经下好的都留着，点「继续」从刚才的进度接着来。';
  } else if (failed) {
    eyebrow = '暂停';
    title = '有人在路上耽搁了';
    lead = '多半是网络不太顺。点「继续」会从刚才的进度接着下载；总是不行的话，在「网络」里填一个代理。';
  } else if (!showCrew) {
    eyebrow = '按需';
    title = '以后可能用到';
    lead = '一般的片子用不到，做到对应的片子时再请也不迟。';
  }

  return (
    <div
      className={
        'setup-guide' + (props.compact ? ' compact' : '') + (running ? ' running' : '') + (failed ? ' failed' : '')
      }
      id="setup-guide"
    >
      <span className="setup-grain" aria-hidden="true" />
      {running && <Projector />}
      <header className="setup-head">
        <div className="setup-heading">
          <span className="setup-eyebrow">{eyebrow}</span>
          <p className="setup-title">
            {title}
            {running && (
              <span className="setup-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </p>
          <p className="setup-lead">{lead}</p>
        </div>
        <div className="setup-cta">
          {running ? (
            <>
              <Percent value={overall} />
              <button className="ghost" onClick={() => void setup.cancel()}>
                暂停
              </button>
            </>
          ) : (
            showCrew && (
              <button className="primary setup-go" onClick={() => void setup.start()}>
                {failed || paused ? '继续' : '开始准备'}
              </button>
            )
          )}
        </div>
      </header>

      {running && (
        <span className="setup-progress" aria-hidden="true">
          <span style={{ width: `${overall}%` }} />
        </span>
      )}

      <NowPlaying crews={[...core, ...later]} items={status.items} task={task} />

      {showCrew && (
        <ul className="crew">
          {core.map((c, i) => (
            <CrewCard
              key={c.key}
              crew={c}
              task={task}
              index={i}
              onInstall={() => void setup.start(c.items.filter((item) => !item.ready).map((item) => item.id))}
            />
          ))}
        </ul>
      )}

      {setup.startError && <p className="setup-error">{setup.startError}</p>}

      <footer className="setup-foot">
        <span className="setup-later">
          {later.map((c) => {
            const { state, percent } = crewState(c, task);
            const idle = running && !inTask(c, task);
            return (
              <button
                key={c.key}
                className={'later-pill ' + state + (idle ? ' idle' : '')}
                style={{ '--p': `${percent}%` } as CSSProperties}
                title={c.desc + '\n\n' + technical(c)}
                disabled={running || state === 'ready'}
                onClick={() => void setup.start(c.items.filter((i) => !i.ready).map((i) => i.id))}
              >
                <span className="later-icon">{laterIcons[c.icon ?? c.key] ?? laterIcons.styles}</span>
                <span>{c.title}</span>
                <span className="later-state">
                  {state === 'ready'
                    ? '已就位'
                    : state === 'working'
                      ? `${percent}%`
                      : state === 'waiting'
                        ? '排队中'
                        : '安装'}
                </span>
              </button>
            );
          })}
        </span>
        <span className="setup-links">
          <button className={'setup-link' + (drawer === 'network' ? ' on' : '')} onClick={() => toggle('network')}>
            网络{setup.proxy.trim() ? ' · 已设代理' : ''}
          </button>
          <button className={'setup-link' + (drawer === 'advanced' ? ' on' : '')} onClick={() => toggle('advanced')}>
            高级
          </button>
        </span>
      </footer>

      {drawer === 'network' && (
        <div className="setup-drawer">
          <label className="setup-proxy">
            <span>代理</span>
            <input
              value={setup.proxy}
              onChange={(e) => setup.setProxy(e.target.value)}
              placeholder="http://127.0.0.1:7890"
              disabled={running}
              spellCheck={false}
            />
          </label>
          <p className="setup-fine">下载很慢或总是中断时再填；不知道是什么可以不填。</p>
        </div>
      )}
      {drawer === 'advanced' && (
        <div className="setup-drawer">
          {failed && (
            <>
              <p className="setup-fine strong">{forUser(failed.error ?? '')}</p>
              {failed.log_tail && failed.log_tail.length > 0 && (
                <pre className="setup-log">{failed.log_tail.join('\n')}</pre>
              )}
              <p className="setup-fine">完整记录在 {shortPath(failed.log)}</p>
            </>
          )}
          <div className="setup-row-inline">
            {!running && (
              <button className="setup-link" onClick={() => void setup.recheck()} disabled={setup.checking}>
                {setup.checking ? '检查中…' : '重新检查'}
              </button>
            )}
            {!running && coreMissing === 0 && <RenderCheck />}
          </div>
        </div>
      )}
    </div>
  );
}
