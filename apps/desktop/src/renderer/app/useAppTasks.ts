import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, forUser, post } from '../api';
import type { Tab } from '../components/Preview';
import type { SkillsStatus } from '../components/SkillsPill';
import type { Task } from '../types';

export function useAppTasks(opts: {
  currentId: string;
  tab: Tab;
  panelOpen: boolean;
  renderer: string;
  rendererModel: string;
  rendererOptions: string;
  notify: (message: string) => void;
  loadProject: () => Promise<void>;
  loadSessions: () => Promise<void>;
}) {
  const { currentId, tab, panelOpen, renderer, rendererModel, rendererOptions, notify, loadProject, loadSessions } =
    opts;
  const [skills, setSkills] = useState<SkillsStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);

  const loadTasks = useCallback(async () => {
    try {
      const result = await api<{ tasks: Task[] }>('/api/tasks');
      setTasks((result.tasks ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at)));
    } catch {
      // 任务列表拿不到不影响其他功能。
    }
  }, []);

  useEffect(() => {
    if (currentId) void loadTasks();
  }, [currentId]);

  // HyperFrames 官方技能：在 Studio 里新建的项目在后台装，装好之前或装失败时提示。
  const loadSkills = useCallback(async () => {
    try {
      const result = await api<{ status?: SkillsStatus }>('/api/skills');
      setSkills(result.status ?? null);
      return result.status;
    } catch {
      setSkills(null);
      return undefined;
    }
  }, []);

  useEffect(() => {
    setSkills(null);
    if (!currentId) return;
    let timer = 0;
    const poll = async () => {
      const status = await loadSkills();
      if (status?.installing) timer = window.setTimeout(poll, 1000);
    };
    void poll();
    return () => window.clearTimeout(timer);
  }, [currentId]);

  const installSkills = async () => {
    try {
      setSkills(await post('/api/skills/install'));
      const poll = async () => {
        const status = await loadSkills();
        if (status?.installing) window.setTimeout(poll, 1000);
      };
      window.setTimeout(poll, 1000);
    } catch (err) {
      notify(errorText(err));
    }
  };

  // 任务在跑时每两秒查一次，结束时刷新项目；空闲时十秒一次，顺带探测连接。
  const activeTasks = tasks.some((t) => t.status === 'queued' || t.status === 'running');
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !activeTasks) void loadProject();
    wasActive.current = activeTasks;
    if (!currentId) return;
    const timer = window.setInterval(
      () => {
        void loadTasks();
        if (!activeTasks) void loadSessions();
      },
      activeTasks ? 2000 : 10000,
    );
    return () => window.clearInterval(timer);
  }, [activeTasks, currentId]);

  const navigation = useMemo(() => ({ currentId, tab, panelOpen }), [currentId, tab, panelOpen]);
  const activeNavigation = useRef(navigation);
  useLayoutEffect(() => {
    activeNavigation.current = navigation;
  }, [navigation]);

  const run = useCallback(
    async (path: string, payload: Record<string, unknown> = {}, onAccepted?: () => void) => {
      const startedFrom = activeNavigation.current;
      try {
        await post(
          path,
          /\/render(\/all)?$/.test(path)
            ? { ...payload, renderer, renderer_model: rendererModel, renderer_options: rendererOptions }
            : payload,
        );
        if (activeNavigation.current === startedFrom) onAccepted?.();
        notify('已开始，进度见右上角任务。');
        await loadTasks();
        await loadSessions();
      } catch (err) {
        notify(errorText(err));
      }
    },
    [loadTasks, loadSessions, notify, renderer, rendererModel, rendererOptions],
  );

  // Dock 角标与完成通知（客户端里才有）：一轮对话、一次渲染要跑很久，人多半去做别的事了。
  const taskStatus = useRef(new Map<string, Task['status']>());
  useEffect(() => {
    const active = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length;
    window.onset?.setBadge?.(active);
    for (const task of tasks) {
      const before = taskStatus.current.get(task.task_id);
      if ((before === 'running' || before === 'queued') && (task.status === 'succeeded' || task.status === 'failed')) {
        window.onset?.notify?.(
          task.status === 'succeeded' ? '任务完成' : '任务失败',
          forUser(task.message || task.error || task.type),
        );
      }
      taskStatus.current.set(task.task_id, task.status);
    }
  }, [tasks]);

  return { skills, tasks, installSkills, run };
}
