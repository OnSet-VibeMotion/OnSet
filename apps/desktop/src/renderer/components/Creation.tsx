import { useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, forUser, post } from '../api';
import type { Attachment, CanvasOption, Project, Task } from '../types';
import { materialFiles, uploadMaterials, type HomeMaterial } from './homeAttachments';
import '../creation.css';

/**
 * 新建项目的「开机」画面。起片名、建项目、放素材、装技能、请编排工具开工，几步摆成剪辑
 * 时间线上的四段片段，播放头按真实进度走；场记板写着片名、画幅与制作方式，监视器按
 * 选定的画幅放倒计时片头，全部就绪时打板、闪白、推进到项目里。
 *
 * 顺序刻意先装技能再开工：编排工具一开工就该有 hyperframes 技能可用。装技能要联网、
 * 一分钟上下，所以随时可以「不等了」——技能转到后台，顶栏继续显示进度。
 */

export interface CreationJob {
  parent: string;
  /** 按第一句话或文件名起的名字（不含日期）：AI 起名失败或用户不等时用它。 */
  name: string;
  canvas: string;
  canvasInfo?: CanvasOption;
  /** 选定的整片风格（风格库目录名），空表示不用。 */
  filmStyle: string;
  delivery: string;
  narration: string;
  modeLabel: string;
  tool: string;
  toolLabel: string;
  message: string;
  materials: HomeMaterial[];
}

type StepID = 'name' | 'create' | 'upload' | 'skills' | 'style' | 'start';
type StepState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';

interface Step {
  id: StepID;
  label: string;
  weight: number;
}

const steps: Step[] = [
  { id: 'name', label: '起片名', weight: 8 },
  { id: 'create', label: '建立项目', weight: 6 },
  { id: 'upload', label: '放入素材', weight: 8 },
  { id: 'skills', label: '装备技能', weight: 54 },
  { id: 'style', label: '整片风格', weight: 12 },
  { id: 'start', label: '召集编排', weight: 12 },
];

interface SkillsStatus {
  installed: boolean;
  installing: boolean;
  error?: string;
  progress?: { stage: string; percent: number; indeterminate?: boolean };
}

const FPS = 30;

/** 读得出文字的素材：取开头一段交给起名。 */
const textFile = /\.(md|markdown|txt|text|srt|vtt|csv|json|html?|ya?ml)$/i;

