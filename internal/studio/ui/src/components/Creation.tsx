import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, errorText, post } from '../api';
import type { Attachment, CanvasOption, Project } from '../types';
import '../creation.css';

/**
 * 新建项目的「开机」画面。建项目、放素材、装技能、请编排工具开工，四步摆成剪辑
 * 时间线上的四段片段，播放头按真实进度走；场记板写着片名、画幅与制作方式，监视器按
 * 选定的画幅放倒计时片头，全部就绪时打板、闪白、推进到项目里。
 *
 * 顺序刻意先装技能再开工：编排工具一开工就该有 hyperframes 技能可用。装技能要联网、
 * 一分钟上下，所以随时可以「不等了」——技能转到后台，顶栏继续显示进度。
 */

export interface CreationJob {
  parent: string;
  name: string;
  canvas: string;
  canvasInfo?: CanvasOption;
  style: string;
  delivery: string;
  narration: string;
  modeLabel: string;
  tool: string;
  toolLabel: string;
  message: string;
  files: File[];
}

type StepID = 'create' | 'upload' | 'skills' | 'start';
type StepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

interface Step {
  id: StepID;
  label: string;
  weight: number;
}

const steps: Step[] = [
  { id: 'create', label: '建立项目', weight: 10 },
  { id: 'upload', label: '放入素材', weight: 10 },
  { id: 'skills', label: '装备技能', weight: 68 },
  { id: 'start', label: '召集编排', weight: 12 },
];

interface SkillsStatus {
  installed: boolean;
  installing: boolean;
  error?: string;
  progress?: { stage: string; percent: number; indeterminate?: boolean };
}

const FPS = 30;

