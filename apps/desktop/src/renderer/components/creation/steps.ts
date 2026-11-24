import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { api, errorText, forUser, post } from '../../api';
import type { Project, Task } from '../../types';
import { materialFiles } from '../homeAttachments';
import { type CreationJob, excerpts, type SkillsStatus, type StepID, type StepState } from './helpers';

export type MarkStep = (id: StepID, state: StepState, fraction?: number) => void;

export async function runNamingStep(opts: {
  job: CreationJob;
  mark: MarkStep;
  setCaption: (text: string) => void;
  setRenamed: (value: boolean) => void;
  skipNaming: MutableRefObject<() => void>;
}): Promise<{ base: string; token: string }> {
  const { job, mark, setCaption, setRenamed, skipNaming } = opts;
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
  return { base, token };
}

export async function createProjectStep(
  job: CreationJob,
  dated: string,
  token: string,
): Promise<{ project: Project; filmStyleTask: string; filmStyleError: string }> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const name = attempt === 1 ? dated : `${dated}-${attempt}`;
    try {
      const response = await post<{ project: Project; film_style_task?: string; film_style_error?: string }>(
        '/api/projects/create',
        {
          parent: job.parent,
          name,
          canvas: job.canvas,
          delivery: job.delivery,
          narration: job.narration,
          film_style: job.filmStyle,
          naming: attempt === 1 ? token : '',
        },
      );
      return {
        project: response.project,
        filmStyleTask: response.film_style_task ?? '',
        filmStyleError: response.film_style_error ?? '',
      };
    } catch (err) {
      if (!(err instanceof Error) || !/已经存在/.test(err.message)) throw err;
    }
  }
  throw new Error('同名的项目太多了，换个说法再试');
}

export function waitForSkillsStep(opts: {
  isCancelled: () => boolean;
  mark: MarkStep;
  setCaption: (text: string) => void;
  setFractions: Dispatch<SetStateAction<Record<StepID, number>>>;
  setIndeterminate: (value: boolean) => void;
  setSkillsError: (text: string) => void;
  skipSkills: MutableRefObject<() => void>;
  retrySkills: MutableRefObject<() => void>;
}): Promise<void> {
  const { isCancelled, mark, setCaption, setFractions, setIndeterminate, setSkillsError, skipSkills, retrySkills } =
    opts;
  return new Promise<void>((resolve) => {
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
      if (isCancelled() || done) return;
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
      timer = window.setTimeout(() => void poll(), 600);
    };
    retrySkills.current = () => {
      void (async () => {
        setSkillsError('');
        setCaption('重新装备技能…');
        try {
          await post('/api/skills/install');
        } catch (err) {
          setSkillsError(errorText(err));
          return;
        }
        timer = window.setTimeout(() => void poll(), 600);
      })();
    };
    void poll();
  });
}

export function waitForStyleStep(opts: {
  filmStyle: string;
  filmStyleTask: string;
  filmStyleError: string;
  isCancelled: () => boolean;
  mark: MarkStep;
  setCaption: (text: string) => void;
  setStyleError: (text: string) => void;
  skipStyle: MutableRefObject<() => void>;
  retryStyle: MutableRefObject<() => void>;
}): Promise<void> {
  const {
    filmStyle,
    filmStyleTask,
    filmStyleError,
    isCancelled,
    mark,
    setCaption,
    setStyleError,
    skipStyle,
    retryStyle,
  } = opts;
  return new Promise<void>((resolve) => {
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
      if (isCancelled() || done) return;
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
    retryStyle.current = () => {
      void (async () => {
        setStyleError('');
        setCaption('正在装整片风格…');
        try {
          const started = await post<{ task_id: string }>('/api/film-style', { style: filmStyle });
          void watch(started.task_id);
        } catch (err) {
          setStyleError(errorText(err));
        }
      })();
    };
    if (filmStyleTask) void watch(filmStyleTask);
    else if (filmStyleError) setStyleError(filmStyleError);
    else retryStyle.current();
  });
}
