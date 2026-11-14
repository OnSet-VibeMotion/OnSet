import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, errorText, forUser, post } from '../api';
import type { PrereqStatus, SetupStatus } from '../types';
import '../setup.css';

/**
 * 开拍前的准备：前置资源的安装页。
 *
 * 给用户看的是「摄制组」——画面、剪辑、配音、字幕四个组各自就位——而不是工具名：几项技术上的前置资源
 * 合成一个组（HyperFrames 技能 + CLI + 浏览器 = 画面组），工具名、版本、安装位置只在悬停提示与「高级」里。
 * 背后跑的是与 am setup 同一份清单（/api/setup/run），断了重来会接着下。首页与顶栏的弹窗共用这一个组件。
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

const proxyKey = 'am.setup.proxy';

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

/** 路径里的家目录换成 ~（只为显示短一些）。 */
function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, '~');
}

// ---- 图标：24 格线稿，描边随文字颜色 ----

function Icon(props: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {props.children}
    </svg>
  );
}

// 带 class 的那几笔在组「准备中」时动起来（setup.css 的「各组的小动画」）：镜头的光圈转、胶片走片、
// 话筒外一圈声波、字幕一行行打出来。静止时与原来的线稿一模一样。
const icons: Record<string, ReactNode> = {
  render: (
    <Icon>
      <rect x="2.5" y="6.5" width="13" height="11" rx="2" />
      <path className="ic-beam" d="M15.5 10.5l6-3.5v10l-6-3.5" />
      <g className="ic-lens">
        <circle cx="9" cy="12" r="2.2" />
        <path d="M9 9.8v1.1M11.2 12h-1.1M9 14.2v-1.1M6.8 12h1.1" />
      </g>
    </Icon>
  ),
  media: (
    <Icon>
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M8 3v18M16 3v18" />
      {/* 两侧的片孔：一条虚线，走片时挪动虚线的起点，片孔就在框里一格格往上走。 */}
      <path className="ic-reel" d="M6 4.6v15M18 4.6v15" strokeWidth="2" strokeLinecap="butt" strokeDasharray="1.5 3" />
    </Icon>
  ),
  voice: (
    <Icon>
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
      <path className="ic-wave w1" d="M2.6 6.5a9 9 0 0 0 0 7" />
      <path className="ic-wave w2" d="M21.4 6.5a9 9 0 0 1 0 7" />
    </Icon>
  ),
  align: (
    <Icon>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path className="ic-type t1" pathLength={1} d="M6.5 11h6M14.5 11h3" />
      <path className="ic-type t2" pathLength={1} d="M6.5 15h3M11.5 15h6" />
    </Icon>
  ),
  music: (
    <Icon>
      <path d="M9 18V6l10-2.5v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="15.5" r="2.5" />
    </Icon>
  ),
  design: (
    <Icon>
      <path d="M12 3v12M8 7v6M16 7v6M4 10v2M20 10v2" />
      <path d="M8.5 21h7M12 18v3" />
    </Icon>
  ),
  styles: (
    <Icon>
      <path className="ic-lift" d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </Icon>
  ),
};

// ---- 把技术上的几项合成用户听得懂的「组」 ----

interface Crew {
  key: string;
  /** 图标名（icons 的键）；不写用 key。 */
  icon?: string;
  title: string;
  desc: string;
  items: PrereqStatus[];
}

const voiceNames: Record<string, string> = {
  minimax: 'MiniMax',
  bailian: '阿里云百炼',
  edge: '微软 Edge 朗读',
  elevenlabs: 'ElevenLabs',
  tencent: '腾讯云',
  mlx: '本机合成',
  breeze: 'Breeze TTS 2（本机）',
};

/** 要一起就位的几个组；没有对应项（例如这台机器不配音）就不显示。 */
function coreCrews(items: PrereqStatus[]): Crew[] {
  const pick = (test: (item: PrereqStatus) => boolean) => items.filter(test);
  const voice = items.find((item) => item.group === 'tts');
  const voiceName = voice ? voiceNames[voice.id.slice('tts:'.length)] ?? '' : '';
  const crews: Crew[] = [
    { key: 'render', title: '画面', desc: '把每个镜头画出来、渲染成视频', items: pick((i) => ['skills', 'cli', 'browser'].includes(i.group)) },
    { key: 'media', title: '剪辑', desc: '检查、拼接画面与声音', items: pick((i) => i.group === 'ffmpeg') },
    { key: 'voice', title: '配音', desc: voiceName ? `把文稿读成配音 · ${voiceName}` : '把文稿读成配音', items: pick((i) => i.group === 'tts') },
    { key: 'align', title: '字幕', desc: '让字幕和配音逐字对上', items: pick((i) => i.group === 'align') },
  ];
  return crews.filter((c) => c.items.length > 0);
}

