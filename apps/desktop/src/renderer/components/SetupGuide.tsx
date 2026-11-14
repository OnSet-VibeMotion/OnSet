import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api, errorText, forUser, post } from '../api';
import type { PrereqStatus, RenderCheckResult, SetupStatus } from '../types';
import { CrewStage, paceWord, stageKind, usePace } from './CrewStage';
import '../setup.css';

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

// 「以后可能用到」那排药丸的图标；风格库那一层在装的时候轻轻抬起。四个核心组画的是小景（CrewStage）。
const icons: Record<string, ReactNode> = {
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
  if (design.length) out.push({ key: 'design', title: '音色设计', desc: window.onset?.platform === 'win32' ? '在音色页按描述做一个新声音 · Windows CUDA Q8_0 · 约 6.2 GB' : '在音色页按描述做一个新声音 · 约 4.6 GB', items: design });
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
    // 每一项占同样的份额：已完成的算满，正在进行的按它自己的百分比。量不出百分比（npm、pip、浏览器下载）的
    // 不算——以前按一半算，Windows 上下浏览器时就一直停在 50%，看着像卡死了；那种步骤改为显示下了多少字节。
    const current = (progress[active]?.percent ?? 0) / 100;
    return { state: 'working', percent: Math.round((100 * (finished + current)) / c.items.length) };
  }
  if (running && progress.some((p) => p?.state === 'pending')) return { state: 'waiting', percent: (100 * finished) / c.items.length };
  return { state: 'missing', percent: 0 };
}

/** 每一项用大白话说是在干什么（「正在赶来」那一条的第二行）。 */
const purposes: Record<string, string> = {
  skills: '下载画面组的制作手册',
  cli: '安装渲染程序',
  browser: '下载渲染用的浏览器，约 390 MB',
  ffmpeg: '下载剪辑工具',
  tts: '安装配音工具',
  voice: '安装音色设计工具',
  align: '安装字幕对齐工具',
  styles: '下载风格库',
  beat: '准备节拍分析环境',
};

function purposeOf(item: PrereqStatus): string {
  return purposes[item.id] ?? purposes[item.group] ?? item.name;
}

/** 字节数写成 MB / GB。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1_048_576) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/** 秒数写成「3 分 12 秒」。 */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 一个组正在准备的那一项，以及它是第几步。 */
function runningStep(c: Crew, task: SetupStatus['task']): { item: PrereqStatus; progress: NonNullable<SetupStatus['task']>['items'][string]; index: number } | null {
  const index = c.items.findIndex((item) => task?.items[item.id]?.state === 'running');
  if (index < 0 || !task) return null;
  return { item: c.items[index], progress: task.items[c.items[index].id], index };
}

/**
 * 人在路上走到哪：已完成的项加上正在准备的那一项走了多少。量得出百分比的按百分比；只知道字节数的，
 * 下得越多越往前挪（最多走到这一段的 85%），一点都量不出的按用了多久慢慢挪——画面上看得出在走，
 * 但不拿它冒充百分比，卡片与顶上的数字仍只按量得出的算。
 */
function walkPercent(c: Crew, task: SetupStatus['task'], percent: number): number {
  const step = runningStep(c, task);
  if (!step || step.progress.percent !== undefined) return percent;
  const share = 100 / c.items.length;
  const p = step.progress;
  const amount = p.bytes !== undefined ? p.bytes / (80 * 1_048_576) : p.started_at ? (Date.now() - p.started_at) / 180_000 : 0;
  return percent + share * 0.85 * (1 - Math.exp(-amount));
}

/** 悬停时给懂行的人看：具体是哪些工具、版本、装在哪。 */
function technical(c: Crew): string {
  return c.items.map((i) => `${i.name}${i.version ? ' ' + i.version : ''}${i.ready ? '\n  ' + i.location : ''}`).join('\n');
}

/** 这一组有没有参与这次安装（没参与的在安装进行中变暗，让正在装的那一组跳出来）。 */
function inTask(c: Crew, task: SetupStatus['task']): boolean {
  return c.items.some((item) => task?.items[item.id] !== undefined);
}

const stateLabel: Record<State, string> = { ready: '已就位', missing: '待准备', waiting: '排队中', working: '在路上', failed: '没成功', paused: '已暂停' };

function Check() {
  return (
    <span className="crew-check" aria-hidden="true">
      <svg viewBox="0 0 12 12">
        <path d="M3 6.2l2 2 4-4.4" />
      </svg>
    </span>
  );
}