/** 项目名后面带上日期（月日），同一主题隔天再做也不撞名。 */
export function datedName(base: string, at = new Date()): string {
  return `${base}-${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
}

async function excerpts(files: File[]): Promise<{ name: string; text: string }[]> {
  return Promise.all(
    files.map(async (file) => {
      if (!textFile.test(file.name) && !file.type.startsWith('text/')) return { name: file.name, text: '' };
      try {
        return { name: file.name, text: Array.from(await file.slice(0, 32 * 1024).text()).slice(0, 3000).join('') };
      } catch {
        return { name: file.name, text: '' };
      }
    }),
  );
}

export function Creation(props: { job: CreationJob; onDone: (projectId: string, sessionId: string) => void; onClose: (error: string) => void }) {
  const { job } = props;
  const [states, setStates] = useState<Record<StepID, StepState>>({ name: 'running', create: 'waiting', upload: 'waiting', skills: 'waiting', style: 'waiting', start: 'waiting' });
  const [fractions, setFractions] = useState<Record<StepID, number>>({ name: 0, create: 0, upload: 0, skills: 0, style: 0, start: 0 });
  const [caption, setCaption] = useState(job.materials.length > 0 ? '正在读你的话和素材，给片子起个名字…' : '正在读你的话，给片子起个名字…');
  const [error, setError] = useState('');
  const [skillsError, setSkillsError] = useState('');
  const [styleError, setStyleError] = useState('');
  const [indeterminate, setIndeterminate] = useState(false);
  const [finale, setFinale] = useState<'' | 'clap' | 'zoom'>('');
  const [title, setTitle] = useState('');
  // 拟片名这一幕：drafting 时监视器放原话与扫描线，reveal 时划掉原话、逐字写出新片名；空串时回到倒计时。
  const [naming, setNaming] = useState<'' | 'drafting' | 'reveal'>('drafting');
  // 定下的片名是不是 AI 起的（是才划掉原话）。
  const [renamed, setRenamed] = useState(false);
  const [started] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const project = useRef<Project | null>(null);
  const attachments = useRef<Attachment[]>([]);
  const skipSkills = useRef<() => void>(() => {});
  const skipNaming = useRef<() => void>(() => {});
  const retrySkills = useRef<() => void>(() => {});
  const skipStyle = useRef<() => void>(() => {});
  // 建项目时后端已经起了装风格的任务（film_style_task）；这里只跟进度。
  const filmStyleTask = useRef('');
  const filmStyleError = useRef('');
  const retryStyle = useRef<() => void>(() => {});

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
        // 1. 起片名：用选定的编排工具读一遍用户的话与素材开头，起一个说清内容的名字。
        // 起不出来（工具没装、超时）或用户不等，就用第一句话截出来的名字。
        let base = job.name;
        let token = '';
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = (state: StepState) => {
            if (done) return;
            done = true;
            mark('name', state, 1);
            resolve();
          };
          skipNaming.current = () => {
            setCaption('用你的第一句话当片名');
            finish('skipped');
          };
          void (async () => {
            try {
              const answer = await post<{ name: string; naming?: string; error?: string }>('/api/projects/name', {
                tool: job.tool,
                message: job.message,
                files: await excerpts(materialFiles(job.materials).slice(0, 10)),
              });
              if (done) return;
              token = answer.naming ?? '';
              if (answer.name) {
                base = answer.name;
                setRenamed(answer.name !== job.name);
                setCaption(`片名定为「${answer.name}」`);
                finish('done');
              } else {
                setCaption('没起出名字，先用你的第一句话');
                finish('skipped');
              }
            } catch {
              if (done) return;
              setCaption('没起出名字，先用你的第一句话');
              finish('skipped');
            }
          })();
        });
        if (cancelled) return;
        const dated = datedName(base);
        setTitle(dated);
        // 定名：划掉原话、逐字写出片名，停一拍再回到倒计时。
        setNaming('reveal');
        await sleep(reducedMotion() ? 300 : Math.min(inkDuration(dated) + 900, 2400));
        if (cancelled) return;
        setNaming('');
        await sleep(200);
        if (cancelled) return;

        // 2. 建立项目：重名就加序号。
        mark('create', 'running');
        setCaption('正在建立项目文件夹…');
        let created: Project | null = null;
        for (let attempt = 1; attempt <= 20 && !created; attempt++) {
          const name = attempt === 1 ? dated : `${dated}-${attempt}`;
          try {
            const response = await post<{ project: Project; film_style_task?: string; film_style_error?: string }>('/api/projects/create', {
              parent: job.parent,
              name,
              canvas: job.canvas,
              delivery: job.delivery,
              narration: job.narration,
              film_style: job.filmStyle,
              naming: attempt === 1 ? token : '',
            });
            created = response.project;
            filmStyleTask.current = response.film_style_task ?? '';
            filmStyleError.current = response.film_style_error ?? '';
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

        // 3. 放入素材。
        mark('upload', 'running');
        if (job.materials.length) {
          setCaption(`正在放入 ${job.materials.length} 个素材…`);
          attachments.current = await uploadMaterials(job.materials);
          mark('upload', 'done', 1);
        } else {
          setCaption('没有素材，跳过');
          mark('upload', 'skipped', 1);
        }
        await sleep(350);
        if (cancelled) return;

        // 4. 装备技能：后端建项目时已经在后台开装，这里只看进度。可以随时不等。
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
                setSkillsError(forUser(status.error));
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

        // 5. 整片风格：选了才装（onset film-style use，第一次要下载风格库）。装不上可以重试或跳过，
        // 跳过就由编排工具在稿件审核时再推荐。
        if (job.filmStyle) {
          mark('style', 'running');
          setCaption('正在装整片风格…');
          await new Promise<void>((resolve) => {
            let timer = 0;
            let done = false;
            const finish = (state: StepState) => {
              if (done) return;
              done = true;
              window.clearTimeout(timer);
              mark('style', state, 1);
              resolve();
            };
            skipStyle.current = () => {
              setStyleError('');
              setCaption('不装整片风格，先开始制作');
              finish('skipped');
            };
            const watch = async (id: string) => {
              if (cancelled || done) return;
              try {
                const task = await api<Task>('/api/tasks/' + encodeURIComponent(id));
                if (task.status === 'succeeded') {
                  setCaption('整片风格就绪');
                  finish('done');
                  return;
                }
                if (task.status === 'failed' || task.status === 'cancelled') {
                  setStyleError(forUser(task.error || task.message || '整片风格没装上'));
                  setCaption('整片风格没装上');
                  return; // 等用户选重试或跳过
                }
              } catch {
                // 读状态失败就下一次再试。
              }
              timer = window.setTimeout(() => void watch(id), 800);
            };
            retryStyle.current = async () => {
              setStyleError('');
              setCaption('正在装整片风格…');
              try {
                const started = await post<{ task_id: string }>('/api/film-style', { style: job.filmStyle });
                void watch(started.task_id);
              } catch (err) {
                setStyleError(errorText(err));
              }
            };
            if (filmStyleTask.current) void watch(filmStyleTask.current);
            else if (filmStyleError.current) setStyleError(filmStyleError.current);
            else void retryStyle.current();
          });
          if (cancelled) return;
          await sleep(300);
        } else {
          mark('style', 'skipped', 1);
        }

        // 6. 召集编排：开始整片制作。
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
  const namingStep = states.name === 'running';

  return (
    <div className={'creation' + (finale ? ' ' + finale : '')} role="dialog" aria-modal="true" aria-label="正在新建项目">
      <div className="creation-grain" aria-hidden="true" />
      <div className="creation-stage">
        <Slate
          title={title}
          naming={naming}
          canvas={job.canvasInfo ? `${job.canvasInfo.width}×${job.canvasInfo.height}` : job.canvas}
          mode={job.modeLabel}
          date={`${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`}
          tool={job.toolLabel}
          clapped={finale !== ''}
        />

        <div className="monitor" style={{ aspectRatio: String(ratio) }}>
          {naming && !finale ? (
            <TitleDraft draft={job.name} title={title} phase={naming} renamed={renamed} reading={job.materials.length > 0 ? '正在读你的话和素材' : '正在读你的话'} />
          ) : finale ? (
            <div className="monitor-title">
              <span className="monitor-kicker">TAKE 1</span>
              <strong>{title}</strong>
            </div>
          ) : (
            <div className="leader" aria-hidden="true">
              <div className="leader-sweep" style={{ background: `conic-gradient(rgba(255,255,255,.16) ${sweep}deg, transparent ${sweep}deg)` }} />
              <div className="leader-cross" />
              <div className="leader-ring" />
              <div className="leader-ring inner" />
              <span className="leader-number">{countdown}</span>
            </div>
          )}
          <span className="monitor-rec">
            <i />
            REC
          </span>
          <span className="monitor-tc mono">{timecode(elapsed)}</span>
          <span className="monitor-safe" aria-hidden="true" />
        </div>

        <div className="timeline-rig">
          <div className="rig-ruler mono" aria-hidden="true">
            {Array.from({ length: 11 }, (_, i) => (
              <span key={i}>{timecode((i * Math.max(elapsed, 10)) / 10).slice(3, 8)}</span>
            ))}
          </div>
          <div className="rig-track video">
            <span className="track-label mono">V1</span>
            <div className="track-lane">
              {steps.map((step) => {
                const state = states[step.id];
                const fill = state === 'done' || state === 'skipped' ? 1 : state === 'running' ? fractions[step.id] : 0;
                return (
                  <div
                    key={step.id}
                    className={'clip ' + state + ((step.id === 'skills' && indeterminate) || (step.id === 'name' && state === 'running') || (step.id === 'style' && state === 'running') ? ' indeterminate' : '')}
                    style={{ flexGrow: step.weight }}
                  >
                    <span className="clip-fill" style={{ width: `${fill * 100}%` }} />
                    <span className="clip-label">
                      {step.label}
                      {state === 'skipped' && step.id === 'skills' && <em> · 后台</em>}
                      {state === 'skipped' && step.id === 'name' && <em> · 用原话</em>}
                      {state === 'skipped' && step.id === 'style' && <em> · 不用</em>}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="rig-track audio">
            <span className="track-label mono">A1</span>
            <div className="track-lane wave" aria-hidden="true">
              {Array.from({ length: 64 }, (_, i) => (
                <i key={i} style={{ animationDelay: `${(i * 97) % 1100}ms`, height: `${30 + ((i * 37) % 60)}%` }} />
              ))}
            </div>
          </div>
          <div className="playhead" style={{ left: `calc(48px + (100% - 60px) * ${overall / 100})` }} aria-hidden="true">
            <span className="playhead-cap" />
          </div>
        </div>

        <div className="creation-caption" aria-live="polite">
          <span className="caption-percent mono">{Math.round(overall)}%</span>
          <span className="caption-text">{error || caption}</span>
        </div>

        <div className="creation-actions">
          {error ? (
            <button className="pill" onClick={() => props.onClose(error)}>
              回到首页
            </button>
          ) : styleError ? (
            <>
              <span className="creation-error" title={styleError}>
                {firstLine(styleError)}
              </span>
              <button className="pill" onClick={() => retryStyle.current()}>
                重试
              </button>
              <button className="pill primary-pill" onClick={() => skipStyle.current()}>
                跳过，先开始制作
              </button>
            </>
          ) : skillsError ? (
            <>
              <span className="creation-error" title={skillsError}>
                {firstLine(skillsError)}
              </span>
              <button className="pill" onClick={() => retrySkills.current()}>
                重试
              </button>
              <button className="pill primary-pill" onClick={() => skipSkills.current()}>
                跳过，先开始制作
              </button>
            </>
          ) : namingStep ? (
            <button className="pill ghost-pill" onClick={() => skipNaming.current()} title={`不等 AI 起名，片名用「${job.name}」`}>
              不等了，用我的第一句话
            </button>
          ) : (
            running && (
              <button className="pill ghost-pill" onClick={() => skipSkills.current()} title="技能转到后台继续装，AI 先从写稿、配音开始">
                不等了，先开始制作
              </button>
            )
          )}
        </div>
      </div>
      {finale === 'clap' && <div className="creation-flash" aria-hidden="true" />}
    </div>
  );
}

/** 逐字写出的一行字（拟片名那一幕的监视器与场记板共用）：每个字晚 INK_STEP 毫秒出现。 */
const INK_STEP = 55;

function inkDuration(text: string): number {
  return Array.from(text).length * INK_STEP + 420;
}

function reducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function Ink(props: { text: string; delay?: number }) {
  return (
    <span className="ink" aria-label={props.text}>
      {Array.from(props.text).map((ch, i) => (
        <span key={i} className="ink-char" aria-hidden="true" style={{ animationDelay: `${(props.delay ?? 0) + i * INK_STEP}ms` }}>
          {ch}
        </span>
      ))}
    </span>
  );
}

/**
 * 监视器上的「拟片名」：拟定中放用户的原话当暂定片名，一道扫描线来回读；定名时（AI 起了新名字）
 * 划掉原话，逐字写出片名。没起出名字时不划线，直接把原话写成片名。
 */
function TitleDraft(props: { draft: string; title: string; phase: 'drafting' | 'reveal'; renamed: boolean; reading: string }) {
  const reveal = props.phase === 'reveal';
  return (
    <div className={'title-draft ' + props.phase + (props.renamed ? ' renamed' : '')}>
      <span className="monitor-kicker">{reveal ? 'TITLE' : 'WORKING TITLE'}</span>
      {(!reveal || props.renamed) && (
        <span className="draft-words">
          {props.draft}
          {!reveal && <i className="draft-scan" aria-hidden="true" />}
        </span>
      )}
      {reveal ? (
        <strong className="draft-title">
          {/* 监视器上只写片名，日期后缀留在场记板上。 */}
          <Ink text={props.title.replace(/-\d{4}$/, '')} delay={props.renamed ? 380 : 0} />
        </strong>
      ) : (
        <span className="draft-reading">
          {props.reading}
          <i className="draft-dots" aria-hidden="true">
            <b />
            <b />
            <b />
          </i>
        </span>
      )}
    </div>
  );
}

function Slate(props: { title: string; naming: '' | 'drafting' | 'reveal'; canvas: string; mode: string; date: string; tool: string; clapped: boolean }) {
  return (
    <div className={'slate' + (props.clapped ? ' clapped' : '')}>
      <div className="slate-arm" aria-hidden="true">
        <span />
      </div>
      <div className="slate-top" aria-hidden="true">
        <span />
      </div>
      <div className="slate-body">
        <div className="slate-row wide">
          <label>片名</label>
          {props.naming === 'drafting' || !props.title ? (
            <strong className="pending">
              <i className="chalk-caret" aria-hidden="true" />
            </strong>
          ) : props.naming === 'reveal' ? (
            <strong>
              <Ink text={props.title} delay={380} />
            </strong>
          ) : (
            <strong>{props.title}</strong>
          )}
        </div>
        <div className="slate-row">
          <label>画幅</label>
          <span className="mono">{props.canvas}</span>
        </div>
        <div className="slate-row">
          <label>形式</label>
          <span>{props.mode}</span>
        </div>
        <div className="slate-row">
          <label>场 / 镜</label>
          <span className="mono">01 / 001</span>
        </div>
        <div className="slate-row">
          <label>日期</label>
          <span className="mono">{props.date}</span>
        </div>
        <div className="slate-row wide">
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
