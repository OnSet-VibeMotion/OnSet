import { useEffect, useMemo, useRef, useState } from 'react';
import { errorText, post } from '../../api';
import type { Attachment, Project } from '../../types';
import { uploadMaterials } from '../homeAttachments';
import { type CreationJob, datedName, inkDuration, reducedMotion, type StepID, type StepState, steps } from './helpers';
import { createProjectStep, runNamingStep, waitForSkillsStep, waitForStyleStep } from './steps';

export function useCreationRunner(job: CreationJob, onDone: (projectId: string, sessionId: string) => void) {
  const [states, setStates] = useState<Record<StepID, StepState>>({
    name: 'running',
    create: 'waiting',
    upload: 'waiting',
    skills: 'waiting',
    style: 'waiting',
    start: 'waiting',
  });
  const [fractions, setFractions] = useState<Record<StepID, number>>({
    name: 0,
    create: 0,
    upload: 0,
    skills: 0,
    style: 0,
    start: 0,
  });
  const [caption, setCaption] = useState(
    job.materials.length > 0 ? '正在读你的话和素材，给片子起个名字…' : '正在读你的话，给片子起个名字…',
  );
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
    const isCancelled = () => cancelled;
    const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const run = async () => {
      try {
        // 1. 起片名：用选定的编排工具读一遍用户的话与素材开头，起一个说清内容的名字。
        // 起不出来（工具没装、超时）或用户不等，就用第一句话截出来的名字。
        const { base, token } = await runNamingStep({ job, mark, setCaption, setRenamed, skipNaming });
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
        const createdInfo = await createProjectStep(job, dated, token);
        const created = createdInfo.project;
        filmStyleTask.current = createdInfo.filmStyleTask;
        filmStyleError.current = createdInfo.filmStyleError;
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
        await waitForSkillsStep({
          isCancelled,
          mark,
          setCaption,
          setFractions,
          setIndeterminate,
          setSkillsError,
          skipSkills,
          retrySkills,
        });
        if (cancelled) return;
        await sleep(300);

        // 5. 整片风格：选了才装（onset film-style use，第一次要下载风格库）。装不上可以重试或跳过，
        // 跳过就由编排工具在稿件审核时再推荐。
        if (job.filmStyle) {
          mark('style', 'running');
          setCaption('正在装整片风格…');
          await waitForStyleStep({
            filmStyle: job.filmStyle,
            filmStyleTask: filmStyleTask.current,
            filmStyleError: filmStyleError.current,
            isCancelled,
            mark,
            setCaption,
            setStyleError,
            skipStyle,
            retryStyle,
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
        if (!cancelled) onDone(created.id, startedTurn.session_id);
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

  return {
    states,
    fractions,
    caption,
    error,
    skillsError,
    styleError,
    indeterminate,
    finale,
    title,
    naming,
    renamed,
    started,
    now,
    overall,
    skipNaming,
    skipSkills,
    retrySkills,
    skipStyle,
    retryStyle,
  };
}