function CrewCard(props: { crew: Crew; task: SetupStatus['task']; index: number; onInstall: () => void }) {
  const { state, percent } = crewState(props.crew, props.task);
  const idle = props.task?.running && !inTask(props.crew, props.task);
  // 赶来的速度就是下载速度：量得出百分比的按百分比算，只知道字节数的按字节算，后端说好一会儿没动静就算停住。
  const step = runningStep(props.crew, props.task);
  const byBytes = step !== null && step.progress.percent === undefined;
  const pace = usePace(byBytes ? step.progress.bytes ?? 0 : percent, state === 'working', byBytes ? 'bytes' : 'percent', step?.progress.quiet);
  const word = paceWord(pace);
  let working = `${stateLabel.working} ${percent}%`;
  if (byBytes && step.progress.bytes) working = `${stateLabel.working} · 已下 ${formatBytes(step.progress.bytes)}`;
  else if (byBytes && props.crew.items.length > 1) working = `${stateLabel.working} · 第 ${step.index + 1}/${props.crew.items.length} 步`;
  else if (byBytes) working = stateLabel.working;
  return (
    <li className={'crew-card ' + state + (idle ? ' idle' : '')} title={technical(props.crew)} style={{ '--i': props.index } as CSSProperties}>
      <span className="crew-stage">
        <CrewStage kind={stageKind(props.crew.key)} state={state} percent={walkPercent(props.crew, props.task, percent)} pace={pace} />
        {state === 'ready' && <Check />}
      </span>
      <span className={'crew-meter ' + state} aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="crew-title">{props.crew.title}</span>
      <span className="crew-desc">{props.crew.desc}</span>
      <span className="crew-state">{state === 'working' ? `${working}${word ? ' · ' + word : ''}` : stateLabel[state]}</span>
      {state !== 'ready' && (
        <button className="setup-link crew-install" onClick={props.onInstall} disabled={!!props.task?.running}>
          {state === 'working' ? '正在准备…' : state === 'waiting' ? '等待安装' : state === 'failed' ? '重试安装' : `安装${props.crew.title}工具`}
        </button>
      )}
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
function Percent(props: { value: number; className?: string }) {
  const shown = useTween(props.value);
  return (
    <span className={props.className ?? 'setup-percent'}>
      {Math.round(shown)}
      <small>%</small>
    </span>
  );
}

/**
 * 正在下载的那一项：单独一条亮出来——哪一组、具体是什么、走到哪一步、自己的进度，后面排着谁。
 * 换到下一项时整条重新入场（key 换了），看得出「轮到谁了」。
 */
function NowPlaying(props: { crews: Crew[]; items: PrereqStatus[]; task: SetupStatus['task'] }) {
  const task = props.task;
  if (!task?.running) return null;
  const item = props.items.find((i) => task.items[i.id]?.state === 'running');
  const crew = item && props.crews.find((c) => c.items.includes(item));
  const queued = props.crews.filter((c) => c !== crew && crewState(c, task).state === 'waiting').map((c) => c.title);
  if (!item || !crew) return null;
  return <NowCard key={item.id} crew={crew} item={item} task={task} queued={queued} />;
}

/**
 * 「正在赶来」那一条：哪一组、第几步、用大白话说在干什么，量得出的给百分比，量不出的给下了多少、多快，
 * 再加用了多久与子进程最近的一行输出；好一会儿没有动静时照实说，并指向「网络」里的代理。
 */
function NowCard(props: { crew: Crew; item: PrereqStatus; task: NonNullable<SetupStatus['task']>; queued: string[] }) {
  const { crew, item, task, queued } = props;
  const progress = task.items[item.id];
  const measured = progress?.percent !== undefined;
  const percent = progress?.percent ?? 0;
  const crewPercent = crewState(crew, task).percent;
  const pace = usePace(measured ? crewPercent : progress?.bytes ?? 0, true, measured ? 'percent' : 'bytes', progress?.quiet);
  const word = paceWord(pace);
  const index = crew.items.indexOf(item);
  const elapsed = progress?.started_at ? (Date.now() - progress.started_at) / 1000 : 0;
  const quiet = progress?.quiet ?? 0;
  const facts: string[] = [];
  if (!measured && progress?.bytes) facts.push(`已下载 ${formatBytes(progress.bytes)}`);
  if (pace.bytesRate && pace.bytesRate > 0 && !pace.stalled) facts.push(`${formatBytes(pace.bytesRate)}/s`);
  if (elapsed >= 1) facts.push(`已用 ${formatDuration(elapsed)}`);
  return (
    <div className={'setup-now' + (quiet >= 60 ? ' quiet' : '')}>
      <span className="now-stage-art">
        <CrewStage kind={stageKind(crew.key)} state="working" percent={walkPercent(crew, task, crewPercent)} pace={pace} />
      </span>
      <div className="now-body">
        <span className="now-label">
          <i className="now-live" aria-hidden="true" />
          正在赶来{word ? ` · ${word}` : ''}
        </span>
        <span className="now-title">
          {crew.title}
          <span className="now-item">
            {crew.items.length > 1 ? `第 ${index + 1} 步，共 ${crew.items.length} 步：` : ''}
            {purposeOf(item)}
          </span>
        </span>
        <span className={'now-bar' + (measured ? '' : ' unknown')} aria-hidden="true">
          <span style={{ width: measured ? `${percent}%` : undefined }} />
        </span>
        <span className="now-stage">
          <span>{progress?.stage || '准备中'}</span>
          {facts.length > 0 && <span className="now-facts">{facts.join(' · ')}</span>}
          {queued.length > 0 && <span className="now-queue">接下来：{queued.join('、')}</span>}
        </span>
        {progress?.activity && (
          <span className="now-activity" title={progress.activity}>
            {progress.activity}
          </span>
        )}
        {quiet >= 60 && (
          <span className="now-warn">
            已经 {formatDuration(quiet)}没有新动静了，可能是网络不通。可以在下面「网络」里填一个代理，或者先暂停、过一会儿再继续——已经下好的不会丢。
          </span>
        )}
      </div>
      {measured && <Percent value={percent} className="now-percent" />}
    </div>
  );
}

const browserWords: Record<RenderCheckResult['browser'], string> = {
  lent: '借用客户端自带的浏览器',
  own: '你自己指定的浏览器',
  downloaded: '另外下载的渲染用浏览器',
};

/**
 * 试渲染一个镜头：在临时目录里用 HyperFrames 渲染 1 秒的小画面，看这台电脑能不能出片（/api/setup/render-check）。
 * 走的是与真正渲染同一个入口；Windows 上借用客户端浏览器那条路只有真机验证得了，这个按钮就是给它用的。
 */
function RenderCheck() {
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const [result, setResult] = useState<RenderCheckResult | null>(null);
  const [error, setError] = useState('');
  const start = async () => {
    setState('running');
    setError('');
    setResult(null);
    try {
      setResult(await post<RenderCheckResult>('/api/setup/render-check'));
    } catch (err) {
      setError(errorText(err));
    }
    setState('done');
  };
  return (
    <span className="render-check">
      <button className="setup-link" onClick={() => void start()} disabled={state === 'running'}>
        {state === 'running' ? '正在试渲染…' : state === 'done' ? '再试一次' : '试渲染一个镜头'}
      </button>
      {state === 'running' && <span className="render-check-note">在后台渲染一段 1 秒的小画面，十几秒就好。</span>}
      {error && <span className="render-check-fail">{forUser(error)}</span>}
      {result && (
        <span className={'render-check-result' + (result.ok ? ' ok' : ' fail')}>
          {result.frame && <img src={result.frame} alt="试渲染的画面" />}
          <span className="render-check-text">
            <strong>{result.ok ? `能出片，用了 ${result.seconds} 秒` : '没能出片'}</strong>
            <span>
              用的是{browserWords[result.browser]}
              {result.hooked ? '（Windows 的借用方式）' : ''}
            </span>
            {result.error && <span className="render-check-fail">{forUser(result.error)}</span>}
            {!result.ok && result.log_tail && result.log_tail.length > 0 && <pre className="setup-log">{result.log_tail.join('\n')}</pre>}
          </span>
        </span>
      )}
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
        <div className="setup-ok-row">
          <p className="setup-title">摄制组已全部就位</p>
          <RenderCheck />
        </div>
      </div>
    );
  }

  // 安装进行中按这次真正在装的组算（只装一个风格库时不该一开始就显示 100%）；否则按四个核心组。
  const counted = running ? [...core, ...later].filter((c) => inTask(c, task)) : core;
  const overall = counted.length === 0 ? 100 : Math.round(counted.reduce((sum, c) => sum + crewState(c, task).percent, 0) / counted.length);
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

      <NowPlaying crews={[...core, ...later]} items={status.items} task={task} />

      {showCrew && (
        <ul className="crew">
          {core.map((c, i) => (
            <CrewCard key={c.key} crew={c} task={task} index={i} onInstall={() => void setup.start(c.items.filter((item) => !item.ready).map((item) => item.id))} />
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
            {!running && coreMissing === 0 && <RenderCheck />}
          </div>
        </div>
      )}
    </div>
  );
}