export function Creation(props: { job: CreationJob; onDone: (projectId: string, sessionId: string) => void; onClose: (error: string) => void }) {
  const { job } = props;
  const [states, setStates] = useState<Record<StepID, StepState>>({ create: 'running', upload: 'waiting', skills: 'waiting', start: 'waiting' });
  const [fractions, setFractions] = useState<Record<StepID, number>>({ create: 0, upload: 0, skills: 0, start: 0 });
  const [caption, setCaption] = useState('正在建立项目文件夹…');
  const [error, setError] = useState('');
  const [skillsError, setSkillsError] = useState('');
  const [indeterminate, setIndeterminate] = useState(false);
  const [finale, setFinale] = useState<'' | 'clap' | 'zoom'>('');
  const [title, setTitle] = useState(job.name);
  const [started] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const project = useRef<Project | null>(null);
  const attachments = useRef<Attachment[]>([]);
  const skipSkills = useRef<() => void>(() => {});
  const retrySkills = useRef<() => void>(() => {});

  const mark = (id: StepID, state: StepState, fraction?: number) => {
    setStates((current) => ({ ...current, [id]: state }));
    if (fraction !== undefined) setFractions((current) => ({ ...current, [id]: fraction }));
  };

  // 时间码与片头倒计时用的时钟。
  useEffect(() => {
    if (finale === 'zoom') return;
    let frame = 0;
    const tick = () => {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [finale]);

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const run = async () => {
      try {
        // 1. 建立项目：重名就加序号。
        let created: Project | null = null;
        for (let attempt = 1; attempt <= 20 && !created; attempt++) {
          const name = attempt === 1 ? job.name : `${job.name}-${attempt}`;
          try {
            created = (
              await post<{ project: Project }>('/api/projects/create', {
                parent: job.parent,
                name,
                canvas: job.canvas,
                style: job.style,
                delivery: job.delivery,
                narration: job.narration,
              })
            ).project;
          } catch (err) {
            if (!(err instanceof Error) || !/已经存在/.test(err.message)) throw err;
          }
        }
        if (!created) throw new Error('同名的项目太多了，换个说法再试');
        project.current = created;
        setTitle(created.name);
        mark('create', 'done', 1);
        await sleep(350);
        if (cancelled) return;

        // 2. 放入素材。
        mark('upload', 'running');
        if (job.files.length) {
          setCaption(`正在放入 ${job.files.length} 个素材…`);
          const form = new FormData();
          for (const file of job.files) form.append('file', file, file.name);
          attachments.current = (await api<{ attachments: Attachment[] }>('/api/uploads', { method: 'POST', body: form })).attachments;
          mark('upload', 'done', 1);
        } else {
          setCaption('没有素材，跳过');
          mark('upload', 'skipped', 1);
        }
        await sleep(350);
        if (cancelled) return;

        // 3. 装备技能：后端建项目时已经在后台开装，这里只看进度。可以随时不等。
        mark('skills', 'running');
        setCaption('正在装备 HyperFrames 官方技能…');
        await new Promise<void>((resolve) => {
          let timer = 0;
          let done = false;
          const finish = (state: StepState) => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            setIndeterminate(false);
            mark('skills', state, 1);
            resolve();
          };
          skipSkills.current = () => {
            setCaption('技能转到后台继续装');
            finish('skipped');
          };
          const poll = async () => {
            if (cancelled || done) return;
            try {
              const status = (await api<{ status?: SkillsStatus }>('/api/skills')).status;
              if (status?.installing) {
                setSkillsError('');
                const p = status.progress;
                if (p) {
                  setFractions((current) => ({ ...current, skills: Math.max(current.skills, p.percent / 100) }));
                  setIndeterminate(!!p.indeterminate);
                  setCaption(`装备技能 · ${p.stage}${p.indeterminate ? '' : ` ${Math.round(p.percent)}%`}`);
                }
              } else if (status?.error) {
                setSkillsError(status.error);
                setCaption('技能没装上');
                return; // 等用户选重试或跳过
              } else {
                setCaption('技能就绪');
                finish('done');
                return;
              }
            } catch {
              // 读状态失败就下一次再试。
            }
            timer = window.setTimeout(poll, 600);
          };
          retrySkills.current = async () => {
            setSkillsError('');
            setCaption('重新装备技能…');
            try {
              await post('/api/skills/install');
            } catch (err) {
              setSkillsError(errorText(err));
              return;
            }
            timer = window.setTimeout(poll, 600);
          };
          void poll();
        });
        if (cancelled) return;
        await sleep(300);

        // 4. 召集编排：开始整片制作。
        mark('start', 'running');
        setCaption(`正在请 ${job.toolLabel} 开工…`);
        const startedTurn = await post<{ session_id: string }>('/api/production/start', {
          message: job.message || '用上传的文件做这条视频。',
          attachments: attachments.current,
          tool: job.tool,
        });
        mark('start', 'done', 1);
        setCaption('开机');
        if (cancelled) return;

        // 打板、闪白、推进到项目。
        setFinale('clap');
        await sleep(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 1100);
        setFinale('zoom');
        await sleep(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 520);
        if (!cancelled) props.onDone(created.id, startedTurn.session_id);
      } catch (err) {
        setError(errorText(err));
        setCaption('出了点问题');
        setStates((current) => {
          const next = { ...current };
          for (const step of steps) if (next[step.id] === 'running') next[step.id] = 'failed';
          return next;
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const overall = useMemo(() => {
    let total = 0;
    for (const step of steps) {
      const state = states[step.id];
      const fraction = state === 'done' || state === 'skipped' ? 1 : state === 'running' ? fractions[step.id] : 0;
      total += step.weight * fraction;
    }
    return total;
  }, [states, fractions]);

  const elapsed = (now - started) / 1000;
  const countdown = 3 - (Math.floor(elapsed) % 3);
  const sweep = (elapsed % 1) * 360;
  const ratio = job.canvasInfo ? job.canvasInfo.width / job.canvasInfo.height : 3 / 4;
  const today = new Date(started);
  const running = states.skills === 'running';

  return (
    <div class={'creation' + (finale ? ' ' + finale : '')} role="dialog" aria-modal="true" aria-label="正在新建项目">
      <div class="creation-grain" aria-hidden="true" />
      <div class="creation-stage">
        <Slate
          title={title}
          canvas={job.canvasInfo ? `${job.canvasInfo.width}×${job.canvasInfo.height}` : job.canvas}
          mode={job.modeLabel}
          date={`${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`}
          tool={job.toolLabel}
          clapped={finale !== ''}
        />

        <div class="monitor" style={{ aspectRatio: String(ratio) }}>
          {finale ? (
            <div class="monitor-title">
              <span class="monitor-kicker">TAKE 1</span>
              <strong>{title}</strong>
            </div>
          ) : (
            <div class="leader" aria-hidden="true">
              <div class="leader-sweep" style={{ background: `conic-gradient(rgba(255,255,255,.16) ${sweep}deg, transparent ${sweep}deg)` }} />
              <div class="leader-cross" />
              <div class="leader-ring" />
              <div class="leader-ring inner" />
              <span class="leader-number">{countdown}</span>
            </div>
          )}
          <span class="monitor-rec">
            <i />
            REC
          </span>
          <span class="monitor-tc mono">{timecode(elapsed)}</span>
          <span class="monitor-safe" aria-hidden="true" />
        </div>

        <div class="timeline-rig">
          <div class="rig-ruler mono" aria-hidden="true">
            {Array.from({ length: 11 }, (_, i) => (
              <span key={i}>{timecode((i * Math.max(elapsed, 10)) / 10).slice(3, 8)}</span>
            ))}
          </div>
          <div class="rig-track video">
            <span class="track-label mono">V1</span>
            <div class="track-lane">
              {steps.map((step) => {
                const state = states[step.id];
                const fill = state === 'done' || state === 'skipped' ? 1 : state === 'running' ? fractions[step.id] : 0;
                return (
                  <div
                    key={step.id}
                    class={'clip ' + state + (step.id === 'skills' && indeterminate ? ' indeterminate' : '')}
                    style={{ flexGrow: step.weight }}
                  >
                    <span class="clip-fill" style={{ width: `${fill * 100}%` }} />
                    <span class="clip-label">
                      {step.label}
                      {state === 'skipped' && step.id === 'skills' && <em> · 后台</em>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div class="rig-track audio">
            <span class="track-label mono">A1</span>
            <div class="track-lane wave" aria-hidden="true">
              {Array.from({ length: 64 }, (_, i) => (
                <i key={i} style={{ animationDelay: `${(i * 97) % 1100}ms`, height: `${30 + ((i * 37) % 60)}%` }} />
              ))}
            </div>
          </div>
          <div class="playhead" style={{ left: `calc(48px + (100% - 60px) * ${overall / 100})` }} aria-hidden="true">
            <span class="playhead-cap" />
          </div>
        </div>

        <div class="creation-caption" aria-live="polite">
          <span class="caption-percent mono">{Math.round(overall)}%</span>
          <span class="caption-text">{error || caption}</span>
        </div>

        <div class="creation-actions">
          {error ? (
            <button class="pill" onClick={() => props.onClose(error)}>
              回到首页
            </button>
          ) : skillsError ? (
            <>
              <span class="creation-error" title={skillsError}>
                {firstLine(skillsError)}
              </span>
              <button class="pill" onClick={() => retrySkills.current()}>
                重试
              </button>
              <button class="pill primary-pill" onClick={() => skipSkills.current()}>
                跳过，先开始制作
              </button>
            </>
          ) : (
            running && (
              <button class="pill ghost-pill" onClick={() => skipSkills.current()} title="技能转到后台继续装，编排工具先从写稿、配音开始">
                不等了，先开始制作
              </button>
            )
          )}
        </div>
      </div>
      {finale === 'clap' && <div class="creation-flash" aria-hidden="true" />}
    </div>
  );
}

function Slate(props: { title: string; canvas: string; mode: string; date: string; tool: string; clapped: boolean }) {
  return (
    <div class={'slate' + (props.clapped ? ' clapped' : '')}>
      <div class="slate-arm" aria-hidden="true">
        <span />
      </div>
      <div class="slate-top" aria-hidden="true">
        <span />
      </div>
      <div class="slate-body">
        <div class="slate-row wide">
          <label>片名</label>
          <strong>{props.title}</strong>
        </div>
        <div class="slate-row">
          <label>画幅</label>
          <span class="mono">{props.canvas}</span>
        </div>
        <div class="slate-row">
          <label>形式</label>
          <span>{props.mode}</span>
        </div>
        <div class="slate-row">
          <label>场 / 镜</label>
          <span class="mono">01 / 001</span>
        </div>
        <div class="slate-row">
          <label>日期</label>
          <span class="mono">{props.date}</span>
        </div>
        <div class="slate-row wide">
          <label>编排</label>
          <span>{props.tool}</span>
        </div>
      </div>
    </div>
  );
}

function timecode(seconds: number): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total % 1) * FPS);
  return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':');
}

function firstLine(text: string): string {
  const line = text.split('\n')[0];
  return line.length > 60 ? line.slice(0, 60) + '…' : line;
}