/** 以后可能用到、要单独点的：体积大，用到才装。 */
function laterCrews(items: PrereqStatus[]): Crew[] {
  const out: Crew[] = [];
  // 内置插件登记的（例如卡点的节拍分析环境、各整片风格来源）：同一 group 里名字相同的合成一张卡片，名字、说明与图标由插件登记。
  // 不只按 group 合：两个风格来源同在 styles 组，合成一张的话一个装了、一个没装时卡片上看不出缺的是哪个。
  const cardKey = (i: PrereqStatus) => i.group + ':' + i.later!.title;
  for (const key of [...new Set(items.filter((i) => i.later).map(cardKey))]) {
    const own = items.filter((i) => i.later && cardKey(i) === key);
    const later = own[0].later!;
    out.push({ key, icon: later.icon ?? own[0].group, title: later.title, desc: later.desc, items: own });
  }
  const design = items.filter((i) => i.group === 'voice');
  if (design.length) out.push({ key: 'design', title: '音色设计', desc: '在音色页按描述做一个新声音 · 约 4.6 GB', items: design });
  return out;
}

type State = 'ready' | 'missing' | 'waiting' | 'working' | 'failed' | 'paused';

/** 几项合成一个组之后的状态与进度（0–100）。 */
function crewState(c: Crew, task: SetupStatus['task']): { state: State; percent: number } {
  const running = task?.running ?? false;
  const progress = c.items.map((item) => task?.items[item.id]);
  const done = c.items.map((item, i) => item.ready || progress[i]?.state === 'done');
  const finished = done.filter(Boolean).length;
  // 用户点了暂停：后端把那一项记成失败、原因是「已取消」，在界面上不算出错。
  const stopped = progress.find((p) => p?.state === 'failed');
  if (stopped) return { state: stopped.error === '已取消' ? 'paused' : 'failed', percent: (100 * finished) / c.items.length };
  if (finished === c.items.length) return { state: 'ready', percent: 100 };
  const active = progress.findIndex((p) => p?.state === 'running');
  if (active >= 0) {
    // 每一项占同样的份额：已完成的算满，正在进行的按它自己的百分比（没有就算一半）。
    const current = (progress[active]?.percent ?? 50) / 100;
    return { state: 'working', percent: Math.round((100 * (finished + current)) / c.items.length) };
  }
  if (running && progress.some((p) => p?.state === 'pending')) return { state: 'waiting', percent: (100 * finished) / c.items.length };
  return { state: 'missing', percent: 0 };
}

/** 悬停时给懂行的人看：具体是哪些工具、版本、装在哪。 */
function technical(c: Crew): string {
  return c.items.map((i) => `${i.name}${i.version ? ' ' + i.version : ''}${i.ready ? '\n  ' + i.location : ''}`).join('\n');
}

const stateLabel: Record<State, string> = { ready: '已就位', missing: '待准备', waiting: '排队中', working: '准备中', failed: '没成功', paused: '已暂停' };

/** 图标外一圈进度：就位时整圈变绿并带一个对勾。 */
function Ring(props: { percent: number; state: State; children: ReactNode }) {
  const r = 27;
  const c = 2 * Math.PI * r;
  return (
    <span className={'crew-ring ' + props.state}>
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle className="track" cx="30" cy="30" r={r} />
        <circle className="value" cx="30" cy="30" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - props.percent / 100)} />
        {/* 准备中时绕圈走的一点光：下载停在某个百分比上时，也看得出它还在干活。 */}
        <circle className="orbit" cx="30" cy="30" r={r} strokeDasharray={`${c * 0.08} ${c * 0.92}`} />
      </svg>
      <span className="crew-icon">{props.children}</span>
      {props.state === 'ready' && (
        <span className="crew-check" aria-hidden="true">
          <svg viewBox="0 0 12 12">
            <path d="M3 6.2l2 2 4-4.4" />
          </svg>
        </span>
      )}
    </span>
  );
}

function CrewCard(props: { crew: Crew; task: SetupStatus['task']; index: number }) {
  const { state, percent } = crewState(props.crew, props.task);
  return (
    <li className={'crew-card ' + state} title={technical(props.crew)} style={{ '--i': props.index } as CSSProperties}>
      <Ring percent={percent} state={state}>
        {icons[props.crew.icon ?? props.crew.key] ?? icons.styles}
      </Ring>
      <span className="crew-title">{props.crew.title}</span>
      <span className="crew-desc">{props.crew.desc}</span>
      <span className="crew-state">{state === 'working' ? `${stateLabel.working} ${percent}%` : stateLabel[state]}</span>
    </li>
  );
}

/** 数字平滑地走到目标值（进度每秒才更新一次，直接跳显得一顿一顿）。 */
function useTween(target: number, ms = 900): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  const shown = useRef(target);
  useEffect(() => {
    from.current = shown.current;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      shown.current = from.current + (target - from.current) * eased;
      setValue(shown.current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

/** 右上角的大百分比：平滑地数上去。 */
function Percent(props: { value: number }) {
  const shown = useTween(props.value);
  return (
    <span className="setup-percent">
      {Math.round(shown)}
      <small>%</small>
    </span>
  );
}

/** 安装进行中顶上的放映机光束与走动的胶片：只是氛围，不承载信息。 */
function Projector() {
  return (
    <span className="setup-projector" aria-hidden="true">
      <span className="setup-beam" />
      <span className="setup-reel" />
    </span>
  );
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
  const paused = stoppedTask !== null && Object.values(stoppedTask.items).some((p) => p.state === 'failed' && p.error === '已取消');
  const failed = paused ? null : stoppedTask;
  const allReady = coreMissing === 0 && later.every((c) => c.items.every((i) => i.ready));
  const toggle = (which: 'network' | 'advanced') => setDrawer(drawer === which ? '' : which);

  if (allReady && !running) {
    return (
      <div className={'setup-guide ok' + (props.compact ? ' compact' : '')}>
        <p className="setup-title">摄制组已全部就位</p>
      </div>
    );
  }

  const overall = core.length === 0 ? 100 : Math.round(states.reduce((sum, s) => sum + s.percent, 0) / core.length);
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
    <div className={'setup-guide' + (props.compact ? ' compact' : '') + (running ? ' running' : '') + (failed ? ' failed' : '')} id="setup-guide">
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

      {showCrew && (
        <ul className="crew">
          {core.map((c, i) => (
            <CrewCard key={c.key} crew={c} task={task} index={i} />
          ))}
        </ul>
      )}

      {setup.startError && <p className="setup-error">{setup.startError}</p>}

      <footer className="setup-foot">
        <span className="setup-later">
          {later.map((c) => {
            const { state, percent } = crewState(c, task);
            return (
              <button
                key={c.key}
                className={'later-pill ' + state}
                title={c.desc + '\n\n' + technical(c)}
                disabled={running || state === 'ready'}
                onClick={() => void setup.start(c.items.filter((i) => !i.ready).map((i) => i.id))}
              >
                <span className="later-icon">{icons[c.icon ?? c.key] ?? icons.styles}</span>
                <span>{c.title}</span>
                <span className="later-state">{state === 'ready' ? '已就位' : state === 'working' ? `${percent}%` : state === 'waiting' ? '排队中' : '安装'}</span>
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
            <input value={setup.proxy} onChange={(e) => setup.setProxy(e.target.value)} placeholder="http://127.0.0.1:7890" disabled={running} spellCheck={false} />
          </label>
          <p className="setup-fine">下载很慢或总是中断时再填；不知道是什么可以不填。</p>
        </div>
      )}
      {drawer === 'advanced' && (
        <div className="setup-drawer">
          {failed && (
            <>
              <p className="setup-fine strong">{forUser(failed.error ?? '')}</p>
              {failed.log_tail && failed.log_tail.length > 0 && <pre className="setup-log">{failed.log_tail.join('\n')}</pre>}
              <p className="setup-fine">完整记录在 {shortPath(failed.log)}</p>
            </>
          )}
          <div className="setup-row-inline">
            {!running && (
              <button className="setup-link" onClick={() => void setup.recheck()} disabled={setup.checking}>
                {setup.checking ? '检查中…' : '重新检查'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
